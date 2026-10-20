# Aurialis High-Fidelity Redesign Plan

## 1. Goal

Rebuild the blank React/Vite prototype as a polished, mobile-first audio-mastering workspace with a warm editorial identity. The result should feel calm, tactile, and human rather than like a conventional dark audio plugin, while still presenting credible mastering information and controls.

The prototype will:

- Accept real local audio through click, drag/drop, and clipboard paste.
- Play and scrub uploaded audio in the browser.
- Simulate analysis, mastering, stem separation, reference matching, release checks, and exports with believable progress and deterministic results.
- Persist the user's library, project settings, albums, reports, and uploaded audio in the current browser.
- Include no login or account flow and no backend.
- Be designed mobile-first, then expand into a desktop audio-workstation layout.

## 2. Confirmed Scope and Constraints

### Product decisions

- Fidelity: high-fidelity interactive prototype.
- Core screens: upload, simple mastering, advanced mastering, smart stem splitter, library, and album organiser.
- Researched additions: reference matching and release check.
- Audio depth: real upload/playback, simulated DSP and analysis.
- Persistence: local browser persistence.
- Identity: no authentication screens; only a small local profile/settings affordance if useful.
- Responsive strategy: establish controls and task flow on mobile first, then provide a purpose-built desktop audio layout rather than merely stretching the mobile UI.
- Deep mode: a faithful interactive simulation of the production repository's versioned `MasteringScript` workflow, including five engineer-style profiles, section-aware analysis, AI-artifact findings, and editable automation moves. It remains an honest simulation and does not perform real AI analysis or DSP.
- Smart Split: an exact stem-count selector for every value from 2 through 6, not only production-model presets.

### Repository facts

- The repository is a clean React 19 + TypeScript + Vite 8 scaffold.
- Tailwind CSS v4 is available through the Vite plugin.
- Existing app code is effectively blank, with no reusable UI or state model.
- Use `pnpm`; do not start another development server because the Figma Make server is already supervised.
- Current broad verification commands are `pnpm format` and `pnpm build`.

### Explicit non-goals

- No server, shared cloud library, collaboration, authentication, or cross-device sync.
- No real mastering DSP, machine-learning model, source separation, spectral analysis, or transcoding.
- No claim that a simulated processed export contains actual mastering changes.
- No billing, pricing, onboarding tour, or public marketing site.
- No reproduction of the current site's black/blue visual styling.

## 3. Experience Architecture

Use browser routes so each major workspace is addressable and browser back/forward works:

- `/` — upload/home
- `/library` — saved tracks and projects
- `/master/:trackId` — mastering workspace; simple, advanced, and deep modes are internal tabs
- `/split/:trackId` — smart stem splitter
- `/albums` — album list and creation
- `/albums/:albumId` — album consistency workspace
- `/reference/:trackId` — reference matching
- `/release-check/:trackId` — technical and distribution readiness report

Add `react-router-dom` for routing and `lucide-react` for a consistent icon set. Avoid emoji and one-off text symbols for interface icons.

### Global responsive shell

**Mobile**

- Compact top bar with Aurialis wordmark, current context, and overflow/settings action.
- Four-item bottom navigation: Home, Library, Albums, Tools.
- Tool-specific secondary navigation uses segmented controls or a compact horizontal scroller.
- Mastering controls open as inline sections or bottom sheets; the transport remains reachable with a sticky mini-player.
- All primary actions and sliders have at least 44px touch targets.

**Tablet**

- Bottom navigation can remain, while analysis cards become a two-column grid.
- Advanced controls and charts can sit side-by-side where space allows.

**Desktop**

- Persistent narrow left navigation rail with brand, primary destinations, and recent projects.
- Main canvas contains the waveform, meters, spectrum/EQ visualization, and workflow content.
- Contextual inspector sits on the right for mastering controls, stem settings, reference parameters, or release details.
- Sticky transport spans the bottom of the working canvas.
- Use responsive caps and fluid columns so the interface works at laptop widths and does not become excessively sparse on wide monitors.

## 4. Visual System

Before implementation, invoke the `make/use-design-system` skill and establish reusable tokens rather than styling screens ad hoc.

### Direction

