#!/usr/bin/env node
/**
 * doom-breaker — deterministic circuit breaker for agent tool calls.
 *
 * Zero runtime dependencies. Node >= 18.
 * Exit codes: 0 ok | 1 command failed | 2 usage | 3 blocked (circuit open)
 */
import { spawnSync } from "node:child_process";
import { Circuit } from "./core/circuit.js";
import { argsFingerprint, fingerprint } from "./core/fingerprint.js";
import { DEFAULT_STATE_FILE, FileStateStore } from "./core/state.js";
import { McpProxy } from "./mcp/proxy.js";

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_CIRCUIT_OPEN = 3;

const c = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const HELP = `doom-breaker — deterministic circuit breaker for agent tool calls

Usage:
  doom-breaker exec [--tool <name>] [--max-repeats <n>] [--state-file <path>] [--json] -- <command...>
  doom-breaker mcp-proxy [--max-repeats <n>] [--state-file <path>] -- <downstream_command...>
  doom-breaker status [--state-file <path>]
  doom-breaker reset [<tool>] [--state-file <path>]

Commands:
  exec       Run a command under circuit-breaker protection. Repeated identical
             failures trip the circuit; the next identical call is BLOCKED
             (exit code 3) with a corrective message instead of burning tokens.
  mcp-proxy  Transparent stdio MCP proxy. Wrap any MCP server to intercept and
             circuit-break repeating tool call failures.
  status     List recorded circuits and their state.
  reset      Clear one tool's circuit (or all circuits when no tool is given).

Options:
  --tool <name>        Logical tool name (defaults to the command name).
  --max-repeats <n>    Identical failures needed to trip the circuit (default 3).
  --state-file <path>  State location (default .doombreaker/state.json).
  --json               Emit machine-readable JSON events.

Exit codes:
  0 success | 1 command failed | 2 usage error | 3 blocked (circuit open)`;

interface ParsedArgs {
  tool: string | null;
  maxRepeats: number;
  stateFile: string;
  json: boolean;
  command: string[];
  positional: string[];
}

function usageError(message: string): never {
  console.error(c.red(`doom-breaker: ${message}`));
  console.error(c.gray("Run `doom-breaker` for usage."));
  process.exit(EXIT_USAGE);
}

