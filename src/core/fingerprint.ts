import { createHash } from "node:crypto";

export interface FingerprintInput {
  /** Logical tool name, e.g. "curl", "npm", "web-search". */
  tool: string;
  /** Arguments passed to the tool (JSON-serializable). */
  args: unknown;
  /** Raw error/combined output produced by the failing call. */
  error: string;
}

/**
 * Normalize noisy parts of an error so that two *semantically identical*
 * failures produce the same fingerprint even when timestamps, memory
 * addresses, or big counters differ between runs.
 */
export function normalizeError(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    // ISO-ish timestamps: 2026-11-16T10:00:00.000Z, 2026-11-16 10:00:00, etc.
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    // Memory addresses / hex pointers.
    .replace(/\b0x[0-9a-fA-F]+\b/g, "0x<addr>")
    // Big numeric literals (counts, byte sizes, ms timers).
    .replace(/\b\d[\d,\.]{3,}\b/g, "<n>")
    .trim();
}

/**
 * Deterministic 16-hex-char fingerprint of a failing tool call.
 * Same (tool, args, normalized error) => same fingerprint, always.
 */
export function fingerprint(input: FingerprintInput): string {
  const normalized = JSON.stringify({
    tool: input.tool,
    args: input.args,
    error: normalizeError(input.error),
  });
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Fingerprint of (tool, args) WITHOUT the error — computable *before* a call
 * runs. Used at preflight to distinguish "the same doomed call again"
 * (block it) from "a changed strategy" (let it through as a probe).
 */
export function argsFingerprint(input: Omit<FingerprintInput, "error">): string {
  const normalized = JSON.stringify({ tool: input.tool, args: input.args });
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
