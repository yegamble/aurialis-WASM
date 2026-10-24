# Qualification process ownership

These helpers belong only to bounded local QA runners. Application, audio and HTTP request code must never import them.

`owned_groups.py` derives from the accepted private decoder checkpoint. It admits exact Node and detached browser PID, start time, process group and command hash identities, preserves known group continuity after parent changes, refuses unseen members without an anchor and revalidates before bounded signals. Normal exit does not bypass final cleanup. A changed command hash requires a fresh snapshot: only an absent PID or the same exact identity now in zombie state settles exit, with before/after observations recorded. A changed live command, start or process group still refuses signals.

Synthetic setup first verifies process monitoring before spawning anything. The directly owned child must wait for exact admission acknowledgment before creating a detached child; setup failure always terminates and reaps the direct child, whose own cleanup reaps its child. The synthetic TERM handler only sets a flag, so it cannot throw between an OS spawn and assignment of the child handle; a controlled gate covers that exact boundary. Earlier nine-case success with authorized monitoring did not cover sandbox-denied startup and is insufficient. The original fixture, its failure and the first corrected exit-race failures remain retained under `artifacts/album-ownership-fixture-correction/`.

`observed_process.py` pins an external native host for RSS observations and counts the union once; it never signals that host. Missing or changed identity refuses observation. Parent runners retain primary and cleanup errors separately and never reinterpret uncertainty as a clean exit. Browser launch and pre-Worker admission require the parent acknowledgment before workload execution.

Run the eighteen synthetic controls with `python3 -m unittest discover -s scripts/qualification -p '*_test.py'`. The three Node admission/handle-settlement contracts run in `pnpm test`. Exactly one actual normal no-audio browser probe and one corrected controlled-crash probe passed. The first leader-only crash assertion remains retained RED. The corrected predicate requires the exact pre-admitted PID/start/group of a live survivor; no new or reused identity can satisfy it. Members disappeared before cleanup signaling, so these results do not show that a browser signal caused exit. These controls do not establish cleanup of unidentified children from the rejected earlier fixture.

## Album supervisor

The normal and crash modes use a tiny Worker without audio or codec work. Use a fresh scratch name for every attempt; prior receipts and results are never overwritten. The pinned Node executable is verified before launch.

```sh
python3 scripts/run-album-scale.py \
  --node "$HOME/.nvm/versions/node/v26.12.0/bin/node" \
  --mode normal --seconds 60 \
  --budget-root artifacts/album-qualification-example \
  --scratch artifacts/album-qualification-example/normal
```

The runner forces sources, results, profile, temporary downloads and observations under the budget root. It checks the 6 GiB free-disk reserve plus 128 MiB guard, 1.1 GiB aggregate data, 512 MiB profile/scratch, 1 GiB per Node/native process, 3 GiB per browser process and 4 GiB union RSS including the pinned external native host exactly once. A denied snapshot fails before spawning. Browser launch remains owned through returned-handle assignment and admission cleanup. Actual group cleanup is awaited even after Node exit; uncertainty retains separate primary/cleanup errors and cannot become a pass.

Scale mode additionally requires its native host PID for native execution, the exact project name and the applicable accepted audio resource plan. The current no-audio probe does not qualify audio processing, three-minute tracks, full-album delivery, a physical 8 GB device or production resource guarantees.
