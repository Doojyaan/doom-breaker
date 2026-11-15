import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "src", "cli.js");

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

function tempStateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "doom-e2e-"));
  return join(dir, "state.json");
}

const failCmd = ["node", "-e", "console.error('boom'); process.exit(1)"];
const okCmd = ["node", "-e", "process.exit(0)"];

test("e2e: three identical failures trip; the fourth identical call is BLOCKED (exit 3)", () => {
  const sf = tempStateFile();
  const base = ["exec", "--tool", "curl", "--state-file", sf, "--"];

  for (let i = 0; i < 3; i++) {
    const r = runCli([...base, ...failCmd]);
    assert.equal(r.status, 1, `run ${i + 1} should fail but execute`);
  }

  const blocked = runCli([...base, ...failCmd]);
  assert.equal(blocked.status, 3, "fourth identical call must be blocked");
  assert.match(blocked.stderr, /blocked/i);
  assert.match(blocked.stderr, /same failure 3 times/i);
});

test("e2e: changing arguments counts as a changed strategy (not blocked)", () => {
  const sf = tempStateFile();
  const base = ["exec", "--tool", "curl", "--state-file", sf, "--"];

  const r1 = runCli([...base, ...failCmd]);
  assert.equal(r1.status, 1);

  const r2 = runCli([...base, ...okCmd]);
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout, "");
});

test("e2e: success resets the circuit so identical failures start counting from zero", () => {
  const sf = tempStateFile();
  const base = ["exec", "--tool", "curl", "--state-file", sf, "--"];

  for (let i = 0; i < 3; i++) assert.equal(runCli([...base, ...failCmd]).status, 1);
  assert.equal(runCli([...base, ...okCmd]).status, 0); // resets

  // Starts fresh: first two identical failures execute again.
  assert.equal(runCli([...base, ...failCmd]).status, 1);
  assert.equal(runCli([...base, ...failCmd]).status, 1);
  assert.equal(runCli([...base, ...failCmd]).status, 1); // trips again
  assert.equal(runCli([...base, ...failCmd]).status, 3); // blocked
});

test("e2e: status lists circuits; reset clears them", () => {
  const sf = tempStateFile();
  const base = ["exec", "--tool", "curl", "--state-file", sf, "--"];
  for (let i = 0; i < 3; i++) runCli([...base, ...failCmd]);

  const st = runCli(["status", "--state-file", sf]);
  assert.equal(st.status, 0);
  assert.match(st.stdout, /curl/);
  assert.match(st.stdout, /open/);

  const rs = runCli(["reset", "curl", "--state-file", sf]);
  assert.equal(rs.status, 0);
  assert.match(rs.stdout, /reset 1 circuit/);

  const st2 = runCli(["status", "--state-file", sf]);
  assert.match(st2.stdout, /No circuits recorded/);
});

test("e2e: --json emits machine-readable events", () => {
  const sf = tempStateFile();
  const base = ["exec", "--tool", "curl", "--state-file", sf, "--json", "--"];

  const r1 = runCli([...base, ...failCmd]);
  assert.equal(r1.status, 1);

  for (let i = 0; i < 2; i++) runCli([...base, ...failCmd]);
  const blocked = runCli([...base, ...failCmd]);
  assert.equal(blocked.status, 3);
  const ev = JSON.parse(blocked.stdout) as { event: string; tool: string; repeats: number };
  assert.equal(ev.event, "circuit_open");
  assert.equal(ev.tool, "curl");
  assert.equal(ev.repeats, 3);
});

test("e2e: usage errors exit with code 2", () => {
  const sf = tempStateFile();
  const bad = runCli(["exec", "--tool", "curl", "--state-file", sf, "--"]);
  assert.equal(bad.status, 2);

  const badRepeat = runCli(["exec", "--max-repeats", "zero", "--"]);
  assert.equal(badRepeat.status, 2);

  const unknown = runCli(["fly"]);
  assert.equal(unknown.status, 2);
});

test("e2e: corrupt state file does not crash the CLI", () => {
  const sf = tempStateFile();
  writeFileSync(sf, "not json at all !!!");

  const r = runCli(["exec", "--tool", "curl", "--state-file", sf, "--", ...okCmd]);
  assert.equal(r.status, 0);
});