- Editorial, understated, tactile, and quietly technical.
- Warm paper canvas with subtle grain/noise made in CSS; no photography is needed for this utility product.
- Dark brown-charcoal ink rather than pure black.
- Terracotta/clay as the main action color; muted moss and ochre as supporting data colors.
- Thin warm-gray rules, restrained shadows, and modest corner radii.
- Generous whitespace around headings and task transitions, balanced with compact control groups where technical density is useful.
- Abstract album and waveform artwork can use simple CSS/SVG line work and blocks of color rather than stock imagery.

### Proposed typography

- `Newsreader` for display headings, track titles, large metrics, and editorial moments.
- `Instrument Sans` for navigation, controls, labels, and dense technical text.
- Load both as public Google fonts in `src/index.css`, with resilient serif/sans-serif fallbacks.
- Use tabular numerals for timers, LUFS, dB, sample-rate, and peak values.

### Core tokens

Define CSS custom properties and Tailwind theme mappings for:

- Canvas, raised paper, sunken paper, ink, secondary ink, border, terracotta, moss, ochre, warning, and destructive colors.
- Display/body/mono-numeric font stacks.
- A restrained spacing scale, card radii, fine borders, and two shadow levels.
- Motion durations/easing, with `prefers-reduced-motion` disabling nonessential movement.

### Signature details

- A typographic Aurialis wordmark with a small circular “listening mark.”
- Hairline dividers and index-like uppercase eyebrow labels.
- Waveforms and analysis charts drawn as custom responsive SVG, using slightly imperfect line rhythms.
- Processing states represented by a moving scan line and changing editorial status copy, not neon glows.
- Focus rings use a strong dark/clay contrast and remain visible on paper surfaces.

## 5. Screen Specifications

### A. Upload/Home

Purpose: create the shortest path from arrival to a playable mastering project.

- Editorial hero: “Master with your ears intact” or similarly restrained copy, short supporting text, and local-only privacy note.
- Large paper drop zone supporting:
  - click to browse,
  - drag enter/leave/drop,
  - document-level paste of an audio file,
  - keyboard activation.
- Show supported formats based on browser playback capability, not a promise of universal codec support.
- On selection, validate MIME/type and attempt metadata loading.
- After metadata is available, show a compact track receipt with filename, duration, size, and detected format, then move into an analysis progress state.
- “Try the workspace” demo entry uses a seeded visual project; real playback becomes available after uploading a file.
- Lower section shows recent projects and three concise workflow cards: Master, Split, Check release.

States: idle, drag-active, validating, analyzing, ready, unsupported file, unreadable/corrupt audio, and storage warning.

### B. Library

Purpose: resume work without losing mastering state.

- Search, filter chips (All, Draft, Mastered, Stem project, Needs review), and sort.
- Mobile card view; desktop editorial table/list with artwork, title, duration, modified date, status, LUFS target, and album.
- Each item supports resume, quick play, add to album, duplicate settings, and delete.
- Destructive delete requires confirmation and removes both metadata and stored audio.
- Empty state routes directly to upload.
- Storage usage indicator in a small settings panel; explain that projects live only in this browser.

### C. Mastering Workspace

Shared composition:

- Track header with title, file metadata, saved-state indicator, Split stems, Reference, Release check, and Export actions.
- Responsive waveform with current-time playhead, click/touch seek, elapsed/total time, play/pause, restart, and volume.
- A/B control:
  - A is the original uploaded file.
  - B is the simulated processed state and uses the same source audio; the UI and metrics change, but copy must not imply that real DSP has occurred.
- Analysis strip: integrated LUFS, true peak, loudness range, dynamic range, and stereo correlation.
- Simple/Advanced/Deep segmented mode control.
- All meaningful edits autosave.

#### Simple mode

- Genre presets: Pop, Hip-hop, Rock, Electronic, Acoustic, R&B, Classical, Podcast.
- Tone intent cards: Warm, Open, Punchy, Intimate, Wide, Clean.
- Large intensity control that is usable as a slider on mobile and a dial-like visualization on desktop.
- Output targets: Streaming balanced, Loud, Dynamic, Podcast, and Custom.
- “Create master” starts a staged simulated job: listening, balancing, finishing.
- Completion updates metrics, report status, and library state, with undo/reset.

