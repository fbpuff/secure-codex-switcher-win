import { spawn } from "node:child_process";
import packageJson from "../../package.json" with { type: "json" };

const REQUEST_TIMEOUT_MS = 30_000;
const COMPLETION_TIMEOUT_MS = 30 * 60_000;

/**
 * Run one continuation while Desktop is closed. The caller owns the process
 * lifetime; the returned promises provide protocol-level start/completion
 * evidence instead of UI focus evidence.
 */
export function startCodexThreadResume({
  threadId,
  codexDir,
  continuationText,
  spawnImpl = spawn,
  timeoutMs = REQUEST_TIMEOUT_MS,
  completionTimeoutMs = COMPLETION_TIMEOUT_MS
} = {}) {
  const started = deferred();
  const completion = deferred();
  const closed = deferred();
  const ctx = {
    threadId,
    codexDir,
    continuationText,
    spawnImpl,
    timeoutMs: normalizeTimeout(timeoutMs, REQUEST_TIMEOUT_MS),
    completionTimeoutMs: normalizeTimeout(completionTimeoutMs, COMPLETION_TIMEOUT_MS),
    process: undefined,
    nextId: 1,
    pending: new Map(),
    buffer: "",
    turnId: undefined,
    earlyCompletions: new Map(),
    turnStartSent: false,
    startedSettled: false,
    completionSettled: false,
    finished: false,
    completionTimer: undefined,
    completion,
    closed
  };
  void run(ctx, started, completion);
  return {
    started: started.promise,
    completion: completion.promise,
    closed: closed.promise,
    cancel: () => failTransport(ctx, completion, protocolError("DESKTOP_OWNERSHIP_CONFLICT", "Codex Desktop opened during app-server continuation"))
  };
}

async function run(ctx, started, completion) {
  try {
    validate(ctx);
    launch(ctx);
    await request(ctx, "initialize", { clientInfo: { name: "secure_codex_switcher", title: "Secure Codex Switcher", version: packageJson.version } });
    send(ctx, "initialized", {});
    const read = await request(ctx, "thread/read", { threadId: ctx.threadId, includeTurns: false });
    assertThread(read, ctx.threadId, "THREAD_READ_MISMATCH");
    const status = read.result.thread.status;
    if (status?.active === true || ["active", "running", "inprogress", "in_progress", "processing"].includes(String(status?.type ?? "").toLowerCase())) {
      throw protocolError("THREAD_ACTIVE_OR_UNKNOWN", "thread/read did not confirm an inactive thread");
    }
    const resumed = await request(ctx, "thread/resume", { threadId: ctx.threadId });
    assertThread(resumed, ctx.threadId, "THREAD_RESUME_MISMATCH");
    ctx.turnStartSent = true;
    const turn = await request(ctx, "turn/start", { threadId: ctx.threadId, input: [{ type: "text", text: ctx.continuationText }] });
    ctx.turnId = turn?.result?.turn?.id;
    if (typeof ctx.turnId !== "string" || !ctx.turnId) throw protocolError("TURN_ID_MISSING", "turn/start did not return a turn id");
    ctx.startedSettled = true;
    started.resolve({ started: true, turnId: ctx.turnId });
    const early = ctx.earlyCompletions.get(ctx.turnId);
    if (early) {
      ctx.earlyCompletions.delete(ctx.turnId);
      finish(ctx, completion, early.status);
      return;
    }
    ctx.completionTimer = setTimeout(() => finish(ctx, completion, "uncertain", protocolError("APP_SERVER_TIMEOUT", "turn/completed timed out")), ctx.completionTimeoutMs);
  } catch (error) {
    const outcome = ctx.turnStartSent ? "uncertain" : "failed";
    finish(ctx, completion, outcome, error);
    if (!ctx.startedSettled) { ctx.startedSettled = true; started.resolve({ started: false, outcome, error: serializeError(error) }); }
  }
}

