export function isRecoverableMainProcessError(error) {
  const text = formatMainProcessError(error).toLowerCase();
  return (
    text.includes("socketerror") ||
    text.includes("other side closed") ||
    text.includes("und_err_socket") ||
    text.includes("und_err_connect_timeout") ||
    text.includes("fetch failed") ||
    text.includes("econnreset") ||
    text.includes("etimedout") ||
    text.includes("tlswrap") ||
    text.includes("tlssocket")
  );
}

export function formatMainProcessError(error) {
  if (error instanceof Error) {
    const parts = [error.stack || `${error.name}: ${error.message}`];
    if (error.cause) {
      parts.push(`Cause: ${formatMainProcessError(error.cause)}`);
    }
    return parts.join("\n");
  }
  return String(error);
}
