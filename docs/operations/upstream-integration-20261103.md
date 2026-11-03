# Upstream integration, 2026-11-03

The included T3 Code base is `15707a84b03e27bb257d60e027812ebf94bbda25` (version 0.1.6), recorded in `fork-upstream.json`. The fork baseline before the integration was `5be6ec6bd9c7d47483a217c11966ad6ea6385f36`, followed by local commit `4006afecc27e15a6b41e4727ca723f3123fa71f9`, which raised the default managed tunnel limit from three to eight. The integration retains that change. This record describes source integration; it does not claim a build, release, or installation.

## Server ownership and compatibility

- The fork's maintenance coordinator remains the admission path for native server and Android installation and recovery, including activity observation, fences, affected-home snapshots, receipts, and recovery. Desktop confirmed installation follows the desktop path. The upstream `t3 up` command is deliberately unavailable until its service changes support maintenance admission; it fails closed with guidance instead of restarting a potentially active service.
- Connect keeps the fork's selected and persisted authority, remote-cleanup handling, and managed tunnel lifecycle alongside upstream managed policy and reachability handling. A managed-policy refusal cannot reconnect a disabled link; remote cleanup remains available. Saved account homes remain scoped to explicit instance configuration, so an inherited `CODEX_HOME` cannot silently select another account.
- Projection storage retains fork legacy payload decoding and evidence handling while adopting upstream paging and deferred data. Thread orchestration keeps fork reply-cycle and archive-only deletion behavior alongside upstream side-chat locks, cascades, unused checks, and stop race handling. Codex's archived-session recovery uses one bounded unarchive retry, shared by resume paths.
- Project discovery retains fork metadata caching and excluded-path checks while adopting upstream bounded, batched Git reads and Pi transcript discovery. Temporary preview sharing, conversation evidence, fork WebSocket services, and maintenance authorization remain wired alongside upstream MCP and RPC additions.
- Fork migration slots remain intact. Upstream migrations originally numbered 73 through 78 are registered at 120 through 125, with identity and schema reconciliation for recognized upstream histories. Unrecognized histories fail closed rather than silently relabeling migrations. Dev-database copy tests now assert refusal and preservation of the source for an unknown pre-V2 migration; this is intentional under the stricter reconciliation policy. Existing V2 collision checks remain in place.
- The context budget records the measured combined provider instructions and MCP tool list after upstream additions. This updates the measurement, not the limits or the behavior of previously saved user settings.

## Server verification

All local runs used a single worker and low scheduling priority. The scoped server TypeScript check passed after the integration. Focused checks passed:

- Thread stop, projection storage, Connect lifecycle, project scanner, and storage cleanup: 5 files, 400 tests.
- MCP core and preview, asset access, Connect authority, thread search, and legacy importer: 6 files from an 8-file run. The other two initially exposed the intentional migration-history expectation change and a stale context-budget measurement; both passed in the subsequent adapter run.
- Migration copy, context budget, ACP, Claude, Codex, and provider registry: 598 of 600 tests passed initially. The two failures exposed the duplicated archived-session retry and the missing upstream Kiro in a registry expectation. After correction, Codex adapter, provider registry, and Codex account-home driver tests passed: 3 files, 221 tests.
- WebSocket, maintenance operator, boot service, preview broker, device handlers, and text generation: 7 files, 167 tests.
- Maintenance and self-update suites: 12 files, 113 tests. Earlier focused managed-runtime and self-update runs passed 32 and 14 tests respectively.

Independent server/admission/recovery review and final whole-integration checks remain required before publication. These tests use isolated fixtures; they do not establish packaged desktop, Android, Windows/WSL hardware, or live-device update and recovery behavior. No application was installed or running service restarted during this integration.

## Client reconciliation and local verification

The desktop scroll-to-end action holds the viewport through the programmatic jump and
settling. Delayed upward scroll notifications no longer cancel the jump; a subsequent
wheel gesture still releases follow. The focused regression was observed failing before
the fix and passing afterward; timeline/follow checks pass 94 cases.

The fork keeps its existing verified-release channel selector and hosted channel links.
The new upstream npm-based cross-machine track-switch dialog is not connected to fork
feeds and is omitted; it does not replace the fork updater. Generic mirrors remain
unsupported by the desktop fork because they lack its exact-artifact binding.

Local client checks include 408 selected web cases, 128 desktop cases, 25 settings DOM
cases and 68 settings logic cases. Client-runtime, web, desktop, mobile and server
typechecks pass, apart from reported non-failing Effect suggestions/warnings.
Standalone Android native sources and bridge behavior remain retained. Physical APK
installation/recovery, real notification delivery and real-device responsive behavior
were not exercised locally. CI owns the complete build/update/recovery release gates.
