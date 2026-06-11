import fs from "node:fs";
import path from "node:path";

export const HTTP_ONLY_PROVIDER_ID = "secure_codex_switcher_http";

const ROOT_TAG = "# secure-codex-switcher: http-only-model-provider";
const ORIGINAL_PREFIX = "# secure-codex-switcher: original-model-provider ";
const INSERTED_MARKER = "# secure-codex-switcher: inserted-model-provider";
const BLOCK_BEGIN = "# >>> secure-codex-switcher: http-only-provider >>>";
const BLOCK_END = "# <<< secure-codex-switcher: http-only-provider <<<";

export function readCodexHttpOnlyStatus(configPath) {
  if (!fs.existsSync(configPath)) {
    return { enabled: false, configPath };
  }
  const content = fs.readFileSync(configPath, "utf8");
  return {
    enabled:
      content.includes(ROOT_TAG) &&
      content.includes(BLOCK_BEGIN) &&
      new RegExp(`^\\s*\\[model_providers\\.${HTTP_ONLY_PROVIDER_ID}\\]\\s*$`, "m").test(content) &&
      /^\s*supports_websockets\s*=\s*false\s*$/m.test(extractManagedBlock(content)),
    configPath
  };
}

export function setCodexHttpOnlyMode(configPath, enabled) {
  const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const cleaned = removeManagedConfig(original, newline);
  const next = enabled ? addManagedConfig(cleaned, newline) : cleaned;

  if (next !== original) {
    atomicWriteText(configPath, next);
  }
  return readCodexHttpOnlyStatus(configPath);
}

export function ensureCodexHttpOnlyMode(configPath) {
  if (readCodexHttpOnlyStatus(configPath).enabled) {
    return { enabled: true, configPath };
  }
  return setCodexHttpOnlyMode(configPath, true);
}

export function readCodexBaseProvider(configPath) {
  if (!fs.existsSync(configPath)) {
    return "openai";
  }
  const content = fs.readFileSync(configPath, "utf8");
  const originalMarker = splitLines(content).find((line) => line.startsWith(ORIGINAL_PREFIX));
  if (originalMarker) {
    const originalLine = Buffer.from(originalMarker.slice(ORIGINAL_PREFIX.length).trim(), "base64").toString("utf8");
    return parseProviderValue(originalLine) ?? "openai";
  }
  if (content.includes(INSERTED_MARKER)) {
    return "openai";
  }
  const firstTableOffset = content.search(/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/m);
  const rootContent = firstTableOffset >= 0 ? content.slice(0, firstTableOffset) : content;
  return parseProviderValue(rootContent) ?? "openai";
}

function addManagedConfig(content, newline) {
  const providerSection = new RegExp(`^\\s*\\[model_providers\\.${HTTP_ONLY_PROVIDER_ID}\\]\\s*$`, "m");
  if (providerSection.test(content)) {
    throw new Error(`Codex config already defines model provider "${HTTP_ONLY_PROVIDER_ID}" outside the Switcher-managed block.`);
  }

  const lines = splitLines(content);
  const firstTableIndex = lines.findIndex((line) => /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line));
  const rootSearchEnd = firstTableIndex === -1 ? lines.length : firstTableIndex;
  const existingRootIndex = lines.slice(0, rootSearchEnd).findIndex((line) => /^\s*model_provider\s*=/.test(line));
  const managedRoot = `model_provider = "${HTTP_ONLY_PROVIDER_ID}" ${ROOT_TAG}`;

  if (existingRootIndex >= 0) {
    const originalLine = lines[existingRootIndex];
    const encoded = Buffer.from(originalLine, "utf8").toString("base64");
    lines.splice(existingRootIndex, 1, `${ORIGINAL_PREFIX}${encoded}`, managedRoot);
  } else {
    const insertAt = firstTableIndex === -1 ? lines.length : firstTableIndex;
    const rootLines = [INSERTED_MARKER, managedRoot];
    if (insertAt > 0 && lines[insertAt - 1] !== "") {
      rootLines.unshift("");
    }
    rootLines.push("");
    lines.splice(insertAt, 0, ...rootLines);
  }

  const rootContent = joinLines(lines, newline).trimEnd();
  const providerBlock = [
    BLOCK_BEGIN,
    `[model_providers.${HTTP_ONLY_PROVIDER_ID}]`,
    'name = "OpenAI ChatGPT HTTP only"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_websockets = false",
    BLOCK_END
  ].join(newline);

  return `${rootContent}${rootContent ? `${newline}${newline}` : ""}${providerBlock}${newline}`;
}

function removeManagedConfig(content, newline) {
  if (!content) {
    return "";
  }

  const withoutBlock = content.replace(
    new RegExp(`${escapeRegExp(BLOCK_BEGIN)}[\\s\\S]*?${escapeRegExp(BLOCK_END)}(?:\\r?\\n)?`, "g"),
    ""
  );
  const lines = splitLines(withoutBlock);
  const restored = [];

  for (const line of lines) {
    if (line.startsWith(ORIGINAL_PREFIX)) {
      const encoded = line.slice(ORIGINAL_PREFIX.length).trim();
      try {
        restored.push(Buffer.from(encoded, "base64").toString("utf8"));
      } catch {
        throw new Error("Cannot restore the original Codex model_provider setting.");
      }
      continue;
    }
    if (line === INSERTED_MARKER || line.includes(ROOT_TAG)) {
      continue;
    }
    restored.push(line);
  }

  const normalized = joinLines(restored, newline);
  return normalized.trim() ? `${normalized.trimEnd()}${newline}` : "";
}

function extractManagedBlock(content) {
  const start = content.indexOf(BLOCK_BEGIN);
  const end = content.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) {
    return "";
  }
  return content.slice(start, end + BLOCK_END.length);
}

function splitLines(content) {
  if (!content) {
    return [];
  }
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function joinLines(lines, newline) {
  return lines.join(newline);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseProviderValue(value) {
  return value.match(/^\s*model_provider\s*=\s*["']([^"']+)["']/m)?.[1];
}

function atomicWriteText(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, value, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}