#### Advanced mode

- Interactive EQ response SVG with five draggable band points and corresponding accessible numeric controls.
- Compressor: threshold, ratio, attack, release, makeup gain, and bypass.
- Stereo image: width and mono-bass controls.
- Limiter: ceiling, target LUFS, release, and true-peak toggle.
- Saturation/color: amount and character.
- Module enable/bypass, reset, and preset handoff from Simple mode.
- Mobile presents modules as accordions; desktop uses the right inspector while the visualization remains in the main canvas.
- Values update the simulated analysis deterministically so controls feel connected rather than decorative.

#### Deep mode

Deep mode mirrors the production repository's interaction model and `MasteringScript` version 1 shape, but generates all results deterministically in the browser.

- Five engineer-style profiles, using the production IDs and neutral labels:
  - `modern_pop_polish` — Modern Pop Polish
  - `hip_hop_low_end` — Hip-Hop Low-End
  - `indie_warmth` — Indie Warmth
  - `metal_wall` — Metal Wall
  - `pop_punk_air` — Pop Punk Air
- Selecting a profile stages it; Apply regenerates the deterministic script. If any move has been edited, confirm before discarding those edits.
- “Analyze deeply” runs cancellable staged progress through:
  1. Detecting sections
  2. Analyzing stems and artifacts
  3. Writing the mastering script
- Show elapsed time, overall progress, current phase, completed-phase durations, cancel, retry, and a concise simulated-failure state.
- Generate labeled sections from the production vocabulary: intro, verse, chorus, bridge, drop, breakdown, outro, and unknown. Each section stores start/end time, simulated loudness, and spectral centroid.
- Generate a versioned `MasteringScript` containing track ID, sample rate, duration, profile, sections, moves, and optional stem-analysis reports.
- Present a section strip and five automation lanes: Volume, EQ, Comp/Sat, Width, and AI Repair. A shared playhead follows the global transport.
- Moves use the production parameter vocabulary for input gain, compressor controls, five EQ bands, saturation, stereo width, and AI Repair. Each move stores its time range, envelope points, reason, original value, edited state, and muted state.
- Clicking or tapping a move opens an accessible editor with its parameter, section/time range, explanation, current value, mute/unmute, reset, and a bounded value control. Editing shifts the displayed envelope while preserving its shape.
- Edited and muted moves receive distinct non-color indicators. Reset restores the original simulated proposal. A text summary provides an accessible equivalent to the timeline.
- The AI Repair lane is populated only when deterministic artifact analysis flags a stem. Reports expose classification, confidence, narrowness, spectral-collapse score, and band correlations; copy frames these as simulated indicators, not proof that a track is AI-generated.
- Script A/B toggles the active script without moving the playhead. Both states play the same source Blob; only the UI, timeline state, and simulated metrics differ.
- Deep scripts, profile choice, move edits/mutes, artifact reports, and interrupted status persist with the project. Reopening a project restores the last completed script.
- Mobile remains fully functional: profiles become a horizontal/card selector, the timeline is horizontally scrollable with sticky lane labels, and move editing uses a bottom sheet. Desktop uses the main canvas for the timeline and the right inspector for profiles, progress, findings, and move details.

### D. Smart Stem Splitter

- If entered without a track, present the upload surface.
- Choose an exact output count with a 2–6 segmented/stepper selector. Each count deterministically maps to:
  - 2: Vocals, Instrumental
  - 3: Vocals, Drums, Other
  - 4: Vocals, Drums, Bass, Other
  - 5: Vocals, Drums, Bass, Melody, Other
  - 6: Vocals, Drums, Bass, Guitar, Piano, Other
- Changing the count before processing updates the preview labels; changing it after processing asks before replacing the current simulated stem layout and resets per-stem edits only after confirmation.
- Simulated job progresses through upload preparation, source analysis, and separation.
- Result workspace shows color-coded stem lanes with deterministic mini-waveforms.
- Each stem includes mute, solo, level, pan, and rename; advanced per-stem EQ is outside scope.
- Master transport moves one shared playhead. Solo/mute affects interface state; actual local playback remains the source mix.
- “Send to mastering” creates/updates a stem-origin master project and transfers the chosen mix settings.
- Export stems opens a prototype notice because no real source separation occurred.

