# Aurialis High-Fidelity Redesign Plan

## Goal

Rebuild the blank React 19 + TypeScript + Vite 8 scaffold as a polished, mobile-first audio-mastering prototype with a warm editorial identity. The app will accept and play real local audio, simulate analysis and processing deterministically, and persist projects and audio in IndexedDB. It will not use a backend, authentication, real DSP, source separation, machine learning, or transcoding.

## Confirmed Product Decisions

- Visual direction: warm paper surfaces, dark brown-charcoal ink, terracotta actions, muted moss/ochre data colors, restrained rules/shadows, and generous editorial spacing.
- Typography: Newsreader for display text and Instrument Sans for UI, loaded as public Google fonts.
- Fidelity: high-fidelity interactive prototype, not a static mockup.
- Audio: real click, drag/drop, and clipboard-paste upload; browser playback and seeking; simulated processing.
- Persistence: browser-local IndexedDB for metadata, settings, reports, albums, stems, Deep scripts, and uploaded Blobs.
- Responsive behavior: mobile-first task flows plus a purpose-built desktop workstation shell.
- Deep mode: faithful interactive simulation of the production repository's version 1 `MasteringScript` workflow.
- Smart Split: exact 2–6 stem-count selector.
- Honest presentation: all simulated analysis, A/B, mastering, splitting, and export limitations must be disclosed.

## Explicit Non-goals

- No backend, cloud storage, accounts, collaboration, cross-device sync, billing, or marketing site.
- No real mastering DSP, ML analysis, source separation, spectral analysis, or audio transcoding.
- No claim that B playback or exported audio contains real mastering changes.
- No reproduction of the current site's dark blue control-room styling.

## Repository and Implementation Constraints

- Use the existing React/Vite/Tailwind CSS v4 scaffold and `pnpm`.
- Add `react-router-dom` and `lucide-react`.
- Before UI implementation, invoke `make/use-design-system`.
- Do not start a development server; the Figma Make server is already supervised.
- Use CSS custom properties/Tailwind theme mappings in `src/index.css`.
- Use native controls where possible. Custom chart/timeline interactions require labeled control and text-summary equivalents.
- Avoid emoji and one-off text glyphs as icons.

## Routes and Global Shell

- `/` — Upload/Home
- `/library` — Library
- `/master/:trackId` — Simple, Advanced, and Deep mastering
- `/split/:trackId` — Smart Stem Splitter
- `/albums` — Album index
- `/albums/:albumId` — Album workspace
- `/reference/:trackId` — Reference Match
- `/release-check/:trackId` — Release Check

Mobile uses a compact top bar, four-item bottom navigation, inline sections/bottom sheets, and a sticky mini transport. Tablet uses denser two-column content. Desktop uses a narrow left rail, main visualization canvas, right inspector, and sticky bottom transport. Primary controls have at least 44px touch targets.

## Visual System

- Define canvas, raised/sunken paper, ink, secondary ink, border, terracotta, moss, ochre, warning, and destructive tokens.
- Add display/body/numeric font tokens, tabular numeric styles, restrained radii, fine borders, two shadow levels, and motion tokens.
- Use CSS-only subtle paper grain; no photography is required.
- Use custom responsive SVGs for waveforms and analysis charts.
- Use a typographic Aurialis wordmark with a small circular listening mark.
- Use index-like eyebrow labels, visible clay/dark focus rings, and reduced-motion support.

## Screen and Flow Specifications

### Upload/Home

- Editorial hero, local-only privacy note, large accessible drop zone, recent projects, and workflow links.
- Support file picker, drag/drop, document-level audio paste, and keyboard activation.
- Validate likely audio type, then confirm support by attempting media metadata load.
- Show filename, duration, size, and detected format before deterministic analysis progress.
- Multiple valid dropped files import into the library; open the first and summarize skipped files.
- Provide seeded demo projects, but real playback only for uploaded audio.
- States: idle, drag-active, validating, analyzing, ready, unsupported, corrupt/unreadable, and storage warning.

### Library

