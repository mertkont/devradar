using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Shell;

namespace Devradar
{
    /// <summary>
    /// Tools → Options → devradar → General. Mirrors the VS Code and Rider
    /// settings: server URL, display-name override, and an optional team key.
    /// All three default to empty / the public devradar.workers.dev URL.
    /// </summary>
    [ComVisible(true)] // required by VS — DialogPage is instantiated via COM by the Options dialog
    [Guid(PackageGuids.DevradarOptionsPageString)]
    public class DevradarOptionsPage : DialogPage
    {
        [Category("Connection")]
        [DisplayName("Server URL")]
        [Description("devradar WebSocket server URL. Usually you don't need to change this.")]
        public string ServerUrl { get; set; } = DevradarService.DefaultServerUrl;

        [Category("Identity")]
        [DisplayName("Display name")]
        [Description("Override the name shown to teammates. If empty, your git user.name is used.")]
        public string DisplayName { get; set; } = string.Empty;

        [Category("Privacy")]
        [DisplayName("Team key (optional)")]
        [Description("Shared phrase mixed into the room key. If everyone in the same repo enters the same value, outsiders who know the repo URL cannot join the room.")]
        public string TeamKey { get; set; } = string.Empty;

        protected override void OnApply(PageApplyEventArgs e)
        {
            base.OnApply(e);
            // Settings changed → bounce the WS so the new server URL / team
            // key / display name take effect on the next hello.
            _ = DevradarService.Instance.RestartAsync();
        }
    }
}
