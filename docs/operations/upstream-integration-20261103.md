# Upstream integration, 2026-11-03

The included T3 Code base is `260297b55fc97c5b10ff55511967f6d20c622e54` (version 0.1.6), recorded in `fork-upstream.json`. The first integration checkpoint included `15707a84b03e27bb257d60e027812ebf94bbda25`; the subsequent ten upstream commits advance that base to the final pin. The fork baseline before the integration was `5be6ec6bd9c7d47483a217c11966ad6ea6385f36`, followed by local commit `4006afecc27e15a6b41e4727ca723f3123fa71f9`, which raised the default managed tunnel limit from three to eight. The integration retains that change. This record describes source integration; it does not claim a build, release, or installation.

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

Independent server/admission/recovery and UI/Android reviews found no concrete regression in their reviewed pre-tail paths. A separate tail persistence review found a missing production pruning boundary; its fix and fresh re-review are recorded below. These tests use isolated fixtures; they do not establish packaged desktop, Android, Windows/WSL hardware, or live-device update and recovery behavior. No application was installed or running service restarted during this integration.

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

## Subsequent upstream changes

The tail adds replay-boundary checks for databases whose upstream history was pruned, updated Codex release metadata, and provider usage and Git status fixes. The fork retains its existing lossless history policy, projection verification and rebuild, and conservative compaction. Upstream's automatic one-day event pruning is intentionally uncommissioned because it deletes history the fork retains; it is not an equivalent replacement for those guarantees. If a database already records an upstream prune boundary, reconnects resynchronize through snapshots and projection rebuilding refuses before changing any projection rows. Compressed historical payloads and prompt anchors continue to use the fork's compatibility readers.

Fork compaction still removes superseded event states. Each deletion page atomically records a conservative reconnect boundary, while a separate receipt identifies compaction performed on a reconstructable history. For older markerless stream gaps, reconnects use snapshots and further compaction waits. An explicit rebuild can certify retained history by replaying into projections in a transaction and comparing every affected table in both directions; a mismatch rolls back, leaving projections intact. A damaged projection or legacy storage encoding that prevents exact comparison cannot be certified this way and requires a suitable recovery asset. Global SQLite sequence gaps alone do not trigger this check.

The new managed Codex pin is available through the existing explicit installation flow. An older supported managed runtime is not downloaded or activated automatically on server startup: upstream's startup activation does not perform the fork's activity and maintenance admission. The runtime already in use remains available until an explicit update.

The tail server check passed TypeScript and 274 focused tests across 11 files, including
projection verification and rebuild, retained storage compatibility, reconnect replay,
managed Codex installation, Grok, and Git status. The shared usage-limits suite passed
64 tests, including a merged account with both a default and a chosen provider name.

## Final local checks and review

All 40 recursive typecheck tasks pass. Documentation links and examples pass the fork
checker, and source conflict-marker and whitespace checks pass (upstream patch payloads
retain their required whitespace). Settings DOM and logic checks pass 25 and 68 cases;
post-tail sidebar/citation/track-switch checks pass 103 cases after correcting the
track-switch comparison to use exact release versions rather than client provenance.
SSH and Grok ACP fixture checks pass 13 and 10 cases; desktop startup/window fixtures
pass 36 cases. The VCS/CLI selected run has passing evidence for all 433 cases across
the full run and the corrected fixture rerun.

The persistence re-review found the original boundary guard was not reached by real
compaction. Event deletion and replay-boundary recording now share a transaction.
State-preserving fork compaction records a reconstructability receipt. Legacy
markerless gaps can be certified only by replaying inside a transaction and comparing
all 18 affected projection/position tables against temporary snapshots in both
directions. A mismatch rolls back without rewriting stored projections; explicitly
lossy upstream histories remain refused. Compaction cannot obscure an existing
unproved gap. Actual-compactor thread/shell reconnect, rollback and replay-equivalence
checks pass, including 187 final impacted cases. A fresh independent Luna review
closed the finding with no remaining scoped issue; it did not run tests or inspect
live data.

No nightly has been published or installed by this source integration. Publication
still requires the exact-source release pipeline gates and repository write access.

### Nightly release worker correction

Run 41720364281 failed on Linux because the isolated worker has neither patchelf nor sudo; Windows then lacked the Linux CLI archive. The optional dependency verification artifact was absent, so dependency installation ran its checks normally. The release workflow now builds patchelf 0.18.0 from its SHA-256 pinned upstream release in runner temporary storage without privileges. A local native build reported `patchelf 0.18.0`; runner and release workflow policy suites passed (51 tests). Publication and device validation remain separate.

### Cross-platform test fixtures

Release run 41731728442 passed desktop, Android and candidate assembly but failed host suites. Migration expectations now use the registered 120–125 slots. Windows fixtures avoid unsupported filename characters and trailing spaces. SSH classification tests invoke a quoted, normalized fixture through `sh`, disable SSH variant probing, and assert the diagnostic reached Git. The shallow-clone fixture uses a real empty file and restricts its clone to the local file protocol; command failures include stderr. The failed Windows log omitted the original Git stderr, so the exact failing null-device operation remains unconfirmed until the retry. These changes do not alter production classification.

Run 41750727434 reached the Windows host suite and exposed a worktree-list assertion comparing Git forward slashes with native backslashes. The assertion now normalizes the expected path to Git notation. The focused long-branch worktree test passed locally (one test); actual Windows verification remains with the next release run.
