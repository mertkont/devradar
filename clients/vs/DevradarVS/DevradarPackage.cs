using System;
using System.Runtime.InteropServices;
using System.Threading;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.Shell;
using Task = System.Threading.Tasks.Task;

namespace Devradar
{
    /// <summary>
    /// Visual Studio extension entrypoint. Registers a single tool window
    /// (peers list + chat in one panel) and an options page. The actual
    /// WebSocket connection / presence tracking lives in DevradarService.
    /// </summary>
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    // Auto-load the package whenever a solution is open. Without this,
    // the package only loads when the user manually opens the tool window
    // — meaning presence wouldn't run in the background and teammates
    // wouldn't see them online until they opened the chat. This brings
    // VS in line with the VS Code extension (activates on startup) and
    // the JetBrains plugin (ProjectActivity on project open).
    //
    // Hardcoded GUID is `vsContextGuidSolutionExists` — the same value
    // UIContextGuids80.SolutionExists / VSConstants.UICONTEXT.SolutionExists_string
    // expand to. Using the literal avoids importing the right namespace
    // (depends on which Microsoft.VisualStudio.* assembly is available).
    [ProvideAutoLoad("f1536ef8-92ec-443c-9ed7-fdadf150da82", PackageAutoLoadFlags.BackgroundLoad)]
    [ProvideToolWindow(typeof(DevradarToolWindow), Style = VsDockStyle.Tabbed, Window = "3ae79031-e1bc-11d0-8f78-00a0c9110057")] // Solution Explorer guid as a sane dock target
    [ProvideOptionPage(typeof(DevradarOptionsPage), "devradar", "General", 0, 0, true)]
    [Guid(PackageGuids.DevradarPackageString)]
    public sealed class DevradarPackage : ToolkitPackage
    {
        protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
        {
            // The tool window is registered via [ProvideToolWindow]; Visual
            // Studio surfaces it under View → Other Windows → devradar.
            this.RegisterToolWindows();

            // Kick off presence WS asynchronously so the IDE doesn't block on
            // startup if the network is slow.
            await DevradarService.Instance.StartAsync(this);
        }

        protected override void Dispose(bool disposing)
        {
            try { DevradarService.Instance.Dispose(); } catch { /* ignore */ }
            base.Dispose(disposing);
        }
    }

    internal static class PackageGuids
    {
        public const string DevradarPackageString = "b9d4a6c8-7e0f-4f8d-9a3a-2c1f8d5e2f9a";
        public const string DevradarToolWindowString = "c9d4a6c8-7e0f-4f8d-9a3a-2c1f8d5e2f9b";
        public const string DevradarOptionsPageString = "d9d4a6c8-7e0f-4f8d-9a3a-2c1f8d5e2f9c";

        public static readonly Guid DevradarToolWindow = new(DevradarToolWindowString);
    }
}
