# Database storage and performance

This guide records the measured audit and the lossless storage implementation introduced by
migration 101. The measurements below describe the pre-optimization database, not claimed
production savings. Historical rewrites require an explicitly requested, admitted update.

## Measured local database, 2026-10-12

The running `userdata/statev2.sqlite` was approximately **26.55 GiB**, with 4 KiB pages,
WAL mode, and **zero freelist pages**. Its WAL was approximately 5 MiB. The filesystem also
reported approximately 26.55 GiB allocated to the main file.

The heavier audit used the existing, verified pre-installation recovery copy in SQLite
read-only immutable mode, with idle disk priority, a small page cache, and cooperative
pauses. No new database copy was made, no live table scan held a read transaction open,
and the running application and its conversations were left running. That recovery copy
was **26.49 GiB**; the live database had grown slightly since its capture.

The sizes below are confirmed by SQLite's `dbstat` virtual table. "With indexes" includes
the indexes belonging to that table; it is not additional storage to add to the first column.

| Contents                                 | Table data | With indexes | Purpose and retention implications                                                                                                              |
| ---------------------------------------- | ---------: | -----------: | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestration_events`                   |  13.00 GiB |    14.89 GiB | Canonical event history plus retained V1 history. Replay, synchronization, rebuilds, and ordering depend on event semantics.                    |
| `projection_thread_activities`           |   7.30 GiB |     7.79 GiB | Legacy activity/tool records: 1,654,883 rows. Current V2 transcript import does not read this table. It remains valuable historical/audit data. |
| `orchestration_v2_projection_turn_items` |   1.46 GiB |     1.64 GiB | Current tool steps and other timeline items: 272,664 rows. Final outputs and referenced evidence must remain available.                         |
| `orchestration_command_receipts`         |   0.60 GiB |     1.20 GiB | Command deduplication/idempotency. Removing receipts without a retry/replay retention boundary can repeat work.                                 |
| `orchestration_v2_projection_nodes`      |   0.42 GiB |     0.51 GiB | Current orchestration graph state; preserve active/referenced nodes.                                                                            |
| `orchestration_v2_projection_messages`   |   0.14 GiB |     0.17 GiB | Current user/assistant messages: 120,862 rows. Preserve conversation history.                                                                   |
| `projection_thread_messages`             |   0.08 GiB |     0.10 GiB | Legacy messages: 110,117 rows. Includes legacy reasoning omitted from the current importer.                                                     |

All tables together occupied 23.12 GiB and indexes 3.37 GiB. The canonical event table
contained **4,220,865 events**: 3,195,016 V1 events and 1,025,849 V2 events. The old
`orchestration_v2_events` table was empty; removing it would provide negligible savings.
Checkpoint diff blobs and the effect outbox were also negligible compared with the large tables.

### What is needed

[Confirmed] The ordinary message bodies are a small part of the database. Most space belongs
to event history, old activity records, and tool/orchestration state. An event log and its
current projections serve different purposes; their duplication is not sufficient proof
that either can be deleted.

[Confirmed] All 785 tracked legacy imports were marked complete, with 106,350 imported
user/assistant messages. The remaining **3,767 legacy message rows** were all `reasoning`,
totalling approximately 1.47 MiB of text. The importer deliberately selects only user and
assistant roles. Completion markers therefore do not mean every legacy record is represented
in V2. Preserve or separately archive that reasoning before retiring its source table.
The audited V2 thread table contained 1,503 conversations, including 351 archived and 33
marked deleted; those flags do not establish that their historical data is disposable.

[Deduced] The 7.79 GiB legacy activity table/index set is the clearest large candidate for a
validated archive-and-retire migration: it has no current production reader outside its
schema migrations in the audited source, and V2 transcript import reads the legacy message
table instead. This is a migration candidate, not authorization for an ad hoc `DROP TABLE`.
Historical tool output, audit requirements, older-reader compatibility, and recovery still
need explicit treatment.

### Vacuum and other files

`dbstat` measured 2.62 GiB of unused space inside allocated pages. A vacuum may repack some
of it, but this is not a guaranteed saving, and zero freelist pages means there is no large
pool of already deleted pages to reclaim. Vacuum cannot remove retained event history or
duplicate application payloads. It rewrites the database and requires extra disk space;
do not run it on the active production home as part of an inspection.

The same verified recovery manifest contained **12.06 GiB across 302,561 conversation-evidence
files**, separate from SQLite, plus 0.35 GiB of attachments and 0.11 GiB of browser artifacts.
Evidence can contain referenced screenshots, recordings, and copied files; it is not all cache.
The recovery copy is separate retained storage too. Apply the coordinator's recovery retention,
never delete a point or asset still needed by an installation/recovery journal for space.

[`initializeV2Database`](../../apps/server/src/persistence/initializeV2Database.ts) checks whether
V2 already exists before copying V1. It seeds the database once rather than copying it on every
launch. Menu updates must never trigger another database copy.

## Implemented storage policy

Migration 101 adds the archive, content-addressed payload, legacy baseline and maintenance-run
schemas. It removes the unused correlation-id and receipt aggregate/sequence indexes; the
command-ID uniqueness and event stream/sequence indexes remain. Startup does not scan or
rewrite historical bodies. New compressible payloads of 4 KiB through 64 MiB use SHA-256
addressed gzip storage. Larger or incompressible bodies stay inline. Events and current tool
projections share identical bodies, and every application reader expands and verifies them
before decoding or sending ordinary JSON to clients. Replay budgets count original UTF-8
bytes without inflating bodies. Existing web, desktop, mobile and Android wire payloads remain
compatible.

An explicitly requested optimization:

1. Records legacy boundaries only for completed imports whose user/assistant message counts
   match and whose original message IDs exist in V2. Incomplete imports remain untouched.
2. Archives eligible V1 thread events, legacy activities and legacy reasoning as individually
   checksummed gzip rows before removing originals in the same transaction. User/assistant
   import-source messages remain available. The baseline retains each retired stream's maximum
   version and sequence; future writes keep monotonic stream versions. Every V2 event, sequence,
   approval, intermediate progress, completion, message and checkpoint remains replayable.
   Physical compression and content sharing reduce repeated snapshots without discarding
   historical versions or requiring older clients to implement a new resynchronization protocol.
3. Applies a **90-day hot-history boundary** only to completed-import legacy command receipts
   with no pending/running effect. It archives a receipt only when compressed storage plus a
   conservative metadata allowance is smaller. Small receipts remain inexpensive permanent
   idempotency records. Archived command IDs and exact results remain readable indefinitely;
   insert/upsert cannot re-admit a retired command. Current non-legacy receipts remain intact.
4. Compresses old event and tool-projection bodies in bounded batches. Each body is round-trip
   verified before replacement; archives exceeding the 64 MiB bound remain in their source.
5. Deduplicates equal evidence files with **forced copy-on-write clones**, preserving every path,
   its bytes, ownership, permissions and modification/access timestamps. Copies retain independent inodes and future edits.
   Symlinks/special files stay untouched; unsupported filesystems skip sharing. This does not
   delete screenshots, recordings, cited files, copied source trees or active work.
6. Rechecks admission, repacks with SQLite `VACUUM`, checks database and foreign-key integrity,
   and records actual before/after file bytes. A completed transaction is not rerun on startup.

The full archive and payload store live inside `statev2.sqlite`, so online backups, native
restore points and existing rescue/restore paths capture them together. Non-database state
snapshots use copy-on-write copies when supported, with a normal verified-copy fallback.
Recovery-point retention and every journal/asset pin remain unchanged.

## Requesting optimization

Restore-point status listings cache only their small summary after reading a manifest once.
File identity, size, modification time and change time invalidate that cache. This avoids
repeatedly parsing this PC's 85 MiB file manifest during polling: an isolated read-only listing
measured 321 ms and a 642 MiB peak RSS. With the cache, subsequent listings of the same
unchanged point in that process measured 0.30 ms and 0.18 ms. Recovery and storage maintenance still verify the
complete manifest and every file afresh; listing metadata is never a health or recovery proof.

Use the running environment's native controller. Review `maintenance status --json` and its
exact staged digest, then request:

```bash
t3 maintenance install --digest <reviewed-artifact-sha256> --optimize-storage
```

Bulk optimization currently supports **local desktop homes**. Managed-service launchers and
mixed WSL cohorts reject this option because their existing trial-start deadlines cannot
accommodate the bulk rewrite. Payload compression, compatible readers and the light schema
migration still apply to those servers. The controller and target must advertise storage
optimization support; release manifests use
`storageOptimizationProtocol: 1`. Older controllers reject this option instead of silently
ignoring it. Update them through the normal admitted path before requesting this option.
After upgrading an older controller normally, run this same-build maintenance command with
the reviewed **installed** digest:

```bash
t3 maintenance optimize-storage --digest <installed-artifact-sha256>
```

It verifies the published manifest and retained artifact for that exact installed version,
commit and digest, then uses the same native snapshot/trial/recovery path. It restarts the
verified installed binary; no new build or counter is allocated, and a version pin stays set.

The request is persisted in the exact update journal before fencing. Every affected home is
snapshotted and normal update/recovery health receipts still govern admission. The trial
backend closes its migration connection and invokes the packaged CLI in a separate worker
before opening its application database. The worker records its own process creation identity under the live trial parent and keeps
that ownership visible if the parent exits. It checks the
exact fence, trial journal, home ownership, restore-point integrity and repack capacity.
On Linux CPU/I/O priority is set before Node creates its filesystem threads; it runs with
low CPU priority and idle I/O priority; foreground app priorities are
unaffected. The explicit maintenance trial permits up to two hours for large homes.

Running chats block admission and continue. Do not stop agents, forge an idle window, issue
manual SQL against live userdata, or bypass the native controller to obtain this cleanup.
A failure leaves the transaction fenced for the existing verification/recovery paths. Local
production savings and startup latency require measurement after a successfully admitted run.

## Reading cold history

Owner-local machine verbs provide bounded, row-key ordered access to old records:

```bash
t3 maintenance home history --home /absolute/t3-home \
  --source projection_thread_activities --thread <thread-id> --after ""
