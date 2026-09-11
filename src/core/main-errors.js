export function isRecoverableMainProcessError(error) {
  return getMainProcessErrorCode(error) !== "unclassified";
}

export function getMainProcessErrorCode(error) {
  const text = collectMainProcessErrorText(error);
  const rules = [
    ["epipe", ["epipe", "broken pipe"]],
    ["ipc_channel_closed", ["err_ipc_channel_closed", "ipc channel is closed", "ipc channel was closed", "ipc channel closed"]],
    ["ipc_disconnected", ["err_ipc_disconnected", "ipc disconnected"]],
    ["message_port_closed", ["err_message_port_closed", "message port is closed", "message port was closed", "message port closed"]],
    ["stream_destroyed", ["err_stream_destroyed", "err_stream_write_after_end", "stream destroyed", "write after end", "object has been destroyed", "webcontents was destroyed", "webcontents is destroyed"]],
    ["stream_premature_close", ["err_stream_premature_close", "stream premature close", "premature close"]],
    ["connection_reset", ["econnreset", "connection reset"]],
    ["connect_timeout", ["und_err_connect_timeout", "etimedout", "connect timeout"]],
    ["fetch_failed", ["fetch failed"]],
    ["socket_closed", ["socketerror", "other side closed", "und_err_socket", "tlswrap", "tlssocket"]]
  ];

  for (const [code, patterns] of rules) {
    if (patterns.some((pattern) => text.includes(pattern))) {
      return code;
    }
  }
  return "unclassified";
}

export function formatMainProcessError(error) {
  if (error instanceof Error) {
    const parts = [error.stack || `${error.name}: ${error.message}`];
    if (error.cause) {
      parts.push(`Cause: ${formatMainProcessError(error.cause)}`);
    }
    return redactMainProcessError(parts.join("\n"));
  }
  return redactMainProcessError(String(error));
}

function redactMainProcessError(value) {
  return value
    .replace(/(?:file:\/\/\/)?[A-Za-z]:[\\/]Users[\\/][^\\/\r\n]+/gi, "%USERPROFILE%")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/((?:access|refresh|id)_token\s*[:=]\s*)[^\s,}]+/gi, "$1[redacted]");
}

function collectMainProcessErrorText(error) {
  const parts = [formatMainProcessError(error)];
  const seen = new Set();
  let current = error;
  while (current && (typeof current === "object" || typeof current === "function") && !seen.has(current)) {
    seen.add(current);
    if (typeof current.code === "string") parts.push(current.code);
    if (typeof current.name === "string") parts.push(current.name);
    if (typeof current.message === "string") parts.push(current.message);
    current = current.cause;
  }
  return parts.join("\n").toLowerCase();
}
