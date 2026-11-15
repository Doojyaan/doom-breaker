import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { Circuit } from "../src/core/circuit.js";
import { FileStateStore } from "../src/core/state.js";
import { serializeJsonLine } from "../src/mcp/protocol.js";
import { McpProxy } from "../src/mcp/proxy.js";

function tempStore(label: string): FileStateStore {
  const dir = mkdtempSync(join(tmpdir(), `doom-chaos-${label}-`));
  return new FileStateStore(join(dir, "state.json"));
}

class TestReadable extends Readable {
  _read() {}
}

class TestWritable extends Writable {
  chunks: string[] = [];
  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(chunk.toString());
    callback();
  }

  get output(): string {
    return this.chunks.join("");
  }

  get lines(): string[] {
    return this.output
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  clear(): void {
    this.chunks = [];
  }
}

// ---------------------------------------------------------------------------
// 1. Chunked / Fragmented Stream
// ---------------------------------------------------------------------------

test("chaos 1: handles fragmented/chunked JSON-RPC frames across multiple stream chunks", async () => {
  const store = tempStore("chunked");
  const circuit = new Circuit(store, 3);

  const agentInput = new TestReadable();
  const agentOutput = new TestWritable();
  const downstreamInput = new TestReadable();
  const downstreamOutput = new TestWritable();

  const mockChild = {
    stdin: downstreamOutput,
    stdout: downstreamInput,
    stderr: new TestReadable(),
    killed: false,
    on: () => {},
    kill: () => {},
  } as any;

  const proxy = new McpProxy({
    circuit,
    command: ["node"],
    child: mockChild,
    input: agentInput,
    output: agentOutput,
  });
  proxy.start();

  // Part A: Fragmented agent input stream (message split into 4 partial chunks)
  const fullAgentMsg = {
    jsonrpc: "2.0",
    id: 101,
    method: "tools/call",
    params: { name: "search", arguments: { query: "fragmented test" } },
  };
  const serializedMsg = serializeJsonLine(fullAgentMsg);
  const part1 = serializedMsg.slice(0, 15);
  const part2 = serializedMsg.slice(15, 35);
  const part3 = serializedMsg.slice(35, 60);
  const part4 = serializedMsg.slice(60);

  agentInput.emit("data", part1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(downstreamOutput.lines.length, 0, "No line should be emitted before newline");

  agentInput.emit("data", part2);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(downstreamOutput.lines.length, 0, "No line should be emitted mid-message");

  agentInput.emit("data", part3);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(downstreamOutput.lines.length, 0);

  agentInput.emit("data", part4); // includes \n
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(downstreamOutput.lines.length, 1, "Complete line reconstructed upon newline");
  const parsedDownstream = JSON.parse(downstreamOutput.lines[0]);
  assert.equal(parsedDownstream.id, 101);
  assert.equal(parsedDownstream.method, "tools/call");
  assert.equal(parsedDownstream.params.name, "search");

  // Part B: Fragmented downstream response (split into 3 partial chunks)
  const fullDownstreamResp = {
    jsonrpc: "2.0",
    id: 101,
    result: {
      content: [{ type: "text", text: "search result chunked" }],
    },
  };
  const serializedResp = serializeJsonLine(fullDownstreamResp);
  const respPart1 = serializedResp.slice(0, 20);
  const respPart2 = serializedResp.slice(20, 50);
  const respPart3 = serializedResp.slice(50);

  downstreamInput.emit("data", respPart1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(agentOutput.lines.length, 0, "Agent should not receive incomplete response");

  downstreamInput.emit("data", respPart2);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(agentOutput.lines.length, 0);

  downstreamInput.emit("data", respPart3); // includes \n
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(agentOutput.lines.length, 1, "Agent received complete reconstructed response");
  const parsedAgent = JSON.parse(agentOutput.lines[0]);
  assert.equal(parsedAgent.id, 101);
  assert.equal(parsedAgent.result.content[0].text, "search result chunked");

  // Part C: Multiple JSON lines packed inside a single stream chunk
  const lineA = serializeJsonLine({ jsonrpc: "2.0", method: "notifications/a", params: { step: 1 } });
  const lineB = serializeJsonLine({ jsonrpc: "2.0", method: "notifications/b", params: { step: 2 } });
  agentInput.emit("data", lineA + lineB);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(downstreamOutput.lines.length, 3);
  assert.match(downstreamOutput.lines[1], /notifications\/a/);
  assert.match(downstreamOutput.lines[2], /notifications\/b/);

  await proxy.stop();
});

// ---------------------------------------------------------------------------
// 2. Malformed JSON Frames
// ---------------------------------------------------------------------------

test("chaos 2: handles malformed JSON frames and non-JSON text from agent and downstream fail-safe", async () => {
  const store = tempStore("malformed");
  const circuit = new Circuit(store, 3);

  const agentInput = new TestReadable();
  const agentOutput = new TestWritable();
  const downstreamInput = new TestReadable();
  const downstreamOutput = new TestWritable();

  const mockChild = {
    stdin: downstreamOutput,
    stdout: downstreamInput,
    stderr: new TestReadable(),
    killed: false,
    on: () => {},
    kill: () => {},
  } as any;

  const proxy = new McpProxy({
    circuit,
    command: ["node"],
    child: mockChild,
    input: agentInput,
    output: agentOutput,
  });
  proxy.start();

  // 1. Agent sends raw non-JSON text, broken JSON, numbers, empty lines
  const malformedAgentLines = [
    "   ", // empty whitespace
    "NOT_A_JSON_COMMAND",
    "{ unclosed json object",
    "42",
    "true",
    "null",
    JSON.stringify([1, 2, 3]), // array instead of object
  ];

  for (const line of malformedAgentLines) {
    agentInput.emit("data", line + "\n");
  }
  await new Promise((r) => setTimeout(r, 30));

  // Non-empty unparseable lines pass through to downstream fail-safe without throwing
  assert.ok(downstreamOutput.lines.includes("NOT_A_JSON_COMMAND"));
  assert.ok(downstreamOutput.lines.includes("{ unclosed json object"));

  // 2. Downstream sends raw server logs or uncaught exception stack traces to stdout
  const downstreamLogLines = [
    "[INFO] Starting server on port 8080...",
    "DEBUG: connected to backend database",
    "Error: Unexpected internal crash\n    at Object.<anonymous> (/app/server.js:42:15)\n",
    "{ broken response from downstream",
  ];

  for (const logLine of downstreamLogLines) {
    downstreamInput.emit("data", logLine + "\n");
  }
  await new Promise((r) => setTimeout(r, 30));

  // Proxy forwards unparseable downstream lines to agent output without crashing
  assert.ok(agentOutput.lines.some((l) => l.includes("[INFO] Starting server")));
  assert.ok(agentOutput.lines.some((l) => l.includes("DEBUG: connected")));
  assert.ok(agentOutput.lines.some((l) => l.includes("Unexpected internal crash")));

  // 3. Verify proxy is still healthy and handles valid subsequent tool calls
  agentInput.emit(
    "data",
    serializeJsonLine({
      jsonrpc: "2.0",
      id: 200,
      method: "tools/call",
      params: { name: "echo", arguments: { msg: "still alive" } },
    }),
  );
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(downstreamOutput.lines.some((l) => l.includes('"still alive"')));

  await proxy.stop();
});

// ---------------------------------------------------------------------------
// 3. Downstream Process Crash & Abrupt Exit
// ---------------------------------------------------------------------------

test("chaos 3a: downstream process crashes with non-zero exit code, proxy handles exit cleanly", async () => {
  const store = tempStore("crash-exit");
  const circuit = new Circuit(store, 3);

  const agentInput = new TestReadable();
  const agentOutput = new TestWritable();
  const agentStderr = new TestWritable();

  // Spawn a real child that exits immediately with code 42
  const proxy = new McpProxy({
    circuit,
    command: [process.execPath, "-e", "process.exit(42)"],
    input: agentInput,
    output: agentOutput,
    stderr: agentStderr,
  });

  proxy.start();

  const exitCode = await proxy.waitForExit();
  assert.equal(exitCode, 42, "Proxy must propagate downstream exit code 42");

  // Subsequent writes to agentInput after downstream has exited must not throw or crash
  assert.doesNotThrow(() => {
    agentInput.emit(
      "data",
      serializeJsonLine({ jsonrpc: "2.0", id: 999, method: "tools/call", params: { name: "test" } }),
    );
  });

  await proxy.stop();
});

test("chaos 3b: downstream process killed abruptly, proxy resolves exit without hanging or zombies", async () => {
  const store = tempStore("crash-kill");
  const circuit = new Circuit(store, 3);

  const agentInput = new TestReadable();
  const agentOutput = new TestWritable();

  // Spawn a real long-running child
  const proxy = new McpProxy({
    circuit,
    command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    input: agentInput,
    output: agentOutput,
  });

  proxy.start();

  // Give child time to start
  await new Promise((r) => setTimeout(r, 50));

  // Stop proxy which terminates child process
  const stopPromise = proxy.stop();
  const exitPromise = proxy.waitForExit();

  await Promise.all([stopPromise, exitPromise]);

  // Successfully stopped and exited without hanging
  assert.ok(true, "Proxy stopped and child exited cleanly");
});

// ---------------------------------------------------------------------------
// 4. Rapid Trip & Probe Behavior
// ---------------------------------------------------------------------------

test("chaos 4: 3x tool failures trigger circuit OPEN (blocked), probe with different args is allowed and resets circuit", async () => {
  const store = tempStore("trip-probe");
  const circuit = new Circuit(store, 3);

  const agentInput = new TestReadable();
  const agentOutput = new TestWritable();
  const downstreamInput = new TestReadable();
  const downstreamOutput = new TestWritable();

  const trippedEvents: { tool: string; repeats: number }[] = [];
  const blockedEvents: { tool: string; repeats: number }[] = [];

  const mockChild = {
    stdin: downstreamOutput,
    stdout: downstreamInput,
    stderr: new TestReadable(),
    killed: false,
    on: () => {},
    kill: () => {},
  } as any;

  const proxy = new McpProxy({
    circuit,
    command: ["node"],
    child: mockChild,
    input: agentInput,
    output: agentOutput,
    onTrip: (tool, repeats) => trippedEvents.push({ tool, repeats }),
    onBlock: (tool, repeats) => blockedEvents.push({ tool, repeats }),
  });
  proxy.start();

  const failingArgs = { query: "SELECT * FROM missing_table" };
  const probeArgs = { query: "SELECT 1" };

  // Run 3 consecutive identical failing tool calls
  for (let i = 1; i <= 3; i++) {
    const id = 10 + i;
    agentInput.emit(
      "data",
      serializeJsonLine({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "db_query", arguments: failingArgs },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    // Downstream replies with failure
    downstreamInput.emit(
      "data",
      serializeJsonLine({
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: "Table 'missing_table' doesn't exist" }],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
  }

  // 1. Verify circuit tripped
  assert.equal(trippedEvents.length, 1);
  assert.equal(trippedEvents[0].tool, "db_query");
  assert.equal(trippedEvents[0].repeats, 3);

  const stateOpen = await store.load();
  assert.equal(stateOpen.tools.db_query?.state, "open");
  assert.equal(stateOpen.tools.db_query?.repeatCount, 3);

  // 2. Call #4 with identical failing arguments -> BLOCKED by proxy
  const downstreamCountBeforeBlocked = downstreamOutput.lines.length;
  agentInput.emit(
    "data",
    serializeJsonLine({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "db_query", arguments: failingArgs },
    }),
  );
  await new Promise((r) => setTimeout(r, 20));

  // Must NOT forward to downstream
  assert.equal(downstreamOutput.lines.length, downstreamCountBeforeBlocked);

  // Must receive synthetic blocked response with isError: true
  assert.equal(blockedEvents.length, 1);
  assert.equal(blockedEvents[0].tool, "db_query");
  const blockedAgentMsg = JSON.parse(agentOutput.lines[agentOutput.lines.length - 1]);
  assert.equal(blockedAgentMsg.id, 99);
  assert.equal(blockedAgentMsg.result?.isError, true);
  assert.match(blockedAgentMsg.result?.content[0]?.text, /Circuit OPEN: tool 'db_query'/);

  // 3. Call #5 with DIFFERENT arguments (PROBE) -> ALLOWED to pass to downstream
  const downstreamCountBeforeProbe = downstreamOutput.lines.length;
  agentInput.emit(
    "data",
    serializeJsonLine({
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: { name: "db_query", arguments: probeArgs },
    }),
  );
  await new Promise((r) => setTimeout(r, 20));

  // Downstream MUST receive probe call
  assert.equal(downstreamOutput.lines.length, downstreamCountBeforeProbe + 1);
  const probeDownstreamCall = JSON.parse(downstreamOutput.lines[downstreamOutput.lines.length - 1]);
  assert.equal(probeDownstreamCall.id, 100);
  assert.deepEqual(probeDownstreamCall.params.arguments, probeArgs);

  // 4. Downstream succeeds on the probe call
  downstreamInput.emit(
    "data",
    serializeJsonLine({
      jsonrpc: "2.0",
      id: 100,
      result: {
        isError: false,
        content: [{ type: "text", text: "1" }],
      },
    }),
  );
  await new Promise((r) => setTimeout(r, 20));

  // Circuit MUST now be reset to closed!
  const stateReset = await store.load();
  assert.equal(stateReset.tools.db_query?.state, "closed");
  assert.equal(stateReset.tools.db_query?.repeatCount, 0);

  // 5. Subsequent call with original args is now allowed through again
  const downstreamCountBeforeRetry = downstreamOutput.lines.length;
  agentInput.emit(
    "data",
    serializeJsonLine({
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: { name: "db_query", arguments: failingArgs },
    }),
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(downstreamOutput.lines.length, downstreamCountBeforeRetry + 1);

  await proxy.stop();
});

// ---------------------------------------------------------------------------
// 5. Notification & Non-Tool Passthrough
// ---------------------------------------------------------------------------

test("chaos 5: non-tool requests and notifications are forwarded 1:1 without modifying circuit state", async () => {
  const store = tempStore("passthrough");
  const circuit = new Circuit(store, 3);

  const agentInput = new TestReadable();
  const agentOutput = new TestWritable();
  const downstreamInput = new TestReadable();
  const downstreamOutput = new TestWritable();

  const mockChild = {
    stdin: downstreamOutput,
    stdout: downstreamInput,
    stderr: new TestReadable(),
    killed: false,
    on: () => {},
    kill: () => {},
  } as any;

  const proxy = new McpProxy({
    circuit,
    command: ["node"],
    child: mockChild,
    input: agentInput,
    output: agentOutput,
  });
  proxy.start();

  // 1. Agent -> Downstream: "initialize" request (has id)
  const initReq = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } };
  agentInput.emit("data", serializeJsonLine(initReq));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(downstreamOutput.lines.length, 1);
  assert.deepEqual(JSON.parse(downstreamOutput.lines[0]), initReq);

  // Downstream -> Agent: "initialize" response
  const initResp = { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "demo", version: "1.0.0" } } };
  downstreamInput.emit("data", serializeJsonLine(initResp));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(agentOutput.lines.length, 1);
  assert.deepEqual(JSON.parse(agentOutput.lines[0]), initResp);

  // 2. Agent -> Downstream: "notifications/initialized" notification (no id)
  const initNotice = { jsonrpc: "2.0", method: "notifications/initialized", params: {} };
  agentInput.emit("data", serializeJsonLine(initNotice));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(downstreamOutput.lines.length, 2);
  assert.deepEqual(JSON.parse(downstreamOutput.lines[1]), initNotice);

  // 3. Downstream -> Agent: custom notification (no id)
  const serverNotice = { jsonrpc: "2.0", method: "custom/log", params: { level: "info", msg: "ready" } };
  downstreamInput.emit("data", serializeJsonLine(serverNotice));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(agentOutput.lines.length, 2);
  assert.deepEqual(JSON.parse(agentOutput.lines[1]), serverNotice);

  // 4. Agent -> Downstream: custom non-tool method (e.g. "ping" or "resources/list")
  const pingReq = { jsonrpc: "2.0", id: 55, method: "ping", params: {} };
  agentInput.emit("data", serializeJsonLine(pingReq));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(downstreamOutput.lines.length, 3);
  assert.deepEqual(JSON.parse(downstreamOutput.lines[2]), pingReq);

  const pingResp = { jsonrpc: "2.0", id: 55, result: {} };
  downstreamInput.emit("data", serializeJsonLine(pingResp));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(agentOutput.lines.length, 3);
  assert.deepEqual(JSON.parse(agentOutput.lines[2]), pingResp);

  // 5. Verify circuit state store has ZERO recorded tools
  const state = await store.load();
  assert.deepEqual(state.tools, {}, "No tools should be recorded in circuit store for non-tool calls");

  await proxy.stop();
});

// ---------------------------------------------------------------------------
// 6. JSON-RPC Error Objects Tripping Circuit
// ---------------------------------------------------------------------------

test("chaos 6: 3x consecutive JSON-RPC error objects trip the circuit and trigger synthetic block", async () => {
  const store = tempStore("rpc-errors");
  const circuit = new Circuit(store, 3);

  const agentInput = new TestReadable();
  const agentOutput = new TestWritable();
  const downstreamInput = new TestReadable();
  const downstreamOutput = new TestWritable();

  const mockChild = {
    stdin: downstreamOutput,
    stdout: downstreamInput,
    stderr: new TestReadable(),
    killed: false,
    on: () => {},
    kill: () => {},
  } as any;

  const proxy = new McpProxy({
    circuit,
    command: ["node"],
    child: mockChild,
    input: agentInput,
    output: agentOutput,
  });
  proxy.start();

  const toolName = "flaky_tool";
  const toolArgs = { target: "server-a" };

  // Send 3 tool calls that fail with JSON-RPC error response format
  for (let i = 1; i <= 3; i++) {
    const id = 200 + i;
    agentInput.emit(
      "data",
      serializeJsonLine({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: toolName, arguments: toolArgs },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    // Downstream replies with JSON-RPC error object
    downstreamInput.emit(
      "data",
      serializeJsonLine({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "Connection reset by peer" },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
  }

  // Verify circuit is now OPEN
  const state = await store.load();
  assert.equal(state.tools[toolName]?.state, "open");
  assert.equal(state.tools[toolName]?.repeatCount, 3);

  // 4th call with same args must be blocked
  const preDownstreamCount = downstreamOutput.lines.length;
  agentInput.emit(
    "data",
    serializeJsonLine({
      jsonrpc: "2.0",
      id: 999,
      method: "tools/call",
      params: { name: toolName, arguments: toolArgs },
    }),
  );
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(downstreamOutput.lines.length, preDownstreamCount, "4th call must be blocked");
  const blockedResp = JSON.parse(agentOutput.lines[agentOutput.lines.length - 1]);
  assert.equal(blockedResp.id, 999);
  assert.equal(blockedResp.result?.isError, true);
  assert.match(blockedResp.result?.content[0]?.text, /Circuit OPEN: tool 'flaky_tool'/);

  await proxy.stop();
});

// ---------------------------------------------------------------------------
// 7. Missing Executable / Spawn Failure
// ---------------------------------------------------------------------------

test("chaos 7: handles spawn failures (missing executable) gracefully by resolving exit code 1", async () => {
  const store = tempStore("spawn-fail");
  const circuit = new Circuit(store, 3);

  const agentInput = new TestReadable();
  const agentOutput = new TestWritable();
  const agentStderr = new TestWritable();

  const proxy = new McpProxy({
    circuit,
    command: ["__non_existent_binary_xyz_12345__"],
    input: agentInput,
    output: agentOutput,
    stderr: agentStderr,
  });

  proxy.start();

  const exitCode = await proxy.waitForExit();
  assert.equal(exitCode, 1, "Exit code must resolve to 1 on spawn failure");
  assert.ok(
    agentStderr.lines.some((l) => l.includes("downstream process error")),
    "Stderr should report downstream process error",
  );

  await proxy.stop();
});

