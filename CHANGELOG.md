## [0.1.0] - 2026-11-16
### Added
- `exec` command with `--tool`, `--max-repeats`, `--state-file`, and `--json` options.
- `status` command to inspect circuit state.
- `reset` command to clear circuit state for a specific tool or all tools.
- Deterministic SHA-256 fingerprinting of tool, arguments, and normalized error.
- Circuit breaker logic that blocks identical consecutive calls after `--max-repeats` (default 3).
- Exit codes: 0 success, 1 child failure, 2 usage error, 3 blocked.
- Anti-injection execution without a shell.
- Local-first JSON state file with atomic writes.