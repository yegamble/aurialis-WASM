# Aurialis-WASM Design & Branding System Specification

> **Canonical Reference**: Derived from [`docs/design/aurialis-redesign.md`](aurialis-redesign.md), [`docs/design/aurialis-redesign-d7a69d24.md`](aurialis-redesign-d7a69d24.md), and the Figma Make reference (`docs/design/figma-make-reference/`), structured with the guardrail rigor of `vidra` (`design-system.md`).
> **Scope**: All Next.js 16 routes (`src/app/**`), shared UI primitives (`src/components/shared/**`), custom SVG audio visualizations (`src/components/audio/**`), and Playwright accessibility/responsive gates (`e2e/**`).

---

## 1. Design Philosophy & Brand Identity

### 1.1 Warm Editorial Mastering Studio

Aurialis-WASM rejects generic dark-neon DAW skins and sci-fi plugin skeuomorphism. It feels like a **quiet, tactile, daylight mastering room** built from warm archival paper, ink, terracotta clay, sage moss, and brass ochre:

1. **Listening First, Numbers Second**: Every control explains its musical effect in plain language (`Warm`, `Open`, `Streaming -14 LUFS`, `Tame harsh upper-mids`) alongside precise `tabular-nums` engineering telemetry (`LUFS`, `dBTP`, `DR`, `Hz`, `dB`).
2. **Progressive Disclosure**:
   - **Simple Mode**: Outcome-led genre, tone, loudness target, and intensity controls.
   - **Advanced Mode**: Direct 5-band parametric EQ, program-dependent compressor, harmonic saturation (`Warm`/`Thick`/`Crisp`), stereo width + Linkwitz-Riley mono-bass, and 4× oversampled true-peak limiter.
   - **Deep Mode**: AI/LLM `MasteringScript` v1 section-by-section dynamic automation across 5 lanes (`Volume`, `EQ`, `Comp/Sat`, `Width`, `AI Repair`) with 5 engineer profiles (`Warm Analog`, `Punchy Commercial`, `Dynamic & Open`, `Vocal Forward`, `Bass Heavy`).
3. **Brand Mark & Listening Geometry**:
   - The `.brand-mark` (`38×38px` circular emblem in `--ink` with a `1px solid var(--paper)` inset ring at `7px`) and [`public/favicon.svg`](../../public/favicon.svg) evoke an acoustic listening aperture and vinyl/tape reel geometry.
   - Primary upload surfaces use the sculpted `.drop-zone` arch (`border-radius: 140px 140px 28px 28px`) with subtle `feTurbulence` archival paper grain (`opacity: 0.25`, disabled automatically under `@media (prefers-contrast: more)`).

---

## 2. HCL / OKLCH Perceptual Color System & WCAG 2.2 AA Contract

All tokens are calibrated in **OKLCH / HCL perceptual color space** so surface elevations, status washes, and stem/automation lanes maintain uniform perceptual lightness and pass **WCAG 2.2 AA** (`>= 4.5:1` normal text, `>= 3.0:1` large text and interactive boundaries) and **APCA** (`Lc >= 75` primary copy, `Lc >= 60` secondary copy).

### 2.1 Surface, Ink & Border Tokens

| CSS Custom Property | Hex | OKLCH Approximation | Role | Contrast vs `--paper` (`#faf7f0`) | Contrast vs `--paper-deep` (`#e9e3d9`) |
|---|---|---|---|---|---|
| `--canvas` | `#f2eee6` | `oklch(0.949 0.011 78)` | App background canvas | — | — |
| `--paper` | `#faf7f0` | `oklch(0.976 0.008 80)` | Elevated card / workspace surface | `1.00:1` | — |
| `--paper-deep` | `#e9e3d9` | `oklch(0.916 0.014 78)` | recessed well / pill / meter track | — | `1.00:1` |
| `--ink` | `#29231f` | `oklch(0.256 0.014 50)` | Primary text & active fills | **`14.12:1` (AAA)** | **`11.93:1` (AAA)** |
| `--ink-soft` | `#615850` | `oklch(0.472 0.017 58)` | Secondary labels, kickers, muted copy *(rectified from `#6f665e` `4.42:1`)* | **`6.55:1` (AA)** | **`5.54:1` (AA)** |
| `--line` | `#d7cfc3` | `oklch(0.854 0.016 75)` | Hairline structural dividers | Decorative (`1.44:1`) | — |
| `--line-dark` | `#94897d` | `oklch(0.630 0.018 72)` | Interactive input / control borders | **`3.18:1` (AA UI)** | — |

