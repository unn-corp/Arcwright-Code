import { assert, it } from "@effect/vitest";
import {
  EventId,
  ThreadId,
  TurnItemId,
  CommandId,
  IsoDateTime,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import {
  compressText,
  compressHistoryBlock,
  historyBlockReference,
  payloadReference,
  PAYLOAD_PREFIX,
} from "@t3tools/shared/forkStorageCodec";
import * as SqlitePersistence from "./Sqlite.ts";
import * as Events from "./OrchestrationEventStore.ts";
import * as Receipts from "./OrchestrationCommandReceipts.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";

const testLayer = Layer.mergeAll(Events.layer, Receipts.layer, Projections.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layer = it.layer(testLayer);
layer("lossless storage compatibility", (it) => {
  it.effect(
    "writes upstream JSON while retaining old compressed output and Unicode replay budgets",
    () =>
      Effect.gen(function* () {
        const store = yield* Events.OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("storage-output");
        const projections = yield* Projections.ProjectionStoreV2;
        const providerInstanceId = ProviderInstanceId.make("codex");
        yield* projections.apply({
          id: EventId.make("storage-thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            id: threadId,
            projectId: ProjectId.make("storage-project"),
            title: "Stored output",
            providerInstanceId,
            modelSelection: { instanceId: providerInstanceId, model: "gpt-6" },
            createdBy: "user",
            creationSource: "web",
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        const input = "kept original 🧰 output\n".repeat(40_000);
        const event = {
          id: EventId.make("storage-1"),
          threadId,
          type: "turn-item.updated" as const,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("storage-tool"),
            type: "command_execution" as const,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed" as const,
            title: "Saved output",
            input,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        };
        const stored = yield* store.appendAgentEvents({
          events: [event, { ...event, id: EventId.make("storage-2") }],
        });
        yield* projections.apply(event);
        const raw = yield* sql<{
          payload_json: string;
          payload_bytes: number;
        }>`SELECT payload_json,payload_bytes FROM orchestration_events WHERE stream_id=${threadId}`;
        assert.isFalse(raw[0]!.payload_json.startsWith(PAYLOAD_PREFIX));
        assert.deepEqual(JSON.parse(raw[0]!.payload_json), JSON.parse(raw[1]!.payload_json));
        assert.equal(raw[0]!.payload_json, raw[1]!.payload_json);
        const blobs = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM arcwright_payload_blobs`;
        assert.equal(blobs[0]!.count, 0);
        assert.deepEqual(
          yield* projections.getTurnItem({ threadId, itemId: event.payload.id }),
          event.payload,
        );
        const window = yield* projections.getThreadSnapshotWindow(threadId, {
          rowLimit: 10,
          userTurnLimit: 2,
        });
        assert.deepEqual(window.projection.turnItems, [event.payload]);
        assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
        const replay = yield* store.readAgentEvents({ threadId }).pipe(Stream.runCollect);
        assert.deepEqual(replay, stored);
        const stats = yield* store.getAgentReplayStats({
          threadId,
          afterSequence: 0,
          throughSequence: stored[1]!.sequence,
          maxEvents: 10,
        });
        assert.equal(stats.rawPayloadBytes, Buffer.byteLength(raw[0]!.payload_json) * 2);
        assert.isAbove(stats.rawPayloadBytes, input.length * 2);
        const blob = compressText(raw[0]!.payload_json);
        yield* sql`INSERT INTO arcwright_payload_blobs VALUES (${blob.digest},${blob.rawBytes},${blob.compressed})`;
        yield* sql`UPDATE orchestration_events SET payload_json=${payloadReference(blob)},payload_bytes=${blob.rawBytes}
          WHERE event_id=${event.id}`;
        assert.deepEqual(
          yield* store.readAgentEvents({ threadId }).pipe(Stream.runCollect),
          stored,
        );
        yield* sql`UPDATE arcwright_payload_blobs SET compressed=x'00'`;
        const damaged = yield* store
          .readAgentEvents({ threadId })
          .pipe(Stream.runCollect, Effect.exit);
        assert.isTrue(Exit.isFailure(damaged));
        const corruptAppend = yield* store
          .appendAgentEvents({
            events: [{ ...event, id: EventId.make("storage-corrupt-append") }],
          })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isSuccess(corruptAppend));
        const unchanged = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id=${threadId}`;
        assert.equal(unchanged[0]!.count, 3);
      }),
  );

  it.effect(
    "continues archived stream clocks and rolls back payload blobs with rejected appends",
    () =>
      Effect.gen(function* () {
        const store = yield* Events.OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("storage-clock");
        yield* sql`INSERT INTO arcwright_legacy_baselines VALUES (${threadId},40,99,40,0,'2026-01-01')`;
        const now = yield* DateTime.now;
        const event = {
          id: EventId.make("storage-clock-event"),
          threadId,
          type: "turn-item.updated" as const,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("storage-clock-tool"),
            type: "command_execution" as const,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed" as const,
            title: "Saved output",
            input: "atomic output ".repeat(10_000),
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        };
        const before = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM arcwright_payload_blobs`;
        const failure = yield* store
          .appendAgentEvents({ events: [event, event] })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(failure));
        const after = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM arcwright_payload_blobs`;
        assert.equal(after[0]!.count, before[0]!.count);
        yield* store.appendAgentEvents({ events: [event] });
        const clock = yield* sql<{
          stream_version: number;
        }>`SELECT stream_version FROM orchestration_events WHERE stream_id=${threadId}`;
        assert.equal(clock[0]!.stream_version, 41);
      }),
  );

  it.effect.each(["gzip", "block"])(
    "returns a %s archived receipt and refuses to admit its command again",
    (encoding) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* Receipts.OrchestrationCommandReceiptRepository;
        const commandId = CommandId.make(`archived-command-${encoding}`);
        const row = {
          command_id: commandId,
          aggregate_kind: "thread",
          aggregate_id: "storage-receipt",
          command_type: "legacy",
          accepted_at: "2026-01-01T00:00:00.000Z",
          result_sequence: 99,
          status: "rejected",
          error: "original refusal",
        };
        const blob = compressText(JSON.stringify(row));
        let stored = blob.compressed;
        if (encoding === "block") {
          const bytes = Buffer.alloc(blob.rawBytes + 4);
          bytes.writeUInt32BE(blob.rawBytes, 0);
          bytes.write(JSON.stringify(row), 4);
          const block = compressHistoryBlock(bytes);
          yield* sql`INSERT INTO arcwright_history_blocks VALUES(${block.digest},${block.rawBytes},${block.compressed})`;
          stored = historyBlockReference(block.digest, 0);
        }
        yield* sql`INSERT INTO arcwright_history_rows(source,row_key,thread_id,sequence,digest,raw_bytes,compressed)
      VALUES('orchestration_command_receipts',${commandId},'storage-receipt',NULL,${blob.digest},${blob.rawBytes},${stored})`;
        const receipt = {
          commandId,
          aggregateKind: "thread" as const,
          aggregateId: ThreadId.make("storage-receipt"),
          commandType: "legacy",
          acceptedAt: IsoDateTime.make(row.accepted_at),
          resultSequence: 99,
          status: "rejected" as const,
          error: row.error,
        };
        assert.deepEqual(
          Option.getOrThrow(yield* repository.getByCommandId({ commandId })),
          receipt,
        );
        assert.isFalse(
          yield* repository.insertIfAbsent({ ...receipt, status: "accepted", error: null }),
        );
        yield* repository.upsert({ ...receipt, status: "accepted", error: null });
        assert.deepEqual(
          Option.getOrThrow(yield* repository.getByCommandId({ commandId })),
          receipt,
        );
      }),
  );
});
