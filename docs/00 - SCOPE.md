# SCOPE & SPEC — doom-breaker v0.1.0 (MVP)

> Owner tahap: **F.R.I.D.A.Y.** (scope & tiket). Direview oleh **VISION**.

## 1. Masalah (bukti)

Agent AI terjebak *doom loop*: memanggil tool yang sama berulang kali dengan
parameter identik dan menerima error identik, tanpa mengubah strategi.

| Bukti | Sumber |
|---|---|
| ARCBench: aturan dilanggar lebih sering saat agent berulang pada konteks sama | arXiv 2608.11888 |
| Keluhan "agent stuck calling same tool 10-20x, burned my tokens" berulang di r/ClaudeAI & GitHub issues | R1/R3 korpus riset |
| GitHub API: `agent doom loop` = **0 hasil**, `agent loop breaker` = **0 tooling mandiri** | Fase 0, 2026-11-16 |

## 2. Solusi MVP (satu kalimat)

CLI *circuit breaker* yang membungkus eksekusi tool: mem-fingerprint
(tool + args + error), menghitung kegagalan identik beruntun, dan **memblokir**
panggilan berikutnya (exit code 3) dengan pesan korektif yang bisa dibaca agent.

## 3. In Scope (MVP)

- [x] `exec` — jalankan perintah di bawah proteksi circuit breaker
- [x] Fingerprint deterministik: SHA-256 dari (tool, args, error ter-normalisasi)
- [x] Normalisasi error: timestamp, alamat memori, angka besar → placeholder
- [x] State file lokal `.doombreaker/state.json` (atomic write, corrupt-safe)
- [x] Status circuit: `closed` / `open`
- [x] `status` — tabel kondisi semua circuit
- [x] `reset [<tool>]` — buka satu atau semua circuit
- [x] `--json` — event machine-readable untuk integrasi agent
- [x] `--max-repeats N` — ambang trip yang bisa diatur (default 3)
- [x] Exit code yang kontrak: 0 / 1 / 2 / 3

## 4. Out of Scope (v0.1)

- Proxy MCP penuh / intersepsi semua tool call (roadmap v0.2)
- Mode `watch` menempel pada transcript agent (roadmap v0.2)
- Machine learning / heuristik semantik (v0.1 deterministik murni)
- Integrasi cloud / dashboard

## 5. Tiket per Agen

| Tiket | Agen | Deliverable | Status |
|---|---|---|---|
| T-01 Pecah scope & boundary | F.R.I.D.A.Y. | dokumen ini | ✅ |
| T-02 Core: fingerprint + state + circuit | J.A.R.V.I.S. | `src/core/*.ts` | ✅ |
| T-03 CLI: parsing argumen, warna, exit codes | E.D.I.T.H. | `src/cli.ts` | ✅ |
| T-04 Adversarial tests: trip, reset, corrupt state, e2e | ULTRON | `test/*.ts` | ✅ |
| T-05 Packaging: package.json, tsconfig, CI workflow, lint | D.U.M.-E. | root + `.github/` | ✅ |
| T-06 Jalankan test, tampilkan bukti | U | output `npm test` | ✅ |
| T-07 README final + review rilis | VISION | `README.md` | ✅ |

## 6. Kontrak Exit Code

| Kode | Arti |
|---|---|
| 0 | Perintah sukses |
| 1 | Perintah gagal (dipass-through dari child process) |
| 2 | Kesalahan pemakaian CLI |
| 3 | **Diblokir** — circuit OPEN, panggilan identik tidak dieksekusi |
