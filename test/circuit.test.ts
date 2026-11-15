import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateStore } from "../src/core/state.js";
import { Circuit, DEFAULT_MAX_REPEATS } from "../src/core/circuit.js";
import { argsFingerprint, fingerprint, normalizeError } from "../src/core/fingerprint.js";

function tempStore(label: string): FileStateStore {
  const dir = mkdtempSync(join(tmpdir(), `doom-${label}-`));
  return new FileStateStore(join(dir, "state.json"));
}

const FP = fingerprint({ tool: "curl", args: ["-X", "POST", "https://x.dev"], error: "boom" });
const ARGS_FP = argsFingerprint({ tool: "curl", args: ["-X", "POST", "https://x.dev"] });

test("fingerprint is stable for identical inputs", () => {
  const a = fingerprint({ tool: "t", args: { a: 1 }, error: "e" });
  const b = fingerprint({ tool: "t", args: { a: 1 }, error: "e" });
  assert.equal(a, b);
});

test("fingerprint differs when args differ (changed strategy)", () => {
  const a = fingerprint({ tool: "t", args: ["x"], error: "e" });
  const b = fingerprint({ tool: "t", args: ["y"], error: "e" });
  assert.notEqual(a, b);
});

test("normalizeError maps timestamps, hex addresses and big numbers to placeholders", () => {
  const e1 = "failed at 2026-11-16T10:00:00.000Z: 0xDEADBEEF took 123456 ms";
  const e2 = "failed at 2027-01-01 09:30:10: 0xFFFF0000 took 999999 ms";
  assert.equal(normalizeError(e1), normalizeError(e2));
});

test("normalizeError keeps small, meaningful numbers (e.g. HTTP status 404)", () => {
  assert.match(normalizeError("HTTP 404"), /404/);
});

test("circuit does NOT trip before maxRepeats consecutive identical failures", async () => {
  const circuit = new Circuit(tempStore("pre"), DEFAULT_MAX_REPEATS);
  const r1 = await circuit.record("curl", FP, ARGS_FP, "failure");
  const r2 = await circuit.record("curl", FP, ARGS_FP, "failure");
  assert.equal(r1.tripped, false);
  assert.equal(r2.tripped, false);
  assert.equal((await circuit.preflight("curl", ARGS_FP)).allowed, true);
});

test("circuit trips exactly at maxRepeats and blocks the identical call", async () => {
  const circuit = new Circuit(tempStore("trip"), 3);
  await circuit.record("curl", FP, ARGS_FP, "failure");
  await circuit.record("curl", FP, ARGS_FP, "failure");
  const third = await circuit.record("curl", FP, ARGS_FP, "failure");
  assert.equal(third.tripped, true);
  assert.equal(third.repeats, 3);

  const pre = await circuit.preflight("curl", ARGS_FP);
  assert.equal(pre.allowed, false);
  assert.equal(pre.reason, "circuit_open");
});

test("circuit OPEN still allows a call with CHANGED arguments (changed strategy)", async () => {
  const circuit = new Circuit(tempStore("probe"), 3);
  await circuit.record("curl", FP, ARGS_FP, "failure");
  await circuit.record("curl", FP, ARGS_FP, "failure");
  await circuit.record("curl", FP, ARGS_FP, "failure");
  assert.equal((await circuit.preflight("curl", ARGS_FP)).allowed, false);

  const changedFp = argsFingerprint({ tool: "curl", args: ["--retry", "3"] });
  const pre = await circuit.preflight("curl", changedFp);
  assert.equal(pre.allowed, true);
  assert.equal(pre.reason, "ok");
});

test("different fingerprint resets the consecutive counter (changed strategy)", async () => {
  const circuit = new Circuit(tempStore("diff"), 3);
  await circuit.record("curl", FP, ARGS_FP, "failure");
  await circuit.record("curl", FP, ARGS_FP, "failure");
  const otherFp = fingerprint({ tool: "curl", args: ["--retry"], error: "boom" });
  const otherArgsFp = argsFingerprint({ tool: "curl", args: ["--retry"] });
  const r = await circuit.record("curl", otherFp, otherArgsFp, "failure");
  assert.equal(r.repeats, 1);
  assert.equal(r.tripped, false);
});

test("one success resets everything", async () => {
  const circuit = new Circuit(tempStore("succ"), 3);
  await circuit.record("curl", FP, ARGS_FP, "failure");
  await circuit.record("curl", FP, ARGS_FP, "failure");
  const r = await circuit.record("curl", FP, ARGS_FP, "success");
  assert.equal(r.repeats, 0);
  assert.equal((await circuit.preflight("curl", ARGS_FP)).repeats, 0);
});

test("state persists across store instances (new process sees OPEN)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doom-persist-"));
  const file = join(dir, "state.json");
  const circuit = new Circuit(new FileStateStore(file), 2);
  await circuit.record("curl", FP, ARGS_FP, "failure");
  await circuit.record("curl", FP, ARGS_FP, "failure");

  // Simulate a brand-new process reading the same file.
  const fresh = new Circuit(new FileStateStore(file), 2);
  const pre = await fresh.preflight("curl", ARGS_FP);
  assert.equal(pre.allowed, false);
});

test("corrupt state file is treated as fresh state (never crashes host)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doom-corrupt-"));
  const file = join(dir, "state.json");
  writeFileSync(file, "{ this is not json !!!");

  const circuit = new Circuit(new FileStateStore(file), 3);
  const pre = await circuit.preflight("curl", ARGS_FP);
  assert.equal(pre.allowed, true);

  const r = await circuit.record("curl", FP, ARGS_FP, "failure");
  assert.equal(r.repeats, 1);
});

test("reset clears one tool only; reset() clears all", async () => {
  const circuit = new Circuit(tempStore("reset"), 2);
  await circuit.record("a", FP, ARGS_FP, "failure");
  await circuit.record("a", FP, ARGS_FP, "failure");
  await circuit.record("b", FP, ARGS_FP, "failure");
  await circuit.record("b", FP, ARGS_FP, "failure");

  assert.equal(await circuit.reset("a"), 1);
  assert.equal((await circuit.preflight("a", ARGS_FP)).allowed, true);
  assert.equal((await circuit.preflight("b", ARGS_FP)).allowed, false);

  assert.equal(await circuit.reset(), 1);
  assert.equal((await circuit.preflight("b", ARGS_FP)).allowed, true);
});
