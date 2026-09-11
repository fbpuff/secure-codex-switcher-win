import { spawn, spawnSync } from "node:child_process";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const POWERSHELL_TIMEOUT_MS = 10_000;

const protectScript = `
Add-Type -AssemblyName System.Security
$encodedPlain = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($encodedPlain)
$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($protected)
`;

const unprotectScript = `
Add-Type -AssemblyName System.Security
$cipher = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($cipher)
$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($plain)
`;

export function protectString(plainText) {
  return runPowerShell(protectScript, Buffer.from(plainText, "utf8").toString("base64"));
}

export async function protectStringAsync(plainText) {
  return runPowerShellAsync(protectScript, Buffer.from(plainText, "utf8").toString("base64"));
}

export function unprotectString(cipherText) {
  return Buffer.from(runPowerShell(unprotectScript, cipherText), "base64").toString("utf8");
}

export async function unprotectStringAsync(cipherText) {
  return Buffer.from(await runPowerShellAsync(unprotectScript, cipherText), "base64").toString("utf8");
}

function runPowerShell(script, input) {
  if (process.platform !== "win32") {
    throw new Error("Windows DPAPI is only available on Windows.");
  }
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: MAX_OUTPUT_BYTES
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || "DPAPI operation failed").trim());
  }
  return result.stdout.trim();
}

function runPowerShellAsync(script, input) {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("Windows DPAPI is only available on Windows."));
  }
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: POWERSHELL_TIMEOUT_MS
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const append = (current, chunk) => {
      const next = current + chunk;
      if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("DPAPI operation exceeded its output limit."));
      }
      return next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(new Error((stderr || "DPAPI operation failed").trim()));
        return;
      }
      finish(undefined, stdout.trim());
    });
    child.stdin.end(input);
  });
}