### 2.2 Semantic Accent & Status Tokens

| CSS Custom Property | Hex | OKLCH Approximation | Semantic Meaning | AA Paired Text / Surface Contract |
|---|---|---|---|---|
| `--clay` | `#b4543c` | `oklch(0.565 0.128 36)` | Primary brand accent, active A/B & EQ handle | White `#ffffff` on `--clay-dark` (`#8e3f2e`, **`6.42:1` AA**) |
| `--clay-dark` | `#8e3f2e` | `oklch(0.472 0.116 35)` | High-contrast clay text & hover fill | **`6.01:1` AA** on `--paper`, **`4.92:1` AA** on `--clay-wash` |
| `--clay-wash` | `#ecd7cf` | `oklch(0.892 0.028 38)` | Active nav / selected card wash | Paired with `--ink` (**`11.4:1`**) or `--clay-dark` (**`4.92:1`**) |
| `--moss` | `#596c52` | `oklch(0.515 0.041 138)` | Mastered / Pass / Healthy meter fill | Paired with `--moss-dark` for text on washes |
| `--moss-dark` | `#3f5139` | `oklch(0.420 0.042 138)` | Status badge text on `--moss-wash` *(rectified from `4.31:1`)* | **`6.60:1` AA** on `--moss-wash` (`#dce2d7`) |
| `--moss-wash` | `#dce2d7` | `oklch(0.905 0.016 138)` | Mastered / Ready status pill surface | Paired with `--moss-dark` (`#3f5139`, **`6.60:1` AA**) |
| `--ochre` | `#b8893d` | `oklch(0.658 0.106 78)` | Warning / Caution / Processing accent | Paired with `--ochre-dark` for text |
| `--ochre-dark` | `#6d5220` | `oklch(0.450 0.076 78)` | Warning badge text on `--ochre-wash` | **`5.90:1` AA** on `--ochre-wash` (`#eee0bd`) |
| `--ochre-wash` | `#eee0bd` | `oklch(0.908 0.045 84)` | Warning / Finding pill surface | Paired with `--ochre-dark` (`#6d5220`, **`5.90:1` AA**) |
| `--danger` | `#9c3d32` | `oklch(0.502 0.132 30)` | Clipping / True-Peak over / Error / Delete | **`5.88:1` AA** on `--paper`; white `#ffffff` (**`5.88:1`**) on `--danger` |

### 2.3 Perceptually Balanced Stem & Automation Lane Palette

All 6 stem channels and 5 Deep automation lanes are normalized around uniform OKLCH lightness ($L \approx 0.51\text{–}0.55$) so no stem or lane visually dominates by brightness alone:

1. **Vocals / Volume Lane (`--lane-1`)**: `#b4543c` (`oklch(0.565 0.128 36)` — Terracotta Clay)
2. **Drums / EQ Lane (`--lane-2`)**: `#596c52` (`oklch(0.515 0.041 138)` — Sage Moss)
3. **Bass / Comp-Sat Lane (`--lane-3`)**: `#8a6529` (`oklch(0.535 0.088 76)` — Burnished Ochre)
4. **Other / Width Lane (`--lane-4`)**: `#78638b` (`oklch(0.530 0.062 305)` — Muted Plum)
5. **Guitar / AI Repair Lane (`--lane-5`)**: `#4f7482` (`oklch(0.538 0.048 220)` — Slate Petrol)
6. **Piano (`--lane-6`)**: `#936856` (`oklch(0.545 0.056 48)` — Warm Umber)

---

## 3. Typography & Numeric Discipline

- **Display Serif (`--serif`)**: `'Newsreader', Georgia, serif` (`font-weight: 500`, `letter-spacing: -0.025em`, `line-height: 1.08`). Used for page titles, section headers, and track titles.
- **UI & Engineering Sans (`--sans`)**: `'Instrument Sans', -apple-system, BlinkMacSystemFont, sans-serif`.
- **Minimum Font Size Floor**: **`11px` (`0.6875rem`)** across all kickers, badges, axis labels, and bottom-nav captions (eliminating sub-legible `7px`–`8px` micro-text).
- **Tabular Numerals Invariant**: Every timecode (`0:00 / 3:18`), meter readout (`-14.0 LUFS`, `-1.0 dBTP`, `9.2 dB`), slider value, EQ frequency/gain/Q input, and progress percentage **must** apply `font-variant-numeric: tabular-nums` so live updates never cause horizontal layout jitter.

