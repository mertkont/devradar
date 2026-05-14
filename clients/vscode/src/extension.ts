import * as vscode from "vscode";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";

const execFileP = promisify(execFile);

type PresenceUser = {
  userId: string;
  userName: string;
  ide: string;
  project: string;
  file: string | null;
  line: number | null;
  status: "online" | "offline";
  lastSeen?: number;
};

type Identity = { userId: string; userName: string };
type RoomInfo = { roomKey: string; projectLabel: string };

let ws: WebSocket | undefined;
let statusBar: vscode.StatusBarItem;
let users: PresenceUser[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let updateDebounce: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let selfId = "";
let selfName = "Sen";
let extCtx: vscode.ExtensionContext;

// One webview panel per peer userId; opening a chat with the same peer twice
// reveals the existing panel rather than creating a duplicate.
const chatPanels = new Map<string, vscode.WebviewPanel>();

function cfg() {
  const c = vscode.workspace.getConfiguration("devradar");
  return {
    serverUrl: (c.get<string>("serverUrl") ?? "").trim(),
    displayName: (c.get<string>("displayName") ?? "").trim(),
    teamKey: (c.get<string>("teamKey") ?? "").trim(),
  };
}

function shortHash(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function workspaceFolder(): vscode.WorkspaceFolder | undefined {
  const ed = vscode.window.activeTextEditor;
  if (ed) {
    const f = vscode.workspace.getWorkspaceFolder(ed.document.uri);
    if (f) return f;
  }
  return vscode.workspace.workspaceFolders?.[0];
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", args, { cwd, timeout: 3000 });
    const out = stdout.trim();
    return out.length ? out : null;
  } catch {
    return null;
  }
}

// "git@github.com:owner/repo.git" / "https://github.com/owner/repo" -> "github.com/owner/repo"
function normalizeRemote(url: string): string {
  let s = url.trim().replace(/\.git$/i, "");
  const scp = s.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i);
  if (m) return `${m[1]}/${m[2]}`.toLowerCase();
  return s.toLowerCase();
}

async function resolveIdentity(folder: vscode.WorkspaceFolder | undefined): Promise<Identity> {
  const { displayName } = cfg();
  let name = displayName;
  let email: string | null = null;
  if (folder) {
    email = await git(folder.uri.fsPath, ["config", "user.email"]);
    if (!name) name = (await git(folder.uri.fsPath, ["config", "user.name"])) ?? "";
  }
  if (!name) name = os.userInfo().username || "anon";

  let userId: string;
  if (email) {
    userId = "e:" + shortHash(email.toLowerCase());
  } else {
    let fallback = extCtx.globalState.get<string>("devradar.fallbackId");
    if (!fallback) {
      fallback = crypto.randomUUID();
      void extCtx.globalState.update("devradar.fallbackId", fallback);
    }
    userId = "x:" + fallback.slice(0, 16);
  }
  return { userId, userName: name.slice(0, 80) };
}

async function resolveRoom(folder: vscode.WorkspaceFolder | undefined): Promise<RoomInfo | null> {
  if (!folder) return null;
  const remote =
    (await git(folder.uri.fsPath, ["config", "--get", "remote.origin.url"])) ??
    (await git(folder.uri.fsPath, ["remote", "get-url", "origin"]));
  if (!remote) return null;
  const repo = normalizeRemote(remote);
  const { teamKey } = cfg();
  const base = teamKey ? `${repo}|${teamKey}` : repo;
  return { roomKey: "repo:" + shortHash(base), projectLabel: repo };
}

function currentFile(): { file: string | null; line: number | null } {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== "file") return { file: null, line: null };
  return { file: vscode.workspace.asRelativePath(ed.document.uri, false), line: ed.selection.active.line + 1 };
}

let currentRoom: RoomInfo | null = null;

