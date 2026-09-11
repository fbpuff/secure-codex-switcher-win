import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { startCodexThreadResume } from "../src/core/codex-app-server-client.js";

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = {
      writes: [],
      ended: false,
      write: (chunk) => {
        this.stdin.writes.push(String(chunk));
        return true;
      },
      end: () => {
        this.stdin.ended = true;
      }
    };
    this.stdout = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
    this.killed = false;
  }

  emitJson(message) {
    this.stdout.emit("data", `${JSON.stringify(message)}\n`);
  }

  kill() {
    this.killed = true;
    this.emit("close", 0, null);
    return true;
  }
}

function messagesFrom(process) {
  return process.stdin.writes
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for fake app-server message");
}

test("resumes one exact inactive thread and keeps the transport through turn/completed", async () => {
  const processes = [];
  const resume = startCodexThreadResume({
    threadId: "00000000-0000-7000-8000-000000000001",
    codexDir: "C:\\Users\\Test\\.codex",
    continuationText: "Continue only unfinished work.",
    spawnImpl: (_command, _args, options) => {
      const process = new FakeProcess();
      processes.push({ process, options });
      return process;
    }
  });
  const process = processes[0]?.process;
  assert.ok(process);

  await waitFor(() => messagesFrom(process).length >= 1);
  assert.equal(messagesFrom(process)[0].method, "initialize");
  assert.equal(messagesFrom(process)[0].params.clientInfo.name, "secure_codex_switcher");
  process.emitJson({ id: messagesFrom(process)[0].id, result: {} });

  await waitFor(() => messagesFrom(process).length >= 2);
  assert.deepEqual(messagesFrom(process)[1], { method: "initialized", params: {} });
  process.emitJson({
    id: messagesFrom(process)[2].id,
    result: { thread: { id: "00000000-0000-7000-8000-000000000001", status: { type: "notLoaded" } } }
  });

  await waitFor(() => messagesFrom(process).length >= 4);
  assert.equal(messagesFrom(process)[2].method, "thread/read");
  assert.equal(messagesFrom(process)[2].params.threadId, "00000000-0000-7000-8000-000000000001");
  assert.equal(messagesFrom(process)[3].method, "thread/resume");
  process.emitJson({ id: messagesFrom(process)[3].id, result: { thread: { id: "00000000-0000-7000-8000-000000000001" } } });

  await waitFor(() => messagesFrom(process).length >= 5);
  const turnStart = messagesFrom(process)[4];
  assert.equal(turnStart.method, "turn/start");
  assert.equal(turnStart.params.threadId, "00000000-0000-7000-8000-000000000001");
  assert.deepEqual(turnStart.params.input, [{ type: "text", text: "Continue only unfinished work." }]);
  assert.equal(messagesFrom(process).some((message) => message.method === "thread/start"), false);
  const writesBeforeServerRequest = messagesFrom(process).length;
  process.emitJson({
    id: turnStart.id,
    method: "item/requestApproval",
    params: { reason: "probe" }
  });
  assert.equal(messagesFrom(process).length, writesBeforeServerRequest);
  process.emitJson({ id: turnStart.id, result: { turn: { id: "turn-1" } } });

  assert.deepEqual(await resume.started, { started: true, turnId: "turn-1" });
  assert.equal(process.stdin.ended, false);
  assert.equal(process.killed, false);

  process.emitJson({ method: "turn/completed", params: { turn: { id: "turn-1" }, status: "completed" } });
  assert.deepEqual(await resume.completion, { status: "completed", turnId: "turn-1" });
  assert.equal(process.stdin.ended || process.killed, true);
});

