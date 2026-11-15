import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Circuit } from "../core/circuit.js";
import { argsFingerprint, fingerprint } from "../core/fingerprint.js";
import type { StateStore } from "../core/state.js";
import {
  canonicalizeArgs,
  createBlockedResponse,
  extractErrorText,
  isToolCallRequest,
  parseJsonLine,
  serializeJsonLine,
  type JsonRpcId,
} from "./protocol.js";

export interface McpProxyOptions {
  circuit: Circuit;
  store?: StateStore;
  command: string[];
  input?: NodeJS.ReadableStream | Readable;
  output?: NodeJS.WritableStream | Writable;
  stderr?: NodeJS.WritableStream | Writable;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  child?: ChildProcess;
  onTrip?: (tool: string, repeats: number) => void;
  onBlock?: (tool: string, repeats: number) => void;
}

export type McpProxyConfig = Omit<McpProxyOptions, "circuit">;

interface PendingToolCall {
  tool: string;
  args: unknown;
  argsFp: string;
}

/**
 * Deterministic stdio proxy for Model Context Protocol (MCP) servers.
 *
 * Sits between an AI agent host and an MCP server process over stdio.
 * Intercepts `tools/call` JSON-RPC messages:
 *  - Preflights against Circuit to block repeating doomed calls.
 *  - Synthesizes immediate error response when circuit is OPEN.
 *  - Evaluates downstream tool responses: failures increment repeat counters
 *    and trip the circuit; successes reset the circuit.
 *  - Passes all other methods (initialize, tools/list, etc.) through transparently.
 */
export class McpProxy {
  readonly circuit: Circuit;
  readonly store?: StateStore;
  readonly options: McpProxyOptions;

  private child: ChildProcess | null = null;
  private agentReader: readline.Interface | null = null;
  private downstreamReader: readline.Interface | null = null;
  private agentInput: NodeJS.ReadableStream;
  private agentOutput: NodeJS.WritableStream;
  private agentStderr: NodeJS.WritableStream | null;

  private pendingCalls = new Map<JsonRpcId, PendingToolCall>();
  private agentQueue: Promise<void> = Promise.resolve();
  private downstreamQueue: Promise<void> = Promise.resolve();

  private exitPromise: Promise<number | null>;
  private resolveExit!: (code: number | null) => void;
  private started = false;

  constructor(
    circuitOrOptions: Circuit | McpProxyOptions,
    storeOrConfig?: StateStore | McpProxyConfig,
    maybeConfig?: McpProxyConfig,
  ) {
    if ("preflight" in (circuitOrOptions as any) && typeof (circuitOrOptions as Circuit).preflight === "function") {
      this.circuit = circuitOrOptions as Circuit;
      if (storeOrConfig && "load" in (storeOrConfig as any)) {
        this.store = storeOrConfig as StateStore;
        this.options = {
          circuit: this.circuit,
          store: this.store,
          command: maybeConfig?.command ?? [],
          ...maybeConfig,
        };
      } else {
        const config = (storeOrConfig as McpProxyConfig) ?? { command: [] };
        this.store = config.store;
        this.options = {
          circuit: this.circuit,
          ...config,
        };
      }
    } else {
      const opts = circuitOrOptions as McpProxyOptions;
      this.circuit = opts.circuit;
      this.store = opts.store;
      this.options = opts;
    }

    this.agentInput = this.options.input ?? process.stdin;
    this.agentOutput = this.options.output ?? process.stdout;
    this.agentStderr = this.options.stderr ?? process.stderr;

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  /**
   * Starts the downstream MCP server process and attaches stdio line readers.
   */
  start(): McpProxy {
    if (this.started) return this;
    this.started = true;

    if (this.options.child) {
      this.child = this.options.child;
    } else {
      if (!this.options.command || this.options.command.length === 0) {
        throw new Error("McpProxy requires a downstream command to spawn");
      }
      const [cmd, ...args] = this.options.command;
      if (!cmd || typeof cmd !== "string" || cmd.trim().length === 0) {
        throw new Error("McpProxy requires a valid downstream command to spawn");
      }
      const isWin = process.platform === "win32";
      const isBatchOrCmd =
        isWin &&
        (cmd.endsWith(".cmd") ||
          cmd.endsWith(".bat") ||
          cmd === "npm" ||
          cmd === "npx");

      for (const arg of args) {
        if (typeof arg !== "string" || arg.includes("\0")) {
          throw new Error("Downstream command arguments must not contain null bytes");
        }
        if (isBatchOrCmd && /[\r\n]/.test(arg)) {
          throw new Error("Downstream command arguments for batch scripts must not contain newline characters");
        }
      }

      this.child = spawn(cmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        shell: isBatchOrCmd,
      });
    }

    // Guard against unhandled EPIPE errors
    this.child.stdin?.on("error", () => {});
    (this.agentOutput as any).on?.("error", () => {});

    this.child.on("error", (err) => {
      // Process spawn failure or crash
      try {
        this.agentStderr?.write(`doom-breaker [mcp-proxy]: downstream process error: ${err.message}\n`);
      } catch {
        // ignore stream write error on shutdown
      }
      this.resolveExit(1);
    });

    this.child.on("exit", (code) => {
      this.resolveExit(code);
    });

    // Pipe child stderr directly to agent stderr
    if (this.child.stderr && this.agentStderr) {
      this.child.stderr.on("data", (chunk) => {
        try {
          this.agentStderr?.write(chunk);
        } catch {
          // ignore stream write error on shutdown
        }
      });
    }

    // Set up line-by-line reading for Agent stdin
    this.agentReader = readline.createInterface({
      input: this.agentInput,
      crlfDelay: Infinity,
      terminal: false,
    });

    this.agentReader.on("line", (line) => {
      this.onAgentLine(line);
    });

    this.agentReader.on("close", () => {
      // Agent closed stdin; signal downstream child stdin to end
      try {
        this.child?.stdin?.end();
      } catch {
        // ignore
      }
    });

    // Set up line-by-line reading for downstream stdout
    if (this.child.stdout) {
      this.downstreamReader = readline.createInterface({
        input: this.child.stdout,
        crlfDelay: Infinity,
        terminal: false,
      });

      this.downstreamReader.on("line", (line) => {
        this.onDownstreamLine(line);
      });
    }

    return this;
  }

