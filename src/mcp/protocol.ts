/**
 * MCP and JSON-RPC 2.0 protocol types and framing helpers for doom-breaker.
 *
 * Implements newline-delimited JSON-RPC 2.0 framing and standard Model Context
 * Protocol (MCP) message shapes for transparent proxying and deterministic
 * circuit-breaker interception.
 */

// --- JSON-RPC 2.0 Base Types ---

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
}

export interface JsonRpcResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse
  | JsonRpcErrorResponse;

// --- MCP Tool Call Types ---

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown> | unknown;
  _meta?: Record<string, unknown>;
}

export interface McpToolCallRequest extends JsonRpcRequest<McpToolCallParams> {
  params: McpToolCallParams;
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface McpEmbeddedResource {
  type: "resource";
  resource: unknown;
}

export type McpContent =
  | McpTextContent
  | McpImageContent
  | McpEmbeddedResource
  | { type: string; [key: string]: unknown };

export interface McpToolCallResult {
  content?: McpContent[];
  isError?: boolean;
  [key: string]: unknown;
}

export type McpToolCallResponse = JsonRpcResponse<McpToolCallResult>;

// --- Type Guards ---

export function isJsonRpcRequest(val: unknown): val is JsonRpcRequest {
  if (!val || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  return (
    (obj.jsonrpc === "2.0" || obj.jsonrpc === undefined) &&
    typeof obj.method === "string" &&
    obj.id !== undefined &&
    !("result" in obj) &&
    !("error" in obj)
  );
}

export function isJsonRpcNotification(val: unknown): val is JsonRpcNotification {
  if (!val || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  return (
    (obj.jsonrpc === "2.0" || obj.jsonrpc === undefined) &&
    typeof obj.method === "string" &&
    obj.id === undefined
  );
}

export function isJsonRpcResponse(val: unknown): val is JsonRpcResponse {
  if (!val || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  return (
    (obj.jsonrpc === "2.0" || obj.jsonrpc === undefined) &&
    obj.id !== undefined &&
    "result" in obj &&
    !("method" in obj)
  );
}

export function isJsonRpcErrorResponse(val: unknown): val is JsonRpcErrorResponse {
  if (!val || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  return (
    (obj.jsonrpc === "2.0" || obj.jsonrpc === undefined) &&
    obj.id !== undefined &&
    "error" in obj &&
    obj.error !== null &&
    typeof obj.error === "object" &&
    !("method" in obj)
  );
}

export function isToolCallRequest(req: unknown): req is McpToolCallRequest {
  if (!isJsonRpcRequest(req)) return false;
  if (req.method !== "tools/call") return false;
  if (!req.params || typeof req.params !== "object") return false;
  return typeof (req.params as Record<string, unknown>).name === "string";
}

// --- Framing & Serialization Helpers ---

/**
 * Maximum single JSON-RPC line size accepted for parsing (16 MB).
 * Protects against memory exhaustion / event loop freezing from giant payloads.
 */
export const MAX_JSON_LINE_LENGTH = 16 * 1024 * 1024;

/**
 * Serializes an object as a single JSON line terminated with `\n`.
 */
export function serializeJsonLine(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}

/**
 * Safely parses a single line into a JSON object. Returns null if invalid, empty, or oversized.
 */
export function parseJsonLine(line: string): unknown | null {
  if (line.length > MAX_JSON_LINE_LENGTH) {
    return null;
  }
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Recursively canonicalizes tool call arguments by sorting object keys alphabetically.
 * Ensures consistent serialization regardless of key ordering in dictionaries.
 * Hardened with recursion depth check, cycle detection, and prototype pollution guard.
 */
export function canonicalizeArgs(
  val: unknown,
  seen: Set<unknown> = new Set(),
  depth: number = 0,
): unknown {
  if (depth > 64) {
    return "[MaxDepth]";
  }
  if (val === null || typeof val !== "object") {
    return val;
  }
  if (seen.has(val)) {
    return "[Circular]";
  }
  seen.add(val);
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (Array.isArray(val)) {
    return val.map((item) => canonicalizeArgs(item, seen, depth + 1));
  }
  const obj = val as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (key === "__proto__") continue;
    sorted[key] = canonicalizeArgs(obj[key], seen, depth + 1);
  }
  return sorted;
}

/**
 * Extracts concatenated text from an MCP Tool Call result's content array.
 */
export function extractErrorText(result: McpToolCallResult): string {
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) {
    return "";
  }
  return result.content
    .filter(
      (c): c is McpTextContent =>
        c !== null &&
        typeof c === "object" &&
        c.type === "text" &&
        typeof (c as any).text === "string",
    )
    .map((c) => c.text)
    .join("\n")
    .trim();
}

/**
 * Generates the deterministic synthetic blocked response when the circuit is OPEN.
 */
export function createBlockedResponse(
  id: JsonRpcId,
  toolName: string,
  repeats: number = 3,
): JsonRpcResponse<McpToolCallResult> {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      isError: true,
      content: [
        {
          type: "text",
          text: `⛔ Circuit OPEN: tool '${toolName}' repeated the same failure ${repeats} times. Change your strategy, use different arguments, or ask the user.`,
        },
      ],
    },
  };
}
