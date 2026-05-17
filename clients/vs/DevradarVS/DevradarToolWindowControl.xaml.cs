using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace Devradar
{
    /// <summary>
    /// The WPF UI for the devradar tool window. Top half = peers list (live
    /// from DevradarService), bottom half = chat with the currently selected
    /// peer. Service callbacks come in on a background thread; everything
    /// here marshals to the Dispatcher before touching WPF.
    /// </summary>
    public partial class DevradarToolWindowControl : UserControl
    {
        private readonly ObservableCollection<PeerVm> _peers = new();
        private readonly Dictionary<string, List<UiMessage>> _conversations = new(StringComparer.Ordinal);
        private string? _selectedPeerId;
        private bool _disposed;

        public DevradarToolWindowControl()
        {
            InitializeComponent();
            PeersList.ItemsSource = _peers;

            var svc = DevradarService.Instance;
            svc.PresenceChanged += OnPresenceChanged;
            svc.ChatReceived += OnChatReceived;
            svc.ChatAcked += OnChatAcked;
            svc.ChatFailed += OnChatFailed;
            svc.ConnectionChanged += OnConnectionChanged;

            Unloaded += OnUnloaded;

            // Replay anything that was already in the buffer before we attached.
            foreach (var m in svc.SnapshotChatBuffer())
            {
                RememberMessage(m, fromBuffer: true);
            }
            RefreshPresence();
            RefreshConnection(svc.IsConnected);
        }

        private void OnUnloaded(object sender, RoutedEventArgs e)
        {
            if (_disposed) return;
            _disposed = true;
            var svc = DevradarService.Instance;
            svc.PresenceChanged -= OnPresenceChanged;
            svc.ChatReceived -= OnChatReceived;
            svc.ChatAcked -= OnChatAcked;
            svc.ChatFailed -= OnChatFailed;
            svc.ConnectionChanged -= OnConnectionChanged;
        }

        // ---------- Event handlers from the service (background thread) ----------

        private void OnPresenceChanged() => Dispatcher.BeginInvoke(new Action(RefreshPresence));
        private void OnChatReceived(ChatMessage msg) => Dispatcher.BeginInvoke(new Action(() => { RememberMessage(msg, fromBuffer: false); if (msg.From == _selectedPeerId || (msg.Self && msg.To == _selectedPeerId)) RenderTranscript(); }));
        private void OnChatAcked(string id) => Dispatcher.BeginInvoke(new Action(() => MarkMessageState(id, sending: false, failed: null)));
        private void OnChatFailed(string id, string reason) => Dispatcher.BeginInvoke(new Action(() => MarkMessageState(id, sending: false, failed: ReasonHuman(reason))));
        private void OnConnectionChanged(bool connected) => Dispatcher.BeginInvoke(new Action(() => RefreshConnection(connected)));

        // ---------- UI refreshes ----------

        private void RefreshPresence()
        {
            var svc = DevradarService.Instance;
            var ourId = svc.SelfUserId;
            var ordered = svc.Peers
                .Where(p => !string.IsNullOrEmpty(p.UserId))
                .OrderByDescending(p => p.IsOnline)
                .ThenBy(p => p.UserName, StringComparer.OrdinalIgnoreCase)
                .ToList();

            // Preserve current selection if still present.
            var prevSelected = _selectedPeerId;

            _peers.Clear();
            foreach (var p in ordered)
            {
                _peers.Add(new PeerVm
                {
                    UserId = p.UserId,
                    UserName = p.UserName + (p.UserId == ourId ? " (you)" : string.Empty),
                    IsOnline = p.IsOnline,
                    StatusBrush = p.IsOnline ? Brushes.LimeGreen : Brushes.Gray,
                    SubLine = p.IsOnline
                        ? p.Ide + (string.IsNullOrEmpty(p.File) ? string.Empty : " · " + p.File)
                        : "offline · last seen " + LastSeenFormatter.Format(p.LastSeen),
                    RightHint = p.UserId == ourId ? string.Empty : (p.IsOnline ? "💬 chat" : "💬 chat (offline)"),
                    IsSelf = p.UserId == ourId,
                });
            }

            HeaderText.Text = svc.NoRepo
                ? "devradar — no git repo in this solution"
                : $"devradar — {svc.Peers.Count(p => p.IsOnline)} online · {svc.ProjectLabel}";

            if (prevSelected != null)
            {
                var match = _peers.FirstOrDefault(v => v.UserId == prevSelected);
                if (match != null) PeersList.SelectedItem = match;
            }

            UpdateChatHeader();
        }

        private void RefreshConnection(bool connected)
        {
            UpdateBannerAndInputState();
        }

        private void UpdateChatHeader()
        {
            var peer = CurrentPeerVm();
            if (peer is null || peer.IsSelf)
            {
                ChatHeaderText.Text = "Pick someone above to chat";
                ChatStatusText.Text = string.Empty;
                Transcript.Text = string.Empty;
            }
            else
            {
                ChatHeaderText.Text = "Chat with " + peer.UserName;
                if (peer.IsOnline)
                {
                    ChatStatusText.Text = "● online";
                    ChatStatusText.Foreground = Brushes.SeaGreen;
                }
                else
                {
                    var lastSeen = DevradarService.Instance.Peers.FirstOrDefault(p => p.UserId == peer.UserId)?.LastSeen;
                    ChatStatusText.Text = "○ last seen " + LastSeenFormatter.Format(lastSeen);
                    ChatStatusText.Foreground = Brushes.Gray;
                }
                RenderTranscript();
            }
            UpdateBannerAndInputState();
        }

        private void UpdateBannerAndInputState()
        {
            var peer = CurrentPeerVm();
            var svc = DevradarService.Instance;
            string? banText = null;
            if (!svc.IsConnected) banText = "You're not connected, messages can't be sent.";
            else if (peer != null && !peer.IsSelf && !peer.IsOnline)
                banText = peer.UserName + " is offline — your message won't be delivered.";

            if (banText != null)
            {
                BannerText.Text = "⚠  " + banText;
                Banner.Visibility = Visibility.Visible;
            }
            else
            {
                Banner.Visibility = Visibility.Collapsed;
            }

            var ready = svc.IsConnected && peer != null && !peer.IsSelf && peer.IsOnline;
            InputField.IsEnabled = ready;
            SendButton.IsEnabled = ready;
        }

        // ---------- Conversation state ----------

        private void RememberMessage(ChatMessage msg, bool fromBuffer)
        {
            var peerId = msg.Self ? msg.To : msg.From;
            if (string.IsNullOrEmpty(peerId)) return;
            if (!_conversations.TryGetValue(peerId, out var list))
            {
                list = new List<UiMessage>();
                _conversations[peerId] = list;
            }
            var existing = list.FirstOrDefault(m => m.Id == msg.Id);
            if (existing != null)
            {
                existing.Sending = false;
                existing.Failed = null;
            }
            else
            {
                list.Add(new UiMessage
                {
                    Id = msg.Id,
                    Text = msg.Text,
                    Ts = msg.Ts,
                    Self = msg.Self,
                    FromName = msg.FromName,
                    Sending = false,
                    Failed = null,
                });
            }
        }

        private void MarkMessageState(string id, bool sending, string? failed)
        {
            foreach (var kv in _conversations)
            {
                var hit = kv.Value.FirstOrDefault(m => m.Id == id);
                if (hit != null)
                {
                    hit.Sending = sending;
                    hit.Failed = failed;
                    if (kv.Key == _selectedPeerId) RenderTranscript();
                    return;
                }
            }
        }

        private void RenderTranscript()
        {
            if (_selectedPeerId is null)
            {
                Transcript.Text = string.Empty;
                return;
            }
            if (!_conversations.TryGetValue(_selectedPeerId, out var list))
            {
                Transcript.Text = string.Empty;
                return;
            }
            var sb = new StringBuilder();
            foreach (var m in list)
            {
                var time = DateTimeOffset.FromUnixTimeMilliseconds(m.Ts).LocalDateTime.ToString("HH:mm");
                var name = m.Self ? "You" : m.FromName;
                sb.Append('[').Append(time).Append("]  ").Append(name).Append(": ").Append(m.Text);
                if (m.Failed != null) sb.Append("   ⚠ ").Append(m.Failed);
                else if (m.Sending) sb.Append("   …");
                sb.Append('\n');
            }
            Transcript.Text = sb.ToString();
            Transcript.CaretIndex = Transcript.Text.Length;
            TranscriptScroll.ScrollToEnd();
        }

        private PeerVm? CurrentPeerVm() => PeersList.SelectedItem as PeerVm;

        private static string ReasonHuman(string reason) => reason switch
        {
            "offline" => "recipient offline",
            "rate-limited" => "too fast",
            "disconnected" => "not connected",
            _ => "send failed",
        };

        // ---------- WPF event handlers ----------

        private void OnPeerSelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            _selectedPeerId = CurrentPeerVm()?.UserId;
            UpdateChatHeader();
        }

        private void OnReconnectClicked(object sender, RoutedEventArgs e)
        {
            _ = DevradarService.Instance.RestartAsync();
        }

        private void OnSendClicked(object sender, RoutedEventArgs e) => DoSend();

        private void OnInputKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key == Key.Enter && (Keyboard.Modifiers & ModifierKeys.Shift) == 0)
            {
                e.Handled = true;
                DoSend();
            }
        }

        private void DoSend()
        {
            var peer = CurrentPeerVm();
            if (peer is null || peer.IsSelf || !peer.IsOnline) return;
            var text = InputField.Text.Trim();
            if (string.IsNullOrEmpty(text)) return;

            var id = DevradarService.Instance.SendChat(peer.UserId, text);
            if (id is null) return;

            if (!_conversations.TryGetValue(peer.UserId, out var list))
            {
                list = new List<UiMessage>();
                _conversations[peer.UserId] = list;
            }
            list.Add(new UiMessage
            {
                Id = id,
                Text = text,
                Ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                Self = true,
                FromName = DevradarService.Instance.SelfUserName,
                Sending = true,
                Failed = null,
            });

            InputField.Clear();
            RenderTranscript();
            InputField.Focus();
        }

        // ---------- View model rows ----------

        // We rebuild the ObservableCollection on every presence refresh rather
        // than mutating individual rows, so PropertyChanged plumbing isn't
        // needed (which is why this isn't INotifyPropertyChanged).
        private sealed class PeerVm
        {
            public string UserId { get; set; } = string.Empty;
            public string UserName { get; set; } = string.Empty;
            public string SubLine { get; set; } = string.Empty;
            public string RightHint { get; set; } = string.Empty;
            public bool IsOnline { get; set; }
            public bool IsSelf { get; set; }
            public Brush StatusBrush { get; set; } = Brushes.Gray;
        }

        private sealed class UiMessage
        {
            public string Id { get; set; } = string.Empty;
            public string Text { get; set; } = string.Empty;
            public long Ts { get; set; }
            public bool Self { get; set; }
            public string FromName { get; set; } = string.Empty;
            public bool Sending { get; set; }
            public string? Failed { get; set; }
        }
    }
}