  /**
   * Queue incoming agent lines sequentially to guarantee ordering.
   */
  private onAgentLine(line: string): void {
    this.agentQueue = this.agentQueue.then(async () => {
      try {
        await this.handleAgentLine(line);
      } catch {
        // Fail-safe: do not crash proxy on unexpected message processing errors
      }
    });
  }

  /**
   * Handles a single line sent by the agent host.
   */
  private async handleAgentLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const parsed = parseJsonLine(trimmed);
      if (!parsed || typeof parsed !== "object") {
        // Non-JSON or unparseable: pass through to downstream
        this.writeToDownstream(trimmed + "\n");
        return;
      }

      if (isToolCallRequest(parsed)) {
        const tool = parsed.params.name;
        const rawArgs = parsed.params.arguments ?? {};
        const canonical = canonicalizeArgs(rawArgs);
        const argsFp = argsFingerprint({ tool, args: canonical });

        const pre = await this.circuit.preflight(tool, argsFp);
        if (!pre.allowed) {
          // Circuit is OPEN: block and return synthetic error response without forwarding
          const blockedResp = createBlockedResponse(parsed.id, tool, pre.repeats);
          this.writeToAgent(serializeJsonLine(blockedResp));
          this.options.onBlock?.(tool, pre.repeats);
          return;
        }

        // Allowed: record pending tool call and forward to downstream
        this.pendingCalls.set(parsed.id, { tool, args: canonical, argsFp });
        this.writeToDownstream(trimmed + "\n");
        return;
      }

      // All other requests and notifications pass through unmodified
      this.writeToDownstream(trimmed + "\n");
    } catch {
      // Fail-safe: if any error occurs during processing, pass through to avoid breaking communication
      this.writeToDownstream(trimmed + "\n");
    }
  }

  /**
   * Queue downstream output lines sequentially to guarantee ordering.
   */
  private onDownstreamLine(line: string): void {
    this.downstreamQueue = this.downstreamQueue.then(async () => {
      try {
        await this.handleDownstreamLine(line);
      } catch {
        // Fail-safe
      }
    });
  }

  /**
   * Handles a single line returned by the downstream MCP server.
   */
  private async handleDownstreamLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const parsed = parseJsonLine(trimmed);
      if (!parsed || typeof parsed !== "object") {
        this.writeToAgent(trimmed + "\n");
        return;
      }

      const resObj = parsed as Record<string, unknown>;
      const id = resObj.id as JsonRpcId;

      if (id !== undefined && this.pendingCalls.has(id)) {
        const pending = this.pendingCalls.get(id)!;
        this.pendingCalls.delete(id);

        if (resObj.result && typeof resObj.result === "object") {
          const result = resObj.result as Record<string, unknown>;
          if (result.isError === true) {
            // MCP Tool Call Error
            const errorText = extractErrorText(result) || "Tool execution error";
            const fp = fingerprint({
              tool: pending.tool,
              args: pending.args,
              error: errorText,
            });
            const rec = await this.circuit.record(
              pending.tool,
              fp,
              pending.argsFp,
              "failure",
            );
            if (rec.tripped) {
              this.options.onTrip?.(pending.tool, rec.repeats);
            }
          } else {
            // MCP Tool Call Success
            await this.circuit.record(
              pending.tool,
              "",
              pending.argsFp,
              "success",
            );
          }
        } else if (resObj.error && typeof resObj.error === "object") {
          // JSON-RPC Error Response
          const errObj = resObj.error as Record<string, unknown>;
          const errorText =
            typeof errObj.message === "string"
              ? errObj.message
              : JSON.stringify(errObj);
          const fp = fingerprint({
            tool: pending.tool,
            args: pending.args,
            error: errorText,
          });
          const rec = await this.circuit.record(
            pending.tool,
            fp,
            pending.argsFp,
            "failure",
          );
          if (rec.tripped) {
            this.options.onTrip?.(pending.tool, rec.repeats);
          }
        }
      }

      // Forward the response line to agent host
      this.writeToAgent(trimmed + "\n");
    } catch {
      // Fail-safe: forward downstream response
      this.writeToAgent(trimmed + "\n");
    }
  }

  /**
   * Writes data safely to downstream child stdin.
   */
  private writeToDownstream(data: string): boolean {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      return false;
    }
    try {
      return this.child.stdin.write(data);
    } catch {
      return false;
    }
  }

  /**
   * Writes data safely to agent stdout.
   */
  private writeToAgent(data: string): boolean {
    if (!this.agentOutput || !(this.agentOutput as any).writable) {
      return false;
    }
    try {
      return (this.agentOutput as any).write(data);
    } catch {
      return false;
    }
  }

  /**
   * Waits until the downstream process exits.
   */
  waitForExit(): Promise<number | null> {
    return this.exitPromise;
  }

  /**
   * Gracefully closes readers and kills the downstream process.
   */
  async stop(): Promise<void> {
    this.agentReader?.close();
    this.downstreamReader?.close();
    if (this.child && !this.child.killed) {
      try {
        this.child.stdin?.end();
        this.child.kill();
      } catch {
        // ignore
      }
    }
  }
}
