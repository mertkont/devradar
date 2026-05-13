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
let extCtx: vscode.ExtensionContext;

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
    socket = new WebSocket(`${serverUrl}?room=${encodeURIComponent(room.roomKey)}`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket;
  setStatus("$(broadcast) devradar: bağlanıyor…", room.projectLabel);

  socket.on("open", () => {
    if (ws !== socket) return;
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
    render();
  });

  socket.on("message", (data: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg?.type === "presence" && Array.isArray(msg.users)) {
      users = msg.users;
      render();
    } else if (msg?.type === "error") {
      vscode.window.showErrorMessage(`devradar: ${msg.message ?? "bilinmeyen hata"}`);
    }
  });

  socket.on("close", () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
    if (ws === socket) ws = undefined;
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

async function showPeers() {
  if (!currentRoom) {
    vscode.window.showInformationMessage("devradar: bu klasörün git remote'u yok, devradar çalışmıyor.");
    return;
  }
  if (!users.length) {
    vscode.window.showInformationMessage("devradar: henüz veri yok (bağlanılıyor olabilir).");
    return;
  }
  const items: vscode.QuickPickItem[] = users
    .slice()
    .sort((a, b) =>
      a.status === b.status ? a.userName.localeCompare(b.userName) : a.status === "online" ? -1 : 1,
    )
    .map((u) => ({
      label: `${u.status === "online" ? "$(circle-filled)" : "$(circle-outline)"} ${u.userName}${u.userId === selfId ? " (sen)" : ""}`,
      description:
        u.status === "online"
          ? `${u.ide}${u.file ? " · " + u.file : ""}`
          : `offline · son görülme: ${formatLastSeen(u.lastSeen)}`,
    }));
  await vscode.window.showQuickPick(items, {
    title: `devradar — ${currentRoom.projectLabel}`,
    placeHolder: "Bu repoda kim, nerede",
  });
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
