import * as vscode from "vscode";
import * as os from "node:os";
import { WebSocket } from "ws";

type PresenceUser = {
  userId: string;
  userName: string;
  ide: string;
  project: string;
  file: string | null;
  line: number | null;
  status: "online" | "offline";
};

let ws: WebSocket | undefined;
let statusBar: vscode.StatusBarItem;
let users: PresenceUser[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let updateDebounce: ReturnType<typeof setTimeout> | undefined;
let stopped = false;

const SELF_ID = `${os.hostname()}::${os.userInfo().username}`;

function getConfig() {
  const c = vscode.workspace.getConfiguration("devradar");
  return {
    serverUrl: (c.get<string>("serverUrl") ?? "").trim(),
    sharedToken: (c.get<string>("sharedToken") ?? "").trim(),
    userName: (c.get<string>("userName") ?? "").trim() || os.userInfo().username || "anon",
  };
}

function currentProject(): string {
  return vscode.workspace.workspaceFolders?.[0]?.name ?? "(no folder)";
}

function currentFile(): { file: string | null; line: number | null } {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== "file") return { file: null, line: null };
  return { file: vscode.workspace.asRelativePath(ed.document.uri, false), line: ed.selection.active.line + 1 };
}

function connect() {
  if (stopped) return;
  const { serverUrl, sharedToken, userName } = getConfig();
  if (!serverUrl) {
    statusBar.text = "$(warning) devradar: sunucu adresi yok";
    statusBar.tooltip = "Ayarlar → devradar.serverUrl";
    return;
  }
  if (!sharedToken) {
    statusBar.text = "$(warning) devradar: token yok";
    statusBar.tooltip = "Ayarlar → devradar.sharedToken (Cloudflare'deki SHARED_TOKEN ile aynı olmalı)";
    return;
  }

  let socket: WebSocket;
  try {
    socket = new WebSocket(serverUrl);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.on("open", () => {
    if (ws !== socket) return;
    socket.send(JSON.stringify({
      type: "hello",
      token: sharedToken,
      userId: SELF_ID,
      userName,
      ide: "vscode",
      project: currentProject(),
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
    statusBar.text = "$(circle-slash) devradar: bağlı değil";
    statusBar.tooltip = "Yeniden bağlanmayı deniyor…";
    scheduleReconnect();
  });

  socket.on("error", () => { /* "close" follows */ });
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, 5_000);
}

function sendUpdateNow() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const { file, line } = currentFile();
  ws.send(JSON.stringify({ type: "update", file, line, project: currentProject() }));
}

function scheduleUpdate() {
  if (updateDebounce) clearTimeout(updateDebounce);
  updateDebounce = setTimeout(() => {
    updateDebounce = undefined;
    sendUpdateNow();
  }, 1_500);
}

function render() {
  const online = users.filter((u) => u.status === "online");
  const others = online.filter((u) => u.userId !== SELF_ID);
  statusBar.text = `$(broadcast) devradar: ${online.length} online`;
  statusBar.tooltip = others.length
    ? new vscode.MarkdownString(others.map((u) => `**${u.userName}** — ${u.ide}${u.file ? " · `" + u.file + "`" : ""}`).join("\n\n"))
    : "Şu an tek başınasın";
  statusBar.show();
}

async function showPeers() {
  if (!users.length) {
    vscode.window.showInformationMessage("devradar: henüz veri yok (bağlanılıyor olabilir)");
    return;
  }
  const items: vscode.QuickPickItem[] = users
    .slice()
    .sort((a, b) =>
      a.status === b.status ? a.userName.localeCompare(b.userName) : a.status === "online" ? -1 : 1,
    )
    .map((u) => ({
      label: `${u.status === "online" ? "$(circle-filled)" : "$(circle-outline)"} ${u.userName}${u.userId === SELF_ID ? " (sen)" : ""}`,
      description: u.status === "online" ? `${u.ide}${u.file ? " · " + u.file : ""}` : "offline",
      detail: `proje: ${u.project}`,
    }));
  await vscode.window.showQuickPick(items, { title: "devradar — takım", placeHolder: "Kim nerede" });
}

export function activate(context: vscode.ExtensionContext) {
  stopped = false;
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "devradar.showPeers";
  statusBar.text = "$(broadcast) devradar: bağlanıyor…";
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("devradar.showPeers", showPeers),
    vscode.commands.registerCommand("devradar.reconnect", () => {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
      try { ws?.close(); } catch { /* ignore */ }
      connect();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => sendUpdateNow()),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor) scheduleUpdate();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("devradar")) {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
        try { ws?.close(); } catch { /* ignore */ }
        connect();
      }
    }),
  );

  connect();
}

export function deactivate() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (updateDebounce) clearTimeout(updateDebounce);
  try { ws?.close(); } catch { /* ignore */ }
}