async function connect() {
  if (stopped) return;
  closeSocket();

  const { serverUrl } = cfg();
  if (!serverUrl) {
    setStatus("$(warning) devradar: sunucu adresi yok", "Ayarlar → devradar.serverUrl");
    return;
  }

  const folder = workspaceFolder();
  const [identity, room] = await Promise.all([resolveIdentity(folder), resolveRoom(folder)]);
  if (!room) {
    setStatus("$(circle-slash) devradar: repo yok", "Bu klasörün bir git remote'u yok — devradar repo bazlı çalışır.");
    return;
  }
  currentRoom = room;
  selfId = identity.userId;

  let socket: WebSocket;
  try {
    // Explicit 10s handshake timeout: defends against the macOS sleep/wake case
    // where the underlying TCP/TLS state is half-broken and the open phase would
    // otherwise hang silently, breaking the reconnect chain.
    socket = new WebSocket(`${serverUrl}?room=${encodeURIComponent(room.roomKey)}`, {
      handshakeTimeout: 10_000,
    });
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket;
  setStatus("$(broadcast) devradar: bağlanıyor…", room.projectLabel);

  socket.on("open", () => {
    if (ws !== socket) return;
    selfName = identity.userName;
    socket.send(JSON.stringify({
      type: "hello",
      userId: identity.userId,
      userName: identity.userName,
      ide: "vscode",
      project: room.projectLabel,
    }));
    sendUpdateNow();
    heartbeatTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "heartbeat" }));
    }, 30_000);
    notifyChatPanelsOfConnection(true);
    render();
  });

  socket.on("message", (data: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg?.type === "presence" && Array.isArray(msg.users)) {
      users = msg.users;
      notifyChatPanelsOfPresence();
      render();
    } else if (msg?.type === "chat") {
      handleIncomingChat(msg);
    } else if (msg?.type === "chat-ack") {
      // Server confirmed delivery. The optimistic UI already displayed the
      // message; we forward the ack so the bubble can drop its "sending…" state.
      routeChatEventToPeer(msg.to, { type: "ack", id: msg.id, ts: msg.ts });
    } else if (msg?.type === "chat-error") {
      // Server rejected the send (recipient offline, rate-limited, etc.).
      // Route precisely to the panel whose peer matches msg.to; fall back to
      // every panel for older servers that omit the `to` field.
      if (typeof msg.to === "string") {
        routeChatEventToPeer(msg.to, { type: "error", id: msg.id, reason: msg.reason });
      } else {
        for (const panel of chatPanels.values()) {
          panel.webview.postMessage({ type: "error", id: msg.id, reason: msg.reason });
        }
      }
    } else if (msg?.type === "error") {
      vscode.window.showErrorMessage(`devradar: ${msg.message ?? "bilinmeyen hata"}`);
    }
  });

  socket.on("close", () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
    if (ws === socket) {
      ws = undefined;
      // Drop stale presence data so the QuickPick doesn't keep showing the
      // pre-disconnect "online" peers while the status bar says we're not connected.
      users = [];
      notifyChatPanelsOfConnection(false);
    }
    setStatus("$(circle-slash) devradar: bağlı değil", "Yeniden bağlanmayı deniyor…");
    scheduleReconnect();
  });

  socket.on("error", () => { /* "close" follows */ });
}

function closeSocket() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
  const s = ws;
  ws = undefined;
  if (s) { try { s.close(); } catch { /* ignore */ } }
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connect();
  }, 5_000);
}

function sendUpdateNow() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const { file, line } = currentFile();
  ws.send(JSON.stringify({ type: "update", file, line, project: currentRoom?.projectLabel }));
}

function scheduleUpdate() {
  if (updateDebounce) clearTimeout(updateDebounce);
  updateDebounce = setTimeout(() => {
    updateDebounce = undefined;
    sendUpdateNow();
  }, 1_500);
}