```

Supported sources are `projection_thread_activities`, `orchestration_events`,
`projection_thread_messages`, and `orchestration_command_receipts`. The result contains the
original rows and a `next` row-key cursor; pass it as `--after` until an empty page. Pages cap
at 100 rows and approximately 4 MiB, allowing one larger bounded row when needed. Archived
reasoning and historical tool output are preserved even though V2's old importer did not
show them. These private exports may contain conversation data; retain normal home privacy.

## Sources and code boundaries

- [SQLite `dbstat`](https://www.sqlite.org/dbstat.html), [VACUUM](https://www.sqlite.org/lang_vacuum.html),
  and [WAL behavior](https://www.sqlite.org/wal.html).
- [Database setup and WAL size policy](../../apps/server/src/persistence/Sqlite.ts).
- [Canonical event append/replay](../../apps/server/src/persistence/OrchestrationEventStore.ts).
- [Legacy transcript import](../../apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts)
  and [application-event migration](../../apps/server/src/persistence/Migrations/OrchestrationV2/ApplicationEventSource.ts).
- [Current projections](../../apps/server/src/orchestration-v2/ProjectionStore.ts),
  [command receipts](../../apps/server/src/orchestration-v2/CommandReceiptStore.ts),
  and [conversation evidence](../../apps/server/src/assets/ConversationEvidence.ts).
