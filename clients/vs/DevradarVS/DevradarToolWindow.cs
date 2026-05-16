using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Shell;

namespace Devradar
{
    /// <summary>
    /// Visual Studio tool window host. Surfaces under
    /// View → Other Windows → devradar. The actual UI is the WPF
    /// DevradarToolWindowControl set as Content.
    /// </summary>
    [Guid(PackageGuids.DevradarToolWindowString)]
    public class DevradarToolWindow : ToolWindowPane
    {
        public DevradarToolWindow() : base(null)
        {
            Caption = "devradar";
            Content = new DevradarToolWindowControl();
        }
    }
}