- Search, sort, and filters for All, Draft, Mastered, Stem project, and Needs review.
- Mobile cards and desktop editorial list/table.
- Actions: resume, quick play, add to album, duplicate settings, delete, and relink missing source.
- Delete confirmation removes metadata and Blob while preventing dangling album references.
- Show local storage usage and explain browser-only persistence.

### Mastering Workspace

- Track header, save state, file metadata, Split, Reference, Release Check, and Export actions.
- Shared responsive waveform, play/pause, restart, seek, volume, elapsed/total time, and current playhead.
- A/B uses one source Blob: A is original; B changes simulated UI/metrics only.
- Analysis strip: integrated LUFS, true peak, loudness range, dynamic range, and stereo correlation.
- Simple/Advanced/Deep segmented mode; meaningful edits autosave.

#### Simple

- Genres: Pop, Hip-hop, Rock, Electronic, Acoustic, R&B, Classical, Podcast.
- Tone intents: Warm, Open, Punchy, Intimate, Wide, Clean.
- Responsive intensity slider/dial and targets: Streaming balanced, Loud, Dynamic, Podcast, Custom.
- “Create master” stages listening, balancing, and finishing; completion updates deterministic metrics and supports undo/reset.

#### Advanced

- Five-band draggable EQ SVG plus equivalent numeric inputs.
- Compressor: threshold, ratio, attack, release, makeup, bypass.
- Stereo: width and mono bass.
- Limiter: ceiling, target LUFS, release, true-peak toggle.
- Saturation: amount and character.
- Module enable/bypass/reset and handoff from Simple settings.
- Mobile accordions; desktop right inspector. Values deterministically affect displayed analysis.

#### Deep

Deep mode mirrors production interactions and the version 1 schema while remaining entirely simulated.

- Profiles and IDs:
  - `modern_pop_polish` — Modern Pop Polish
  - `hip_hop_low_end` — Hip-Hop Low-End
  - `indie_warmth` — Indie Warmth
  - `metal_wall` — Metal Wall
  - `pop_punk_air` — Pop Punk Air
- Profile selection is staged. Apply regenerates profile-specific moves while preserving section boundaries. If moves are edited, confirm before discarding edits.
- “Analyze deeply” runs cancellable phases: Detecting sections, Analyzing stems and artifacts, Writing mastering script.
- Show progress, elapsed time, completed-phase durations, cancel, retry, interruption recovery, and concise failure state.
- Section vocabulary: intro, verse, chorus, bridge, drop, breakdown, outro, unknown.
- `MasteringScript`: literal version `1`, track ID, sample rate, duration, profile, `Section[]`, `Move[]`, optional `StemAnalysisReport[]`.
- Each Section has ID, type, start/end seconds, loudness LUFS, and spectral centroid.
- Closed Move parameters cover input gain; compressor threshold, ratio, attack, release, makeup; EQ bands 1–5 gain; saturation drive; stereo width; AI Repair amount.
- Each Move has ID, parameter, start/end, ordered `[time,value]` envelope points, reason, original value, edited, and muted.
- Timeline: section strip plus Volume, EQ, Comp/Sat, Width, and AI Repair lanes with shared transport playhead.
- Tapping a move opens an accessible editor showing parameter, section/time, reason, bounded value, mute, and reset. Editing offsets the envelope while preserving shape; reset restores the proposal.
- Edited/muted status uses labels/icons as well as color. Provide a text summary for the timeline.
- Artifact reports contain stem ID, classification, confidence, narrowness, spectral-collapse score, and band correlations.
- AI Repair moves appear only for deterministic artifact-positive results. Copy must not claim the tool detected AI authorship.
- Script A/B does not restart playback and does not alter audio; it changes timeline state and simulated metrics.
- Persist profile, completed script, move edits/mutes, reports, A/B state, and interrupted status.
- Mobile: horizontal profile cards, horizontally scrollable timeline with sticky lane labels, bottom-sheet editor. Desktop: timeline in canvas and profile/progress/findings/editor in inspector.

### Smart Stem Splitter

