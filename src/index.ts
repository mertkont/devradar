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
};

type StoredMember = {
  userId: string;
  userName: string;
  ide: string;
  project: string;
  lastSeen: number;
};

const STALE_MEMBER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

type ClientMsg =
  | { type: "hello"; userId: string; userName: string; ide: string; project: string }
  | { type: "update"; file?: string | null; line?: number | null; project?: string }
  | { type: "heartbeat" };

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
      };
      ws.serializeAttachment(att);
      const member: StoredMember = {
        userId: att.userId,
        userName: att.userName,
        ide: att.ide,
        project: att.project,
        lastSeen: Date.now(),
      };
      await this.ctx.storage.put(`member:${att.userId}`, member);
      await this.pruneStaleMembers();
      ws.send(JSON.stringify({ type: "welcome", userId: att.userId }));
      await this.broadcast();
      return;
    }

    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;

    if (msg.type === "update") {
      att.file = msg.file ? String(msg.file).slice(0, 512) : null;
      att.line = typeof msg.line === "number" ? msg.line : null;
      if (msg.project) att.project = String(msg.project).slice(0, 256);
      ws.serializeAttachment(att);
      await this.broadcast();
      return;
    }

    // heartbeat: connection liveness is enough on its own, nothing to do
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.broadcast(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.broadcast(ws);
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
    const sockets = this.ctx.getWebSockets().filter((s) => s !== exclude);

    const online = new Map<string, Attachment>();
    for (const s of sockets) {
      const att = s.deserializeAttachment() as Attachment | null;
      if (att) online.set(att.userId, att);
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
