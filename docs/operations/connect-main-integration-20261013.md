# Connect feature integration — 2026-10-13

This source merge combines the reviewed Connect branch at
`23c400e8fbf8f15947f98d9738b523e678c9c813` with pinned local main
`86b38c7b368af6a0bc0cf2bde0c9bf2e11d8c0a8`. Their common base is
`17e1ba033e5fb71471006a62df6da91efa4e998a`. The included upstream remains
`511d20c6f20c2ed6ff787aba068d7d673e2949b9`, recorded in `fork-upstream.json`;
the T3 base is `0.0.45`, separate from Arcwright release counters and installer
identities. The incoming frozen dependency graph upgrades Effect from `4.0.1`
to `4.0.2` and retains its provider/source-control package extractions.

## Combined behavior

The eight textual conflicts combine required behavior:

- Browser/Electron auth shells keep the Connect managed-auth adapter and relay
  provider, with incoming personal-profile synchronization under the Clerk provider.
- Native-mobile onboarding retains its new Refresh action and Arcwright Connect name.
- The shared route model retains VPN classification, confirmed Tailscale markers,
  learned-route credentials and existing protocol IDs; visible labels remain Arcwright.
- Route settings retain the APK's direct-notification selection alongside the updated
  route list and drag controls.
- Shared package exports include both `connectProfile` and every incoming export.
- Outside-agent and remote-access guidance combines the new reachable-route and
  permissions behavior with the Connect branding and owned-service boundaries.

Clean-merge inspection found a deleted-path caller: Connect's pending-cleanup store
now imports the unchanged atomic-write helper from `@t3tools/shared/atomicWrite`.
The CLI's side-effect-denial fixture includes the new relay-client pruning method.
Native public-config type imports use an explicit extension. New route and renewal
test expectations match the retained Arcwright display labels; their permission and
credential assertions remain intact.

| Retained area                          | Combined ownership and checks                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build profile and hosted entry         | Atomic legacy/owned/cloudless public profiles, build digests, private hosted LocalState, frozen public content, hosted-only assets/CSP/legal links and CLI PKCE remain. Profile/build, hosted-artifact and legal/PWA tests pass.                                                                                                      |
| Native auth and notifications          | SDK 1.1.11, authority admission before SDK initialization, callback/cancellation/restoration, account fences, selected-registration locking, direct-route alerts and read-only native DPoP renewal remain. Native and bundled-web regressions pass.                                                                                   |
| Personal participant profiles          | Browser/Electron keep incoming Clerk synchronization. The APK uses an optional request-only native public-profile action, described below. Shared contracts, resolver, chip and profile settings remain.                                                                                                                              |
| Persisted Connect authority and unlink | Server/CLI, shared authorization, PWA and native credential bindings, local-disable state, bounded cleanup reminders and cross-process atomic cleanup locking remain. Lifecycle, HTTP, CLI and cleanup tests pass.                                                                                                                    |
| Relay admission and delivery identity  | Opaque owned OAuth introspection, preflight before Worker construction, anonymous-PWA exclusion and cleanup-only removal, locked account conversion and durable link/subscription incarnations remain. Auth/API/service tests and scoped persistence checks pass. The existing ordered PostgreSQL incarnation migration is unchanged. |
| Driver canary                          | Actual Drizzle public exports, lazy runtime acquisition, read-only transaction, secret/scope/head gates, response deadline, owned interruption/finalization and offline Workerd fixtures remain. Merged dependency-graph fixtures pass; no live commissioning occurred.                                                               |
| Maintenance and recovery               | Incoming coordinator, all-home snapshots, launch/write fencing, durable health, shared idle-root identity, native APK guard and recovery ownership are retained without divergence in their incoming implementations. No update or recovery was performed.                                                                            |
| Storage and history                    | Incoming migration 107, schema fingerprint, compressed payload compatibility, verified legacy archives and compact cold blocks remain unchanged. Focused migration/storage fixtures pass without reading or migrating a live database.                                                                                                |
| Providers, automation and shared UI    | Incoming provider/source-control packages, RPC/session/presentation changes and personal profiles remain alongside drafts, replies, Stop, sidebar dragging, phone browser and temporary shares. Six automatic-work defaults and saved-choice decoding remain incoming source; nothing enables them during integration.                |