---

## 4. Mobile-First Responsive Architecture (`320px` to `1440px+`)

Aurialis-WASM is styled **mobile-first** (`320px–390px`) and progressively enhanced at tablet (`768px`) and desktop workstation (`1024px–1440px+`):

| Viewport Tier | Breakpoint | Navigation & Shell | Mastering Workspace Layout |
|---|---|---|---|
| **Mobile Phone** | `320px–767px` | Compact top header + persistent 4-item bottom nav (`Home`, `Library`, `Albums`, `Tools`) | Single-column flow: Track header → Waveform/Spectrum → Sticky mini-transport docked above bottom nav (`bottom: 66px`, `scroll-padding-bottom: 160px`) → Mode tabs (`Simple`, `Advanced` accordions, `Deep` horizontal scroll timeline with `position: sticky; left: 0` lane headers and `BottomSheet` move editor). |
| **Tablet** | `768px–1023px` | Compact rail or top bar | Stacked canvas + 2-column control grid; full transport bar. |
| **Desktop Workstation** | `1024px–1440px+` | Persistent `236px` left `.rail` with active track indicator | 2-column `.workspace-layout` (`minmax(0, 1fr) 390px` inspector), full-width waveform/spectrum/Deep timeline canvas, and sticky bottom transport. |

### 4.1 Non-Negotiable Touch & Pointer Rules

1. **Minimum `44×44px` Interactive Target (`WCAG 2.5.8`)**: Every button, icon button, filter chip, segmented mode tab, A/B switch, checkbox row, select, EQ band handle, Deep timeline move button, and stem `Mute`/`Solo` button must have an interactive hit area of at least **`44×44px`**. Thin visual bars (such as `16px` Deep timeline move pills) use a `44px` row container or `::after` hit-target expansion.
2. **Single-Pointer & Keyboard Parity (`WCAG 2.5.7`)**: Every draggable control (5-band EQ SVG nodes, waveform seek, album track ordering) has a direct keyboard and single-click numeric/button equivalent (`Band 1..5` frequency/gain/Q inputs, keyboard arrow seek, explicit `Move up` / `Move down` track order buttons).
3. **Zero Horizontal Overflow**: `document.documentElement.scrollWidth <= document.documentElement.clientWidth` must hold at `320px`, `375px`, `390px`, `768px`, `1024px`, and `1440px`.

---

## 5. Component State Matrix Contract

Every route and shared primitive implements explicit, non-color-only state representations:

- **`DropZone` & `HomePage`**: `idle` · `drag-active` · `validating` · `analyzing` (with compact file receipt) · `ready` · `unsupported-file` · `corrupt-audio` · `multi-file-summary` · `storage-warning`.
- **`LibraryPage`**: `loading-skeleton` · `empty` · filtered (`All`, `Draft`, `Mastered`, `Stem project`, `Needs review`) · `missing-blob-relink` · `delete-confirm-modal`.
- **`MasterPage` (`Simple`, `Advanced`, `Deep`)**: `original-A` vs `mastered-B` (with `Level match` loudness-compensated A/B toggle) · per-module `enabled`/`bypassed` · Deep `profile-dirty-confirm` · job `queued`/`running` (`aria-live="polite"` + cancel) / `interrupted-retry` / `failed` · move `default` / `selected` / `edited` (badge) / `muted` (badge + strikethrough) · `ExportModal` (`16-bit` / `24-bit` / `32-bit float` WAV + TPDF dither).
- **`SplitPage` (`2–6` Stems)**: Stem count selector (`2`, `3`, `4`, `5`, `6`) with existing-stem replacement confirmation modal · per-stem `Mute`, `Solo`, `Level` (`0–140%`), `Pan` (`-100..+100`), inline editable label, individual WAV download, and summed stem-mix WAV export.
- **`AlbumsPage`, `ReferencePage`, `ReleaseCheckPage`**: Outlier badge explanations, `Loudness`/`Tone`/`Dynamics` consistency views, target reference curve overlay with `Apply match to track`, and grouped release readiness (`Passed`, `Consider`, `Fix before release`).
