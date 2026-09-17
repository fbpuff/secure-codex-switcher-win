// Metadata only. This observer never activates a window or consumes input.
export function normalizeContinuationFocusDiagnostics(value) {
  const result = {};
  if (["focus_snapshot", "foreground_sample", "mouse_down", "observer_started", "observer_stopped", "observer_unavailable", "window_binding"].includes(value?.diagnosticKind)) result.diagnosticKind = value.diagnosticKind;
  if (["rebound", "unchanged", "evidence_error", "composer_changed", "prompt_changed", "process_mismatch", "composer_unavailable", "foreground_unstable", "root_mismatch", "submit_mismatch"].includes(value?.bindingReason)) result.bindingReason = value.bindingReason;
  if (["before_activate", "after_activate", "after_focus", "before_submit", "before_fallback", "finished"].includes(value?.checkpoint)) result.checkpoint = value.checkpoint;
  for (const key of ["targetHandle", "foregroundHandle", "targetPid", "foregroundPid", "focusedPid", "clickHandle", "clickPid", "sequence", "elapsedMs", "dropped", "nativeError", "scannedHandle", "scannedRoot", "scannedOwner", "scannedParent", "foregroundRoot", "foregroundOwner", "composerRoot", "composerNative", "submitRoot"]) {
    if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) result[key] = value[key];
  }
  if (Number.isSafeInteger(value?.ancestorDepth) && value.ancestorDepth >= 0) result.ancestorDepth = Math.min(value.ancestorDepth, 32);
  for (const key of ["targetMatch", "focusedComposerMatch", "clickTarget", "injected", "setForegroundResult", "hookInstalled", "stopped", "promptMatch", "processMatch", "usable", "stable", "evidenceError", "submitUsable"]) {
    if (typeof value?.[key] === "boolean") result[key] = value[key];
  }
  return result;
}

