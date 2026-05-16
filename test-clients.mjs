import { WebSocket } from "ws";

// wrangler dev listens on http://localhost:8787 by default
const BASE = process.env.DEVRADAR_URL ?? "ws://localhost:8787/ws";
const ROOM = process.env.DEVRADAR_ROOM ?? "test-room";
const URL = `${BASE}?room=${encodeURIComponent(ROOM)}`;

function makeClient(userId, userName, ide, project) {
  const ws = new WebSocket(URL);
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", userId, userName, ide, project }));
  });
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "presence") {
      const summary = msg.users
        .map((u) => `${u.userName}[${u.status}${u.file ? " " + u.file : ""}]`)
        .join(", ");
      console.log(`[${userName}] presence:`, summary);
    } else {
      console.log(`[${userName}]`, msg);
    }
  });
  ws.on("close", () => console.log(`[${userName}] disconnected`));
  ws.on("error", (e) => console.log(`[${userName}] error:`, e.message));
  return ws;
}

const a = makeClient("u1", "Mert", "vscode", "azure-proj");
const b = makeClient("u2", "Ayse", "rider", "azure-proj");

setTimeout(() => {
  console.log("\n--- Mert opens index.ts ---");
  a.send(JSON.stringify({ type: "update", file: "src/index.ts", line: 42 }));
}, 700);

setTimeout(() => {
  console.log("\n--- Ayse opens Program.cs ---");
  b.send(JSON.stringify({ type: "update", file: "Program.cs", line: 10 }));
}, 1200);

setTimeout(() => {
  console.log("\n--- Mert disconnects ---");
  a.close();
}, 1800);

setTimeout(() => {
  console.log("\n--- Done ---");
  b.close();
  process.exit(0);
}, 2800);
