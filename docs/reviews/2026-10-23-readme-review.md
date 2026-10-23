# README research and accuracy review

Scope: rewrite the project introduction for readers with different technical backgrounds, add a first-use guide and developer reference, and verify claims against this checkout. No application behavior changed. Documentation branch: `docs/readme-and-reader-guides`; status: **open — awaiting merge**.

Final source baseline: main `f9ae07753ccd76b3f45121f6782498d5854874e8`, integrated into the documentation branch. The final claim review and refreshed build checks include measured Deep diagnostics, Library source recovery, ScriptV2 foundations and measured Reference proposals. Production files match that baseline.

## GitHub examples reviewed

The starting point was [Awesome README](https://github.com/matiassingers/awesome-readme). Its collection supplied examples to study, not evidence about Aurialis.

| README | Observed pattern | Applied here |
| --- | --- | --- |
| [HTTPie](https://github.com/httpie/cli/blob/master/README.md) | Purpose first, a demonstration, then small task-based examples. | Plain-language introduction and import → listen → export walkthrough. |
| [dbt](https://github.com/dbt-labs/dbt/blob/main/README.md) | Introduces concepts for newcomers and points to focused guides. | Define mastering before naming the stack; link user and developer guides. |
| [The Lounge](https://github.com/thelounge/thelounge/blob/master/README.md) | Visible navigation and separate installation/development paths. | Short top navigation and a dedicated development guide. |
| [Size Limit](https://github.com/ai/size-limit/blob/main/README.md) | Explains user impact and organizes usage by scenario. | “What you want to do” tables and a task-based docs index. |
| [Triumph Mayflower Club](https://github.com/Stack-in-a-box/triumphmayflowerclub.com/blob/master/README.md) | Welcomes beginners and explains setup prerequisites. | Exact tool versions, expected startup result, glossary and troubleshooting. |

Aurialis's existing record mark and paper-and-ink identity provide the visual direction. No demo, screenshot, license badge, performance benchmark or support guarantee was invented.

## Claim checks

The technical writer coordinated with an independent claims reviewer using backend, security and skeptical-review perspectives. A separate QA agent checked the executable build. Role definitions came from the repository's [technical writer](../../.claude/agents/aurialis-tech-writer.md), [QA](../../.claude/agents/aurialis-qa.md) and [skeptical reviewer](../../.claude/agents/aurialis-devils-advocate.md) instructions; the review was scoped to documentation.

| Claim area | Source checked | Result reflected in the docs |
| --- | --- | --- |
| Build, tool versions and embedded assets | [`package.json`](../../package.json), [tool pins](../../.mise.toml), [build script](../../scripts/build.sh), [development script](../../scripts/dev.sh) | Source-build requirements; one executable after building; no hot reload. |
| Flags, address precedence and request limits | [CLI](../../cmd/aurialis/main.go), [server](../../internal/server/server.go), [jobs](../../internal/jobs/manager.go) | Loopback-only service, environment overrides, hard limits and retryable busy responses. |
| Import and export formats | [audio reconstruction](../../internal/audio/cdr.go), [workstation](../../src/components/AurialisWorkstation.tsx) | WAV browser input; limited API AIFF; reconstructed stereo source; explicit export depths and limits. |
| Simple/Advanced, A/B and profiles | [workstation](../../src/components/AurialisWorkstation.tsx), [store](../../src/lib/store.tsx), [browser engine](../../src/lib/browser-engine.ts) | New projects default to Advanced; shared settings; no automatic A/B level matching; static Deep profiles. |
| Deep diagnostics and schedule foundations | [source-analysis panel](../../src/components/shared/FeatureAnalysisPanel.tsx), [script validation](../../internal/mastering/script_v2.go), [schedule compilation](../../internal/server/automation.go) | Measured original-source diagnostics are available; ScriptV2 APIs do not enable timeline editing or schedule attachment in the production Deep screen. |
| Storage, Library recovery and privacy | [browser database](../../src/lib/db.ts), [Library](../../src/components/shared/LibraryView.tsx), [store](../../src/lib/store.tsx), [server](../../internal/server/server.go) | Browser-local storage is not a source backup; bounded session fallback; exact-identity relink versus confirmed replacement; native processing in memory; no cloud audio service required. |
| Measured Reference | [Reference panel](../../src/components/shared/ReferenceMatchingPanel.tsx), [request boundary](../../internal/server/reference.go) | Starting-chain output versus original reference audio; explicit proposal review, Apply and session-owned Revert; combined 129 MiB request cap. |
| Albums and release checks | [workstation](../../src/components/AurialisWorkstation.tsx) | Temporary bounded album downloads and diagnostic targets rather than certification. |
| License | Repository file inventory | No license file present; no license or redistribution permission asserted. |

Historical verification remains in [tasks](../tasks.md) and [the ledger](../../.claude/war-room/ledger.md). It was removed from the README's introduction without being promoted to current-session evidence.

## Verification for this documentation change

Executed with Node `26.12.0`, pnpm `10.33.0` and Go `1.26.10`. Build, binary smoke and CLI help were rerun against the final main baseline above:

- Frozen dependency installation: exit 0.
- `pnpm run build:binary`: exit 0, including both WASM targets and the static interface.
- `pnpm run test:binary`: exit 0, serving embedded assets and checking API behavior from an empty temporary directory (`compiled-binary-smoke`).
- `./aurialis -h`: exit 0; documented flags and defaults confirmed.
- Spelling check across all nine changed Markdown files: zero issues.
- Local-link and anchor check: references across the five rewritten/new reader and review documents resolved; package script references matched `package.json`.
- `git diff --check`: exit 0.

These checks do not establish new browser, audio-quality, hardware or platform-certification results. Full Go, browser and API suites were not rerun for the documentation-only diff.
