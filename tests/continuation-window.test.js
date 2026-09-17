import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { continuationWindowScript } from "../src/services/continuation-window.js";
import { buildCodexDesktopContinuationScript, normalizeDesktopDiscoveryDiagnostics } from "../src/services/account-service.js";

test("window reconciliation retains bounded metadata without private content", () => {
  const safe = { diagnosticKind: "window_binding", checkpoint: "after_focus", bindingReason: "rebound",
    scannedHandle: 11, foregroundHandle: 22, composerRoot: 22, foregroundRoot: 22,
    scannedRoot: 11, scannedOwner: 0, foregroundOwner: 11, ancestorDepth: 4,
    focusedComposerMatch: true, promptMatch: true, processMatch: true, usable: true };
  assert.deepEqual(normalizeDesktopDiscoveryDiagnostics({ ...safe, title: "private", prompt: "secret", exception: "private" }), safe);
  assert.deepEqual(normalizeDesktopDiscoveryDiagnostics({ bindingReason: "private", composerRoot: -1, ancestorDepth: Infinity }), {});
});

test("real PowerShell binding decision accepts verified roots and rejects ambiguous focus", { skip: process.platform !== "win32" }, () => {
  const script = `${continuationWindowScript}
function Get-ContinuationWindowEvidence { return $script:evidence }
$base = @{ scannedHandle=11; foregroundHandle=22; foregroundRoot=22; composerRoot=22; focusedComposerMatch=$true; promptMatch=$true; processMatch=$true; usable=$true; stable=$true; submitRoot=22; submitUsable=$true }
$script:evidence = $base.Clone()
if ((Resolve-ContinuationForeground $null 1 'synthetic' 11 'after_focus').ToInt64() -ne 22) { throw 'rebind failed' }
$script:evidence = $base.Clone(); $script:evidence.scannedHandle=22
if ((Resolve-ContinuationForeground $null 1 'synthetic' 22 'before_submit').ToInt64() -ne 22) { throw 'stable failed' }
foreach ($key in @('focusedComposerMatch','promptMatch','processMatch','usable','stable','submitUsable')) {
  $script:evidence=$base.Clone(); $script:evidence[$key]=$false
  $rejected=$false
  try { Resolve-ContinuationForeground $null 1 'synthetic' 11 'before_submit' | Out-Null } catch { $rejected=$true }
  if (-not $rejected) { throw ('accepted invalid '+$key) }
}
foreach ($root in @(0,33)) {
  $script:evidence=$base.Clone(); $script:evidence.composerRoot=$root
  $rejected=$false
  try { Resolve-ContinuationForeground $null 1 'synthetic' 11 'before_fallback' | Out-Null } catch { $rejected=$true }
  if (-not $rejected) { throw 'accepted unrelated same-process root' }
}
'binding_passed'`;
  const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; & ([scriptblock]::Create([Console]::In.ReadToEnd()))"], { input: script, encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.match(result, /binding_passed/);
  assert.match(result, /"bindingReason":"rebound"/);
  assert.match(result, /"bindingReason":"root_mismatch"/);
  assert.match(result, /"bindingReason":"foreground_unstable"/);
});

test("all submission paths revalidate live ancestry without dropping rollout verification", () => {
  const script = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");
  for (const checkpoint of ["after_focus", "before_submit", "before_fallback"]) {
    assert.ok(script.includes(`Resolve-ContinuationForeground $composer $elementProcessId $prompt $windowHandle '${checkpoint}'`));
  }
  assert.match(script, /TreeWalker\]::ControlViewWalker/);
  assert.match(script, /\$depth -lt 32/);
  assert.match(script, /GetAncestor\(\$native, 2\)/);
  assert.match(script, /Test-ContinuationTurnStarted/);
});

test("live ancestry collector rejects stale roots, changed controls and wrong submit owners", { skip: process.platform !== "win32" }, () => {
  // Execute the production PowerShell collector against isolated UIA/Win32
  // doubles; no desktop window is activated and no input is emitted.
  const script = `Add-Type @'
using System;
public class Props { public int NativeWindowHandle; public int ProcessId=7; public bool IsEnabled=true; public bool IsOffscreen; }
public class Node { public Props Current=new Props(); public Node Parent; }
namespace System.Windows.Automation {
  public class AutomationElement { public static Node FocusedElement; }
  public class TreeWalker { public static TreeWalker ControlViewWalker=new TreeWalker(); public Node GetParent(Node n) {return n.Parent;} }
}
public class CodexForegroundWindow {
  public static IntPtr Foreground=new IntPtr(22);
  public static IntPtr GetForegroundWindow() {return Foreground;}
  public static IntPtr GetAncestor(IntPtr h,uint flags) {return flags==2 ? h : IntPtr.Zero;}
  public static IntPtr GetWindow(IntPtr h,uint flags) {return IntPtr.Zero;}
  public static uint Pid(IntPtr h) {return 7;}
}
'@
function Test-SameAutomationElement($a,$b) { return [Object]::ReferenceEquals($a,$b) }
function Test-ContinuationPromptValue($a,$b) { return $a -ceq $b }
function Get-ContinuationComposerValue { return 'synthetic' }
${continuationWindowScript}
$root=New-Object Node; $root.Current.NativeWindowHandle=22
$composer=New-Object Node; $composer.Parent=$root
$submit=New-Object Node; $submit.Parent=$root
[System.Windows.Automation.AutomationElement]::FocusedElement=$composer
$e=Get-ContinuationWindowEvidence $composer 7 'synthetic' ([IntPtr]11) $submit
if($e.composerRoot -ne 22 -or $e.ancestorDepth -ne 1 -or $e.submitRoot -ne 22 -or -not $e.focusedComposerMatch){throw 'ancestry failed'}
if((Resolve-ContinuationForeground $composer 7 'synthetic' 11 'after_focus' $submit).ToInt64() -ne 22){throw 'collector rebind failed'}
foreach($case in @('root','submit','prompt','focus','process','disabled','offscreen','depth')) {
  $root.Current.NativeWindowHandle=22; $submit.Parent=$root; $composer.Parent=$root
  $composer.Current.IsEnabled=$true; $composer.Current.IsOffscreen=$false
  [System.Windows.Automation.AutomationElement]::FocusedElement=$composer
  $expected='synthetic'; $expectedPid=7
  switch($case) {
    'root' {$root.Current.NativeWindowHandle=33}
    'submit' {$other=New-Object Node; $other.Current.NativeWindowHandle=33; $submit.Parent=$other}
    'prompt' {$expected='changed'}
    'focus' {[System.Windows.Automation.AutomationElement]::FocusedElement=New-Object Node}
    'process' {$expectedPid=8}
    'disabled' {$composer.Current.IsEnabled=$false}
    'offscreen' {$composer.Current.IsOffscreen=$true}
    'depth' {$composer.Parent=$composer}
  }
  $rejected=$false
  try {Resolve-ContinuationForeground $composer $expectedPid $expected 11 'before_submit' $submit | Out-Null} catch {$rejected=$true}
  if(-not $rejected){throw ('accepted '+$case)}
}
'collector_passed'`;
  assert.match(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; & ([scriptblock]::Create([Console]::In.ReadToEnd()))"], { input: script, encoding: "utf8", windowsHide: true, timeout: 15000 }), /collector_passed/);
});
