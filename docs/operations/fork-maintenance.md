# Maintaining this fork

This guide owns the retained behavior of `unn-corp/t3code`. Follow the linked user guides for
operation and the implementation links when changing a feature. Upstream mobile in `apps/mobile`
is a separate Expo/store client; it does not build or update our APK.

The initial audit compared the committed fork with its recorded upstream integrations, including
`87eacfc6c4`, `01a14ef2bc`, and the tested integration at `01b0f9e896`. It also included the local
Android, browser-sharing, and documentation changes. An upstream merge is not evidence that every
fork feature shipped upstream. Recheck `git log --first-parent` and compare the fork with the full
upstream commit recorded in `fork-upstream.json` when revisiting ownership; avoid treating an old
merge-base file list or a moving remote branch as the current divergence.

## Integrating upstream

Follow the [mandatory merge rules](../../AGENTS.md#mandatory-rules-for-upstream-merges). Record the
pre-merge fork commit and pin the incoming upstream commit before resolving conflicts. Use the
feature sections below to trace every affected retained feature through its contracts, runtime
wiring, clients, persistence, and checks. Audit clean merges, moves, and deletions as well as
conflict hunks; missing startup wiring or a renamed service can break a feature without a conflict.

Upstream equivalents may replace fork implementations after equivalent behavior is verified on
the affected surfaces and connection modes. Update ownership links and required release-suite
paths when implementations move. Run focused checks against isolated data, obtain the independent
Luna reviews required by `AGENTS.md`, and update provenance and affected guidance in the same change.
Publishing and installing require the build, update, and recovery gates on that exact source;
hardware validation that has not run must remain explicit. Source integration must not disturb
running chats or enable scheduled releases.

Published migration IDs are compatibility identities. Follow the
[migration upgrade guide](../orchestration-v2/migration-upgrades.md) when upstream and fork histories
assign different schemas to the same ID, and retain the history-preservation and failure tests.
Never renumber installed fork history to make an upstream merge appear current.

The vendored `.repos` trees stay outside fork release checkouts. If an upstream reference tree
contains Git submodule entries, preserve their root-relative registration in `.gitmodules`, with
initialization disabled. GitHub checkout's credential cleanup traverses these entries even during
a sparse checkout; missing root metadata can stop every build before dependency installation.

The [2026-10-12 integration record](upstream-integration-20261012.md) records the
pinned upstream range, retained package ownership and compatibility corrections.
The [2026-10-13 Connect integration record](connect-main-integration-20261013.md)
records its pinned main merge, native participant adapter, focused checks and remaining
relay/runtime and device gates.

## Lossless data storage

Migration 101 adds content-addressed compressed event/tool bodies, checksummed cold
legacy history and durable legacy stream baselines. The server expands references
before its existing contracts and JSON projection queries, preserving paired-client
compatibility and original replay byte budgets. Normal startup performs light schema
work; migration 102 queues one-time historical shrink for populated older databases.
Supported desktop, WSL and managed-service launchers perform it during native maintenance;
older service launchers hold it pending until refreshed. Migration 103 binds a fast schema
and ledger SHA check to the compiled schema contract; matching future loads skip migration
execution. Completed bulk cleanup is tracked separately and is not rerun.
Migration 107 upgrades both original and previously optimized homes to storage migration 2:
cold rows share bounded, checksummed Brotli blocks, with indexed access and exact record
verification. Mixed gzip/block readers preserve command tombstones and archived exports.
Packing is resumable and stays in the admitted worker; no historical row is discarded.
The exact journal, native snapshots, worker parent/child identities, fencing, capacity
checks and final health receipts govern the entire operation. Worker ownership survives
an unexpected parent exit; recovery must not race a recorded storage worker.

The implementation is owned by [payload storage](../../apps/server/src/persistence/PayloadStorage.ts),
[the codec](../../packages/shared/src/forkStorageCodec.ts),
[legacy archives](../../packages/shared/src/forkStorageArchive.ts),
[compact history blocks](../../packages/shared/src/forkStorageBlocks.ts),
[maintenance admission](../../packages/shared/src/forkStorageMaintenance.ts), and
[the CLI worker](../../apps/server/src/maintenance/storageWorker.ts). Preserve the
storage compatibility and maintenance regression suites when merging upstream. Populated databases from older builds queue a durable one-time shrink; it uses the same
coordinator snapshots and receipts, preserves version pins, and waits for launcher support.
Read
[the storage runbook](database-storage.md) for retention boundaries, old-history access,
supported installation paths and production verification. GitHub build retention is
owned separately by [the release retention policy](fork-releases.md#github-build-storage-retention).

## Agent memory admission

New agent starts, restarts, and restart continuations are held under host memory pressure without
claiming their durable effects. Existing agents, cancellation, interrupts, and cleanup keep their
normal paths. The guard runs in the server for desktop, standalone, web, mobile, and Android callers;
each paired environment uses its own host's RAM. Source behavior requires a packaged server update;
build 82 does not include it.

Ownership: [AgentStartAdmission](../../apps/server/src/resourceTelemetry/AgentStartAdmission.ts),
[HostResources](../../apps/server/src/resourceTelemetry/HostResources.ts),
[EffectOutbox](../../apps/server/src/orchestration-v2/EffectOutbox.ts), and
[EffectWorker](../../apps/server/src/orchestration-v2/EffectWorker.ts). Production wiring belongs to
[server.ts](../../apps/server/src/server.ts). The
[resource architecture](../internals/resource-telemetry.md#agent-start-admission) specifies thresholds,
sampling and ordering; [usage guidance](../user/usage.md#running-several-agents) explains waiting.

Verification: `AgentStartAdmission.test.ts`, `EffectOutbox.memory.test.ts`, `EffectWorker.test.ts`,
and `FoundationPersistence.test.ts` cover hysteresis, 20 pending starts, resumption, control work,
cancellation, and durable ordering. Sustained real-provider load and packaged-device validation
remain separate release checks. Admission cannot prevent an already-running tool or unrelated
application from exhausting memory. OS-killed runtimes still require verified coordinator lock
repair; this feature does not clear locks or bypass maintenance fencing.

## Product branding

The fork is named **Arcwright Code** across web, Electron, the standalone Android APK, and
Expo mobile variants. The transparent masters in [assets/arcwright](../../assets/arcwright)
own the wordmark and AC lightning mark; [the asset guide](../../assets/README.md) explains
regeneration and verification. Linux desktop registration uses content-derived icon filenames so KDE and other desktop caches do not retain a previous logo. Keep pre-ready and URL-handler registration on the same icon identity.

Header images, launchers, splash screens, notifications, and
widgets must use these shared outputs. Keep installed package IDs, signing identities, URL
schemes, legacy data folders, and recovery artifact names compatible when changing display names.
The product name remains **Arcwright Code**. New numbered nightly installations use
**Arcwright Code — Nightly N** in their launcher and application identity; the allocated release
version, source and digest remain the update/recovery authority. About and App updates also
show the included T3 base separately from the Arcwright build. Development desktops retain the
`(Dev)` label. Windows keeps its previous channel-specific executable filename so already
recorded updater/recovery handoffs still relaunch it; NSIS shortcuts and uninstall metadata use
the clean product name. Do not change those executable paths without a handoff migration.

The account-based relay feature is named **Arcwright Connect** in web/desktop, the bundled
Android web UI, upstream Expo mobile, and CLI output. Preserve internal `T3Connect` identifiers,
`t3-connect` paths, `t3 connect` commands, `T3CODE_*` keys, JWT audiences, callbacks, and persisted
connection formats. The [Connect architecture](../internals/t3-connect.md) and
[setup runbook](./connect-setup.md) own its trust boundaries and deployment requirements.
Relay bearer policy belongs to [Config.ts](../../infra/relay/src/Config.ts),
[ClerkClientAuth.ts](../../infra/relay/src/auth/ClerkClientAuth.ts), and the request admission/DPoP
bootstrap in [Api.ts](../../infra/relay/src/http/Api.ts). Preserve strict owned issuer/audience
session checks, opaque-only approved CLI client/scope/Unix-seconds grant checks, and deliberate
legacy compatibility. DPoP exchange stays session-only and environment-link guards remain separate.
Keep auth preflight ahead of Worker layer construction and the raw runtime-binding check in
[workerAuthPolicy.ts](../../infra/relay/src/workerAuthPolicy.ts); empty policy settings cannot
silently select legacy through provider normalization.
Focused auth/API and DPoP regression fixtures cover these boundaries; public relay commissioning
and the remaining privacy, abuse, deletion and physical-device gates are not established by them.
The managed-allocation lifecycle SQL protocol remains unwired; preserve its legacy quarantine,
retained uncertain owners and immutable target identity. The provider/publication/unlink conversion
must land together before deployment, with no mixed old and new writers or automatic owner reset.
The example configuration selects upstream T3 services in legacy mode. Explicit owned builds
require one complete validated public profile; cloudless builds clear managed aliases across web,
CLI, standalone Android and Expo. [connectProfile.ts](../../packages/shared/src/connectProfile.ts)
owns pure mode/authority selection; [public-config.ts](../../scripts/lib/public-config.ts) owns
bounded public-file loading and receipt digests. Owned/cloudless release/recovery still requires
original-artifact profile/source/APK binding. Private Arcwright Clerk/Cloudflare delivery is not
commissioned. Standalone APK native foreground sign-in is implemented; live
owned-service and phone verification remain pending. Keep direct/Tailscale routes,
saved pairings, and credentials through branding changes. Account sign-in discovers environments;
enabling host sharing exposes one, joining saves a client route, and deregistration revokes the
account link. Forgetting a route on one device does not deregister its host.

The independent owned hosted entry belongs to [alchemy.web.run.ts](../../infra/relay/alchemy.web.run.ts),
the [offline builder](../../scripts/build-owned-connect-web.ts), and its public-content/asset helpers.
Preserve its complete five-field digest, controlled compile inputs, external private LocalState,
clean-source artifact receipt and final actual Alchemy manifest. Hosted preparation pages may
precede the relay; they do not commission public Google signup, account isolation, deletion or native
delivery. Keep JavaScript-free public pages, hosted-only headers and assets-first SPA routing
separate from the existing website, Vercel channels and Android/Electron/local classification.
The shared web [legal helper](../../apps/web/src/legalLinks.ts) binds Welcome and Settings policy links
and owned copy to the validated public profile, including desktop/APK bundles; retain legacy/cloudless
behavior and keep telemetry preferences separate. Hosted Clerk protection CSP permits only its documented
script/frame hosts and all-port connection source; static public pages retain the detached no-script
policy. The owned database/tunnel is operated through its Dokploy-managed application; that commissioning
does not establish migrations or public relay availability.
The [hosted runbook](./connect-setup.md#independent-owned-hosted-web) owns deployment and recovery gates.

## Android client

**Behavior and reason.** A standalone APK bundles the shared web client and native phone features.
It keeps environment pairing on the phone and primarily reaches hosts over Tailscale. Android does
not run the coding-agent server or a Tailscale daemon inside the APK.

**Entry points.** The Android launcher opens the conversation workspace and its mobile thread list;
the web index route keeps this APK behavior separate from the desktop's automatic draft landing.
Explicit notification routes and Android activity restoration retain their destinations.
Use Settings → Connections to pair each host. The Android
[guide](../user/android-fork.md) covers installation and everyday routes. The
[runbook](./android-pwa.md) owns signing, build commands, editing, and isolated verification.

**Ownership.** [MainActivity.java](../../apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/MainActivity.java)
owns the shell and origin boundary; [build.gradle](../../apps/android-pwa/app/build.gradle) and
[build-android-pwa.ts](../../scripts/build-android-pwa.ts) own packaging. The retained phone automation host uses the native bridge and server broker; desktop browser
automation uses upstream's `DesktopBrowserHost` channel rather than the retired renderer automation
IPC. When updating browser contracts, check both paths and keep temporary Tailscale shares
under the one-hour idle lease. Shared connections live in
[client-runtime](../../packages/client-runtime/src). Web native adapters live in
[android](../../apps/web/src/android).

**Verification and coupling.** The native browser instrumentation and Java unit tests described in
the runbook cover release APK behavior. Test in-place, same-key installation and preserved
connections, system permission changes, cover/unfolded dimensions, and live resize. Changes to
shared Settings or client-runtime require an APK rebuild. Never uninstall to upgrade; losing the
signing identity prevents normal in-place replacement.
Pairing QR scanning uses the bundled web client and the shell's existing camera permission
boundary. Verify desktop QR decoding, permission denial, and camera release on cancellation;
check the camera on a phone before commissioning the APK.

## Phone alerts

**Behavior and entry.** Settings → General → Android notifications controls system notifications
and background host connections. The APK maintains authenticated host WebSockets through a native
foreground service; it does not use upstream cloud push delivery. Automatic alerts are suppressed
while any client on a mutually paired environment remains visible on an awake display. Focus and
input inactivity do not release suppression. Hidden/minimized/sleeping clients do; consumed alerts
do not replay later. Updater confirmations and explicit Send test remain available.

**Ownership.** [NativeNotifications.java](../../apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/NativeNotifications.java),
[AgentNotificationService.java](../../apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/AgentNotificationService.java),
and [NotificationCredentials.java](../../apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/NotificationCredentials.java)
own permission, alert lifecycle, and encrypted credentials. The
[Android notification runbook](./android-pwa.md#background-alerts) covers operational limits.

Connection-service refreshes must not repost healthy status notifications. The
[connection status tests](../../apps/android-pwa/app/src/test/java/com/devotek/t3code/pwa/ConnectionNotificationStateTest.java)
cover repeated refresh, healthy host changes, loss/recovery, and required service startup.

**Verification and coupling.** Test completion/input/failure while locked, notification tap to the
correct environment/thread, denied permission, lost connectivity, and duplicate suppression.
[NetworkNotificationPresenceTest](../../apps/android-pwa/app/src/test/java/com/devotek/t3code/pwa/NetworkNotificationPresenceTest.java),
[PhoneAlertQueueTest](../../apps/android-pwa/app/src/test/java/com/devotek/t3code/pwa/PhoneAlertQueueTest.java),
and [ClientVisibility.test.ts](../../apps/desktop/src/notifications/ClientVisibility.test.ts) cover
cross-host lease expiry, reconnect waiting, stale alerts, unfocused visible windows, and native
Windows display notifications. Desktop `ClientVisibility`, web `backgroundActivityReporter`, and
native `NetworkNotificationPresence` own the suppression boundary. Verify minimize/restore and
screen sleep on each OS; missing Linux display APIs and browser PWAs retain conservative visibility.
Host ticket/subscription changes affect the service. Android force-stop and system restrictions
can require reopening the app; preserve encrypted credentials when updating native storage.

## Phone browser and temporary Tailscale shares

**Behavior and entry.** Open a thread → right panel → Add panel surface → Browser. The APK uses a
separate native WebView and phone-local automation; remote page content receives no application
bridges. Temporary localhost shares belong to browser tabs and expire after one hour without an
actual page navigation. Closing the last owner also releases its share.

**Ownership.** [NativeBrowser.java](../../apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/NativeBrowser.java)
and [BrowserPolicy.java](../../apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/BrowserPolicy.java)
own phone execution. [PreviewView.tsx](../../apps/web/src/components/preview/PreviewView.tsx),
[Manager.ts](../../apps/server/src/preview/Manager.ts),
[PortPublisher.ts](../../apps/server/src/preview/PortPublisher.ts), and
[TemporaryShareProxy.ts](../../apps/server/src/preview/TemporaryShareProxy.ts) own host sharing and
cleanup. Desktop/headless automation and recordings now use the host's
[ServerBrowser.ts](../../apps/server/src/preview/ServerBrowser.ts) and desktop CDP channel.
Desktop page text insertion belongs to the attached tab's WebContents, without switching the
visible tab or desktop focus. [DesktopBrowserHost.test.ts](../../apps/desktop/src/preview/DesktopBrowserHost.test.ts)
covers two-tab draft isolation and failed insertion without retrying into another guest. Root
keyboard events require that same guest to have desktop focus; otherwise they fail with instructions
to select the requested tab or operate its DOM controls, without moving focus or replaying input.
The server encodes recordings, enforces the attachment size limit, and persists conversation
attachments; the retired Electron renderer upload helper is no longer an admission boundary.
[ServerBrowser.test.ts](../../apps/server/src/preview/ServerBrowser.test.ts) covers broker routing and
persisted recording bytes and is required by the host-runtime release suite. The phone host retains
its separately advertised native operations and does not advertise recording support.
[RpcAuthorization.ts](../../apps/server/src/auth/RpcAuthorization.ts) and
[forkExtraWs.ts](../../apps/server/src/forkExtraWs.ts) share the host admission rules: browser host
registration checks admission when attached; browser commands, element picking, frame writes, and
session resume hold work leases until they finish. The [admission tests](../../apps/server/src/auth/RpcAuthorization.maintenance.test.ts)
cover this observer/work boundary. The [Android runbook](./android-pwa.md) documents routing and deployment.

**Verification and coupling.** [PortPublisher.test.ts](../../apps/server/src/preview/PortPublisher.test.ts)
and [TemporaryShareProxy.test.ts](../../apps/server/src/preview/TemporaryShareProxy.test.ts) cover
ownership, real visits versus probes/assets, expiry, HTTP/WebSocket forwarding, restart cleanup,
and failed teardown retry. Test phone foreground/lock transitions and real-time resize. Both host
and APK must support the sharing capability; old hosts do not receive guessed Tailscale URLs.
Tailscale Serve must be available on the host. Do not remove unrelated Serve configuration.

## Responsive composer, sidebar, and glance rail

**Behavior and reason.** Touch layouts keep composer actions singular when collapsed, preserve
drafts, reserve sidebar drag-grip space while visible, and resize across the phone's two screens.
Appearance offers an always-compact composer preference for new and existing chats; multiline
drafts and actionable drawers or errors still expand. The default retains automatic sizing. Composer attachments share one non-wrapping, horizontally
scrolling strip, including images, videos, files, and attachments of queued messages being edited.
The glance rail adds project scope, usage, and quick access without replacing thread controls.
Dictation holds client installation through microphone permission, recording, decoding, and
transcription; cancelling releases that hold only after the pending operation ends.

**Ownership and entry.** The conversation composer is
[ChatComposer.tsx](../../apps/web/src/components/chat/ChatComposer.tsx) with
[ComposerPrimaryActions.tsx](../../apps/web/src/components/chat/ComposerPrimaryActions.tsx).
Sidebar behavior is shared by [Sidebar.tsx](../../apps/web/src/components/Sidebar.tsx),
[LegacySidebar.tsx](../../apps/web/src/components/LegacySidebar.tsx), their pointer/drag helpers,
and [GlanceRail.tsx](../../apps/web/src/components/GlanceRail.tsx).
Grouped repository grips use
[Sidebar.repositoryDrag.ts](../../apps/web/src/components/Sidebar.repositoryDrag.ts) and the
shared pointer lifecycle. Drop destinations include each group's heading, active conversation
rows and adjacent viewport padding; touch grips are larger without changing the sidebar width.
Touch and keyboard reordering persist through the existing local project-order store.
The legacy sidebar retains its dnd-kit project sorting. Keep repository destinations distinct
from thread state drops, and cancel a pending gesture when search replaces the list or a window
resizes. [Repository gesture tests](../../apps/web/src/components/Sidebar.repositoryDrag.test.ts)
cover physical members moving together, release positions, clicks, and interrupted gestures.
The empty-draft headline in [ChatView.tsx](../../apps/web/src/components/ChatView.tsx) participates
in layout with the composer: the whole stack centers when it fits and scrolls below the header
when the keyboard reduces available height. Fixed header controls share the safe-area top inset
with the flow header; breadcrumb space must reserve the full control cluster. Verify long
project/thread names, short keyboard-sized viewports, and the mobile sidebar wordmark alongside
the existing cover/unfolded resize checks.
[OpenWhisprVoiceInput.tsx](../../apps/web/src/components/chat/OpenWhisprVoiceInput.tsx)
uses the shared client-operation guard; its [interaction tests](../../apps/web/src/components/chat/OpenWhisprVoiceInput.test.tsx)
cover denied admission, cancelled permission acquisition, and pending transcription.
When the picker preload cannot return a frozen page snapshot, desktop capture retries with bounded DOM-only extraction. Retain the screenshot/navigation consistency check, request/frame validation, and listener cleanup. React source attribution is optional in this fallback.

Desktop preview annotations use the same recorder in
[PreviewAnnotationEditor.tsx](../../apps/web/src/components/preview/PreviewAnnotationEditor.tsx).
The app-root modal owns a frozen screenshot and extracted element metadata, independently of the
preview tab's navigation or lifetime. The typed snapshot IPC captures both in the desktop process;
the inspected page never owns the editor or microphone. Keep the draft, original thread, marks,
and comment in the IndexedDB-backed [editor store](../../apps/web/src/previewAnnotationEditorStore.ts)
so app reloads restore completed captures. Escape, backdrop clicks, and Close request discard
approval; only explicit discard or successful attachment/submission clears the session. Capture
and attachment failures must leave the modal open. Unmounting cancels dictation and late transcripts
cannot update another session. Keep capture, persistence, dismissal, and send regression tests
alongside these modules.

Preview-page microphone permissions are separate from the annotation editor's recorder.
[MicrophonePermission.ts](../../apps/desktop/src/preview/MicrophonePermission.ts), installed by
[BrowserSession.ts](../../apps/desktop/src/preview/BrowserSession.ts), prompts only for top-level,
audio-only requests from any HTTP(S) webpage origin. Chromium's secure-context requirements
still apply. Keep each origin's saved choice independent and preserve legacy loopback choices.
Both Electron handlers enforce the exact requested origin and media type; video, mixed requests,
and subframes remain denied. Store Allow/Deny in the partition's own storage directory, keep
incognito choices in memory, and reset choices during profile site-data clearing. Reject opaque
and non-web origins. Keep profile isolation, persistence, navigation-during-prompt, and
camera-denial checks in [MicrophonePermission.test.ts](../../apps/desktop/src/preview/MicrophonePermission.test.ts).

**Verification and coupling.** Keep the corresponding component, pointer, drag, and draft tests
with these modules. Verify keyboard and touch interaction, one Send/microphone/prompt, opening
sidebar without width jumps, drafts across collapse, reduced motion, screen readers, and live
fold/unfold resize. Upstream composer/sidebar refactors can incorporate equivalent fixes; compare
actual behavior before reapplying a patch. Shared web changes ship in desktop/PWA and only reach
Android after rebuilding its bundle.

The APK native container zeroes handled bars/cutout/IME insets before forwarding updates to WebView;
see [shell inset maintenance](./android-pwa.md#shell-insets-and-folded-layouts). Verify native header
alignment and keyboard hide after live fold changes as well as browser viewport tests.

## Usage limits source

Desktop Limits reads the local primary connection. Web and the fork Android APK read one current
connection, with a single-choice connection picker when there is no local host. Limit refreshes,
provider accounts, hub accounts, Cursor prompts, and failure notices use that same selection.
Other-device failures are excluded while current-connection failures remain visible. Cost and
token history retain their separate multi-environment filter; the upstream React Native client
retains its own pooling view.

The selected usage atom reads no sessions, history queries, or provider snapshots for unselected
devices. Regression coverage lives in `UsagePage.refresh.test.tsx`,
`usageEnvironmentSelection.test.ts`, and `usage.sources.test.ts`.

## Chat participant identity

The shared participant contracts and client-runtime resolver retain message-time author photos
and model attribution. Web, desktop and fork Android use the same chip and profile settings;
upstream native mobile renders the shared attribution with its own chip. Preserve first personal
account initialization, per-principal local profiles, manual photo choices, bounded raster
thumbnails, broken-photo initials, and instance colors through timeline and auth refactors.
Provider credentials must never initialize human profiles. Author metadata is display information,
not proof of authorization. Replies must canonicalize their author snapshots from the target.
The fork APK uses its native session's optional public-profile request instead of Clerk browser
hooks. That read and deferred local persistence are fenced to the captured account/session/generation;
transient failure retains existing edits and metadata, and confirmed sign-out selects the local profile.

Known human authors resolve from current client profiles across chat, pinned chips and replies;
unattributed legacy messages use the active profile, while unknown recorded authors retain their
snapshots. Profile edits do not rewrite message history or other principals.
AI message bubbles default on when no preference is saved; saved opt-outs are preserved.
Web timelines place chips outside bubbles, show one per consecutive sender group, and pin that
identity while its group scrolls past. Preserve this through row recycling and disclosure changes;
agent reply controls belong beside their messages. Agent deliveries use the left side even when
their transport role is user; human messages remain on the right. In the fork Android app and on narrow mobile screens,
participant identities and subagent starts, activity, and finishes remain in the feed; duplicate
pinned identity tabs and the subagent row above the composer are hidden. Wider screens retain
those shortcuts across parent turns and scrolling. Collapsed repository groups in both sidebars and Working,
Snoozed, and Settled shelves summarize input/approval, failure/limit, and unread completion
with an icon per status and a multiplier above one. Counts use shell summaries and the same
server-authoritative read watermarks as thread rows, without opening hidden thread details.
`TimelineParticipants.test.tsx`, `CollapsedThreadStatusIndicators.test.tsx`, and the timeline
component tests cover these boundaries.

Focused coverage lives in the participant contract/runtime tests, `ParticipantChip.test.tsx`,
`ParticipantProfileSync.test.tsx`, `AndroidParticipantProfileSync.test.tsx`, the native
`ConnectParticipantProfileTest`, and `MessageReplies.integration.test.ts`. Keep plain and bubble
messages, reply chains and related-agent lists using the same identity rules. See
[chat profiles](../user/appearance.md#chat-participants-and-your-profile).

## Direct message replies

**Behavior and ownership.** Web/desktop and the fork Android web bundle expose
right-click/touch Reply, a persisted composer quote, and a focused reply-thread
dialog. [MessageReplies.tsx](../../apps/web/src/components/chat/MessageReplies.tsx)
and [messageReplies.ts](../../packages/shared/src/messageReplies.ts) own the UI
and graph traversal. V2 message context holds links; the event sink links assistant
output, and `t3_message_reply` lets live agents choose earlier user messages.
The [composer guide](../user/composer.md#reply-to-a-message) describes use and the
[internals guide](../internals/composer-context-references.md#direct-message-replies)
describes persistence and bounded history reads. React Native UI is uncommissioned.

**Verification and coupling.** Keep reply graph, composer persistence, UI action,
SQL pagination/index, canonical target, queued edit, cycle rejection, provider
projection, and MCP ownership tests with this feature. New paired hosts must ship
the reply-chain RPC and MCP tool. Compare upstream reply semantics before merging
future context, timeline, composer, and tool refactors; do not drop assistant
context or flatten a focused thread into the whole transcript.

## Stop, commands, and run recovery

**Behavior and reason.** Stop must remain reachable while work or cancellation is pending.
A settled parent does not prove its commands, delegated work, or provider children terminated.
Stopping Codex work also pauses its goal; restart recovery and cancellation have separate semantics.

**Ownership.** [ComposerPrimaryActions.tsx](../../apps/web/src/components/chat/ComposerPrimaryActions.tsx),
[ProviderTurnControlService.ts](../../apps/server/src/orchestration-v2/ProviderTurnControlService.ts),
[RunExecutionService.ts](../../apps/server/src/orchestration-v2/RunExecutionService.ts), and provider
adapters own the path. [ProviderRuntimeRecoveryService.ts](../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
owns restart reconciliation. Pending background work stays observable after a root turn settles.

**Verification and coupling.** Use control-service, recovery regression, and run-execution tests;
exercise approval waits, compaction, background commands, child agents, lost provider transport,
and cancellation awaiting process termination. Keep Stop prominent in update notices. Provider
SDK changes require reviewing process ownership and terminal-event behavior, not only UI state.

## Organizations and automation dashboard

**Behavior and entry.** Organizations provides guided Architect setup, durable bounded autonomous
work, budgets, recovery, and repository/GitHub synchronization. The agent dashboard provides
reviews, findings, implementation work, and scheduled maintenance. These are retained fork domains,
not evidence that equivalent upstream surfaces exist.

**Ownership.** Follow [Organizations architecture](../internals/organizations.md),
[Organizations user guide](../user/organizations.md),
[dashboard user guide](../user/agent-dashboard.md), and
[review operations](./agent-dashboard-reviews.md). Implementations live in
[organizations](../../apps/server/src/organizations) and
[agentDashboard](../../apps/server/src/agentDashboard).

Top-level automatic-work policies in Settings → Automation default off, including scheduled
repository review, Continuous Improvement, product opportunity discovery, Decision Follow-up,
pull request rollups, and inactive worktree cleanup. Preserve explicitly saved opt-ins when
decoding settings; manual dashboard actions remain available while scheduled automation is off.

**Verification and coupling.** Domain tests cover durable authorization, budgets, stopped work,
reconciliation, review/implementation scheduling, and credential redaction. Test new schedulers
against device maintenance fencing and the persisted restored-automation review hold; the server
runtime context must carry its singleton admission service into server-scoped layers. Keep the
[automatic security scheduler](../../apps/server/src/agentDashboard/AgentDashboardSecurityScheduler.test.ts),
[review worker](../../apps/server/src/agentDashboard/AgentDashboardReviewJobService.test.ts),
[activated Organization work](../../apps/server/src/organizations/OrganizationLiveWorkExecutor.test.ts),
and [maintenance policy](../../apps/server/src/maintenance/MaintenanceCoordinator.test.ts)
regressions with their domain suites.
Provider-role/model defaults and upstream orchestration event changes require reviewing adapters
and contracts. Tool-free Architect prompts, output validation and credential redaction now live in
[provider-core](../../packages/provider-core/src/server/OrganizationArchitectPrompt.ts), with
server compatibility exports. Packaged Cursor, Grok and OpenCode drivers own their text generation;
both OpenCode protocol versions expose the isolated Architect handler. Preserve the bound output,
private temporary directories, tool denial and native process ownership when changing their runners. Restoring old data must not silently replay schedules, queues, or standing work
authorization.

## Experimental Codex Cloud integration

**Behavior and delivery.** A compatible T3 server inside a Codex Cloud VM supports
ordinary environment-local conversations through a private HTTP/WebSocket route.
Live Squidhub commissioning verified Claude and owner-only Personal Codex chats;
clarity-relay also verified independent Personal sign-in, completed Codex turns,
and conversation persistence across a Browser reload. Unnamed and Work remain
uncommissioned. Tunnel provisioning and VM lifecycle remain experimental, and
pairing a test Browser does not pair the user's desktop profile. See
[user setup](../user/cloud-environments.md) and
[network architecture](../internals/remote.md#cloud-vm-environments).

The [Linux VM setup helper](../../scripts/cloud-environment.py) initializes only
a fresh private home with the verified fork installer and runs the native service
launcher without an OS service manager. It enables existing per-host maintenance
controls; `setup` combines fresh initialization and managed launch, while
status/update/auto-update call the same authenticated operator controller.
`setup/init --repository` with the account list and confirmed owner derives
`repository (Owner) — Codex Cloud`; `--name` accepts an explicit name instead.
Both store a repository label, passed as `T3CODE_ENVIRONMENT_LABEL`
to the launcher and every restarted runtime. Server descriptor naming resolves
that override before host discovery, leaving the persisted environment ID intact.
It requires delivery of the updated server label resolver as well as the helper;
older release archives still publish their discovered hostname.
`export-accounts` reads a source settings file and exports only Codex provider IDs,
labels, and enabled preferences. `setup/init --accounts` requires a confirmed
`--owner-account` ID and seeds only that owner by default, including its new-chat
and text-generation selections. `--include-account` explicitly opts additional
IDs into fresh setup; later additions use the existing Providers flow. When the
default `codex` slot is not selected, its legacy configuration is disabled so
registry hydration cannot silently add an enabled ambient-login provider. All
selected entries use a VM-local shared workspace home; separate browser sign-ins and
the existing protected provider credential stores own their sessions. No host
paths, environment variables, or credentials are exported. Subsequent starts
preserve provider changes. The helper's tests cover export privacy, malformed
lists, owner selection, explicit extras, fresh seeding, and refusal to rewrite
configured homes. An isolated live Squidhub VM verified owner-only Personal
selection, independent managed browser sign-in, a completed GPT-6-Luna turn,
and a follow-up after pairing through the private route. Unnamed, Work, and
multi-account Codex authentication and inference remain uncommissioned.
Client environment naming belongs to the shared connection catalog and its
web/desktop/fork Android Connections menu and upstream mobile details. Overrides
are device-local presentation data, survive discovery/route refresh, and never
replace the registry's live connection target. Server naming remains the default
for clients without an override. Removing a saved environment forgets its name.
Fresh cloud homes seed the native update policy with automatic installation on
(or `init --auto off`), without confirming bootstrap review. Later policy changes
persist through that controller, retain pins and all activity blockers, and are
never rewritten by a subsequent start. It never
replaces an existing home, fabricates launcher context, or bypasses activity,
snapshot, trial, health, or recovery admission. Verify its fresh-home refusal,
recorded-version selection, duplicate-start lock, and owned-process shutdown with
`python3 scripts/cloud-environment.test.py`. Initial managed-launch commissioning
used isolated Linux state; transition of the existing Squidhub server and a live
cloud binary replacement remain uncommissioned. See
[cloud environment updates](../user/updating.md#cloud-vm-environments) and the
[Codex Cloud setup runbook](../user/cloud-environments.md). Reusable image preparation
and task startup are documented separately; tunnel provisioning, client pairing,
and account/VM lifecycle automation remain uncommissioned.

Native Linux server startup also provisions the detached Organization launch
broker. Preserve its bootstrap in `cli/server.ts` and command registration in
`binCli.ts`; the launcher cannot quiesce scopes without it. Keep the native broker
CLI/quiescence regression in `OrganizationScopeLaunchBrokerCli.test.ts` and guarded
older-home provisioning tests in `maintenance/scopeBrokerBootstrap.test.ts` with
release update verification. The supported `maintenance scope-broker` operation
uses a verified corrected CLI only to provision that broker for an existing idle
managed home; it does not install that CLI's build or relax update admission.

**Ownership and verification.** The [managed setup helper](../../scripts/cloud-environment.py)
owns fresh VM setup and managed launch. Ordinary environment connections and
provider adapters own pairing, account isolation, conversation execution, and
maintenance admission. The former Cloud tasks panel, controller worker service,
and their RPC/MCP transports have been removed. Existing saved controller data
is not migrated into VM conversations or deleted from installed data homes.
Run the helper's focused tests and normal connection/provider suites when changing
these paths. Do not commission by starting a development server against the
installed T3 data home.

## Checkpoints and model compatibility

**Behavior and reason.** Fork fixes avoid rehashing Git LFS files while capturing checkpoints,
recover stale Codex shadow-home entries, and support the fork's configured model/role shapes.
T3-owned Git subprocesses share a budget of eight total commands and two heavy commands, with
heavy commands serialized per checkout, including commands with extended or unlimited deadlines.
Automatic status refreshes pause under storage pressure and can be disabled per project.
Checkpoints can be disabled independently, preserving existing rollback points; this removes
file rollback and automatic change summaries for new turns. These controls ship in web, desktop,
the fork APK's web bundle, and upstream mobile. Rebuilding the APK is required to deliver them there.

**Ownership and verification.** [checkpointing](../../apps/server/src/checkpointing) owns repository
state; [provider](../../apps/server/src/provider) and
[orchestration adapters](../../apps/server/src/orchestration-v2/Adapters) own provider compatibility.
Run the relevant checkpoint/provider regression tests when syncing upstream. Model availability
comes from the live provider catalog, not a documentation snapshot. Confirm whether upstream has
incorporated equivalent behavior before retaining compatibility patches.
`ClaudeAdapterV2` continuation turns drain the wake buffer before the turn becomes active and stop
replaying once a live result has closed the turn; otherwise a race leaves an agent-created run
`running` forever and every follow-up message stays queued. Keep the wake-race regression test.
The Git budget and refresh policy are owned by [vcs](../../apps/server/src/vcs) and
[background](../../apps/server/src/background); checkpoint policy is enforced by the V2
[CheckpointService](../../apps/server/src/orchestration-v2/CheckpointService.ts). Retain their focused
budget, pause/recovery, inheritance, and checkpoint-disable tests when syncing upstream. These
limits cover T3-owned commands; provider shells and other applications have separate process owners.

## Conversation evidence retention

Conversation evidence media uses chat-read authorization and signed exact-file URLs on the
connected environment, including Tailscale. The server validates the physical per-conversation
directory before signing; other host media continues to require filesystem-read permission.
Agent image paths beginning with `~/` resolve on the environment host. Hosted image failures
refresh their signed URL once and expose manual retry instead of waiting for the periodic refresh;
repeated failures must not cause a request loop or bypass file permissions. Raster pictures stored
as file-picker attachments serve inline by default, including to older receiving clients; explicit
downloads and other file formats retain their existing disposition.
Keep these boundaries covered in `AssetAccess.test.ts`, `RpcAuthorization.test.ts`, and
the client's asset URL and media routing tests.

**Behavior and entry.** Settings → Storage → Conversation evidence controls environment-wide
cleanup when a conversation is archived or its evidence reaches the chosen age. Both policies
start disabled. Saved agent browser screenshots and claimed recordings are owned by their
conversation. Agents receive instructions and the `t3_evidence_directory` tool for other temporary
outputs; arbitrary shell writes are not redirected. Permanent deliverables belong outside this
storage. Legacy browser captures and desktop-local recording copies retain their separate policy.

**Ownership and coupling.** [ConversationEvidence.ts](../../apps/server/src/assets/ConversationEvidence.ts)
owns safe per-conversation paths and file capture; [storageCleanup.ts](../../apps/server/src/storageCleanup.ts)
owns retention and waits for active runs, background tasks, and shell processes to stop. Cleanup
sweeps use the host admission lease, and evidence is included in update restore points and rescue copies. Shared
[Storage settings](../../apps/web/src/components/settings/StorageSettings.tsx) reach web, desktop,
and the fork APK; the APK needs a rebuilt web bundle. Upstream mobile has its own Storage route.
Older hosts omit the capability and do not receive evidence settings. Existing installations need
an updated host before captures use the new storage.

**Verification.** [Evidence service tests](../../apps/server/src/assets/ConversationEvidence.test.ts),
[cleanup tests](../../apps/server/src/storageCleanup.test.ts), and the MCP preview/registration tests
cover conversation ownership, upload retries, archive and age policies, busy-thread protection,
and safe cleanup boundaries. Deleted conversations remain eligible for age cleanup. Removing
files invalidates their evidence links; unarchiving cannot restore them. Uploaded message
attachments, conversation history, and project files remain outside these policies.

## Discord bridge

**Delivery and entry.** The host server can mirror linked agent threads to Discord and accept
messages from configured author IDs. It is configured only through the server's
`discordBridge` settings and secret store; there is no client Settings screen. The bridge runs in
the server process, including when the operator reaches that host over Tailscale. The
[Discord guide](../internals/discord-bridge.md) documents token storage, channel permissions,
allowlists, REST polling, and the activity data sent to Discord.

**Ownership.** [DiscordBridge.ts](../../apps/server/src/discord/Layers/DiscordBridge.ts) observes
committed v2 events and runs the inbound poller; [DiscordRestClient.ts](../../apps/server/src/discord/DiscordRestClient.ts)
owns REST requests; [DiscordBridgeLinks.ts](../../apps/server/src/persistence/DiscordBridgeLinks.ts)
persists thread links, message chunks, and inbound cursors. The bridge applies the shared
maintenance and restored-automation admission policy to each outbound write and inbound message.
Outbound events waiting on maintenance are retained only in the serial in-memory queue and are
lost if the host process restarts before they run.

**Verification and coupling.** [DiscordBridge.integration.test.ts](../../apps/server/src/discord/Layers/DiscordBridge.integration.test.ts)
uses the actual SQLite link repository to verify the durable cursor survives dispatch failure,
maintenance holds block both inbound and outbound writes, and a held outbound item retries after
admission reopens. Keep oldest-first polling from moving the cursor past an unconsumed message.
This is host functionality, not an APK or cloud-push feature.

## Updates and recovery

**Update now** uses the same exact-artifact installation action as the CLI and host controls.
Explicit installation skips the automatic idle window and countdown through a durable
transaction journal flag; automatic delivery keeps both. Preserve fresh process and activity
checks, admission leases, all runtime fence acknowledgements, snapshots and recovery capacity.
Turning off automatic installation leaves manual installation available. Desktop controllers
without WSL members advertise interruption support. The UI warns only when work is running,
then sends an exact-artifact `interruptActiveWork` confirmation. Normal backend shutdown
preserves session recovery; the affected cohort remains pinned until handoff or a safe abort.
An abort restarts old backends after admission is released. Surviving work and unrelated
runtimes still block installation. Android retains its native installation guard.

Maintenance uses the `active-runtime` projection selector; restart recovery keeps
`runtime`, which also reconciles ready provider sessions. A ready session alone is
not active work. Keep one shared `IdleProcessRoots` service at server scope so
spawn sites and the collector use the same exact PID/creation identity registry. The shared
package owns [idleProcessRoots](../../packages/shared/src/idleProcessRoots.ts); the server
[compatibility export](../../apps/server/src/maintenance/IdleProcessRoots.ts) re-exports that same
service object. Provider packages must import the shared service rather than create their own registry.
Only a verified provider root is exempt: terminal shells, unregistered helper
children (including a lingering code-mode host), reused PIDs, and unknown process
observations still hold installation. A completed turn does not prove those
children have exited; never stop sessions or clear their records to obtain admission.

GitHub feed rate limits are different from ordinary network failures. Respect the
controller's `nextCheckAt` for desktop automatic checks; four-minute wakeups do not
override the normal four-hour feed cadence or failure backoff. Explicit checks can
run sooner unless GitHub's enforced cooldown is still active. Respect the
advertised reset time and `Retry-After` delay, keep the staged artifact, and report
an offline blocker while the cooldown is active. Repeated manual checks and install
requests must not consume more requests during that period. Installation still
requires a fresh eligible release listing afterward; cached metadata never admits
an update when the release origin cannot be checked.

### Resolve an unknown orphan after offline verification

An orphan created by an incomplete process census can remain blocked even when no child PID was
recorded. Use this procedure only for recovery from an already stopped runtime, never to stop live
agent work to make an update proceed. When their work has finished, exit every T3 client and
server on the device, then inspect the local coordinator records:

```sh
t3 maintenance orphans --json
```

Check the recorded owner identities, every listed child, and any active transaction fence. Also inspect
the host process list and verify there is no unrecorded T3, provider, terminal, or agent work. The
attestation command rechecks that the exact owner and every registered runtime owner have exited, that
known children are gone, and that no transaction fence is active. It removes only the named orphan.
An unknown-identity child PID must be absent; a reused or still-running PID is refused. A stale owner
identity, missing confirmation, unreadable process identity, or any live runtime is refused.

Copy `id`, `owner.pid`, and `owner.started` for the exact orphan from the JSON output, then type the
required acknowledgment exactly:

```sh
t3 maintenance attest-orphan \
  --participant 'PARTICIPANT_ID' \
  --owner-pid OWNER_PID \
  --owner-started 'OWNER_CREATION_IDENTITY' \
  --confirm 'I checked for unrecorded processes'
```

This command never terminates a process or removes a transaction fence. If work is still active, wait
for it to finish. If process identity cannot be read, keep the device blocked and resolve the host
problem before retrying.

**Ownership.** Additive wire contracts live in
[maintenance.ts](../../packages/contracts/src/maintenance.ts). Host ownership, activity admission,
and durable transaction boundaries live in [maintenance](../../apps/server/src/maintenance).
[AppUpdateSettings.tsx](../../apps/web/src/components/settings/AppUpdateSettings.tsx) is the desktop
client's canonical update control; About shows identity. Browser cache reload belongs to
[PwaAppUpdateSettings.tsx](../../apps/web/src/components/settings/PwaAppUpdateSettings.tsx) and is
hidden in the APK because it cannot replace native code. Release history and CLI installers target
this fork.

**Arcwright version ownership.** The displayed T3 base comes from
[`fork-upstream.json`](../../fork-upstream.json); the separate Arcwright counter identifies
our build. [`buildVersion.ts`](../../packages/shared/src/buildVersion.ts) owns shared labels,
with the native equivalent in `VersionLabels.java`. Keep compatibility checks separate from
installer ordering and fork release availability. Maintain provenance when integrating upstream,
and retain immutable historical installer identities. See
[version provenance and history](./fork-releases.md#version-provenance-and-history) for build
ownership, label tests, and release-title cleanup rules.
Target selection recognizes historical `0.0.x-preview` and `0.0.x-fork` installed identities
without admitting their artifacts into the release feed. This compatibility does not bypass
coordinator bootstrap, activity admission, or recovery requirements.

**Implementation and commissioning.** Coordinator services, multi-home transactions, desktop
and Android controllers, shared UI controls, native recovery, external recovery helpers, and fork
release workflows are implemented with focused verification. The initial fenced journal is durably
written under the coordinator lock before the registry publishes its fence; a journal left by an
interrupted fence acquisition is inert, and an unexplained fence remains blocked. A complete signed manual baseline is
available; automatic publishing and production rollout remain uncommissioned. The release rehearsal and hardware update/recovery checks must pass
before enabling automatic publishing. Existing installations need the known-good updater baseline
and explicit device bootstrap before participating. A successful source test is not a hardware
installation receipt.

Desktop activity reporting is owned by
[maintenancePolling.ts](../../apps/desktop/src/maintenance/maintenancePolling.ts), started by
`DesktopForkMaintenance`. Its observation loop must remain independent of serialized updater
actions: installation waits for a fresh post-fence observation from the desktop itself. The
[polling regression tests](../../apps/desktop/src/maintenance/maintenancePolling.test.ts) hold
the controller busy beyond the stale threshold and verify both acknowledgement and detection of
new work. Include this scenario when changing updater scheduling or admission.

`maintenanceCore` also records both committed updates and verified recoveries in the installed-build
identity. Recovery must adopt the journal's predecessor digest and increment the installation sequence;
the record is outside restored userdata. Verify that the current digest matches the recovery pin and
that Resume retains the separate automation-review hold.

The native Android recovery screen also opens a pending Android installation confirmation directly.
`RecoveryActivity`, `UpdateEngine`, and `UpdateNotifications` own this route. Verify it with both
normal and recovery APKs, including a dismissed notification and a restarted app process; the
button must open the existing app-owned installer session and must never submit another install.

While an Android installation request waits, native `UpdateEngine.statusTarget` must name the
exact requested artifact, including a cached rollback when a newer normal update is staged. The
web adapter disables a second install action until that request finishes or is cancelled. Keep
[UpdateEngineStatusTargetTest.java](../../apps/android-pwa/app/src/test/java/com/devotek/t3code/pwa/UpdateEngineStatusTargetTest.java)
and [updates.test.ts](../../apps/web/src/android/updates.test.ts) in the release verification for
selected-target identity and pending-request controls.

Android updater persistence belongs to `UpdateStore`. Its backup must be written separately while
the committed primary stays readable, then the new primary is atomically renamed over it. Package
replacement can terminate any lifecycle write; moving the primary away before committing the new
file produces a false corruption hold. `UpdateStoreTest` verifies interrupted commits preserve the
installer session and recovery pin. See [state and restart verification](./android-pwa.md#state-pins-and-restart-verification).

The native recovery page can also discard explicitly confirmed orphaned Android installer
sessions after backup recovery. `InstallerSessions` and `InstallerSessionsTest` own identity,
ownership, inactivity, and stale-dialog checks; `UpdateEngine` revalidates before cancellation.
This repair leaves the safety hold and update policy paused until the normal reboot/settings review.

**Verification.** [forkMaintenanceAdmission.test.ts](../../packages/shared/src/forkMaintenanceAdmission.test.ts),
[forkMaintenanceStore.test.ts](../../packages/shared/src/forkMaintenanceStore.test.ts), and
[forkMaintenanceTransaction.test.ts](../../packages/shared/src/forkMaintenanceTransaction.test.ts) cover stale/unknown
participants, live ownership, launch races, five-minute idle windows, capacity, all-home snapshots,
WSL health failure, interrupted restoration, and the durable commit/write-admission boundary.
[Desktop maintenance tests](../../apps/desktop/src/maintenance/DesktopForkMaintenance.test.ts)
exercise its controller and startup recovery; [handoff tests](../../packages/shared/src/forkDesktopHandoff.test.ts)
exercise replacement after the recorded owner exits. Native guard/storage tests and isolated
`UpdaterSmokeInstrumentation` cover Android. Release suites bind required tests and package
receipts to the exact candidate commit and payload.

**UI maintenance.** [AppUpdateSettings.tsx](../../apps/web/src/components/settings/AppUpdateSettings.tsx)
and [ForkUpdateControls.tsx](../../apps/web/src/components/settings/ForkUpdateControls.tsx) own
client presentation; the state controller and host controller own requests. Shared presentation
keeps the phase, blocker details, and failure alert distinct so Settings does not repeat the same
status or error. Affected local homes use the client’s actual platform name; WSL homes keep
their separate distribution labels. Packaged updater identity requires the full source commit in
build metadata, even though the UI abbreviates it for display.
[HostUpdateSettings.tsx](../../apps/web/src/components/settings/HostUpdateSettings.tsx) presents
named environments in Connections. [hostUpdateBatcher.ts](../../apps/web/src/state/hostUpdateBatcher.ts)
serializes distinct replacement targets under their explicit coordinator ID and coalesces aliases
by the controller's affected-home identity; [its tests](../../apps/web/src/state/hostUpdateBatcher.test.ts)
cover aliases, separate homes, independent devices, offline results, and retry. Both sidebars
use [ForkSidebarUpdateStatus.tsx](../../apps/web/src/components/sidebar/ForkSidebarUpdateStatus.tsx),
and the application menu opens the canonical settings surface. Host notices and machine
compatibility/update actions live in the shared sidebar footer through
[SidebarHostUpdateNotices.tsx](../../apps/web/src/components/sidebar/SidebarHostUpdateNotices.tsx),
including remote web/APK environments. The composer and conversation details do not render
update cards. Host notices use the selected thread/draft environment, falling back to the primary
environment outside a conversation; the machine list retains independent update targets.
Recovery and restored-automation review have separate dialogs and interaction tests. When these
surfaces move, update Settings search, navigation, both sidebars, user routes, and the relevant
interaction tests together. Electron/native/host services retain installation authority; UI adapters
do not duplicate admission logic.

## Keeping this guide accurate

Update this guide and the appropriate user/runbook/architecture page in the same change whenever
behavior, UI location, ownership, build requirements, or compatibility changes. Keep obsolete
instructions out of live guides. Link meaningful verification scenarios and tests; do not substitute
a file inventory for feature ownership. Before an upstream merge lands, check retained behavior,
shared contracts, both sidebars, all update entry points, APK origin boundaries, and operating docs.
Use isolated data/coordinator namespaces and Luna agents for delegated testing and review.

## Copy-on-write worktrees

The CLI `t3 update` adapter in
[`coordinatedUpdate.ts`](../../apps/server/src/maintenance/coordinatedUpdate.ts) uses the running
home's operator credential and maintenance controller. It cannot install from an unrelated release
index, repoint a launcher independently, or use a legacy service restart as a fallback. Maintain
[`CLI admission tests`](../../apps/server/src/cli/update.test.ts) in the host-runtime release suite.

CLI pairing against a live home uses the existing server’s owner-authenticated local pairing route. It never registers a second runtime or opens the live database. A maintenance fence refuses issuance; a live server without this API must be updated rather than falling back to offline issuance. Offline `auth pairing create` retains ordinary startup admission when no server is running.

**Delivery.** Implemented in source; desktop and APK release delivery has not been commissioned.

**Behavior and entry.** Settings → Source control → Space-efficient worktrees is an opt-in
server setting. The host probes mandatory file cloning on the worktree filesystem; incompatible
hosts show a disabled control with the reason in web, desktop, the fork APK, and upstream mobile.
A clean checkout base shares unchanged data across new worktrees. Existing worktrees are not
converted, and engine caches remain separate.

**Ownership.** [WorktreeStorage.ts](../../apps/server/src/vcs/WorktreeStorage.ts) owns filesystem
probing, the per-repository checkout cache, and cached disk measurements. The glance rail
requests active-worktree usage only while open, on the thread's environment. Btrfs uses optional
unprivileged `btrfs-progs` for exclusive/shared data; other filesystems use labeled allocation
estimates (Windows uses logical file size). Shared Git objects are outside this measurement.
[GitVcsDriverCore.ts](../../apps/server/src/vcs/GitVcsDriverCore.ts)
initializes independent Git indexes and reconciles the base with the requested tree for UI,
MCP, and background creation paths. The shared client compatibility rule uses the selected
server's advertised support, never the client device's filesystem.

**Verification and coupling.** Focused storage and Git worktree tests cover clean indexes,
cross-commit deletions, independent edits, tracked-only caching, cache replacement, and unsupported
hosts. Custom checkout filters and external attributes bypass reuse; submodule initialization
continues through Git. Shared web changes require rebuilding the fork APK to ship there.

## Standalone Android Connect authentication

**Behavior and entry.** Configured APKs select the native managed-auth shell, open Account Portal
in the system browser, and expose app-owned sign-in/account/sign-out UI. Browser/Electron retain
Clerk providers, account menus and modals. CLI authorization remains hosted-browser-only. Cloudless
builds keep direct pairing. Configured managed alert routes renew a separate native read-only DPoP
session; owned-service and real-phone delivery commissioning remain pending.

**Ownership.** [ConnectAuth.kt](../../apps/android-pwa/app/src/main/kotlin/com/devotek/t3code/pwa/ConnectAuth.kt)
owns account generations, callback lifecycle, cancellation and local logout recovery.
[ClerkConnectAuthSdk.kt](../../apps/android-pwa/app/src/main/kotlin/com/devotek/t3code/pwa/ClerkConnectAuthSdk.kt)
is the supported API-only SDK adapter; the SDK owns Android Keystore persistence and PKCE.
[ConnectAuthBridge.kt](../../apps/android-pwa/app/src/main/kotlin/com/devotek/t3code/pwa/ConnectAuthBridge.kt)
owns the bounded origin/main-frame bridge. The app-owned auth context and Android observable store
feed the shared [managedAuth.tsx](../../apps/web/src/cloud/managedAuth.tsx) relay cleanup/token path.
The build helper resolves one selected public profile for native BuildConfig and bundled Vite;
remote authorization origins remain separate from local surface classification.
[NativeManagedNotifications.kt](../../apps/android-pwa/app/src/main/kotlin/com/devotek/t3code/pwa/NativeManagedNotifications.kt)
owns reference registration, SDK-restoration identity checks and logout cleanup without a WebView.
[ManagedRegistrationCleanup.kt](../../apps/android-pwa/app/src/main/kotlin/com/devotek/t3code/pwa/ManagedRegistrationCleanup.kt)
binds rejection cleanup to the registration's opaque revision and native account fence under the
registration lock; delayed cache eviction matches the same revision/fence.
[NotificationFrameState.kt](../../apps/android-pwa/app/src/main/kotlin/com/devotek/t3code/pwa/NotificationFrameState.kt)
protects final watermark writes and actual alert publication with that lock. Configure and direct
registration mutations share it; direct selection checks remain independent of Clerk and preserve
unchanged/legacy pairing credentials.
The service closes its `PhoneAlertQueue` owner on every connection removal/replacement, including
direct routes, so presence-delayed alerts cannot transfer to a replacement selection. Socket retry
retains the same owner and pending alerts.
Actual registration replacement, including same-account managed re-registration, clears durable
watermarks under the registration lock. Fresh snapshots re-prime outstanding approvals while keeping
historical completions quiet; unchanged direct registration/retry retains state. Configuration removal
also clears watermarks for dormant direct credentials before re-enable.
Publication acknowledges queue entries only on success. Temporary SDK unreadiness retains owned
pending work with its original expiry, and rejected frame/ticket/socket admission retries the same
connection through bounded backoff; displacement discards it. Ownership retains the established
native identity but never authorizes network requests or publication. Same-session recovery requires
no WebView or registration update and always obtains a new single-use socket ticket.
`ConnectAuth` logout flags and observed account/generation transitions use the same credential
monitor as final publication and persistence; the Application binds it explicitly. An admitted local
post/write completes before the native transition becomes visible. SDK jobs start, suspend and reset
outside the monitor, and session eviction never joins under it. Main-thread auth can wait for an
in-progress local preference/notification operation, never a suspended SDK or HTTP exchange.
[NativeManagedEnvironmentSession.kt](../../apps/android-pwa/app/src/main/kotlin/com/devotek/t3code/pwa/NativeManagedEnvironmentSession.kt)
and [NativeDpopKey.kt](../../apps/android-pwa/app/src/main/kotlin/com/devotek/t3code/pwa/NativeDpopKey.kt)
own the worker-only renewal chain and separate native proof key. The notification service retains
its shell/presence/dedup/backoff policies and requests only `orchestration:read`.

**Verification and coupling.** Native unit tests cover cancellation, stale and duplicate callback
handling, initialization, process-death logout cleanup, renewal fencing and origin/request bounds.
Focused web tests cover readiness, account transitions, stale tokens and browser/Electron account
capabilities and ordered managed/direct notification registration. Fake HTTP native tests verify
ES256/JWK/claims, exact exchanges, scope/expiry validation, nonce/replay rejection, fresh tickets,
concurrent renewal, redirect/mismatch rejection and account fences; SDK restoration tests cover
process-local generations and transient readiness. Deterministic blocked-HTTP/lock fixtures verify
that old rejection cleanup retains newer managed/direct registrations and state while current
revocation still removes its own registration; deferred eviction cannot delete newer tokens.
Paused real-thread-watermark fixtures prove that logout/replacement cannot reintroduce stale receipts
or suppress a new approval; current managed/direct frames persist and publish, and publication is
serialized with direct/managed selection changes. Full native assembly and lint prove the upgraded OkHttp/Kotlin dependency graph against
the retained Java shell. Keep direct pairing, installation-scoped push credentials, drafts and
native browser state separate from account logout. A process killed mid-login cannot recover SDK
private in-memory PKCE; an old exact callback is consumed with a retry message. Live sign-in,
restoration/renewal/logout and private service commissioning still require the runbook's phone proof.

## Persisted Connect service authority

Server/CLI authority admission lives in [connectAuthority.ts](../../apps/server/src/cloud/connectAuthority.ts)
and [CloudLink.ts](../../apps/server/src/cloud/CloudLink.ts). Preserve dormant raw link presence:
an incompatible or cloudless saved record must never look absent to auto-enrollment. New OAuth
exchanges and owned links carry public authority bindings, checked even when a known binding
is read in legacy mode; historical unbound legacy restore remains explicit compatibility behavior.
Connector restore/offline fallback, recovery/deletion, signed proof acceptance, publishers, held
hooks and webhook advertisements all use this policy. Local unlink clears only Connect link
secrets, intent and preferences and retains a bounded public cleanup reminder, without scheduling
old-service work or retaining credentials for it. Deliberate matching-profile CLI remote
success or protected web acknowledgement after successful deletion clears only its matching
origin/environment reminder. Unknown-origin reminders stay unresolved for manual review;
malformed/missing saved URLs never force retention of local Connect secrets. Local paired status
and cleanup remain visible in cloudless and partial-record states without managed sign-in.
The acknowledgement uses authenticated HTTP plus `AuthRelayWriteScope`, with no new RPC, and
trusts the authorized writer's remote-success attestation. A full/corrupt reminder file must still
allow desired-off and local connector stop while retaining credentials/binding and reporting failure.
Preserve `cloud-local-disabled` admission across restart; optional `locallyDisabled` uses the existing
neutral wire status instead of adding a closed-enum value. Only successful explicit cleanup or
deliberate realm-valid configuration completion clears it; autonomous reconcile stays inactive.
Reminder append/confirmation must share a cross-process lock over the entire read/modify/write,
not only atomic rename or an in-process semaphore. Keep bounded acquisition, a finite heartbeat,
scoped release, and no automatic stale-lock reaping. Crash-leftover locks require manual review
with all writers stopped; contention or ownership failure must retain the local-disabled state.
Reminder-only CLI cleanup must not bypass surviving incompatible state, including missing saved URLs.
Cloudless terminal link commands reject before runtime acquisition or OAuth. Keep provider/direct
credentials, data and automation choices.

Run the focused cloud lifecycle/token/runtime, relay publisher, webhook proof and web link-controller
regressions when changing this boundary. [Connect setup](./connect-setup.md#changing-the-account-service)
explains the reverse flow. PWA source authority is implemented in
[pwaPushRelay.ts](../../apps/web/src/agentNotifications/pwaPushRelay.ts): owned records are scoped
to normalized relay origins, automatic sync requires the saved endpoint and compatible VAPID key,
and owned/cloudless never use an implicit upstream fallback. Preserve separate Reset/Enable
taps for iOS activation, local preview/disable, and pending remote cleanup. See
[PWA Web Push](../internals/pwa-web-push.md) for anonymous versus authenticated notification
boundaries and uncommissioned owned delivery. Relay ownership lives in
[anonymousPwaPolicy.ts](../../infra/relay/src/agentActivity/anonymousPwaPolicy.ts): validated owned
policy disables anonymous routes, publisher fanout, transitions, queue production and transport,
including old anonymous jobs; credential-authenticated installation removal remains cleanup-only.
[webPushRuntime.ts](../../infra/relay/src/agentActivity/webPushRuntime.ts) captures the Worker configuration.
Authenticated endpoint conversion locks the actual row and clears installation authority and old
ownership baselines atomically, retaining a clean same-owner baseline. Anonymous registration also
locks installation/endpoint rows and performs credential checks and endpoint transfer in one transaction.
Internal durable link/subscription incarnations rotate on authority or target replacement;
public link activation time advances without rewriting original creation provenance. Preferences
and same-owner credential replacement preserve the alert baseline. The ordered incarnation migration
is fixture-verified and pending in production. Focused handler/service tests
and explicitly opted-in disposable PostgreSQL conversion/rollback/concurrency fixtures cover this
source boundary. V2 producer binding uses WebCrypto and explicit activity/test contracts;
all five producers select the subscription incarnation, and activity includes the verified
environment key and account link incarnation (explicit null only for legacy anonymous jobs).
The source consumer verifies HMAC/TTL before policy or reads, then revalidates current
subscription ownership/incarnation/target and activity preferences on every retry. Account activity
uses the exact notification-enabled active account/key/thread/link incarnation and current
state/version/age; copy comes from that authorized row and names require queued and current
permission. Phase age uses fresh time after the relevant authority read and before claiming,
allowing exact expiry equality. Explicit manual tests use fixed generic copy and `/` despite automated preferences.
Owned mode rejects verified V1 and anonymous V2; legacy V1 retains historical copy. Legacy
anonymous V2 stays generic and checks current installation/environment/preferences plus signed
kind/age, with no current source-key/state projection; those changes can remain invisible until
TTL or phase age expires. Denials write no attempts. Conditional transactional 404/410 cleanup
preserves replacement incarnations and their baselines. Fresh database observations admit a send
without a network lock; later changes may race it, and every retry reauthorizes. Focused signed
queue/adapter and PostgreSQL race fixtures establish local source behavior, not browser rendering
or device arrival. Production migration, broader Worker assembly and owned commissioning remain
pending. Native installation credentials and historical release/recovery
rollback authority (**NEXT Task4D**) remain outside this server change; commissioning requires its
own live validation.

Usage pooling keeps one quota bucket per authenticated subscription and workspace. When several
native provider instances share a bucket, retain every configured name and show the shared quota
in account details; never hide a configured instance behind the first label or count its quota twice.

The [October 15 upstream integration](upstream-integration-20261015.md) records ownership and regression coverage for the read-only SQLite worker, fork migration 108, strict backup headroom, physical Windows dependency staging, and retained client features.