/**
 * Security note (E.D.I.T.H.): the command is executed WITHOUT a shell
 * (spawnSync, argv array). No string interpolation, no shell metacharacters,
 * therefore no command-injection surface through user-controlled arguments.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    tool: null,
    maxRepeats: 3,
    stateFile: DEFAULT_STATE_FILE,
    json: false,
    command: [],
    positional: [],
  };

  const dd = argv.indexOf("--");
  const flags = dd === -1 ? argv : argv.slice(0, dd);
  out.command = dd === -1 ? [] : argv.slice(dd + 1);

  for (let i = 0; i < flags.length; i++) {
    const a = flags[i];
    if (a === "--tool") {
      out.tool = flags[++i];
      if (!out.tool) usageError("--tool requires a value");
    } else if (a === "--max-repeats") {
      const v = Number(flags[++i]);
      if (!Number.isInteger(v) || v < 1) usageError("--max-repeats must be a positive integer");
      out.maxRepeats = v;
    } else if (a === "--state-file") {
      out.stateFile = flags[++i] ?? DEFAULT_STATE_FILE;
      if (!out.stateFile) usageError("--state-file requires a path");
    } else if (a === "--json") {
      out.json = true;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function correctiveFeedback(tool: string, repeats: number): string {
  return (
    `Blocked: tool "${tool}" produced the same failure ${repeats} times in a row. ` +
    `Change strategy — use different arguments, a different tool, or ask the user.`
  );
}

async function execCommand(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  if (args.command.length === 0) usageError("exec requires a command after --");

  const tool = args.tool ?? args.command[0];
  const toolArgs = args.command.slice(1);
  const argsFp = argsFingerprint({ tool, args: toolArgs });
  const circuit = new Circuit(new FileStateStore(args.stateFile), args.maxRepeats);

  const pre = await circuit.preflight(tool, argsFp);
  if (!pre.allowed) {
    const feedback = correctiveFeedback(tool, pre.repeats);
    if (args.json) {
      console.log(JSON.stringify({ event: "circuit_open", tool, repeats: pre.repeats, feedback }));
    } else {
      console.error(c.red(`⛔ ${feedback}`));
    }
    process.exit(EXIT_CIRCUIT_OPEN);
  }

  const started = Date.now();
  const child = spawnSync(args.command[0], args.command.slice(1), {
    stdio: "pipe",
    encoding: "utf8",
  });
  const durationMs = Date.now() - started;

  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);

  const combined = `${child.stderr ?? ""}${child.stdout ?? ""}`.trim();
  const outcome: "success" | "failure" = child.status === 0 ? "success" : "failure";
  const fp = fingerprint({ tool, args: toolArgs, error: combined });
  const res = await circuit.record(tool, fp, argsFp, outcome);

  if (res.tripped) {
    const msg = `⚡ doom-breaker: circuit OPEN for "${tool}" after ${res.repeats} identical failures (${durationMs}ms). The next identical call will be blocked.`;
    if (args.json) {
      console.error(JSON.stringify({ event: "circuit_tripped", tool, repeats: res.repeats, durationMs }));
    } else {
      console.error(c.yellow(msg));
    }
  }

  process.exit(child.status ?? 1);
}

async function mcpProxyCommand(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  if (args.command.length === 0) {
    usageError("mcp-proxy requires a downstream command after --");
  }

  const store = new FileStateStore(args.stateFile);
  const circuit = new Circuit(store, args.maxRepeats);

  const proxy = new McpProxy({
    circuit,
    store,
    command: args.command,
    input: process.stdin,
    output: process.stdout,
    stderr: process.stderr,
    onTrip: (tool, repeats) => {
      process.stderr.write(
        c.yellow(
          `⚡ doom-breaker [mcp-proxy]: circuit OPEN for "${tool}" after ${repeats} identical failures. The next identical call will be blocked.\n`,
        ),
      );
    },
    onBlock: (tool, repeats) => {
      process.stderr.write(
        c.red(
          `⛔ doom-breaker [mcp-proxy]: blocked repeating call for "${tool}" (${repeats} failures in a row). Change strategy.\n`,
        ),
      );
    },
  });

  proxy.start();

  const shutdown = async () => {
    await proxy.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const exitCode = await proxy.waitForExit();
  process.exit(exitCode ?? 0);
}

async function statusCommand(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const state = await new FileStateStore(args.stateFile).load();
  const entries = Object.entries(state.tools).sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    console.log(c.gray(`No circuits recorded (state file: ${args.stateFile}).`));
    return;
  }

  console.log(c.bold(`Circuits (state file: ${args.stateFile})`));
  for (const [tool, t] of entries) {
    const paint = t.state === "open" ? c.red : c.green;
    const extra = t.openedAt ? `  opened=${t.openedAt}` : "";
    console.log(`  ${tool.padEnd(24)} ${paint(t.state.padEnd(8))} repeats=${t.repeatCount}${extra}`);
  }
}

async function resetCommand(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const circuit = new Circuit(new FileStateStore(args.stateFile), args.maxRepeats);
  const tool = args.positional[0] ?? undefined;
  const cleared = await circuit.reset(tool);
  console.log(c.green(`✔ reset ${cleared} circuit(s).`));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    return;
  }

  const [cmd, ...rest] = argv;
  if (cmd === "exec") return execCommand(rest);
  if (cmd === "mcp-proxy") return mcpProxyCommand(rest);
  if (cmd === "status") return statusCommand(rest);
  if (cmd === "reset") return resetCommand(rest);
  usageError(`unknown command: ${cmd}`);
}

main().catch((err: unknown) => {
  console.error(c.red(`doom-breaker crashed: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(EXIT_USAGE);
});
