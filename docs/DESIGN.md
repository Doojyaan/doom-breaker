# DESIGN.md — doom-breaker visual identity

> Owner tahap: **VISION**. Semua aset SVG di-Commit langsung di `assets/` — handcrafted, tidak ada generate AI, tidak ada raster.

## 1. Konsep mark

**Satu ide:** *sirkuit sehat yang diputus sakelar terbuka, dengan bunga api di celahnya.*
(Konsep A — "Open Switch", dipilih user 2026-11-16)

- Jalur horizontal hijau = aliran tool call yang sehat.
- Sakelar terbuka merah 45° = circuit yang sudah trip.
- Bunga api kuning di celah = doom loop yang berhenti di situ.

Arsip konsep tidak terpilih: `assets/concepts/concept-b.svg` (broken loop),
`assets/concepts/concept-c.svg` (blown fuse).

## 2. Palet warna (identitas ketat)

| Peran | Hex | Dipakai di |
|---|---|---|
| Closed / sehat | `#2BA640` | jalur sirkuit, pesan sukses |
| Closed (accent) | `#9BE7A4` | kontak sirkuit |
| Tripped / peringatan | `#F5A623` | bunga api, diamond decision, pesan `circuit OPEN` |
| Open / blokir | `#E5484D` | lengan sakelar, `⛔ BLOCK`, exit code 3 |
| Latar gelap | `#0D1117` | tile logo, banner, diagram |
| Permukaan | `#161B22` / `#1C2128` | kotak node, window terminal |
| Garis / teks sekunder | `#30363D` / `#8B949E` / `#6E7681` | border, label, hint |
| Teks utama | `#E6EDF3` | wordmark, isi node |

Aturan: maksimal 3 warna aksen (hijau/kuning/merah) dalam satu visual; warna aksen
selalu bermakna status, bukan dekorasi — konsisten dengan output ANSI di CLI.

## 3. Tipografi

- **Wordmark & semua aset SVG:** stack monospace —
  `ui-monospace, 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, monospace`
- Aksen warna pada separuh kata: `doom-` putih + `breaker` merah.
- Mark icon sendiri **tanpa teks** (murni geometri, aman 16 px).

## 4. Inventaris aset

| File | Fungsi |
|---|---|
| `assets/logo.svg` | Mark final "Broken Loop" (tile gelap 256×256), favicon/avatar source |
| `assets/logo-mono-dark.svg` | Siluet satu warna `#E6EDF3`, latar gelap (tanpa tile) |
| `assets/logo-mono-light.svg` | Siluet satu warna `#0D1117`, latar terang (tanpa tile) |
| `assets/logo-small.svg` | Small-size cut untuk 16–32 px (stroke lebih tebal, tanpa panah) |
| `assets/concepts/` | Arsip konsep A & C yang tidak terpilih |
| `assets/banner.svg` | Hero header README (1200×300) |
| `assets/architecture.svg` | Diagram alur eksekusi (README "How it works") |
| `assets/demo.svg` | Mock terminal: 3 fail → OPEN → blocked → pulih via probe (README) |

## 5. Aturan pemakaian

- Clear space di sekeliling mark ≥ lebar satu pad sirkuit.
- Mark tidak boleh diputar, dimiringkan, atau diganti warna selain tabel di atas.
- Versi satu warna: pakai siluet monokrom `#E6EDF3` (terang) atau `#0D1117` (gelap).
- Diagram & banner menempel pada palet yang sama agar README terasa satu sistem.