function formatLastSeen(ts: number | undefined): string {
  if (!ts || !Number.isFinite(ts)) return "uzun süre önce";
  const ageMs = Math.max(0, Date.now() - ts);
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return "az önce";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} dk önce`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} sa önce`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} gün önce`;
  if (day < 30) return `${Math.floor(day / 7)} hafta önce`;
  return "uzun süre önce";
}

function setStatus(text: string, tooltip: string | vscode.MarkdownString) {
  statusBar.text = text;
  statusBar.tooltip = tooltip;
  statusBar.show();
}

function render() {
  const online = users.filter((u) => u.status === "online");
  const others = online.filter((u) => u.userId !== selfId);
  const tip = new vscode.MarkdownString();
  tip.appendMarkdown(`**Repo:** ${currentRoom?.projectLabel ?? "?"}\n\n`);
  tip.appendMarkdown(
    others.length
      ? others.map((u) => `$(circle-filled) **${u.userName}** — ${u.ide}${u.file ? " · `" + u.file + "`" : ""}`).join("\n\n")
      : "_Şu an bu repoda tek başınasın._",
  );
  tip.supportThemeIcons = true;
  setStatus(`$(broadcast) devradar: ${online.length} online`, tip);
}

// --- chat ---

function handleIncomingChat(msg: {
  from: string;
  fromName: string;
  to: string;
  text: string;
  id: string;
  ts: number;
}) {
  // Pick the "conversation partner" relative to the local user.
  // If `from === selfId`, this is an echo of our own send arriving via another
  // of our sockets (a second IDE window), in which case the partner is `to`.
  const peerId = msg.from === selfId ? msg.to : msg.from;
  const peerName = msg.from === selfId ? userNameFor(msg.to) : msg.fromName;

  const panel = chatPanels.get(peerId);
  if (panel) {
    panel.webview.postMessage({
      type: "message",
      id: msg.id,
      from: msg.from,
      fromName: msg.fromName,
      text: msg.text,
      ts: msg.ts,
      self: msg.from === selfId,
    });
    return;
  }

  if (msg.from === selfId) return; // echo of own message, no panel — ignore

  // No open panel for this peer — surface a non-intrusive notification.
  vscode.window
    .showInformationMessage(
      `devradar: ${peerName} sana yazdı — "${truncate(msg.text, 80)}"`,
      "Aç",
      "Görmezden gel",
    )
    .then((choice) => {
      if (choice !== "Aç") return;
      const peer = users.find((u) => u.userId === peerId);
      const fallback: PresenceUser = peer ?? {
        userId: peerId,
        userName: peerName,
        ide: "?",
        project: "?",
        file: null,
        line: null,
        status: "online",
      };
      openChatWith(fallback);
      // Replay the missed message into the freshly opened panel.
      const p = chatPanels.get(peerId);
      p?.webview.postMessage({
        type: "message",
        id: msg.id,
        from: msg.from,
        fromName: msg.fromName,
        text: msg.text,
        ts: msg.ts,
        self: false,
      });
    });
}

function userNameFor(userId: string): string {
  return users.find((u) => u.userId === userId)?.userName ?? "?";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function routeChatEventToPeer(peerId: string, evt: unknown) {
  const panel = chatPanels.get(peerId);
  if (panel) panel.webview.postMessage(evt);
}

function notifyChatPanelsOfPresence() {
  for (const [peerId, panel] of chatPanels.entries()) {
    const peer = users.find((u) => u.userId === peerId);
    panel.webview.postMessage({
      type: "presence",
      online: peer?.status === "online",
      peerName: peer?.userName,
      lastSeen: peer?.lastSeen ?? null,
    });
  }
}

function notifyChatPanelsOfConnection(connected: boolean) {
  for (const panel of chatPanels.values()) {
    panel.webview.postMessage({ type: "connection", connected });
  }
}

function openChatWith(peer: PresenceUser) {
  const existing = chatPanels.get(peer.userId);
  if (existing) {
    existing.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "devradarChat",
    `💬 ${peer.userName}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = chatHtml(panel.webview, peer);

  panel.webview.onDidReceiveMessage((m: { type: string; text?: string; id?: string }) => {
    if (m.type === "send" && typeof m.text === "string" && typeof m.id === "string") {
      const text = m.text.slice(0, 4096);
      if (!text.trim()) return;
      if (ws?.readyState !== WebSocket.OPEN) {
        panel.webview.postMessage({ type: "error", id: m.id, reason: "disconnected" });
        return;
      }
      ws.send(JSON.stringify({ type: "chat", to: peer.userId, text, id: m.id }));
    }
  });

  panel.onDidDispose(() => {
    chatPanels.delete(peer.userId);
  });

  chatPanels.set(peer.userId, panel);

  // Push initial state.
  panel.webview.postMessage({
    type: "presence",
    online: peer.status === "online",
    peerName: peer.userName,
    lastSeen: peer.lastSeen ?? null,
  });
  panel.webview.postMessage({ type: "connection", connected: ws?.readyState === WebSocket.OPEN });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function chatHtml(webview: vscode.Webview, peer: PresenceUser): string {
  const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const csp = [
    `default-src 'none'`,
    `style-src 'unsafe-inline' ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
  ].join("; ");
  const peerNameSafe = escapeHtml(peer.userName);

  return /* html */ `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>devradar — ${peerNameSafe}</title>
<style>
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; height: 100vh; }
  header { padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 8px; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-red); }
  header.online .dot { background: var(--vscode-charts-green); }
  header .name { font-weight: 600; }
  header .status { color: var(--vscode-descriptionForeground); font-size: 12px; }
  #log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
  .msg { max-width: 75%; padding: 6px 10px; border-radius: 10px; word-wrap: break-word; white-space: pre-wrap; line-height: 1.35; }
  .msg.theirs { align-self: flex-start; background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); }
  .msg.mine { align-self: flex-end; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .msg.mine.sending { opacity: 0.6; }
  .msg.mine.failed { opacity: 0.6; border: 1px solid var(--vscode-errorForeground); }
  .meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .banner { padding: 6px 14px; font-size: 12px; background: var(--vscode-statusBarItem-warningBackground); color: var(--vscode-statusBarItem-warningForeground); }
  .banner.hidden { display: none; }
  footer { border-top: 1px solid var(--vscode-panel-border); padding: 8px 10px; display: flex; gap: 8px; }
  textarea { flex: 1; resize: none; min-height: 32px; max-height: 120px; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; font-family: inherit; font-size: inherit; }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  button { padding: 6px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; font: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
</head>
<body>
  <header id="header">
    <span class="dot"></span>
    <span class="name" id="peerName">${peerNameSafe}</span>
    <span class="status" id="statusText">offline</span>
  </header>
  <div class="banner hidden" id="banner"></div>
  <div id="log"></div>
  <footer>
    <textarea id="input" placeholder="Mesaj…" rows="1"></textarea>
    <button id="send">Gönder</button>
  </footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const header = document.getElementById('header');
  const statusText = document.getElementById('statusText');
  const banner = document.getElementById('banner');
  // Raw names (not HTML-escaped) — webview JS renders via textContent only.
  const peerName = ${JSON.stringify(peer.userName)};
  const selfName = ${JSON.stringify(selfName)};

  let online = ${peer.status === "online" ? "true" : "false"};
  let connected = false;
  let lastSeen = ${typeof peer.lastSeen === "number" ? String(peer.lastSeen) : "null"};
  const seen = new Set();

  function fmtLastSeen(ts) {
    if (!ts || !isFinite(ts)) return 'uzun süre önce';
    const ageMs = Math.max(0, Date.now() - ts);
    const sec = Math.floor(ageMs / 1000);
    if (sec < 60) return 'az önce';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + ' dk önce';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' sa önce';
    const day = Math.floor(hr / 24);
    if (day < 7) return day + ' gün önce';
    if (day < 30) return Math.floor(day / 7) + ' hafta önce';
    return 'uzun süre önce';
  }

  function refreshState() {
    header.classList.toggle('online', online);
    statusText.textContent = online ? 'online' : ('son görülme: ' + fmtLastSeen(lastSeen));
    let banText = '';
    if (!connected) banText = 'Sunucuya bağlı değilsin, mesaj gönderilemez.';
    else if (!online) banText = peerName + ' şu an offline — gönderdiğin mesaj ulaşmaz.';
    if (banText) { banner.textContent = banText; banner.classList.remove('hidden'); }
    else banner.classList.add('hidden');
    sendBtn.disabled = !(connected && online);
    input.disabled = sendBtn.disabled;
  }

  function fmtTs(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function appendMessage({ id, text, ts, self, fromName, sending }) {
    if (seen.has(id)) {
      // Update existing element (e.g. mark as sent)
      const existing = document.querySelector('[data-id="' + cssEscape(id) + '"]');
      if (existing) existing.classList.remove('sending', 'failed');
      return;
    }
    seen.add(id);
    const wrapper = document.createElement('div');
    wrapper.className = 'msg ' + (self ? 'mine' : 'theirs') + (sending ? ' sending' : '');
    wrapper.dataset.id = id;
    wrapper.textContent = text;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = (self ? selfName : fromName) + ' · ' + fmtTs(ts);
    wrapper.appendChild(meta);
    log.appendChild(wrapper);
    log.scrollTop = log.scrollHeight;
  }

  function cssEscape(s) { return s.replace(/[^a-zA-Z0-9_-]/g, ''); }

  function markStatus(id, status, reason) {
    const el = document.querySelector('[data-id="' + cssEscape(id) + '"]');
    if (!el) return;
    el.classList.remove('sending');
    if (status === 'failed') {
      el.classList.add('failed');
      const meta = el.querySelector('.meta');
      if (meta) meta.textContent += ' · ' + (reason === 'offline' ? 'alıcı offline' : reason === 'rate-limited' ? 'çok hızlı' : reason === 'disconnected' ? 'bağlı değil' : 'gönderilemedi');
    }
  }

  function genId() {
    return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  sendBtn.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  function doSend() {
    const text = input.value.trim();
    if (!text) return;
    if (sendBtn.disabled) return;
    const id = genId();
    appendMessage({ id, text, ts: Date.now(), self: true, fromName: selfName, sending: true });
    vscode.postMessage({ type: 'send', text, id });
    input.value = '';
    input.style.height = 'auto';
    input.focus();
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'presence') {
      online = !!m.online;
      if (m.lastSeen != null && typeof m.lastSeen === 'number') lastSeen = m.lastSeen;
      refreshState();
    } else if (m.type === 'connection') {
      connected = !!m.connected;
      refreshState();
    } else if (m.type === 'message') {
      appendMessage(m);
    } else if (m.type === 'ack') {
      markStatus(m.id, 'sent');
    } else if (m.type === 'error') {
      markStatus(m.id, 'failed', m.reason);
    }
  });

  refreshState();
  input.focus();
</script>
</body>
</html>`;
}

async function showPeers() {
  if (!currentRoom) {
    vscode.window.showInformationMessage("devradar: bu klasörün git remote'u yok, devradar çalışmıyor.");
    return;
  }
  if (!users.length) {
    vscode.window.showInformationMessage("devradar: henüz veri yok (bağlanılıyor olabilir).");
    return;
  }
  type Item = vscode.QuickPickItem & { user?: PresenceUser };
  const sorted = users
    .slice()
    .sort((a, b) =>
      a.status === b.status ? a.userName.localeCompare(b.userName) : a.status === "online" ? -1 : 1,
    );
  const items: Item[] = sorted.map((u) => ({
    user: u,
    label: `${u.status === "online" ? "$(circle-filled)" : "$(circle-outline)"} ${u.userName}${u.userId === selfId ? " (sen)" : ""}`,
    description:
      u.status === "online"
        ? `${u.ide}${u.file ? " · " + u.file : ""}`
        : `offline · son görülme: ${formatLastSeen(u.lastSeen)}`,
    detail: u.userId === selfId
      ? undefined
      : u.status === "online"
        ? "$(comment-discussion) Mesajlaş"
        : "$(comment-discussion) Sohbeti aç (offline)",
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: `devradar — ${currentRoom.projectLabel}`,
    placeHolder: "Birine tıkla → sohbet açılır",
  });
  if (pick?.user && pick.user.userId !== selfId) openChatWith(pick.user);
}

export function activate(context: vscode.ExtensionContext) {
  extCtx = context;
  stopped = false;
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "devradar.showPeers";
  setStatus("$(broadcast) devradar: başlatılıyor…", "");
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("devradar.showPeers", showPeers),
    vscode.commands.registerCommand("devradar.reconnect", () => {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
      void connect();
    }),
    vscode.commands.registerCommand("devradar.openChat", async (peerArg?: PresenceUser) => {
      if (peerArg && peerArg.userId) {
        openChatWith(peerArg);
        return;
      }
      // No argument → reuse showPeers to pick someone first.
      await showPeers();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => sendUpdateNow()),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor) scheduleUpdate();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void connect()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("devradar")) void connect();
    }),
  );

  void connect();
}

export function deactivate() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (updateDebounce) clearTimeout(updateDebounce);
  closeSocket();
}
