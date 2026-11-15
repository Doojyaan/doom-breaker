import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { Circuit } from "../src/core/circuit.js";
import { FileStateStore } from "../src/core/state.js";
import {
  parseJsonLine,
  canonicalizeArgs,
  serializeJsonLine,
  MAX_JSON_LINE_LENGTH,
} from "../src/mcp/protocol.js";
import { McpProxy } from "../src/mcp/proxy.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "src", "cli.js");

function runCli(args: string[], input = "") {
  return spawnSync(process.execPath, [cli, ...args], {
    input,
    encoding: "utf8",
  });
}

function tempStore(label: string): FileStateStore {
  const dir = mkdtempSync(join(tmpdir(), `doom-mcp-${label}-`));
  return new FileStateStore(join(dir, "state.json"));
}

// Simple in-memory stream helpers for testing McpProxy in isolation
class MockReadable extends Readable {
  _read() {}
}

class MockWritable extends Writable {
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
}

test("protocol: parseJsonLine parses valid JSON and handles malformed or oversized input fail-safe", () => {
  assert.deepEqual(parseJsonLine('{"jsonrpc":"2.0","id":1}'), {
    jsonrpc: "2.0",
    id: 1,
  });
  assert.equal(parseJsonLine(""), null);
  assert.equal(parseJsonLine("   "), null);
  assert.equal(parseJsonLine("invalid-json-text"), null);
  assert.equal(parseJsonLine("{unclosed:"), null);

  // Oversized line test
  const hugeString = "a".repeat(MAX_JSON_LINE_LENGTH + 10);
  assert.equal(parseJsonLine(hugeString), null);
});

test("protocol: canonicalizeArgs sorts keys, prevents prototype pollution, and prevents recursion overflow", () => {
  // Key sorting
  const sorted = canonicalizeArgs({ b: 2, a: 1, c: { y: 2, x: 1 } });
  assert.deepEqual(sorted, { a: 1, b: 2, c: { x: 1, y: 2 } });
  assert.equal(
    JSON.stringify(sorted),
    JSON.stringify({ a: 1, b: 2, c: { x: 1, y: 2 } }),
  );

  // Prototype pollution guard
  const dangerous = JSON.parse('{"__proto__":{"polluted":true},"valid":"ok"}');
  const sanitized = canonicalizeArgs(dangerous) as Record<string, unknown>;
  assert.equal(sanitized.valid, "ok");
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, "__proto__"), false);

  // Circular reference guard
  const circularObj: any = { name: "test" };
  circularObj.self = circularObj;
  const safeCircular = canonicalizeArgs(circularObj) as any;
  assert.equal(safeCircular.name, "test");
  assert.equal(safeCircular.self, "[Circular]");
});

test("mcp-proxy: security validation rejects invalid commands or arguments with null bytes", () => {
  const circuit = new Circuit(tempStore("sec-val"), 3);

  // Empty command list
  assert.throws(
    () => new McpProxy({ circuit, command: [] }).start(),
    /command/i,
  );

  // Empty executable string
  assert.throws(
    () => new McpProxy({ circuit, command: ["  "] }).start(),
    /valid downstream command/i,
  );

  // Null byte in argument
  assert.throws(
    () => new McpProxy({ circuit, command: ["node", "server.js\0malicious"] }).start(),
    /null bytes/i,
  );
});

test("mcp-proxy: intercepts repeating tool failures and synthesizes blocked response when circuit trips", async () => {
  const store = tempStore("trip-test");
  const circuit = new Circuit(store, 3);

  const agentInput = new MockReadable();
  const agentOutput = new MockWritable();
  const downstreamInput = new MockReadable(); // represents child.stdout
  const downstreamOutput = new MockWritable(); // represents child.stdin

  const mockChild = {
    stdin: downstreamOutput,
    stdout: downstreamInput,
    stderr: new MockReadable(),
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

  // 1. Transparent forwarding of initialize request
  agentInput.emit(
    "data",
    serializeJsonLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(downstreamOutput.lines.length, 1);
  assert.match(downstreamOutput.lines[0], /initialize/);

  // 2. Perform 3 identical tool calls that fail
  for (let i = 1; i <= 3; i++) {
    const reqId = 100 + i;
    // Agent sends tools/call
    agentInput.emit(
      "data",
      serializeJsonLine({
        jsonrpc: "2.0",
        id: reqId,
        method: "tools/call",
        params: { name: "test_tool", arguments: { path: "/bad" } },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    // Downstream replies with tool failure (isError: true)
    downstreamInput.emit(
      "data",
      serializeJsonLine({
        jsonrpc: "2.0",
        id: reqId,
        result: {
          isError: true,
          content: [{ type: "text", text: "File not found: /bad" }],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
  }

  // Verify circuit is now OPEN
  const state = await store.load();
  assert.equal(state.tools.test_tool?.state, "open");
  assert.equal(state.tools.test_tool?.repeatCount, 3);

  // 3. Send 4th identical tool call: must be BLOCKED immediately without forwarding downstream
  const preDownstreamCount = downstreamOutput.lines.length;
  agentInput.emit(
    "data",
    serializeJsonLine({
      jsonrpc: "2.0",
      id: 999,
      method: "tools/call",
      params: { name: "test_tool", arguments: { path: "/bad" } },
    }),
  );
  await new Promise((r) => setTimeout(r, 20));

  // Downstream did NOT receive call 999
  assert.equal(downstreamOutput.lines.length, preDownstreamCount);

  // Agent received synthetic blocked response
  const lastAgentMsg = JSON.parse(agentOutput.lines[agentOutput.lines.length - 1]);
  assert.equal(lastAgentMsg.id, 999);
  assert.equal(lastAgentMsg.result?.isError, true);
  assert.match(lastAgentMsg.result?.content?.[0]?.text, /Circuit OPEN: tool 'test_tool'/);

  await proxy.stop();
});

test("e2e: mcp-proxy CLI help and usage validation", () => {
  // Help contains mcp-proxy
  const h = runCli(["--help"]);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /mcp-proxy/);
  assert.match(h.stdout, /Transparent stdio MCP proxy/);

  // Usage error when missing downstream command
  const bad = runCli(["mcp-proxy", "--"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /mcp-proxy requires a downstream command after --/);
});
