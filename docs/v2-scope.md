# doom-breaker v0.2 Specification — MCP stdio Proxy Mode

## Overview

In v0.1.0, `doom-breaker` provides a CLI wrapper (`doom-breaker exec --tool <name> -- <cmd>`) that protects external commands.
In v0.2, `doom-breaker` introduces `mcp-proxy`: a transparent stdio proxy that sits between an AI agent and any Model Context Protocol (MCP) server.

Instead of wrapping each command line, the agent host connects to `doom-breaker mcp-proxy -- <mcp-server-command>` as if it were the MCP server directly. Every `tools/call` is deterministically intercepted and protected.

## Architecture

```
+------------+               +----------------------------+               +------------------+
|            |  stdio (JSON) |  doom-breaker mcp-proxy    |  stdio (JSON) |                  |
|  AI Agent  | ------------> |  - Parse JSON-RPC line     | ------------> |    MCP Server    |
|  (Host)    | <------------ |  - Preflight circuit check | <------------ | (e.g. filesystem,|
|            |               |  - Fingerprint error/pass  |               |  git, browser)   |
+------------+               +----------------------------+               +------------------+
                                           |
                                           v
                             +----------------------------+
                             |  .doombreaker/state.json   |
                             +----------------------------+
```

## Protocol Handling

1. **JSON-RPC framing**:
   - MCP over stdio uses newline-delimited JSON (`\n` separated UTF-8).
2. **Passthrough methods**:
   - `initialize`, `initialized`, `tools/list`, `resources/*`, `prompts/*`, ping, and notifications pass through unmodified and uninspected.
3. **Intercepted method (`tools/call`)**:
   - `params.name`: Tool name.
   - `params.arguments`: Tool arguments.
   - **Step A: Preflight**:
     - Compute `argsFingerprint = hash(tool, canonicalize(args))`.
     - Check `circuit.preflight(tool, argsFp)`.
     - If `allowed === false` (circuit `OPEN` on identical arguments):
       - Do **NOT** forward to the MCP server.
       - Immediately return a synthetic MCP tool call result or JSON-RPC error response:
         ```json
         {
           "jsonrpc": "2.0",
           "id": <request.id>,
           "result": {
             "isError": true,
             "content": [
               {
                 "type": "text",
                 "text": "⛔ Circuit OPEN: tool '<name>' repeated the same failure 3 times. Change your strategy, use different arguments, or ask the user."
               }
             ]
           }
         }
         ```
   - **Step B: Forwarding & Response Evaluation**:
     - Forward request to downstream MCP server process.
     - Inspect response:
       - If response contains `result.isError === true`:
         - Extract error text from `result.content` (concatenate text parts).
         - Compute failure fingerprint: `hash(tool, args, normalize(errorText))`.
         - Record failure via `circuit.record(tool, fp, argsFp, "failure")`.
       - If response contains `result.isError === false` or standard result:
         - Record success: `circuit.record(tool, fp, argsFp, "success")`.
     - Pass response through to Agent stdout.

## Task Breakdown & Team Allocation

| Task | Agent | Deliverable | Dependencies |
|---|---|---|---|
| **1. Spec & Scope** | F.R.I.D.A.Y. | `docs/v2-scope.md` | Done |
| **2. MCP Proxy Core** | J.A.R.V.I.S. | `src/mcp/proxy.ts`, `src/mcp/protocol.ts` | Task 1 |
| **3. CLI Integration & Safety** | E.D.I.T.H. | `doom-breaker mcp-proxy -- <cmd>` in `src/cli.ts` | Task 2 |
| **4. Adversarial Tests** | ULTRON | `test/mcp-proxy.test.ts` (mock MCP server, error trip, probe) | Task 3 |
| **5. Build & Packaging** | D.U.M.-E. | `npm run build`, bundle validation | Task 4 |
| **6. Verification & Gate** | U & VISION | 100% test pass, zero regressions on v0.1.0 suite | Task 5 |

## Non-Functional Requirements

- **Zero new dependencies**: Built strictly on Node.js built-ins (`node:readline`, `node:child_process`, `node:crypto`).
- **Backward compatibility**: All 19 existing v0.1.0 tests must continue to pass without changes.
- **Fail-safe stdio**: Graceful handling of downstream process crashes or EPIPE.
