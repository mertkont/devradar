/// <reference types="@cloudflare/workers-types" />

export interface Env {
  PRESENCE: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const room = (url.searchParams.get("room") ?? "").trim();
      if (!room || room.length > 512) {
        return new Response("missing or invalid 'room' query parameter", { status: 400 });
      }
      const id = env.PRESENCE.idFromName(room);
      const stub = env.PRESENCE.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === "/room" && request.method === "DELETE") {
      const room = (url.searchParams.get("room") ?? "").trim();
      if (!room || room.length > 512) {
        return new Response("missing or invalid 'room' query parameter", { status: 400 });
      }
      const stub = env.PRESENCE.get(env.PRESENCE.idFromName(room));
      return stub.fetch(request);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("devradar ok\n", { status: 200, headers: { "content-type": "text/plain" } });
    }

    return new Response("not found", { status: 404 });
  },
};

type Attachment = {
  userId: string;
  userName: string;
  ide: string;
  project: string;
  file?: string | null;
  line?: number | null;
  lastSeen: number;
  // Sliding-window rate limit counters for chat messages from this socket.
  chatWindowStart?: number;
  chatCount?: number;
};

const CHAT_MAX_TEXT = 4096;
const CHAT_RATE_WINDOW_MS = 10_000;
const CHAT_RATE_MAX = 15;

type StoredMember = {
  userId: string;
  userName: string;
  ide: string;
  project: string;
  lastSeen: number;
};

const STALE_MEMBER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — for purging long-gone offline members
// Client heartbeats every 30s. We treat a socket as dead after ~2.5 missed heartbeats.
const STALE_SOCKET_MS = 75 * 1000;
const ALARM_INTERVAL_MS = 30 * 1000;

type ClientMsg =
  | { type: "hello"; userId: string; userName: string; ide: string; project: string }
  | { type: "update"; file?: string | null; line?: number | null; project?: string }
  | { type: "heartbeat" }
  | { type: "chat"; to: string; text: string; id: string };

export class PresenceRoom implements DurableObject {
  constructor(private ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method === "DELETE") {
      for (const s of this.ctx.getWebSockets()) {
        try {
          s.close(1000, "room reset");
        } catch {
          // ignore
        }
      }
      await this.ctx.storage.deleteAll();
      return new Response("room cleared\n", { status: 200 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: ClientMsg | undefined;
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.type === "string") msg = parsed as ClientMsg;
    } catch {
      return;
    }
    if (!msg) return;

    const now = Date.now();

    if (msg.type === "hello") {
      if (!msg.userId || !msg.userName) {
        ws.send(JSON.stringify({ type: "error", message: "missing userId or userName" }));
        ws.close(1008, "bad hello");
        return;
      }
      const att: Attachment = {
        userId: String(msg.userId).slice(0, 128),
        userName: String(msg.userName).slice(0, 128),
        ide: (msg.ide || "unknown").slice(0, 64),
        project: (msg.project || "unknown").slice(0, 256),
        file: null,
        line: null,
        lastSeen: now,
      };
      ws.serializeAttachment(att);
      const member: StoredMember = {
        userId: att.userId,
        userName: att.userName,
        ide: att.ide,
        project: att.project,
        lastSeen: now,
      };
      await this.ctx.storage.put(`member:${att.userId}`, member);
      await this.pruneStaleMembers();
      ws.send(JSON.stringify({ type: "welcome", userId: att.userId }));
      await this.broadcast();
      await this.ensureAlarm();
      return;
    }

    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;

    // Any message from the client (update, heartbeat) refreshes liveness on
    // both the socket attachment and the persistent member record. The latter
    // lets us show "last seen N minutes ago" for offline peers.
    att.lastSeen = now;
    await this.touchMember(att.userId, now);

    if (msg.type === "update") {
      att.file = msg.file ? String(msg.file).slice(0, 512) : null;
      att.line = typeof msg.line === "number" ? msg.line : null;
      if (msg.project) att.project = String(msg.project).slice(0, 256);
      ws.serializeAttachment(att);
      await this.broadcast();
      return;
    }

    if (msg.type === "chat") {
      this.handleChat(ws, att, msg, now);
      return;
    }

    // heartbeat: just persist the refreshed lastSeen.
    ws.serializeAttachment(att);
  }