## Native participant-profile compatibility

`getParticipantProfile` is a bounded optional native request, leaving protocol-1
status fields unchanged. The SDK adapter reads only the matching session's user or
public-user snapshot, not a possibly transitioning independent user flow. Public
name/avatar/external-account presentation is capped and fenced by user ID, session
ID and generation before and after the read and again before local persistence.
No credential, device token, private SDK metadata or raw SDK error crosses this action.
Both primary and external-account avatar responses use a native-only refinement:
at most 2,048 characters, parsed HTTPS with a hostname, no userinfo (including empty
markers), and no raw spaces, C0/C1 controls, backslashes or invalid percent escapes.
The shared manual-profile photo contract, including raster data thumbnails, is unchanged.

The APK selects its per-user profile immediately, seeds public metadata once through
the existing shared `seedProfile`, preserves manual edits and existing metadata on
failure, and selects the local profile only on confirmed sign-out. Same-generation
readiness/error/token refreshes do not repeatedly seed it. An older bridge without
the optional action retains auth and manual profiles; a fresh profile has a neutral
name and no photo when public metadata is unavailable. Tests cover delayed reads,
account/session replacement, account return, malformed metadata, sign-out and fallback.

## Verification and limits

Initial merge `f6b2e266396851fb4f244e8312fa52b4b71ccbde` passed
**985 TypeScript tests across 67 files** and
**64 native tests across nine selected suites**, with no skipped assertions. The
12-file profile/route group was rerun after correcting two obsolete display-label
expectations; affected web/native profile tests were also rerun after final cleanup.
Repeated rounds are excluded from those totals. Native debug compilation against the
installed Clerk SDK and the final two affected native suites passed on existing
JDK 17/Android SDK tools. No release APK, signing, installation or physical-phone
acceptance was performed.

A subsequent spec correction tightened native avatar response acceptance without
changing the Kotlin SDK adapter, protocol status fields, account fences or manual
photo contract. Its affected store/profile suites passed **29 tests across two files**;
web typecheck, targeted lint and the documentation checker passed. This adds 18
response-validation cases to the original coverage; it does not claim a rerun of
the complete initial integration or native compilation.

Actual installed `tsc-rs 0.4.0` and the prepared
`TypeScript 7.0.2+effect-tsgo.0.51.1` retain the repository's diagnostics.
Scoped checks pass for server, web, mobile, contracts, shared, client runtime,
Connect build/profile helpers, relay persistence and driver canary. Full relay scope
retained exactly **14 pre-existing errors** at integration: two assembly context errors,
eleven Worker API/layer errors and one Node HMAC import diagnostic. The bounded V2 queue
producer slice removes the Node HMAC diagnostic with the existing WebCrypto service;
actual full relay diagnostics now retain the same **13** assembly/Worker errors with
no new errors. No assertion, service
requirement or compiler rule was weakened to remove them. The ten-guide documentation
checker, focused lint, conflict-marker scan and whitespace check against pinned main
pass. Incoming dependency patches retain their original upstream whitespace.

Independent spec/quality and server/recovery/UI/Android source reviews remain separate
controller gates. Production assembly repair, current-authority V2 Web Push delivery, owned relay commissioning, actual
production PostgreSQL delivery/migrations, device signup/renewal/logout, notification delivery and
release/update/recovery verification remain pending. The old frozen artifact at the
pre-merge source is not production proof for this merge or Effect 4.0.2. Canary deadline
fixtures establish response/interruption/finalization behavior, not a guaranteed clean
socket after disconnect; native disconnect-signal wiring remains unverified.

This integration used local source and isolated fixtures only. It did not open Cloud
conversations, operate a VM/account/browser, deploy, publish, install, stop production
agents, or write a live T3 data home.