- Without a source track, show the upload surface.
- Exact selector mappings:
  - 2: Vocals, Instrumental
  - 3: Vocals, Drums, Other
  - 4: Vocals, Drums, Bass, Other
  - 5: Vocals, Drums, Bass, Melody, Other
  - 6: Vocals, Drums, Bass, Guitar, Piano, Other
- Updating count before processing updates preview labels.
- Updating count after processing requires confirmation and only then replaces lanes and resets stem edits.
- Simulate preparation, source analysis, and separation.
- Show deterministic colored waveform lanes; each supports rename, mute, solo, level, and pan.
- One shared playhead; controls update state while playback remains the source mix.
- “Send to mastering” creates/updates a stem-origin project. Stem export shows a clear prototype limitation notice.

### Albums

- Index supports create, rename, open, and delete; cards show track count, loudness target, consistency score, and modified date.
- Workspace supports artist/release metadata, target, adding library/imported tracks, and ordering.
- Desktop drag reorder plus mobile/keyboard move buttons.
- Rows show order, title, duration, LUFS, true peak, tonal marker, status, and open action.
- Consistency chart switches Loudness/Tone/Dynamics, flags outliers, and explains differences.
- Simulated batch mastering updates displayed results while preserving individual settings.

### Reference Match

- Upload or choose a local reference.
- Compare loudness, tonal balance, dynamics, stereo width, and overlaid tonal curves.
- Controls: amount, tone/dynamics/width priorities, low-end and transient protection.
- Applying writes deterministic derived settings into the track and returns to mastering with undo.

### Release Check

- Staged scan and readiness score.
- Check loudness target, true peak/clipping, dynamic range, mono compatibility, sample rate/format, leading/trailing silence, and metadata.
- Platforms: Spotify, Apple Music, YouTube, SoundCloud, CD, Podcast.
- Group Passed, Consider, and Fix; provide plain-language guidance and deep links to relevant controls.
- Save report and download text/JSON summary.

### Export

- Modal/sheet for name, displayed format, sample rate, bit depth, and dither.
- No transcoding or processed output. The only optional audio download is the unchanged source Blob under a derived filename after explicit confirmation.
- Download release reports separately as JSON.
- Disable source download when Blob is missing without deleting project state.

## State, Persistence, and Simulation

### Typed domain model

- `Track`, `MasterSettings`, `MasteringScript`, `Section`, `Move`, `StemAnalysisReport`, `StemProject`, `Album`, `ReferenceProfile`, `ReleaseReport`, `ProcessingJob`.
- `MasterSettings.mode` is `simple | advanced | deep`.
- `StemProject.requestedCount` is an integer union `2 | 3 | 4 | 5 | 6`.

### State architecture

- Focused React context + reducer with domain actions.
- Persist domain state; keep tabs, sheets, drag/hover, and other transient UI local.
- Load persistence before route content and show a paper skeleton.
- Seed demos only when storage is empty.
- Debounce slider/text autosaves; persist structural actions immediately.

### IndexedDB

- Versioned stores: `projects`, `audio`, `albums`, `stemProjects`.
- Store uploaded Blob separately by track ID.
- If unavailable/blocked/quota-limited, retain in-memory work and show a nonblocking warning.
- Create object URLs only while used and revoke them on source change/unmount.

### Deterministic simulation

- Hash stable track/file/settings inputs for waveforms, metrics, reports, section boundaries, artifacts, and moves.
- Deep profile changes alter move trajectories but not detected section boundaries.
- Clamp all values to plausible ranges and preserve relationships.
- Jobs use cancellable timers and only commit completed results.
- Interrupted jobs restore as retryable, never falsely complete after refresh.
- Normal jobs succeed; any failure demo trigger must be explicit and development-only.

### Playback

- One shared `HTMLAudioElement` controller exposes source, duration, current time, play state, seek, volume, and errors.
- Respect autoplay restrictions and missing/deleted sources.
- All simulated A/B modes share the same source.

## Proposed File Organization

