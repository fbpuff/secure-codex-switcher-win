// Fresh UIA ancestry binds a composer to a native foreground root. Process
// equality or an owned-window relationship alone never authorizes submission.
export const continuationWindowScript = String.raw`
function Get-ContinuationNativeBinding($node) {
  for ($depth = 0; $depth -lt 32 -and $null -ne $node; $depth++) {
    $native = [IntPtr]$node.Current.NativeWindowHandle
    if ($native -ne [IntPtr]::Zero) {
      return @{ native=$native.ToInt64(); root=[CodexForegroundWindow]::GetAncestor($native, 2).ToInt64(); depth=$depth }
    }
    $node = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($node)
  }
  return @{ native=0; root=0; depth=32 }
}
function Get-ContinuationWindowEvidence($composer, $processId, $prompt, $scanned, $submitElement) {
  $foreground = [CodexForegroundWindow]::GetForegroundWindow()
  $e = @{ scannedHandle=$scanned.ToInt64(); foregroundHandle=$foreground.ToInt64(); composerRoot=0; ancestorDepth=0; focusedComposerMatch=$false; promptMatch=$false; processMatch=$false; usable=$false; stable=$false }
  try {
    $e.scannedRoot = [CodexForegroundWindow]::GetAncestor($scanned, 2).ToInt64()
    $e.scannedOwner = [CodexForegroundWindow]::GetWindow($scanned, 4).ToInt64()
    $e.scannedParent = [CodexForegroundWindow]::GetAncestor($scanned, 1).ToInt64()
    $e.foregroundRoot = [CodexForegroundWindow]::GetAncestor($foreground, 2).ToInt64()
    $e.foregroundOwner = [CodexForegroundWindow]::GetWindow($foreground, 4).ToInt64()
    $e.foregroundPid = [CodexForegroundWindow]::Pid($foreground)
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    $e.focusedComposerMatch = Test-SameAutomationElement $focused $composer
    if ($e.focusedComposerMatch) {
      $e.promptMatch = Test-ContinuationPromptValue (Get-ContinuationComposerValue $focused) $prompt
      $e.processMatch = $focused.Current.ProcessId -eq $processId -and $e.foregroundPid -eq $processId
      $e.usable = $focused.Current.IsEnabled -and -not $focused.Current.IsOffscreen
      $binding = Get-ContinuationNativeBinding $focused
      $e.ancestorDepth = $binding.depth; $e.composerNative = $binding.native; $e.composerRoot = $binding.root
      $e.submitRoot = (Get-ContinuationNativeBinding $submitElement).root
      $e.submitUsable = $null -ne $submitElement -and $submitElement.Current.IsEnabled -and -not $submitElement.Current.IsOffscreen -and $submitElement.Current.ProcessId -eq $processId
    }
    $e.stable = [CodexForegroundWindow]::GetForegroundWindow() -eq $foreground
  } catch { $e.evidenceError = $true }
  return $e
}
function Resolve-ContinuationForeground($composer, $processId, $prompt, [IntPtr]$scanned, $checkpoint, $submitElement) {
  $e = Get-ContinuationWindowEvidence $composer $processId $prompt $scanned $submitElement
  $reason = if ($e.evidenceError) { 'evidence_error' }
    elseif (-not $e.focusedComposerMatch) { 'composer_changed' }
    elseif (-not $e.promptMatch) { 'prompt_changed' }
    elseif (-not $e.processMatch) { 'process_mismatch' }
    elseif (-not $e.usable) { 'composer_unavailable' }
    elseif (-not $e.stable) { 'foreground_unstable' }
    elseif ($e.composerRoot -eq 0 -or $e.composerRoot -ne $e.foregroundRoot -or $e.foregroundRoot -ne $e.foregroundHandle) { 'root_mismatch' }
    elseif (-not $e.submitUsable -or $e.submitRoot -ne $e.composerRoot) { 'submit_mismatch' }
    elseif ($e.foregroundHandle -ne $scanned.ToInt64()) { 'rebound' }
    else { 'unchanged' }
  $e.diagnosticKind = 'window_binding'; $e.checkpoint = $checkpoint; $e.bindingReason = $reason
  [Console]::WriteLine('diagnostic:' + ($e | ConvertTo-Json -Compress))
  if ($reason -notin @('rebound','unchanged')) { throw 'Codex continuation foreground/composer binding could not be verified.' }
  return [IntPtr]$e.foregroundHandle
}
`;
