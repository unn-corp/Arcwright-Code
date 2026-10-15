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

### Nightly 118 local delivery and follow-up gate repairs

The pipeline allocated `1.0.1-nightly.20261015.118` from
`964a04db0b490e732e2eb50cf3448d781f3b8b33`. Its Linux AppImage was installed
under the user's explicit one-time offline exception, with a checksum-verified
copy of the original data/profile and a successful integrity check on the copied
database. The actual installed digest is
`8626272f7bf8c9c36c843fa39437309987a9f2e27d893e1709cd2696dc6c8ee6`.
The canonical menu entry is **Arcwright Code — Nightly 118**, desktop ID
`com.t3tools.T3Code.desktop`; the obsolete `t3code-url-handler.desktop` was retired.
The stable launcher remains `~/.local/bin/launch-arcwright-code`. The private
installation record under `~/.t3/maintenance/offline-installations/nightly-118/`
contains the complete recovery, source, menu and verification evidence. The
installed title/sidebar, existing projects/history, HTTP 200 readiness and a second
menu invocation were verified. Autostart remains disabled and current chats remain
running. No native admission or updated native installed-build receipt is claimed.
Bulk storage compaction has not been performed.

The commissioning run did not publish Nightly 118. Windows package validation
passed, but Windows Git fixtures assumed Unix paths, Windows SQLite fixtures
unlinked an open database, the Linux checkpoint fixture timed out, the Linux Debian
gate attempted host-root installation in a read-only worker, and the Android
emulator worker lost communication with GitHub. Counter 118 remains consumed.

Follow-up Git plumbing locates a native Windows executable through canonical
host directories outside the project, rejects relative/network paths and aliases
into the repository, and replaces the child's environment with explicit Git
safeguards. Private empty hook directories work on both platforms, including temp
paths containing spaces. Existing output bounds, timers, fixed arguments, ref CAS,
object proof and authority checks remain. Fixtures use OS scratch paths, file URLs
and explicit Git index mode changes rather than Unix-only executable paths or
filesystem mode behavior. The new helper and affected Git proof tests are required
host-runtime release gates.

SQLite reader-failure fixtures now cause the actual read-only SQLite open to target
a missing file while preserving the open writer. Checkpoint fixtures establish WAL
before starting the worker and bound barrier waits with error/exit diagnostics.
All checkpoint, writer fallback, corruption and warning assertions remain. The
coordinator suite uses one worker to bound simultaneous snapshots/native helpers
within the isolated runner's resource limits. Matching Node 24.22 local coverage
passes; a fresh exact-source Windows/Linux commissioning run is still required.

Linux Debian package gates were qualified in disposable native KVM guests.
Their base OS and dependencies are built into the immutable CI image; each job
verifies that base's digest and creates a private copy-on-write overlay and fresh
SSH keys. Real guest dpkg runs the actual package scripts and package database;
the installed Electron/server CLI must report the expected version and HTTP 200
as guest UID 1001. Guest networking has no egress or host access except a loopback
SSH forward, and there are no host directory mounts or runner credentials in the
guest. Archive, admission and recovery suites remain on the unprivileged outer
worker. The actual package probe supports both retained combined `app.asar` and
current split `server.asar` layouts by inspecting the installed ASAR header. This
does not make Nightly 118 published or authorize another local installation.

On October 15 the immutable image
`sha256:0a477a294b01590de1fddddface30213798fb4eba28c3d6706b01c5ed594d6de`
passed real install (111), update (105 to 111), and recovery (111 to 105) in three
fresh guests. All five installed CLI probes reported the exact version and HTTP
200 as UID 1001. The published Debian package digests were independently checked:
111 was `1d8a37b2f723b36b792b1578edc70d40298323f74da1b3a8bf8e2d473d51f383`;
105 was `f3a8ed160f3acbe09e38c6eecfba671776409281a4a55e407068898a7408a997`.
The sealed guest base digest was
`957dc69daddef7f643c1876c79d6bb4942cfd16c0eb5c5937c76000c88164ba6`.
The qualification log is `/home/devotek/t3-ci-native-deb-qualification.log` on
Mothership. These retained packages qualify the infrastructure, not a new payload.

The follow-up Linux checks passed under CI's Node 24.22: all 312 coordinator tests
(18 files), all 614 required host-runtime tests (49 files), focused package/suite
contracts and Git fixtures, three scoped typechecks, edited-file lint, documentation
links/examples, and process output/timeout cleanup regressions. Independent Luna
re-review cleared the Git execution boundary and native-VM controller findings.
The new source still requires exact-source cross-platform commissioning gates;
these local and infrastructure results do not publish a build or replace the
currently running installation.