```text
src/
  App.tsx
  index.css
  types/audio.ts
  data/{demo,presets,deepProfiles}.ts
  state/{AppProvider,reducer}.tsx
  lib/{db,simulate,audio,format,deepScript}.ts
  components/layout/{AppShell,Navigation,PageHeader}.tsx
  components/audio/{Transport,Waveform,MetricStrip,SpectrumChart,DeepTimeline,DeepMoveEditor,EngineerProfilePicker}.tsx
  components/controls/{SliderField,SegmentedControl,Toggle,ProcessingState}.tsx
  components/shared/{DropZone,Modal,EmptyState,StatusBadge}.tsx
  pages/{HomePage,LibraryPage,MasterPage,SplitPage,AlbumsPage,AlbumPage,ReferencePage,ReleaseCheckPage}.tsx
```

## Error and Edge Cases

- Reject non-audio paste/drop; validate codecs through metadata loading.
- Handle multiple files, corrupt/zero-duration files, large Blob warnings, quota errors, and duplicates.
- Preserve metadata/settings for missing audio and offer relink.
- Sanitize display/export names while retaining originals.
- Cancel timers on navigation; interrupted processing becomes retryable.
- Confirm track, album, and processed-stem replacement deletion.
- Keep albums free of deleted track references.
- Dialogs trap focus, close on Escape, and restore focus.
- Charts/timelines have text summaries; status never relies on color alone.

## Implementation Sequence

1. Invoke design-system guidance; add router/icons; establish tokens, fonts, shell, and route skeletons.
2. Implement types, reducer/context, IndexedDB wrapper, deterministic generators, demos, loading/fallback states, and shared audio controller.
3. Implement upload/paste/drop, metadata validation, Home, and persisted Library.
4. Implement shared Master transport/waveform/metrics, Simple flow, Advanced modules, autosave, A/B, and export disclosure.
5. Implement production-compatible Deep schema types, profiles, deterministic script generation, staged/cancellable analysis, artifact reports, responsive timeline, move editor, dirty-switch guard, A/B, and persistence.
6. Implement exact 2–6 Smart Split, then Albums, Reference Match, and Release Check.
7. Complete errors/empties, responsive polish, motion/reduced motion, keyboard/focus/contrast audit, and `.figma/make/site.json` metadata.

## Verification

### Automated

- Run `pnpm format`.
- Run `pnpm build`.
- Do not start another development server.

### Functional

- Import valid audio via click, drag/drop, and paste; test playback, seek, restart, volume, and refresh persistence.
- Verify settings, Blob playback, reports, albums, stems, and Deep scripts survive refresh.
- Verify Simple/Advanced controls deterministically update metrics and autosave.
- Run all five Deep profiles; validate version 1 shape, stable sections, differing trajectories, progress/cancel/retry, and interruption recovery.
- Edit/mute/reset moves; verify text summary, simulated metrics, profile-switch confirmation, A/B, and persistence.
- Verify deterministic artifact-positive and artifact-negative cases add/omit AI Repair without claiming real detection.
- Run stem counts 2, 3, 4, 5, and 6; verify exact labels and post-processing count-change confirmation.
- Test Albums, Reference application/undo, platform Release Checks, report download, and unchanged-source export disclosure.
- Exercise unsupported/corrupt file, missing Blob/relink, quota fallback, duplicate, and destructive confirmations.

### Responsive and accessible

- Check approximately 375, 768, 1024, and 1440px widths.
- Ensure no clipped charts, page-level horizontal overflow, hidden actions, or inspector traps.
- Verify Deep mobile timeline scrolling and bottom-sheet editing.
- Keyboard-test all primary flows, dialogs, custom graph controls, and move editing.
- Confirm labels, focus management, visible focus, text alternatives, non-color status cues, contrast, and reduced motion.

## Definition of Done

- Every route has designed, populated, responsive states and connected end-to-end flows.
- Real local playback works and all simulated processing is stable and honestly represented.
- Deep mode faithfully reproduces the production profile/script/timeline interaction contract on mobile and desktop.
- Smart Split produces exactly the selected 2–6 lane mapping.
- Browser refresh preserves the local library and project data.
- The warm editorial system is coherent and clearly distinct from the old interface.
- `pnpm format` and `pnpm build` complete successfully.
