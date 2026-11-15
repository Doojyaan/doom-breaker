import type { CircuitRecord, StateStore } from "./state.js";

export interface Preflight {
  allowed: boolean;
  repeats: number;
  reason: "ok" | "circuit_open";
}

export interface RecordResult {
  repeats: number;
  /** True only on the transition closed -> open. */
  tripped: boolean;
}

export const DEFAULT_MAX_REPEATS = 3;

function emptyRecord(): CircuitRecord {
  return { state: "closed", lastFingerprint: null, lastArgsFingerprint: null, repeatCount: 0, openedAt: null };
}

/**
 * The heart of doom-breaker: counts *consecutive identical failures* per tool
 * and trips the circuit open at `maxRepeats`. One success (or a different
 * fingerprint chain) resets the counter — a changed argument means a changed
 * strategy, which is exactly what we want to encourage.
 */
export class Circuit {
  constructor(
    private readonly store: StateStore,
    private readonly maxRepeats: number = DEFAULT_MAX_REPEATS,
  ) {}

  /**
   * Preflight check. When the circuit is OPEN, a call whose (tool, args)
   * fingerprint matches the last failing call is blocked; a call with
   * different arguments is a changed strategy and is allowed as a probe.
   */
  async preflight(tool: string, argsFp: string): Promise<Preflight> {
    const s = await this.store.load();
    const t = s.tools[tool];
    if (t?.state === "open") {
      if (argsFp === t.lastArgsFingerprint) {
        return { allowed: false, repeats: t.repeatCount, reason: "circuit_open" };
      }
      // Open, but this call changed arguments — allow the probe.
      return { allowed: true, repeats: t.repeatCount, reason: "ok" };
    }
    return { allowed: true, repeats: t?.repeatCount ?? 0, reason: "ok" };
  }

  async record(
    tool: string,
    fp: string,
    argsFp: string,
    outcome: "success" | "failure",
  ): Promise<RecordResult> {
    const s = await this.store.load();

    if (outcome === "success") {
      s.tools[tool] = emptyRecord();
      await this.store.save(s);
      return { repeats: 0, tripped: false };
    }

    const t = s.tools[tool] ?? emptyRecord();
    t.repeatCount = t.lastFingerprint === fp ? t.repeatCount + 1 : 1;
    t.lastFingerprint = fp;
    t.lastArgsFingerprint = argsFp;

    let tripped = false;
    if (t.repeatCount >= this.maxRepeats && t.state === "closed") {
      t.state = "open";
      t.openedAt = new Date().toISOString();
      tripped = true;
    }
    s.tools[tool] = t;
    await this.store.save(s);
    return { repeats: t.repeatCount, tripped };
  }

  /** Clear one tool's circuit, or all of them when `tool` is omitted. Returns count cleared. */
  async reset(tool?: string): Promise<number> {
    const s = await this.store.load();
    let cleared = 0;
    for (const key of Object.keys(s.tools)) {
      if (tool === undefined || key === tool) {
        delete s.tools[key];
        cleared++;
      }
    }
    await this.store.save(s);
    return cleared;
  }
}
