using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.Shell;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Devradar
{
    /// <summary>
    /// Process-wide singleton that owns the WebSocket connection to the
    /// devradar server, derives identity + room from `git config`, dispatches
    /// presence and chat events to UI subscribers, and serialises outgoing
    /// sends through a single async lock. Mirrors the VS Code / Rider clients.
    /// </summary>
    public sealed class DevradarService : IDisposable
    {
        public const string DefaultServerUrl = "wss://devradar.mrt-kntt53.workers.dev/ws";

        // 100-message in-memory chat buffer is replayed to new event listeners
        // (e.g. the tool window when first opened) so they don't miss what
        // arrived before they subscribed.
        private const int ChatBufferCap = 100;

        public static DevradarService Instance { get; } = new();

        private DevradarPackage? _package;
        private CancellationTokenSource? _cts;
        private ClientWebSocket? _ws;
        private int _generation;
        private readonly SemaphoreSlim _sendLock = new(1, 1);
        private readonly object _stateLock = new();
        private readonly Queue<ChatMessage> _chatBuffer = new();

        public IReadOnlyList<PeerInfo> Peers { get; private set; } = Array.Empty<PeerInfo>();
        public string SelfUserId { get; private set; } = string.Empty;
        public string SelfUserName { get; private set; } = "You";
        public string ProjectLabel { get; private set; } = "?";
        public bool NoRepo { get; private set; }
        public bool IsConnected => _ws?.State == WebSocketState.Open;

        public event Action? PresenceChanged;
        public event Action<ChatMessage>? ChatReceived;
        public event Action<string>? ChatAcked;            // clientId
        public event Action<string, string>? ChatFailed;   // clientId, reason
        public event Action<bool>? ConnectionChanged;

        public async Task StartAsync(DevradarPackage package)
        {
            _package = package;
            VS.Events.SolutionEvents.OnAfterOpenSolution += OnSolutionChanged;
            VS.Events.SolutionEvents.OnAfterCloseSolution += OnSolutionClosed;
            await ConnectAsync();
        }

        public async Task RestartAsync()
        {
            Disconnect("restart");
            await ConnectAsync();
        }

        private void OnSolutionChanged(Solution? solution) => _ = RestartAsync();
        private void OnSolutionClosed() => Disconnect("solution-closed");

        // ---------- Public surface for the UI ----------

        public IReadOnlyList<ChatMessage> SnapshotChatBuffer()
        {
            lock (_stateLock) return _chatBuffer.ToArray();
        }

        /// <summary>
        /// Send a chat message. Returns the generated clientId so the UI can
        /// match acks / errors back to the optimistic bubble. Returns null
        /// if the WS isn't currently open.
        /// </summary>
        public string? SendChat(string toUserId, string text)
        {
            var ws = _ws;
            if (ws is null || ws.State != WebSocketState.Open) return null;
            var id = "c_" + Guid.NewGuid().ToString("N").Substring(0, 16);
            var payload = new JObject
            {
                ["type"] = "chat",
                ["to"] = toUserId,
                ["text"] = text,
                ["id"] = id,
            };
            _ = SendJsonAsync(ws, payload);
            return id;
        }

        // ---------- Connection management ----------

        private async Task ConnectAsync()
        {
            var gen = Interlocked.Increment(ref _generation);
            try
            {
                var (cwd, ok) = await ResolveSolutionDirAsync();
                if (!ok || cwd is null)
                {
                    NoRepo = true;
                    Peers = Array.Empty<PeerInfo>();
                    PresenceChanged?.Invoke();
                    return;
                }

                var remote = await GitConfigAsync(cwd, "--get", "remote.origin.url");
                if (string.IsNullOrWhiteSpace(remote))
                {
                    NoRepo = true;
                    Peers = Array.Empty<PeerInfo>();
                    PresenceChanged?.Invoke();
                    return;
                }
                NoRepo = false;

                var options = await GetOptionsAsync();
                var repo = NormalizeRemote(remote!);
                ProjectLabel = repo;
                var teamKey = options.TeamKey ?? string.Empty;
                var roomBase = string.IsNullOrEmpty(teamKey) ? repo : (repo + "|" + teamKey);
                var roomKey = "repo:" + Sha256Short(roomBase);

                var email = (await GitConfigAsync(cwd, "user.email"))?.Trim().ToLowerInvariant();
                SelfUserId = !string.IsNullOrWhiteSpace(email)
                    ? "e:" + Sha256Short(email!)
                    : "x:" + Sha256Short(Environment.UserName + "@" + cwd);

                var nameFromGit = (await GitConfigAsync(cwd, "user.name"))?.Trim();
                SelfUserName = !string.IsNullOrWhiteSpace(options.DisplayName)
                    ? options.DisplayName!.Trim()
                    : (!string.IsNullOrWhiteSpace(nameFromGit) ? nameFromGit! : (Environment.UserName ?? "anon"));

                var serverUrl = string.IsNullOrWhiteSpace(options.ServerUrl) ? DefaultServerUrl : options.ServerUrl!.Trim();
                var uri = new Uri(serverUrl + "?room=" + Uri.EscapeDataString(roomKey));

                var cts = new CancellationTokenSource();
                var ws = new ClientWebSocket();
                ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);

                try
                {
                    using var connectCts = CancellationTokenSource.CreateLinkedTokenSource(cts.Token);
                    connectCts.CancelAfter(TimeSpan.FromSeconds(15));
                    await ws.ConnectAsync(uri, connectCts.Token);
                }
                catch
                {
                    cts.Dispose();
                    ws.Dispose();
                    ScheduleReconnect(gen);
                    return;
                }

                if (Interlocked.CompareExchange(ref _generation, gen, gen) != gen)
                {
                    try { ws.Abort(); } catch { }
                    cts.Dispose();
                    ws.Dispose();
                    return;
                }
                _ws = ws;
                _cts = cts;

                await SendJsonAsync(ws, new JObject
                {
                    ["type"] = "hello",
                    ["userId"] = SelfUserId,
                    ["userName"] = SelfUserName,
                    ["ide"] = "vs",
                    ["project"] = ProjectLabel,
                });
                ConnectionChanged?.Invoke(true);

                _ = ReceiveLoopAsync(ws, cts.Token, gen);
                _ = HeartbeatLoopAsync(ws, cts.Token, gen);
            }
            catch
            {
                ScheduleReconnect(gen);
            }
        }

        private void Disconnect(string reason)
        {
            try { _cts?.Cancel(); } catch { }
            var ws = _ws;
            _ws = null;
            try { ws?.Abort(); } catch { }
            try { ws?.Dispose(); } catch { }
            Peers = Array.Empty<PeerInfo>();
            PresenceChanged?.Invoke();
            ConnectionChanged?.Invoke(false);
        }

        private void ScheduleReconnect(int gen)
        {
            ConnectionChanged?.Invoke(false);
            _ = Task.Run(async () =>
            {
                await Task.Delay(TimeSpan.FromSeconds(5));
                if (Volatile.Read(ref _generation) != gen) return;
                await ConnectAsync();
            });
        }

        private async Task ReceiveLoopAsync(ClientWebSocket ws, CancellationToken ct, int gen)
        {
            var buffer = new byte[8192];
            var sb = new StringBuilder();
            try
            {
                while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
                {
                    var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "ack-close", CancellationToken.None); } catch { }
                        break;
                    }
                    sb.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                    if (result.EndOfMessage)
                    {
                        var text = sb.ToString();
                        sb.Clear();
                        try { HandleMessage(text); } catch { /* ignore parse errors */ }
                    }
                }
            }
            catch
            {
                // Connection dropped — let scheduleReconnect take over.
            }
            finally
            {
                if (Volatile.Read(ref _generation) == gen)
                {
                    _ws = null;
                    Peers = Array.Empty<PeerInfo>();
                    PresenceChanged?.Invoke();
                    ConnectionChanged?.Invoke(false);
                    ScheduleReconnect(gen);
                }
            }
        }

        private async Task HeartbeatLoopAsync(ClientWebSocket ws, CancellationToken ct, int gen)
        {
            try
            {
                while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
                {
                    await Task.Delay(TimeSpan.FromSeconds(30), ct).ConfigureAwait(false);
                    if (ct.IsCancellationRequested || ws.State != WebSocketState.Open) break;
                    await SendJsonAsync(ws, new JObject { ["type"] = "heartbeat" });
                }
            }
            catch { /* cancellation or socket closed */ }
        }

        private async Task SendJsonAsync(ClientWebSocket ws, JObject payload)
        {
            await _sendLock.WaitAsync().ConfigureAwait(false);
            try
            {
                if (ws.State != WebSocketState.Open) return;
                var json = payload.ToString(Formatting.None);
                var bytes = Encoding.UTF8.GetBytes(json);
                await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None).ConfigureAwait(false);
            }
            catch { /* socket may be closing */ }
            finally { _sendLock.Release(); }
        }

        // ---------- Inbound message handling ----------

        private void HandleMessage(string text)
        {
            JObject obj;
            try { obj = JObject.Parse(text); }
            catch { return; }
            var type = (string?)obj["type"];
            switch (type)
            {
                case "presence":
                    HandlePresence(obj);
                    break;
                case "chat":
                    HandleChat(obj);
                    break;
                case "chat-ack":
                    {
                        var id = (string?)obj["id"];
                        if (!string.IsNullOrEmpty(id)) ChatAcked?.Invoke(id!);
                    }
                    break;
                case "chat-error":
                    {
                        var id = (string?)obj["id"];
                        var reason = (string?)obj["reason"] ?? "unknown";
                        if (!string.IsNullOrEmpty(id)) ChatFailed?.Invoke(id!, reason);
                    }
                    break;
            }
        }

        private void HandlePresence(JObject obj)
        {
            var arr = obj["users"] as JArray;
            if (arr is null) return;
            var list = new List<PeerInfo>(arr.Count);
            foreach (var t in arr)
            {
                if (t is not JObject u) continue;
                list.Add(new PeerInfo(
                    UserId: (string?)u["userId"] ?? string.Empty,
                    UserName: (string?)u["userName"] ?? "?",
                    Ide: (string?)u["ide"] ?? "?",
                    Project: (string?)u["project"] ?? "?",
                    File: (string?)u["file"],
                    Line: (int?)u["line"],
                    Status: (string?)u["status"] ?? "offline",
                    LastSeen: (long?)u["lastSeen"]));
            }
            Peers = list;
            PresenceChanged?.Invoke();
        }

        private void HandleChat(JObject obj)
        {
            var msg = new ChatMessage(
                id: (string?)obj["id"] ?? string.Empty,
                from: (string?)obj["from"] ?? string.Empty,
                fromName: (string?)obj["fromName"] ?? "?",
                to: (string?)obj["to"] ?? string.Empty,
                text: (string?)obj["text"] ?? string.Empty,
                ts: (long?)obj["ts"] ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                self: ((string?)obj["from"]) == SelfUserId);
            if (string.IsNullOrEmpty(msg.Id) || string.IsNullOrEmpty(msg.From)) return;
            lock (_stateLock)
            {
                _chatBuffer.Enqueue(msg);
                while (_chatBuffer.Count > ChatBufferCap) _chatBuffer.Dequeue();
            }
            ChatReceived?.Invoke(msg);
        }

        // ---------- Solution path / git helpers ----------

        private static async Task<(string? cwd, bool ok)> ResolveSolutionDirAsync()
        {
            try
            {
                var solution = await VS.Solutions.GetCurrentSolutionAsync();
                var path = solution?.FullPath;
                if (string.IsNullOrEmpty(path)) return (null, false);
                var dir = Path.GetDirectoryName(path);
                return (dir, !string.IsNullOrEmpty(dir));
            }
            catch
            {
                return (null, false);
            }
        }

        private static async Task<string?> GitConfigAsync(string cwd, params string[] args)
        {
            // We're on .NET Framework 4.8 (VSIX requirement) which doesn't
            // have ProcessStartInfo.ArgumentList — fall back to the single
            // Arguments string. Our args are always known-safe flags like
            // "--get" and config keys, so a simple space-join is fine.
            try
            {
                var psi = new ProcessStartInfo("git", "config " + string.Join(" ", args))
                {
                    WorkingDirectory = cwd,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                using var p = Process.Start(psi);
                if (p is null) return null;
                var stdout = await p.StandardOutput.ReadToEndAsync().ConfigureAwait(false);
                if (!p.WaitForExit(3000)) { try { p.Kill(); } catch { } return null; }
                var trimmed = stdout.Trim();
                return string.IsNullOrEmpty(trimmed) ? null : trimmed;
            }
            catch
            {
                return null;
            }
        }

        // "git@github.com:owner/repo.git" / "https://github.com/owner/repo" → "github.com/owner/repo"
        private static string NormalizeRemote(string url)
        {
            var s = url.Trim();
            if (s.EndsWith(".git", StringComparison.OrdinalIgnoreCase)) s = s.Substring(0, s.Length - 4);
            var scp = Regex.Match(s, @"^[^@\s]+@([^:\s]+):(.+)$");
            if (scp.Success) return (scp.Groups[1].Value + "/" + scp.Groups[2].Value).ToLowerInvariant();
            var m = Regex.Match(s, @"^[a-zA-Z][a-zA-Z0-9+.\-]*://(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?/(.+)$");
            if (m.Success) return (m.Groups[1].Value + "/" + m.Groups[2].Value).ToLowerInvariant();
            return s.ToLowerInvariant();
        }

        private static string Sha256Short(string s)
        {
            using var sha = SHA256.Create();
            var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(s));
            var sb = new StringBuilder(64);
            foreach (var b in bytes) sb.Append(b.ToString("x2"));
            return sb.ToString().Substring(0, 16);
        }

        // ---------- Options helper ----------

        private async Task<DevradarOptionsPage> GetOptionsAsync()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            return (DevradarOptionsPage)_package!.GetDialogPage(typeof(DevradarOptionsPage));
        }

        public void Dispose()
        {
            Disconnect("dispose");
            _sendLock.Dispose();
            VS.Events.SolutionEvents.OnAfterOpenSolution -= OnSolutionChanged;
            VS.Events.SolutionEvents.OnAfterCloseSolution -= OnSolutionClosed;
        }
    }

    public sealed record PeerInfo(
        string UserId,
        string UserName,
        string Ide,
        string Project,
        string? File,
        int? Line,
        string Status,
        long? LastSeen)
    {
        public bool IsOnline => Status == "online";
    }

    public sealed record ChatMessage(
        string Id,
        string From,
        string FromName,
        string To,
        string Text,
        long Ts,
        bool Self);

    public static class LastSeenFormatter
    {
        public static string Format(long? ts)
        {
            if (ts is null or <= 0) return "a long time ago";
            var age = Math.Max(0, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - ts.Value);
            var sec = age / 1000;
            if (sec < 60) return "just now";
            var min = sec / 60;
            if (min < 60) return min + " min ago";
            var hr = min / 60;
            if (hr < 24) return hr + " h ago";
            var day = hr / 24;
            if (day < 7) return day + " d ago";
            if (day < 30) return (day / 7) + " w ago";
            return "a long time ago";
        }
    }
}