test("does not lose turn/completed when it arrives with the turn/start response", async () => {
  const processes = [];
  const resume = startCodexThreadResume({
    threadId: "00000000-0000-7000-8000-000000000001",
    codexDir: "C:\\Users\\Test\\.codex",
    continuationText: "Continue only unfinished work.",
    timeoutMs: 50,
    spawnImpl: () => {
      const process = new FakeProcess();
      processes.push(process);
      return process;
    }
  });
  const process = processes[0];
  await waitFor(() => messagesFrom(process).length >= 1);
  const initialize = messagesFrom(process)[0];
  process.emitJson({ id: initialize.id, result: {} });
  await waitFor(() => messagesFrom(process).length >= 3);
  const read = messagesFrom(process)[2];
  process.emitJson({
    id: read.id,
    result: { thread: { id: read.params.threadId, status: { type: "notLoaded" } } }
  });
  await waitFor(() => messagesFrom(process).length >= 4);
  const resumeRequest = messagesFrom(process)[3];
  process.emitJson({ id: resumeRequest.id, result: { thread: { id: resumeRequest.params.threadId } } });
  await waitFor(() => messagesFrom(process).length >= 5);
  const turnStart = messagesFrom(process)[4];
  process.emitJson({ id: turnStart.id, result: { turn: { id: "turn-coalesced" } } });
  process.emitJson({ method: "turn/completed", params: { turn: { id: "turn-coalesced" }, status: "completed" } });

  assert.deepEqual(await resume.started, { started: true, turnId: "turn-coalesced" });
  assert.deepEqual(await resume.completion, { status: "completed", turnId: "turn-coalesced" });
  assert.equal(process.stdin.ended || process.killed, true);
});

test("fails closed when thread/read cannot confirm an inactive thread", async () => {
  const processes = [];
  const resume = startCodexThreadResume({
    threadId: "00000000-0000-7000-8000-000000000001",
    codexDir: "C:\\Users\\Test\\.codex",
    continuationText: "Continue only unfinished work.",
    spawnImpl: () => {
      const process = new FakeProcess();
      processes.push(process);
      return process;
    }
  });
  const process = processes[0];
  await waitFor(() => messagesFrom(process).length >= 1);
  const initialize = messagesFrom(process)[0];
  process.emitJson({ id: initialize.id, result: {} });
  await waitFor(() => messagesFrom(process).length >= 3);
  const read = messagesFrom(process)[2];
  assert.equal(read.method, "thread/read");
  process.emitJson({
    id: read.id,
    result: { thread: { id: read.params.threadId, status: { type: "active" } } }
  });

  assert.deepEqual(await resume.started, {
    started: false,
    outcome: "failed",
    error: {
      code: "THREAD_ACTIVE_OR_UNKNOWN",
      message: "thread/read did not confirm an inactive thread"
    }
  });
  assert.equal((await resume.completion).status, "failed");
  assert.equal(messagesFrom(process).some((message) => ["thread/resume", "turn/start", "thread/start"].includes(message.method)), false);
  assert.equal(process.stdin.ended || process.killed, true);
});

test("reports uncertain when turn/start is sent but no response arrives", async () => {
  const processes = [];
  const resume = startCodexThreadResume({
    threadId: "00000000-0000-7000-8000-000000000001",
    codexDir: "C:\\Users\\Test\\.codex",
    continuationText: "Continue only unfinished work.",
    timeoutMs: 20,
    spawnImpl: () => {
      const process = new FakeProcess();
      processes.push(process);
      return process;
    }
  });
  const process = processes[0];
  await waitFor(() => messagesFrom(process).length >= 1);
  const initialize = messagesFrom(process)[0];
  process.emitJson({ id: initialize.id, result: {} });
  await waitFor(() => messagesFrom(process).length >= 3);
  const read = messagesFrom(process)[2];
  process.emitJson({
    id: read.id,
    result: { thread: { id: read.params.threadId, status: { type: "notLoaded" } } }
  });
  await waitFor(() => messagesFrom(process).length >= 4);
  const resumeRequest = messagesFrom(process)[3];
  process.emitJson({ id: resumeRequest.id, result: { thread: { id: resumeRequest.params.threadId } } });
  await waitFor(() => messagesFrom(process).length >= 5);
  assert.equal(messagesFrom(process)[4].method, "turn/start");

  assert.deepEqual(await resume.started, {
    started: false,
    outcome: "uncertain",
    error: {
      code: "APP_SERVER_TIMEOUT",
      message: "turn/start timed out"
    }
  });
  assert.deepEqual(await resume.completion, {
    status: "uncertain",
    error: {
      code: "APP_SERVER_TIMEOUT",
      message: "turn/start timed out"
    }
  });
  assert.equal(process.stdin.ended || process.killed, true);
});