// Native hooks need their own message loop. Events are bounded and queued so the
// callback never does file/console I/O. Coordinates are used only for hit testing.
export const continuationDiagnosticsScript = String.raw`
try {
Add-Type @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public sealed class ContinuationInputObserver {
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSE { public POINT Point; public uint Data, Flags, Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr Window; public uint Message; public UIntPtr WParam; public IntPtr LParam; public uint Time; public POINT Point; public uint Private; }
  delegate IntPtr MouseProc(int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWindowsHookEx(int id, MouseProc proc, IntPtr module, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg, IntPtr window, uint min, uint max, uint remove);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Auto)] static extern IntPtr GetModuleHandle(string name);
  readonly ConcurrentQueue<string> events = new ConcurrentQueue<string>();
  readonly Stopwatch watch = Stopwatch.StartNew();
  Thread worker;
  MouseProc callback;
  IntPtr hook;
  long target;
  int count, dropped;
  volatile bool stopping;
  public void SetTarget(long handle) { Interlocked.Exchange(ref target, handle); }
  static uint Pid(IntPtr window) { uint pid; GetWindowThreadProcessId(window, out pid); return pid; }
  static string Bool(bool value) { return value ? "true" : "false"; }
  string Fields(IntPtr foreground) {
    IntPtr wanted = new IntPtr(Interlocked.Read(ref target));
    return "\"targetHandle\":" + wanted.ToInt64() + ",\"targetPid\":" + Pid(wanted)
      + ",\"foregroundHandle\":" + foreground.ToInt64() + ",\"foregroundPid\":" + Pid(foreground)
      + ",\"targetMatch\":" + Bool(wanted != IntPtr.Zero && foreground == wanted);
  }
  void Record(string kind, string fields) {
    int number = Interlocked.Increment(ref count);
    if (count > 64) { Interlocked.Increment(ref dropped); return; }
    events.Enqueue("{\"diagnosticKind\":\"" + kind + "\",\"sequence\":" + number
      + ",\"elapsedMs\":" + watch.ElapsedMilliseconds + "," + fields + "}");
  }
  IntPtr MouseEvent(int code, IntPtr message, IntPtr data) {
    try {
      long id = message.ToInt64();
      if (code >= 0 && (id == 0x201 || id == 0x204 || id == 0x207 || id == 0x20B)) {
        MOUSE input = (MOUSE)Marshal.PtrToStructure(data, typeof(MOUSE));
        IntPtr clicked = GetAncestor(WindowFromPoint(input.Point), 2);
        IntPtr wanted = new IntPtr(Interlocked.Read(ref target));
        Record("mouse_down", Fields(GetForegroundWindow()) + ",\"clickHandle\":" + clicked.ToInt64()
          + ",\"clickPid\":" + Pid(clicked) + ",\"clickTarget\":" + Bool(wanted != IntPtr.Zero && clicked == wanted)
          + ",\"injected\":" + Bool((input.Flags & 3) != 0));
      }
    } catch { }
    return CallNextHookEx(hook, code, message, data);
  }
  void Run() {
    try {
      callback = MouseEvent;
      hook = SetWindowsHookEx(14, callback, GetModuleHandle(null), 0);
      int error = hook == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
      Record("observer_started", "\"hookInstalled\":" + Bool(hook != IntPtr.Zero) + ",\"nativeError\":" + error);
      IntPtr previous = new IntPtr(-1);
      while (!stopping && watch.ElapsedMilliseconds < 120000) {
        MSG msg;
        while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1)) { }
        IntPtr current = GetForegroundWindow();
        if (current != previous) { Record("foreground_sample", Fields(current)); previous = current; }
        Thread.Sleep(10);
      }
    } catch { Record("observer_unavailable", "\"hookInstalled\":false"); }
    finally { if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook); }
  }
  public void Start() { worker = new Thread(Run); worker.IsBackground = true; worker.Start(); }
  public string[] Drain() { var result = new System.Collections.Generic.List<string>(); string item; while (events.TryDequeue(out item)) result.Add(item); return result.ToArray(); }
  public string Snapshot() { return "{\"diagnosticKind\":\"focus_snapshot\",\"elapsedMs\":" + watch.ElapsedMilliseconds + "," + Fields(GetForegroundWindow()) + "}"; }
  public string Stop() {
    stopping = true;
    bool stopped = worker == null || worker.Join(500);
    return "{\"diagnosticKind\":\"observer_stopped\",\"stopped\":" + Bool(stopped) + ",\"dropped\":" + dropped + ",\"elapsedMs\":" + watch.ElapsedMilliseconds + "}";
  }
}
'@
} catch { [Console]::WriteLine('diagnostic:{"diagnosticKind":"observer_unavailable"}') }
$script:continuationObserver = $null
function Start-ContinuationDiagnostics {
  try { $script:continuationObserver = New-Object ContinuationInputObserver; $script:continuationObserver.Start() }
  catch { [Console]::WriteLine('diagnostic:{"diagnosticKind":"observer_unavailable"}') }
}
function Write-ContinuationFocusDiagnostic($checkpoint, $setResult = $null) {
  try {
    if ($null -eq $script:continuationObserver) { return }
    $script:continuationObserver.SetTarget($windowHandle.ToInt64())
    foreach ($entry in $script:continuationObserver.Drain()) { [Console]::WriteLine('diagnostic:' + $entry) }
    $snapshot = $script:continuationObserver.Snapshot() | ConvertFrom-Json
    $snapshot | Add-Member -NotePropertyName checkpoint -NotePropertyValue $checkpoint
    try {
      $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
      if ($null -ne $focused) {
        $snapshot | Add-Member -NotePropertyName focusedPid -NotePropertyValue $focused.Current.ProcessId
        if ($null -ne $composer) { $snapshot | Add-Member -NotePropertyName focusedComposerMatch -NotePropertyValue (Test-SameAutomationElement $focused $composer) }
      }
    } catch { }
    if ($null -ne $setResult) { $snapshot | Add-Member -NotePropertyName setForegroundResult -NotePropertyValue ([bool]$setResult) }
    [Console]::WriteLine('diagnostic:' + ($snapshot | ConvertTo-Json -Compress))
  } catch { }
}
function Stop-ContinuationDiagnostics {
  try {
    if ($null -eq $script:continuationObserver) { return }
    $summary = $script:continuationObserver.Stop()
    Write-ContinuationFocusDiagnostic 'finished'
    [Console]::WriteLine('diagnostic:' + $summary)
  } catch { }
}
`;
