# Upstream integration — 2026-10-15

The merged source integrates all upstream main commits through
`339179f50a84dc599cce373dbb48f172f182f44e` into fork main, starting from
`9dc9c60ff97668d109218378e6d2d56a3b27cf10`. The previous included upstream was
`511d20c6f20c2ed6ff787aba068d7d673e2949b9`; the incoming range contains 171
commits. `fork-upstream.json` records the exact new source; upstream still labels
its package 0.0.45, independently of the allocated Arcwright nightly counter.

## Retained behavior and compatibility

| Area                   | Merge result and verification                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admission and recovery | Desktop installs still use the native digest-bound controller. Provider startup takes work admission before reads and keeps its workspace lease limited to startup. Missing activity/capability remains a blocker. Service snapshots follow durable launch suspension and quiescence; restart recovery refuses missing proofs. |
| Migration identities   | Released fork IDs 1–107 retain their names. Upstream ThreadFailureLookupIndex (62) maps to fork 108. Reconciliation recognizes upstream ledgers through 62. Sparse or renamed V2 ledger rows fail before the migrator can skip them. Matching schema/ledger fingerprints retain the fast startup path.                         |
| Compressed history     | Both SQLite writer and upstream read-only worker register the same self-contained checksum/codec functions. Gzip blobs and Brotli history blocks decode before JSON inspection, including subagent prompt anchors. Logical byte budgets and legacy baseline reads remain bounded.                                              |
| Node 24 bindings       | ArrayBuffer parameters normalize to Uint8Array without invoking named-binding getters. The SQLite reader/writer suite passes under Node 24 and Node 26.                                                                                                                                                                        |
| Backup disk space      | Linux uses strict reflinks. A clone failure can fall back to a full copy only after checking the current destination free space; clone preflight cannot authorize a later unbounded copy.                                                                                                                                      |
| Windows packaging      | Both app and server staging use physical hoisted dependencies. This addresses the prior Windows ASAR failure on a pnpm virtual-store Clerk LICENSE link; the real Windows release build remains authoritative.                                                                                                                 |
| Pi MCP bridge          | Generated prompt metadata binds its description/name variables and adds hints only to modern direct orchestration tools. Deferred, hidden and legacy entries remain lean; permission and image delivery assertions pass.                                                                                                       |
| Connect and providers  | Owned Arcwright Connect endpoint/authentication selection, token metadata, synchronized provider homes, local cleanup, and one catch-up after reactivation remain. Tool-free Organizations Architect prompts and private provider environments are preserved.                                                                  |
| Chat and mobile        | Shared media delivery, participant pictures/identity, one You label, collapsed status counts, agent feed milestones, current-device usage, responsive controls, and the standalone Android native tree are retained. New prompt/PR actions coexist with fork composer controls.                                                |
| Sidebar and updates    | Upstream grouping preserves saved ordering/legacy grouping keys and fork project dragging. Bulk update version comparison retains provenance and coordinator-only installation; waiting never reports success. User-visible new copy uses Arcwright names.                                                                     |
| Pull-request watches   | Restore grouped reads, host fingerprints, quiet reread limits, rate-limit handling, and watch telemetry. The previous fork had reverted these upstream optimizations; the incoming runtime fixtures now pass.                                                                                                                  |
| Automation and storage | Six automatic-work defaults and update continuation remain off by default; explicit saved preferences are retained. Cleanup stays admitted and respects live sessions and conversation evidence.                                                                                                                               |

## Validation

Local tests use Node 24, low priority, single test workers, temporary fixture homes,
and private maintenance namespaces. Focused checks cover runtime orchestration,
provider generation/settings, cloud authentication/lifecycle, service rollback,
maintenance admission/recovery, SQLite worker parity, migration upgrades,
compressed-history compatibility, schema fingerprints, desktop update state,
Windows packaging rules, and the retained web/mobile chat and update surfaces.

The packaged-reader regression builds one executable JS file using the production
server pack configuration, starts its real read-only SQLite worker, and verifies
gzip payloads, Brotli history, UTF-8 byte lengths, writer/reader equivalence, and
corruption rejection. It is a required host-runtime release gate; SQLite client
parity and migration-ledger tests are also required release checks.

Scoped typechecks cover server, desktop, web, React Native mobile, contracts,
shared, client runtime, provider core/ACP/Cursor/Grok/OpenCode/Pi, GitHub source
control, relay, and release scripts. Fork documentation, edited-file formatting, focused
lint, and whitespace/conflict-marker checks must pass before committing.
Independent Luna server/recovery and UI/Android reviews cleared their confirmed
findings after fixes. Hardware checks and real Windows packaging remain release
and installation gates; fixture results do not measure live database savings.

The first merged-source CI run exposed additional compatibility issues. Follow-up
checks cover the Effect 4 UUID API in relay services, Pi tool metadata, old Git
files-ref detection, stable deleted-project responses, executable-bit fixtures,
valid legacy migration ledgers, and branded Codex wire replays. Existing typed
rejections, authorization checks, ledger validation, and ref safety assertions
remain enforced. Knip now recognizes filename-loaded build/recovery entries and
retains explicitly listed inactive baseline UI modules; independent review found
no merge-induced loss of their wiring. These focused checks pass; the earlier
complete CI run failed and is not evidence of a successful release gate.

The first allocated merged-source Nightly 117 produced a Linux AppImage that
passed a real packaged startup/name/menu check and 1,105 Linux core safety tests
(81 files). Publication stopped at Windows packaging: its service-runner temp
directory was beneath `C:\Windows`, and ASAR path protection rejected a file
there. The desktop workflow now supplies the runner-owned temporary directory
through `TEMP`, `TMP`, and `TMPDIR`; it does not disable path protection or remove
license files. That build fix requires a fresh allocation and Windows validation.
The local Nightly 117 candidate was not installed or published.

Publication must use the exact tested merged main source and a fresh pipeline
allocated nightly identity. Reuse no consumed counter and enable no publishing
schedule. Installation uses the verified release and genuine native maintenance
admission, preserving data and chats. Record the actual digest, version, source,
launcher, canonical Start Menu replacement, and health checks after installation.
No production database is opened or shrunk by this integration's tests.
