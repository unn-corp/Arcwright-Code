# Upstream integration — 2026-10-12

The integration pins upstream `pingdotgg/t3code` at
`511d20c6f20c2ed6ff787aba068d7d673e2949b9`, against the pre-merge fork
`75b335cd37b1d1b60774d39b262c6e9b58857b81`. The prior recorded upstream was
`611132c171f3a821bd2e32f22261135cef6330ac`; the incoming range contains 492 commits.
The included T3 package version remains `0.0.45`. `fork-upstream.json` records the
actual included source independently of the allocated Arcwright nightly counter.

## Retained behavior and implementation

The merge combines the fork's behavior with the new provider/source-control
packages, scoped provider settings, review guides, thread search and lighter history
reads. The audit covers clean merges, deletes, moves and renamed APIs as well as
159 initially conflicted paths. Upstream publishing remains restricted to upstream;
the fork release pipeline alone allocates numbered nightlies and owns their signing,
feeds, recovery metadata and five-per-channel retention.

| Retained area                     | Ownership after integration                                                                                                                                                       | Verification                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Device updates and recovery       | Existing shared coordinator, snapshots, work/launch fences, health receipts, desktop and host controllers                                                                         | Required coordinator, host-runtime, desktop-updater and client-updates suites                                |
| Phone safety and identity         | `apps/android-pwa` and `apps/web/src/android` remain unchanged from the fork baseline; the new Play mirror is guarded to upstream                                                 | Android bridge regression tests; native package gates in release CI                                          |
| Agent memory and idle roots       | Shared `packages/shared/src/idleProcessRoots.ts`, re-exported by the server compatibility module; one service object for provider packages and the coordinator                    | AgentStartAdmission, EffectOutbox memory, IdleProcessRoots, diagnostics and maintenance tests                |
| Lossless storage and warm startup | Existing compressed events/tool bodies and legacy archives; new ThreadFind and history-page readers expand references before decoding                                             | StorageCompatibility, StorageMaintenance, SchemaFingerprint and ThreadFind                                   |
| Installed migration identities    | Fork IDs 1–103 remain fixed; upstream 59–61 map to fork 104–106                                                                                                                   | Schema 93/103 upgrades, upstream 61 reconciliation, unknown-history rollback and regenerated schema contract |
| GitHub project credentials        | Retained richer PR dashboard adapter uses the shared GitHub API/quota and a request-scoped selected credential; expected head SHA remains in REST merge                           | GitHubCli adapter, shared GitHub API, repository service and secret lifecycle tests                          |
| Organizations Architect           | Pure prompt/output/redaction helpers move to provider-core; Cursor/Grok/OpenCode packages retain isolated tool-free generation; both OpenCode protocols route it                  | Provider text generation and Organization regression tests                                                   |
| Legacy provider settings          | Saved blobs migrate once into generic instances; explicit legacy-client patches still fold into those instances before secret persistence; retired map is omitted from saved JSON | ServerSettings migration, old-client patch, secret privacy and native-session tests                          |
| Hermes                            | Driver, settings, glyphs, opaque model IDs and native-session home discovery retained; v2 model config fallback is restricted to method-not-found                                 | Hermes text generation and ACP model-selection tests                                                         |
| Drafts, replies, Stop and voice   | Shared web composer/timeline/state keeps the fork controls and OpenWhispr with the new scoped model APIs                                                                          | Draft lifecycle, MessageReplies, MCP replies, client voice and provider tests                                |
| Responsive project/sidebar layout | Fork project dragging, width controls, collapsed groups, Android branding and mobile thread action sheet retained                                                                 | Sidebar drag/pointer/grouping and mobile model/home tests                                                    |
| Automation and Discord            | Six automatic-work policies and restart continuation stay off by default; explicit saved choices/manual work remain supported                                                     | Required scheduler, Organization execution, Discord, authorization and restart suites                        |

## Performance and compatibility corrections

History pages and ThreadFind load the selected bodies through `arcwright_payload_json`;
compressed references do not reach JSON extraction, search parsing or paired clients.
The compiled schema contract is regenerated from all 106 migrations. Matching future
opens retain the metadata-only schema/ledger fingerprint shortcut; historical shrink
completion remains a separate durable one-time marker.

Upstream ledgers through 61 can already contain schema mapped to fork 106. Reconciliation
therefore fills every missing fork migration through the highest remapped identity,
including storage and fingerprint migrations 99–103, before returning the canonical ledger.
A previous fork at 103 only executes 104–106, without changing old IDs or timestamps.

Git's process budget treats only `worktree list` as a metadata read. It no longer holds
the heavy repository lock while a ref mutation waits for that snapshot; `worktree add`,
`remove`, `prune`, `lock`, `unlock` and `move` retain serialization. Both the process-budget
and ref-snapshot regressions are required host-runtime release gates.

Grok and Hermes Architect helpers observe forbidden tool notifications synchronously
through the existing decoding hook, before prompt completion. The shared ACP client's
notification ordering remains unchanged. The helpers retain private directories,
permission/tool denial, bounded output, timeout and cleanup.

## Verification and publication

Local verification uses Node 24, low process/I/O priority, isolated maintenance namespaces
and a single test worker. Scoped typechecks cover server, desktop, web, mobile, contracts,
shared/client runtime, provider core/ACP/Cursor/Grok/OpenCode, GitHub source control and
release scripts. Focused tests cover the retained areas above; the integration commit
records their final results. The final focused run passed **2,171 tests across 128 files**,
and all **14 scoped typechecks** passed. The documentation checker and 254 resolved/edited
file formatting checks passed. Unchanged upstream dependency-patch context retains its
original whitespace; resolved source passes the whitespace check. The fork documentation checker and resolved-file formatting
must pass before committing. No required assertion is skipped or weakened.

Independent Luna source reviews cover server/recovery and client/Android integration;
confirmed findings are fixed and affected paths reviewed again. Static review and fixture
results do not replace hardware validation or measurements on a production database.

Windows host-runtime fixtures use native joined paths and rewrite Git's hidden `.git`
file through `r+` with explicit truncation. Literal pathspec checks cover bracket names
on every platform and colon-prefixed names on POSIX; worktree listing covers spaces and
Unicode on Windows and embedded newlines on POSIX. These exercise supported filesystem
names with the same preservation assertions; the release gate still rejects skipped tests.

The release pipeline must build and validate the exact merged main source before
publishing its freshly allocated nightly. Scheduled publishing remains disabled. The
current app, chats and production database stay running and unchanged; installation,
Start Menu replacement and production shrink wait for genuine native maintenance
admission under the [release runbook](fork-releases.md). The separate full-data rehearsal
uses a private fixture, so its reported savings are not production savings.
