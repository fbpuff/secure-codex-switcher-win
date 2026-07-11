import { spawnSync } from "node:child_process";

const protectScript = `
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($protected)
`;

const unprotectScript = `
Add-Type -AssemblyName System.Security
$cipher = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($cipher)
$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Text.Encoding]::UTF8.GetString($plain)
`;

export function protectString(plainText) {
  return runPowerShell(protectScript, plainText);
}

export function unprotectString(cipherText) {
  return runPowerShell(unprotectScript, cipherText);
}

function runPowerShell(script, input) {
  if (process.platform !== "win32") {
    throw new Error("Windows DPAPI is only available on Windows.");
  }
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || "DPAPI operation failed").trim());
  }
  return result.stdout.trim();
}