test("uses a separate completion timeout after turn/start succeeds", async () => {
  const processes = [];
  const resume = startCodexThreadResume({
    threadId: "thread-timeout",
    codexDir: "C:\\Users\\Test\\.codex",
    continuationText: "Continue.",
    timeoutMs: 20,
    completionTimeoutMs: 80,
    spawnImpl: () => {
      const process = new FakeProcess();
      processes.push(process);
      return process;
    }
  });
  const process = processes[0];
  await waitFor(() => messagesFrom(process).length >= 1);
  process.emitJson({ id: messagesFrom(process)[0].id, result: {} });
  await waitFor(() => messagesFrom(process).length >= 3);
  process.emitJson({ id: messagesFrom(process)[2].id, result: { thread: { id: "thread-timeout", status: { type: "notLoaded" } } } });
  await waitFor(() => messagesFrom(process).length >= 4);
  process.emitJson({ id: messagesFrom(process)[3].id, result: { thread: { id: "thread-timeout" } } });
  await waitFor(() => messagesFrom(process).length >= 5);
  process.emitJson({ id: messagesFrom(process)[4].id, result: { turn: { id: "turn-timeout" } } });

  assert.equal((await resume.started).started, true);
  const completion = await resume.completion;
  assert.equal(completion.status, "uncertain");
  assert.equal(completion.error.code, "APP_SERVER_TIMEOUT");
});

test("reports uncertain when the transport closes after turn/start was sent", async () => {
  const processes = [];
  const resume = startCodexThreadResume({
    threadId: "00000000-0000-7000-8000-000000000001",
    codexDir: "C:\\Users\\Test\\.codex",
    continuationText: "Continue only unfinished work.",
    timeoutMs: 200,
    spawnImpl: () => {
      const process = new FakeProcess();
      processes.push(process);
      return process;
    }
  });
  const process = processes[0];
  await waitFor(() => messagesFrom(process).length >= 1);
  const initialize = messagesFrom(process)[0];
  process.emitJson({ id: initialize.id, result: {} });
  await waitFor(() => messagesFrom(process).length >= 3);
  const read = messagesFrom(process)[2];
  process.emitJson({
    id: read.id,
    result: { thread: { id: read.params.threadId, status: { type: "notLoaded" } } }
  });
  await waitFor(() => messagesFrom(process).length >= 4);
  const resumeRequest = messagesFrom(process)[3];
  process.emitJson({ id: resumeRequest.id, result: { thread: { id: resumeRequest.params.threadId } } });
  await waitFor(() => messagesFrom(process).length >= 5);
  process.emit("close", 1, null);

  assert.equal((await resume.started).outcome, "uncertain");
  assert.equal((await resume.completion).status, "uncertain");
  assert.equal(process.stdin.ended || process.killed, true);
});

test("reports an uncertain outcome after turn/start returns an explicit server error", async () => {
  const processes = [];
  const resume = startCodexThreadResume({
    threadId: "00000000-0000-7000-8000-000000000001",
    codexDir: "C:\\Users\\Test\\.codex",
    continuationText: "Continue only unfinished work.",
    spawnImpl: () => {
      const process = new FakeProcess();
      processes.push(process);
      return process;
    }
  });
  const process = processes[0];
  await waitFor(() => messagesFrom(process).length >= 1);
  const initialize = messagesFrom(process)[0];
  process.emitJson({ id: initialize.id, result: {} });
  await waitFor(() => messagesFrom(process).length >= 3);
  const read = messagesFrom(process)[2];
  process.emitJson({
    id: read.id,
    result: { thread: { id: read.params.threadId, status: { type: "notLoaded" } } }
  });
  await waitFor(() => messagesFrom(process).length >= 4);
  const resumeRequest = messagesFrom(process)[3];
  process.emitJson({ id: resumeRequest.id, result: { thread: { id: resumeRequest.params.threadId } } });
  await waitFor(() => messagesFrom(process).length >= 5);
  const turnStart = messagesFrom(process)[4];
  process.emitJson({ id: turnStart.id, error: { code: -32000, message: "quota still exhausted" } });

  assert.deepEqual(await resume.started, {
    started: false,
    outcome: "uncertain",
    error: {
      code: -32000,
      message: "quota still exhausted"
    }
  });
  assert.deepEqual(await resume.completion, {
    status: "uncertain",
    error: {
      code: -32000,
      message: "quota still exhausted"
    }
  });
  assert.equal(process.stdin.ended || process.killed, true);
});
