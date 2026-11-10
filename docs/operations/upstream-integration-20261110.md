# Upstream integration, 2026-11-10

This integration includes upstream `pingdotgg/t3code` commit
`8ee7183e6c8a1c22a6698f4909ef7e2a423bec3a` on top of fork commit
`f2cd33caef10070a0af423bfe35a0b21b167edc3`. The included package base is T3 0.1.8;
`fork-upstream.json` records that provenance separately from the release pipeline's
allocated Arcwright nightly counter.

## Compatibility boundaries

| Area                   | Retained behavior and incoming integration                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Conversation recovery  | Provider starts, restarts, fallback, inherited context, side chats and merge-back use bounded history reads with stored/logical byte admission before inflation. Exact command/current-run/recovery state is admitted and read in one SQLite transaction. Omitted context is reported; saved history is retained.                                      |
| Queued messages        | Command reads retain authoritative user messages, execution nodes and attempts. A fixture with 600 pending nodes verifies a queued root is preserved independently of the 500-row history window.                                                                                                                                                      |
| Maintenance            | Verified exited-owner lock recovery shares immutable claims with explicit repair. Live, unknown and interrupted ownership remains blocked. Registry fences, journals, snapshots and activity admission stay authoritative. Upstream reclaim-on-shutdown is unavailable until it has durable fork maintenance authorization; stale markers are ignored. |
| Storage and migrations | Published fork migration identities and legacy payload/archive readers remain intact. Upstream scheduled-task migration 80 maps to fork 127 without replacing the published fork 80. The schema and migration audit retain upstream and published-fork compatibility.                                                                                  |
| Composer and providers | Plan/Build controls, provider profiles, saved selections, queued work, context meter and responsive composer remain. Incoming voice, clear, prompt suggestions and provider changes are combined with those paths. Cursor file credentials and explicitly opted-in Keychain usage remain available; Keychain access defaults off.                      |
| Client and Android     | Folder/sidebar compatibility, Stop, Tailscale pairing, native browser snapshot annotation, live element controls and the standalone Android APK remain distinct from upstream Expo mobile. Existing paired-client contracts and device maintenance remain supported.                                                                                   |
| Packaging              | Arcwright assets, package/signing identities, fork release feeds, source provenance and installer verification remain. Incoming web icons are regenerated from the Arcwright masters. Minimal CLI bootstrap stays separate from heavy maintenance dispatch.                                                                                            |
| Automation and CI      | Six automatic-work policies stay off by default, with saved choices preserved. Linux isolated and Windows native runner requirements, unsupported-platform guards, nightly/weekly schedules and five-build retention remain. Upstream publication stays repository-gated.                                                                              |

## Verification and delivery

Independent Terra reviews were used at the user's request for server/maintenance,
client/Android, and history/lock compatibility. Confirmed findings were fixed and
reviewed again, including deleted Plan APIs, Cursor account usage, command-read
snapshot races, stale reclaim markers, and queued-root preservation.

Focused fixtures cover history and provider switching, coordinator recovery, storage
and migration compatibility, authentication/pairing, Cursor account usage, voice,
preview annotations, Git worktree locking, composer/session logic, settings and
scheduled-task interactions. All 41 recursive package typechecks and the separate web typecheck passed. Final
history/packaging fixtures passed 66 tests; coordinator fixtures passed 51. Scheduled
browser interactions passed all six cases, including cross-computer destination
changes and unsaved edits through disconnect/reconnect. Installer fixtures, fork
release workflow/policy/retention/suite fixtures, icon generation and migration/docs
checks passed. Changed source lint passed with existing non-blocking warnings.
Required package install, update and recovery receipts must still pass in the
fork release workflow against the exact pinned commit before publication.

Native macOS and unsupported architectures remain guarded because corresponding
runner/device proof is unavailable. Fixture/browser checks do not establish real
phone, Windows or sustained production-load verification. The complete Git suite
was not rerun after its process-lane fixture was corrected; its focused process-lane
and 82 worktree cases passed. One CLI dead-server connection case timed out in its initial combined run; its
focused rerun passed. Mobile Plan and new-task-flow fixtures passed; direct device
rendering remains unverified.

Publication is explicitly requested for this integration. It does not authorize
replacing the active desktop build, changing saved update preferences, or touching
live conversation data. Installations continue through the normal exact-artifact
confirmation and maintenance flow.
