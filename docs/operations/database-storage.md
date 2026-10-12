# Database storage and performance

This is a measured storage audit and a proposed improvement order. It does not introduce
automatic data deletion or a supported database-compaction command.

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

## Recommended implementation order

1. **Archive and retire legacy activity storage.** Preserve its complete content in a validated,
   compressed archive or a supported historical store, verify old history and recovery on an
   isolated fixture, then migrate the active database. The current table/index footprint is
   7.79 GiB; net savings depend on archive compression and retained recovery copies.
2. **Compact historical event storage using durable baselines.** First separate retained V1
   events from current V2 replay requirements. Add tested snapshots/baselines, earliest retained
   sequence markers, and resynchronization behavior before pruning. Preserve monotonic stream
   versions, command deduplication, ordering, old history, pending work, and recovery.
3. **Reduce repeated large tool payloads.** Store large outputs/images once in compressed,
   content-addressed storage, with stable references from events and projections. Coalesce
   intermediate progress snapshots while retaining starts, completions, failures, approval
   boundaries, messages, checkpoints, and resumable state. Compression alone is not a drop-in
   change: existing JSON queries, clients, backups, and recovery need compatible readers.
4. **Review indexes and completed receipts.** The correlation-id index occupied approximately
   0.40 GiB and no current production correlation-id predicate was found in the audited source.
   Validate all relevant query plans and compatibility before removing it. Give any completed
   receipt retirement a defined retry/replay horizon; active, queued, or immutable audit receipts
   must not be swept by a generic age-based cleanup.
5. **Deduplicate evidence and provide explicit cold-history retention.** Preserve referenced
   evidence and on-demand old conversation access. Avoid repeated copied source trees and
   rebuildable dependency/build directories. Use reference-aware cleanup and existing per-thread
   activity checks; retaining a conversation must continue to retain its required evidence.
6. **Repack only after the retention migration is verified.** Run compaction through admitted
   maintenance with recovery assets and real health receipts. Keep the current application and
   chats running until an authorized installation/maintenance window is admitted. Measure
   actual resulting bytes, startup time, read latency, and write volume before claiming savings.

These recommendations are not implemented cleanup policies. Do not edit the live database,
delete old events, drop indexes, or stop agents to carry them out during an audit.

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