  // Real-time 1-to-1 chat within a room. The server is the source of truth for
  // "from" — we ignore whatever the client puts there and stamp the sender's
  // userId from the socket's own attachment. That alone prevents the simplest
  // form of impersonation (a client claiming to be someone else inside the
  // same room). It does NOT prevent cross-IDE impersonation by someone who
  // controls a teammate's git email, but neither does the rest of devradar —
  // identity is intentionally derived from git for zero-config UX.
  private handleChat(
    ws: WebSocket,
    att: Attachment,
    msg: { to: string; text: string; id: string },
    now: number,
  ): void {
    // --- input validation ---
    if (typeof msg.to !== "string" || typeof msg.text !== "string" || typeof msg.id !== "string") return;
    const to = msg.to.slice(0, 128);
    const id = msg.id.slice(0, 64);
    const text = String(msg.text).slice(0, CHAT_MAX_TEXT).trim();
    if (!text) return;
    if (to === att.userId) return; // no echo-chat to self

    // --- rate limiting (sliding window per socket) ---
    const winStart = att.chatWindowStart ?? 0;
    if (now - winStart > CHAT_RATE_WINDOW_MS) {
      att.chatWindowStart = now;
      att.chatCount = 1;
    } else {
      att.chatCount = (att.chatCount ?? 0) + 1;
      if (att.chatCount > CHAT_RATE_MAX) {
        ws.serializeAttachment(att);
        try { ws.send(JSON.stringify({ type: "chat-error", id, to, reason: "rate-limited" })); } catch {}
        return;
      }
    }
    ws.serializeAttachment(att);

    // --- find recipient sockets and sender's other sockets in this room ---
    const recipients: WebSocket[] = [];
    const senderEchoes: WebSocket[] = [];
    for (const s of this.ctx.getWebSockets()) {
      const a = s.deserializeAttachment() as Attachment | null;
      if (!a) continue;
      if (now - (a.lastSeen ?? 0) > STALE_SOCKET_MS) continue;
      if (a.userId === to) recipients.push(s);
      else if (a.userId === att.userId && s !== ws) senderEchoes.push(s);
    }

    if (recipients.length === 0) {
      try { ws.send(JSON.stringify({ type: "chat-error", id, to, reason: "offline" })); } catch {}
      return;
    }

    const relay = JSON.stringify({
      type: "chat",
      from: att.userId,
      fromName: att.userName,
      to,
      text,
      id,
      ts: now,
    });
    for (const r of recipients) {
      try { r.send(relay); } catch { /* socket closing */ }
    }
    for (const s of senderEchoes) {
      try { s.send(relay); } catch { /* socket closing */ }
    }
    try {
      ws.send(JSON.stringify({ type: "chat-ack", id, to, ts: now }));
    } catch { /* ignore */ }
  }

  private async touchMember(userId: string, now: number): Promise<void> {
    const m = await this.ctx.storage.get<StoredMember>(`member:${userId}`);
    if (!m) return;
    m.lastSeen = now;
    await this.ctx.storage.put(`member:${userId}`, m);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.broadcast(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.broadcast(ws);
  }

  // Cloudflare Durable Object Alarm — fires periodically while there are connected sockets.
  // Closes any socket that hasn't sent a message (hello/update/heartbeat) within STALE_SOCKET_MS.
  async alarm(): Promise<void> {
    const now = Date.now();
    const toClose: WebSocket[] = [];
    for (const s of this.ctx.getWebSockets()) {
      const att = s.deserializeAttachment() as Attachment | null;
      if (!att) continue;
      if (now - (att.lastSeen ?? 0) > STALE_SOCKET_MS) toClose.push(s);
    }
    for (const s of toClose) {
      try {
        s.close(1011, "stale: no heartbeat");
      } catch {
        // ignore
      }
    }
    if (toClose.length > 0) await this.broadcast();
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  private async ensureAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current == null) await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  private async pruneStaleMembers(): Promise<void> {
    const now = Date.now();
    const connected = new Set<string>();
    for (const s of this.ctx.getWebSockets()) {
      const a = s.deserializeAttachment() as Attachment | null;
      if (a) connected.add(a.userId);
    }
    const stored = await this.ctx.storage.list<StoredMember>({ prefix: "member:" });
    const toDelete: string[] = [];
    for (const [key, m] of stored) {
      if (!connected.has(m.userId) && now - (m.lastSeen ?? 0) > STALE_MEMBER_MS) toDelete.push(key);
    }
    if (toDelete.length) await this.ctx.storage.delete(toDelete);
  }

  private async broadcast(exclude?: WebSocket): Promise<void> {
    const now = Date.now();
    const sockets = this.ctx.getWebSockets().filter((s) => s !== exclude);

    const online = new Map<string, Attachment>();
    for (const s of sockets) {
      const att = s.deserializeAttachment() as Attachment | null;
      if (!att) continue;
      // Defensive: even if the alarm hasn't pruned this socket yet, don't show stale ones as online.
      if (now - (att.lastSeen ?? 0) > STALE_SOCKET_MS) continue;
      online.set(att.userId, att);
    }

    const stored = await this.ctx.storage.list<StoredMember>({ prefix: "member:" });
    const users = [];
    for (const m of stored.values()) {
      const live = online.get(m.userId);
      if (live) {
        users.push({
          userId: m.userId,
          userName: m.userName,
          ide: live.ide,
          project: live.project,
          file: live.file ?? null,
          line: live.line ?? null,
          status: "online" as const,
        });
      } else {
        users.push({
          userId: m.userId,
          userName: m.userName,
          ide: m.ide,
          project: m.project,
          file: null,
          line: null,
          status: "offline" as const,
          lastSeen: m.lastSeen,
        });
      }
    }
    users.sort((a, b) => a.userName.localeCompare(b.userName));

    const payload = JSON.stringify({ type: "presence", users });
    for (const s of sockets) {
      try {
        s.send(payload);
      } catch {
        // socket closing; ignore
      }
    }
  }
}
