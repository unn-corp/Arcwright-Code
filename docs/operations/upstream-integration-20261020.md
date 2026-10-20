# October 20 upstream integration

The latest integration starts from fork `021dcfc1fb077a1c26b7dfb3d52ccf6ef9c79e8f`
and includes upstream `f9dd25914dbd5f061f2685965bcbe2db8cfb912e`, adding
75 commits after the previously integrated `4836fa793816bd65bb0e36171e8d75455b0f82cc`.
`fork-upstream.json` records the included T3 base separately from the allocated
Arcwright build identity.

## Compatibility decisions

The fork keeps its standalone Android shell, native authentication and notification
bridges, Tailscale pairing, responsive workspace, direct replies, queues, and
Organizations. New hosted onboarding uses the existing managed-auth adapter,
including native Android origins. Async desktop topology refreshes retain change
notifications and reject older reads. Stashing saves context records before
removing them from the active draft. Timeline state guards and their renderer
regressions remain in place.

Desktop updates retain explicit artifact confirmation and startup recovery.
Native Android and managed servers retain coordinator admission, snapshots,
launch/write fences and recovery receipts. Linux icons retain content-derived
names while adopting upstream byte writes; executable, signing, launcher and
profile identities remain compatible. Keychain recovery accepts historical
Arcwright channel names after upstream freezes its encryption identity earlier
in startup. Codex daemon state remains private to each shadow home.

Upstream migrations 65, 66 and 67 map to fork IDs 112, 113 and 114. Webhook replay deduplication and coalescing use the new schema at 114; the expected schema fingerprint includes its column, tables and indexes. Existing migration
identities remain unchanged. Settlement repair decodes compressed historical
payloads, preserves V1 records and blob bodies, and updates replay byte counts
for changed V2 events. The latest-todo projection query also decodes archived
items. Existing migration 111's compressed-history repair remains intact.
See [migration upgrades](../orchestration-v2/migration-upgrades.md).

The SQLite adapter combines upstream reader interruption and checkpoint
backpressure with fork codecs, large-buffer bindings and synchronous-operation
diagnostics. Background Git fetches share one admission slot so a stalled network
request cannot consume both heavy-process permits and block local status reads.
The eight-process and two-heavy-process limits remain in force. Owned Connect retains its lifecycle SQL ownership/publication
protocol instead of upstream's legacy allocation writer. Cloudflare account
rate-limit pauses wrap the retained transports; mutating calls remain single
attempts. The upstream legacy ready-tunnel shortcut is not used because it
would bypass this fork's resource verification and publication boundaries.

Connection diagnostics and managed-tunnel reachability checks retain the fork's
local-disabled and cloud authority checks. Connections keeps its selected-computer
navigation, rename and Android pairing paths. Scheduled task details retain the
new webhook filters, replay keys and coalescing controls. Embedded app messages
persist branch and thread settings before dispatch, just like composer sends.

Upstream's desktop reversions overlap deployed credential, launcher, topology,
process ownership and update protections. The fork retains these implementations
and their regression suites, including updater cache validation and bounded
backend shutdown. It also retains responsive sidebar and composer masking and
update controls. Browser regression fixtures use upstream's disposable renderer.
Upstream runtime pruning has no automatic caller here: recovery retention remains
owned by the maintenance coordinator. The release test split is adopted on the
shared self-hosted pool; desktop packaging keeps native platform workers rather
than the incoming Windows cross-build/hosted verification workflow.

Release discovery and feeds remain fork-owned. Format-1 manifests still emit
the original repository identity for installed clients, while new readers accept
both repository names. Six automatic-work policies remain off unless explicitly
saved otherwise. Scheduled releases and shared self-hosted CI remain configured;
this source merge does not commission a manual build or install.

## Verification boundaries

Focused checks cover migration/reconciliation and compressed history, memory
admission, provider and MCP paths, retained client/Android bridges, desktop
updater/keychain identity, release artifacts, shared storage, and relay transport,
DPoP and HTTP behavior. Scoped typechecks and lint accompany the affected packages.
The database source audit checks 67 upstream migrations, 109 published identities,
78 sources and four reviewed exceptions. The fork documentation checker passes.
Independent spec and quality reviews cover server/recovery safety and
UI/Android/desktop integration. Detailed commands, source manifests and results
remain in the conversation's local evidence directory.

Full CI, packaged update/recovery, physical Android, Windows/WSL installation and real
platform keychain checks remain release validation. Repository browser regressions use
headless Chromium fixtures.
Disposable PostgreSQL fixtures require their explicit test database; skipped
fixtures are not passing evidence. No running installation or live data home is
changed by this integration.

## Scheduled release follow-up

The first scheduled release for the merge, run `39424840015`, reserved Nightly 149
but failed mandatory desktop and Windows host suites before publication. The
completion gate correctly refused to publish. Follow-up fixes restore errors for
invalid desktop topology replies while retaining asynchronous snapshot refresh,
and use file lengths for Windows cleanup estimates where stat block counts are
unavailable. Release runtime tests load the server Git fixture configuration;
updater cache paths, SSH stubs, whitespace paths, and the real subprocess timeout
fixture now run portably without skipping required checks. Test diagnostics do
not commission replacement release packages or reuse the failed build counter.

The general CI follow-up also aligns retained reusable Effect generators with
upstream tracing rules and selects all 26 DOM fixture files through explicit
Vitest projects. Tests and required release filenames remain intact; the relay's
outer request span continues to own its untraced inner adapters. Stale migration,
restart-result, model-preference, and ACP branding assertions now match the
integrated contracts. Review fixtures use an isolated stable checkout, stream
clients connect through loopback, and process-exit probes handle forced TCP resets
without swallowing unrelated socket errors. No additional nightly was commissioned.

Client follow-up restores the composer's shared voice-phase wrapper and aligns
fixtures with fork release links, maintenance capability admission, current-device
usage limits, managed authentication, and the durable preview annotation editor.
Cyclic partial mocks no longer block browser test collection. The IPv6 pairing
regression retains exact bracketed Tailscale target checks through an isolated HTTP
transport, so it also runs on Linux workers without IPv6 loopback. Mobile callbacks
retain their error and cleanup behavior while compiling without compiler exemptions.

Relay transaction adapters defer database access until the operation runs, preserving
owned-policy rejection before persistence or crypto. A forward reconciliation snapshot
joins the fork account-deletion and upstream API-pause migration histories without
rewriting historical migrations or changing the SQL schema. PostgreSQL checks use
the owned, socket-only native fixture; fixtures requiring a separate Docker receipt
remain outside that verification. Desktop and host diagnostic suites pass on Windows,
and host diagnostics pass on Linux. These diagnostics do not establish packaged
update/recovery or hardware validation.