### E. Albums

**Album index**

- Create, rename, open, and delete albums.
- Album cards show track count, target loudness, consistency score, and last modified date.

**Album workspace**

- Editorial album header with title, optional artist/release metadata, target preset, and track count.
- Add tracks from the library or import a new file.
- Reorder with drag on desktop and explicit move-up/move-down controls for keyboard/mobile accessibility.
- Per-track row: order, title, duration, measured LUFS, true peak, tonal marker, status, and open action.
- Consistency chart can switch among Loudness, Tone, and Dynamics.
- Flag outliers and explain why they differ.
- “Master album” runs a simulated batch job and normalizes the displayed target/results while preserving each track's individual settings.
- Persist ordering, album target, metadata, and result state.

### F. Reference Match

- Upload or choose a reference track from the local library.
- Side-by-side source/reference summary with loudness, tonal balance, dynamics, and stereo width.
- Overlay two tonal curves in a responsive SVG.
- Controls: match amount, prioritize tone/dynamics/width, and protect low end/transients.
- “Apply reference direction” writes derived settings into the selected track's mastering state and returns to the master workspace with an undoable change.
- Clearly frame results as a direction/match estimate in this prototype.

### G. Release Check

- Run a staged simulated scan, then show a release-readiness score.
- Checks:
  - integrated loudness versus selected platform target,
  - true peak/clipping,
  - dynamic range,
  - stereo/mono compatibility,
  - sample rate and file format,
  - leading/trailing silence,
  - metadata checklist.
- Group findings into Passed, Consider, and Fix before release.
- Platform selector for Spotify, Apple Music, YouTube, SoundCloud, CD, and Podcast.
- Each issue has plain-language guidance and, where applicable, a link to the relevant mastering control.
- Allow saving the report to the project and printing/downloading a text/JSON summary; do not fabricate a processed audio file.

### H. Export Flow

- Modal/sheet with file naming, format presentation, sample-rate/bit-depth options, and dither toggle for realism.
- Because there is no DSP/transcoding, the prototype may download the original uploaded Blob under a derived filename only after explicitly stating that this demo export contains the source audio unchanged.
- A saved release report can be downloaded separately as JSON.
- If the source Blob is unavailable, disable audio download and preserve the project/report state.

## 6. Data and State Design

### Domain models

Create typed models for:

- `Track`
  - id, title, original filename, MIME/extension, duration, size, created/updated timestamps
  - source kind (`upload`, `demo`, `stems`)
  - status (`draft`, `analyzing`, `ready`, `mastered`, `needs-review`)
  - deterministic waveform seed and analysis metrics
  - simple preset selections and advanced module settings
  - reference summary, latest release report, and optional album IDs
- `MasterSettings`
  - mode (`simple`, `advanced`, `deep`), genre, tone, intensity, output target, EQ bands, compressor, stereo, limiter, saturation
- `MasteringScript`
  - literal version `1`, track ID, sample rate, duration, selected production-compatible profile ID
  - typed `Section[]`, `Move[]`, and optional `StemAnalysisReport[]`
- `Section`
  - id, production-compatible section type, start/end seconds, loudness LUFS, spectral centroid Hz
- `Move`
  - id, closed production-compatible parameter ID, start/end seconds, ordered `[time, value]` envelope points, reason, original value, edited, and muted
- `StemAnalysisReport`
  - stem ID, classification, confidence, narrowness score, spectral-collapse score, and band correlations
- `StemProject`
  - source track, exact requested count (2–6), job status, stems, level/pan/mute/solo, phase score
- `Album`
  - id, title, artist/release fields, ordered track IDs, target, consistency status
- `ReferenceProfile`
- `ReleaseReport`
- `ProcessingJob`

### App state

- Use a focused React context + reducer, split into domain actions rather than one large page component.
- Load persisted entities before rendering route content; show a brief paper-skeleton state.
- Seed a few demo records only when the database is empty.
- Debounce autosaves for sliders and text edits; save structural actions immediately.
- Keep transient UI state (open sheet, current tab, hover/drag state) out of persistence.

