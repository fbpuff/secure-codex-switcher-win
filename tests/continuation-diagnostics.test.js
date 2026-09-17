import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { buildCodexDesktopContinuationScript, normalizeDesktopDiscoveryDiagnostics } from "../src/services/account-service.js";

test("continuation focus diagnostics preserve only bounded metadata", () => {
  const safe = { diagnosticKind: "mouse_down", checkpoint: "before_submit", targetHandle: 123,
    foregroundHandle: 456, foregroundPid: 42, targetPid: 43, elapsedMs: 200,
    targetMatch: false, injected: true, clickTarget: false, setForegroundResult: false };
  assert.deepEqual(normalizeDesktopDiscoveryDiagnostics({ ...safe, title: "private", text: "private", x: 100, processPath: "private" }), safe);
  assert.deepEqual(normalizeDesktopDiscoveryDiagnostics({ diagnosticKind: "private", checkpoint: "private", targetHandle: -1, foregroundPid: Infinity, injected: "yes" }), {});
});

test("continuation observer is bounded, observational and disposed before foreground restore", () => {
  const script = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");
  assert.match(script, /SetWindowsHookEx\(14/);
  assert.match(script, /CallNextHookEx/);
  assert.match(script, /UnhookWindowsHookEx/);
  assert.match(script, /ElapsedMilliseconds < 120000/);
  assert.match(script, /count > 64/);
  assert.ok(script.indexOf("Stop-ContinuationDiagnostics", script.indexOf("Restore-ContinuationCursor $cursorCaptured", script.indexOf("fallback_invoke_started"))) < script.lastIndexOf("Restore-ContinuationForeground $previousForeground"));
  assert.match(script, /Write-ContinuationFocusDiagnostic 'after_focus'/);
  assert.match(script, /Write-ContinuationFocusDiagnostic 'before_submit'/);
  assert.match(script, /Resolve-ContinuationForeground \$composer \$elementProcessId \$prompt \$windowHandle 'after_focus'/);
  assert.doesNotMatch(script, /GetWindowText|GetKeyState|GetAsyncKeyState|GetWindowModuleFileName/);
});

test("generated continuation diagnostic C# compiles and PowerShell parses without running automation", { skip: process.platform !== "win32" }, () => {
  const generated = buildCodexDesktopContinuationScript("01234567-89ab-cdef-0123-456789abcdef");
  const encoded = Buffer.from(generated, "utf16le").toString("base64");
  const check = `$s=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))
$tokens=$null; $errors=$null
[void][Management.Automation.Language.Parser]::ParseInput($s,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors | Out-String)}
foreach($m in [regex]::Matches($s,"(?s)Add-Type @'\\r?\\n(.*?)\\r?\\n'@")){ Add-Type -TypeDefinition $m.Groups[1].Value -ErrorAction Stop }
$observer = New-Object ContinuationInputObserver
$observer.Start()
Start-Sleep -Milliseconds 150
$summary = $observer.Stop() | ConvertFrom-Json
if(-not $summary.stopped){throw 'Observer failed to stop'}
$events = @($observer.Drain() | ForEach-Object { $_ | ConvertFrom-Json })
if(-not ($events | Where-Object diagnosticKind -eq 'observer_started')){throw 'Observer did not initialize'}
if($events | Where-Object { $_.diagnosticKind -eq 'observer_started' -and -not $_.hookInstalled }){throw 'Mouse hook unavailable'}
$record = $observer.GetType().GetMethod('Record', [Reflection.BindingFlags]'NonPublic,Instance')
1..70 | ForEach-Object { [void]$record.Invoke($observer, @('foreground_sample','"targetMatch":false')) }
$bounded = @($observer.Drain())
$summary = $observer.Stop() | ConvertFrom-Json
if($bounded.Count -gt 64 -or $summary.dropped -lt 6){throw 'Observer bound missing'}
'diagnostic_compile_passed'`;
  // stdin avoids Windows command-line length limits and never executes the helper.
  assert.match(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; & ([scriptblock]::Create([Console]::In.ReadToEnd()))"], { input: check, encoding: "utf8", windowsHide: true, timeout: 20000 }), /diagnostic_compile_passed/);
  // Exercise the real command transport size, but exit before any automation.
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", "$ErrorActionPreference='Stop'; & ([scriptblock]::Create([Console]::In.ReadToEnd()))"], { input: `exit 0\n${generated}`, encoding: "utf8", windowsHide: true, timeout: 10000 });
});
