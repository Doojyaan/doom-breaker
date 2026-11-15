import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CircuitRecord {
  /** closed = allowed; open = blocks identical-args calls until reset or success. */
  state: "closed" | "open";
  lastFingerprint: string | null;
  /** Fingerprint of (tool, args) of the last failure — known before execution. */
  lastArgsFingerprint: string | null;
  repeatCount: number;
  openedAt: string | null;
}

export interface DoomState {
  version: 1;
  tools: Record<string, CircuitRecord>;
}

export interface StateStore {
  load(): Promise<DoomState>;
  save(state: DoomState): Promise<void>;
}

export const DEFAULT_STATE_FILE = ".doombreaker/state.json";

function emptyRecord(): CircuitRecord {
  return { state: "closed", lastFingerprint: null, lastArgsFingerprint: null, repeatCount: 0, openedAt: null };
}

/**
 * JSON-file backed store with atomic writes (tmp + rename).
 * A missing or corrupt state file is treated as a fresh state —
 * doom-breaker must never crash the host workflow because of its own state.
 */
export class FileStateStore implements StateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<DoomState> {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<DoomState>;
      if (
        parsed &&
        parsed.version === 1 &&
        parsed.tools &&
        typeof parsed.tools === "object" &&
        !Array.isArray(parsed.tools)
      ) {
        return parsed as DoomState;
      }
    } catch {
      /* missing or corrupt -> fresh state */
    }
    return { version: 1, tools: {} };
  }

  async save(state: DoomState): Promise<void> {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }
}

export { emptyRecord };