### Persistence

Use native IndexedDB with a small typed wrapper:

- `projects` store for track metadata/settings/reports.
- `audio` store keyed by track ID for uploaded Blobs.
- `albums` store.
- `stemProjects` store.

Version the database schema from the beginning. Handle blocked/failed IndexedDB by falling back to in-memory state for the session and show a nonblocking warning. Object URLs must be created only while needed and revoked on source changes/unmount.

### Deterministic simulation

- Hash stable inputs (track ID/file metadata plus settings) to produce waveform samples, analysis metrics, consistency scores, and release findings.
- Use the same stable seed to produce Deep sections, stem-artifact reports, profile-specific moves, reasons, and envelope points. Different profiles must produce visibly different but repeatable trajectories while preserving section boundaries.
- Clamp values to plausible ranges and preserve sensible relationships, such as higher intensity increasing displayed loudness and potentially true peak.
- Processing jobs use short staged timers, can be cancelled by navigation, and write final state only when complete.
- Deep analysis failure is deterministic only when explicitly triggered by a development/demo affordance; normal user runs complete successfully. Interrupted Deep jobs reopen as “analysis interrupted” with retry rather than fabricating completion.
- Avoid random values on every render so reports and saved projects remain stable.

### Audio playback

- Centralize playback in one audio controller/hook backed by a single `HTMLAudioElement`.
- Expose source, duration, current time, playing state, seek, volume, and errors.
- Respect browser autoplay rules; playback starts only from user interaction.
- Handle source deletion or missing Blob without crashing.
- “Processed” A/B is representational only and must not create a second fake audio source.

## 7. Component and File Organization

Keep the architecture modular but proportionate to the prototype:

```text
src/
  App.tsx
  index.css
  main.tsx
  types/
    audio.ts
  data/
    demo.ts
    presets.ts
  state/
    AppProvider.tsx
    reducer.ts
  lib/
    db.ts
    simulate.ts
    audio.ts
    format.ts
  components/
    layout/
      AppShell.tsx
      Navigation.tsx
      PageHeader.tsx
    audio/
      Transport.tsx
      Waveform.tsx
      MetricStrip.tsx
      SpectrumChart.tsx
      DeepTimeline.tsx
      DeepMoveEditor.tsx
      EngineerProfilePicker.tsx
    controls/
      SliderField.tsx
      SegmentedControl.tsx
      Toggle.tsx
      ProcessingState.tsx
    shared/
      DropZone.tsx
      Modal.tsx
      EmptyState.tsx
      StatusBadge.tsx
  pages/
    HomePage.tsx
    LibraryPage.tsx
    MasterPage.tsx
    SplitPage.tsx
    AlbumsPage.tsx
    AlbumPage.tsx
    ReferencePage.tsx
    ReleaseCheckPage.tsx
```

Use native HTML controls wherever possible, enhancing their appearance without breaking keyboard behavior. Custom SVG graph interactions must have equivalent labeled form controls.

## 8. Error, Empty, and Edge Cases

- Reject non-audio clipboard/drop content with concise recovery text.
- Handle multiple dropped files by importing all valid files into the library and opening the first; summarize skipped files.
- Detect unsupported codecs by attempting media metadata load, not MIME alone.
- Sanitize filenames for display/export and retain the original separately.
- Handle zero-duration, corrupt, and unexpectedly large files.
- Warn before storing large Blobs and surface quota failures without losing in-memory work.
- Deduplicate only by a lightweight fingerprint (name, size, modified timestamp); ask whether to reuse or import another copy.
- Preserve projects whose audio Blob is missing; show “relink source” rather than deleting their settings.
- Confirm destructive track/album deletion.
- Prevent albums from referencing deleted tracks.
- Processing states remain recoverable after refresh by marking interrupted jobs as paused/needs rerun.
- All dialogs trap focus, close with Escape, and restore focus.
- Charts have text summaries; color is never the sole carrier of pass/warning/fail state.

## 9. Implementation Sequence

1. **Foundation**
   - Load the design-system skill.
   - Add router and icon dependencies.
   - Define typography, color, spacing, focus, surface, and motion tokens in `src/index.css`.
   - Build the responsive shell and route skeletons.

