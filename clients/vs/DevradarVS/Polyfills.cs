// .NET Framework 4.8 (the VSIX target framework) ships with C# 9 / 10 / 11
// syntax via the Roslyn compiler, but is missing a handful of runtime types
// that those language features hook into. The fix is to provide tiny
// internal shims so the compiler emits valid IL that the framework can run.

namespace System.Runtime.CompilerServices
{
    // Required by C# 9's `init`-only setters, which are auto-generated for every
    // positional `record` member (see PeerInfo, ChatMessage). Without this
    // shim, the compiler emits CS0518: "Predefined type
    // 'System.Runtime.CompilerServices.IsExternalInit' is not defined or imported".
    internal static class IsExternalInit { }
}