function launch(ctx) {
  const env = { ...process.env, CODEX_HOME: ctx.codexDir };
  ctx.process = ctx.spawnImpl("codex", ["app-server", "--listen", "stdio://"], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  if (!ctx.process?.stdin || !ctx.process?.stdout) throw protocolError("APP_SERVER_PROCESS_INVALID", "app-server stdio unavailable");
  ctx.process.stdout.setEncoding?.("utf8");
  ctx.process.stdout.on("data", (chunk) => receive(ctx, chunk, completionFor(ctx)));
  ctx.process.on("error", (error) => failTransport(ctx, completionFor(ctx), error));
  ctx.process.on("close", () => {
    ctx.closed.resolve();
    failTransport(ctx, completionFor(ctx), protocolError("APP_SERVER_EOF", "app-server closed"));
  });
}

// The promises are attached by run before launch can emit any response.
function completionFor(ctx) { return ctx.completion; }

function receive(ctx, chunk, completion) {
  ctx.buffer += String(chunk);
  let index;
  while ((index = ctx.buffer.indexOf("\n")) >= 0) {
    const line = ctx.buffer.slice(0, index).trim(); ctx.buffer = ctx.buffer.slice(index + 1);
    if (!line) continue;
    let message; try { message = JSON.parse(line); } catch (error) { failTransport(ctx, completion, protocolError("APP_SERVER_INVALID_JSON", error.message)); return; }
    if (message.method === "turn/completed") {
      const id = message.params?.turn?.id ?? message.params?.turnId;
      const status = message.params?.turn?.status ?? message.params?.status ?? "completed";
      if (id === ctx.turnId) finish(ctx, completion, status);
      else if (typeof id === "string" && id) ctx.earlyCompletions.set(id, { status });
      continue;
    }
    if (!message.method && Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = ctx.pending.get(message.id); if (!pending) continue;
      ctx.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(protocolError(message.error.code ?? "APP_SERVER_ERROR", message.error.message ?? pending.method)); else pending.resolve(message);
    }
  }
}

function request(ctx, method, params) {
  const id = ctx.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ctx.pending.delete(id); reject(protocolError("APP_SERVER_TIMEOUT", `${method} timed out`)); }, ctx.timeoutMs);
    ctx.pending.set(id, { resolve, reject, timer, method });
    try { send(ctx, method, params, id); } catch (error) { clearTimeout(timer); ctx.pending.delete(id); reject(error); }
  });
}

function send(ctx, method, params, id) {
  if (!ctx.process?.stdin || ctx.finished) throw protocolError("APP_SERVER_CLOSED", "app-server is closed");
  ctx.process.stdin.write(`${JSON.stringify({ method, params, ...(id == null ? {} : { id }) })}\n`);
}

function finish(ctx, completion, status, error) {
  if (ctx.finished) return; ctx.finished = true;
  if (ctx.completionTimer) clearTimeout(ctx.completionTimer);
  completion.resolve({ status, ...(ctx.turnId ? { turnId: ctx.turnId } : {}), ...(error ? { error: serializeError(error) } : {}) });
  cleanup(ctx);
}

function failTransport(ctx, completion, error) { if (!ctx.finished) finish(ctx, completion, ctx.turnStartSent ? "uncertain" : "failed", error); }
function cleanup(ctx) { for (const pending of ctx.pending.values()) { clearTimeout(pending.timer); pending.reject(protocolError("APP_SERVER_CLOSED", "app-server closed")); } ctx.pending.clear(); try { ctx.process?.stdin?.end?.(); } catch {} try { ctx.process?.kill?.(); } catch {} }
function assertThread(response, expected, code) { if (!response?.result?.thread || response.result.thread.id !== expected) throw protocolError(code, "app-server returned a different thread"); }
function validate(ctx) { if (typeof ctx.threadId !== "string" || !ctx.threadId.trim()) throw protocolError("INVALID_THREAD_ID", "threadId is required"); if (typeof ctx.codexDir !== "string" || !ctx.codexDir.trim()) throw protocolError("INVALID_CODEX_HOME", "codexDir is required"); if (typeof ctx.continuationText !== "string" || !ctx.continuationText.trim()) throw protocolError("INVALID_CONTINUATION", "continuationText is required"); }
function normalizeTimeout(value, fallback) { return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback; }
function protocolError(code, message) { const error = new Error(String(message)); error.code = code; return error; }
function serializeError(error) { return { code: error?.code ?? "APP_SERVER_ERROR", message: String(error?.message ?? error ?? "app-server operation failed").slice(0, 500) }; }
function deferred() { let resolve; const promise = new Promise((next) => { resolve = next; }); return { promise, resolve }; }