2. **Data layer**
   - Add domain types, deterministic simulation helpers, reducer/context, IndexedDB wrapper, seed records, and persistence loading/error states.
   - Build the shared audio controller and Blob URL lifecycle.

3. **Primary entry and library**
   - Implement upload/drop/paste validation, metadata extraction, simulated analysis, and recent-project handoff.
   - Implement persisted library search, filtering, actions, empty/error states, and storage messaging.

4. **Mastering core**
   - Build transport, waveform, metrics, simple presets, targets, simulated job, autosave, A/B representation, and export disclosure.
   - Add advanced modules and responsive EQ/spectrum SVGs with accessible control equivalents.
   - Add the production-compatible Deep types, deterministic script generator, five-profile picker, staged/cancellable analysis, artifact findings, responsive automation timeline, move editor, profile-switch guard, script A/B state, and persistence.

5. **Connected tools**
   - Implement the exact 2–6 stem selector, deterministic stem mappings, split job/results, count-change confirmation, and “send to mastering.”
   - Implement album index, track selection/order, consistency visualization, and batch simulation.
   - Implement reference comparison/application.
   - Implement release-check scan, platform targets, findings, and report export.

6. **Polish**
   - Complete loading, empty, interruption, unsupported-file, quota, missing-audio, and delete-confirmation states.
   - Add restrained motion and reduced-motion handling.
   - Audit mobile touch ergonomics, keyboard flow, focus visibility, contrast, overflow, and copy consistency.
   - Update `.figma/make/site.json` with an Aurialis title and refined description while keeping indexing disabled.

## 10. Verification and Acceptance Criteria

### Automated checks

- Run `pnpm format`.
- Run `pnpm build`.
- Do not start a second development server.

### Manual functional pass

- Import one valid local audio file by click, drag/drop, and paste.
- Verify play, pause, seek, restart, volume, and duration against the uploaded file.
- Refresh and confirm track metadata, Blob playback, settings, reports, albums, and stem project state persist.
- Change simple presets and advanced controls; verify metrics respond deterministically and remain after refresh.
- Run Deep analysis with all five profiles; verify section boundaries remain stable, profile trajectories differ, and generated script data conforms to the version 1 production shape.
- Edit, mute, and reset Deep moves; verify the timeline, text summary, simulated metrics, dirty profile-switch confirmation, A/B state, and persisted project update correctly.
- Verify deterministic artifact-positive and artifact-negative projects populate or omit AI Repair moves appropriately without presenting the result as real AI detection.
- Complete the simulated mastering flow, cancel/retry where offered, and reset/undo.
- Run every exact stem count from 2 through 6, verify the expected labels, adjust stem controls, confirm count-change replacement behavior, and send the project to mastering.
- Create an album, add/reorder tracks, change the target, run album mastering, and delete a track safely.
- Add a reference, apply its direction, and confirm the master settings update.
- Run release checks for multiple platforms and download a report.
- Verify explicit disclosure before any unchanged-source prototype audio export.
- Trigger unsupported-file, missing-Blob/relink, IndexedDB failure/fallback where practical, and deletion confirmation states.

### Responsive and accessibility pass

- Check representative widths around 375px, 768px, 1024px, and 1440px.
- Ensure no clipped charts, horizontal page scrolling, hidden primary actions, or inspector traps.
- Navigate all key flows by keyboard only.
- Confirm meaningful labels, dialog focus behavior, visible focus states, text alternatives for charts, and non-color status cues.
- Check reduced-motion mode and contrast across canvas, cards, controls, warnings, and disabled states.

### Definition of done

- Every planned route renders a designed, populated, responsive state.
- Core flows connect end-to-end rather than acting as isolated mock screens.
- Real local audio playback works; simulated processing is consistent and honestly represented.
- Deep mode faithfully reproduces the production script/profile/timeline interaction contract while remaining clearly simulated and fully usable on mobile and desktop.
- Smart Split produces the exact selected 2–6 lane layout.
- Browser refresh preserves the local library and project state.
- The visual system is coherent across mobile and desktop and clearly departs from the old dark interface.
- Formatting and production build complete successfully.
