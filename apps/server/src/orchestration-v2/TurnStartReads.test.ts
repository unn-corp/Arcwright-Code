import { assert, it } from "@effect/vitest";
import { compressText, payloadReference } from "@t3tools/shared/forkStorageCodec";
import {
  CheckpointScopeId,
  CheckpointId,
  ContextHandoffId,
  ProviderThreadId,
  ContextTransferId,
  NodeId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";

const layerDatabase = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["sqlite"] as const)(
  "loads startup state without obsolete transcript payloads in %s",
  (storage) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:completion-reads");
      const runId = RunId.make("run:completion-reads");
      const messageId = MessageId.make("message:completion-reads");
      const instanceId = ProviderInstanceId.make("codex");
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: ProjectId.make("project:completion-reads"),
        title: "Completion controls",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "test" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 2,
        providerInstanceId: instanceId,
        modelSelection: thread.modelSelection,
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId: NodeId.make("startup:root"),
        activeAttemptId: null,
        status: "queued",
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const putThread = (value: OrchestrationV2AppThread) =>
        store.apply({
          id: EventId.make(`event:thread:${value.id}`),
          type: "thread.created",
          threadId: value.id,
          occurredAt: now,
          payload: value,
        });
      const putRun = (value: OrchestrationV2Run) =>
        store.apply({
          id: EventId.make(`event:run:${value.id}:${value.status}`),
          type: "run.updated",
          threadId,
          runId: value.id,
          occurredAt: now,
          payload: value,
        });
      yield* putThread(thread);
      yield* putRun(run);
      const scopeId = CheckpointScopeId.make("startup:shared-scope");
      yield* store.apply({
        id: EventId.make("startup:root-event"),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: run.rootNodeId!,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId: run.rootNodeId!,
          kind: "root_turn",
          status: "pending",
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: scopeId,
          startedAt: null,
          completedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("startup:scope-event"),
        type: "checkpoint-scope.created",
        threadId,
        occurredAt: now,
        payload: {
          id: scopeId,
          threadId,
          runId: RunId.make("run:old"),
          nodeId: NodeId.make("startup:earlier-root"),
          parentScopeId: null,
          providerThreadId: null,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo/worktree",
          createdAt: now,
        },
      });
      const message = {
        id: messageId,
        threadId,
        runId,
        nodeId: null,
        role: "user" as const,
        text: "Continue",
        attachments: [],
        streaming: false,
        createdBy: "agent" as const,
        creationSource: "server" as const,
        createdAt: now,
        updatedAt: now,
        delegatedCompletion: { parentRunId: RunId.make("parent-run"), generation: 1, taskIds: [] },
      };
      yield* store.apply({
        id: EventId.make("event:input"),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: message,
      });
      const oldRunId = RunId.make("run:old");
      yield* putRun({ ...run, id: oldRunId, ordinal: 1, status: "completed" });
      const item = {
        id: TurnItemId.make("item:history"),
        threadId,
        runId: oldRunId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed" as const,
        title: "old command",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "command_execution" as const,
        input: "echo history",
        output: "historical result",
      };
      yield* store.apply({
        id: EventId.make("item-event"),
        type: "turn-item.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: item,
      });
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
          VALUES ('obsolete-history', ${threadId}, NULL, NULL, 'assistant', 0,
            ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            type, status, ordinal, updated_at, payload_json)
          VALUES ('obsolete-tool', ${threadId}, ${oldRunId}, NULL, NULL, NULL,
            'tool_call', 'completed', 2, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
        assert.equal((yield* Effect.exit(store.getThreadProjection(threadId)))._tag, "Failure");
      }
      const selected = yield* store.getThreadRecords(threadId, ["runs", "messages"], {
        runIds: [runId],
        messageIds: [messageId],
      });
      assert.deepEqual(Object.keys(selected).sort(), ["messages", "runs", "thread"]);
      assert.deepEqual(
        selected.runs.map((r) => r.id),
        [runId],
      );
      assert.deepEqual(
        selected.messages.map((m) => m.id),
        [messageId],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["messages"], { messageIds: [] })).messages,
        [],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["command_execution"],
          turnItemRunId: oldRunId,
        })).turnItems,
        [item],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["command_execution"],
          turnItemRunId: runId,
        })).turnItems,
        [],
      );
      assert.equal(yield* store.getNextTurnItemOrdinal(threadId), storage === "sqlite" ? 3 : 2);
      assert.equal(yield* store.getMessageCount(threadId), storage === "sqlite" ? 2 : 1);
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["messages"], {
          messageRunIds: [runId],
        })).messages.map((message) => message.id),
        [messageId],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["messages"], { messageRunIds: [] })).messages,
        [],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["command_execution"],
          turnItemRunIds: [oldRunId],
        })).turnItems,
        [item],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"], { turnItemRunIds: [] })).turnItems,
        [],
      );
      assert.deepEqual(yield* store.getThreadAttachmentIds(threadId), []);
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = json_object('text', ${"x".repeat(512_000)}, 'attachments', json_array(json_object('id', 'attachment:old'))) WHERE message_id = 'obsolete-history'`;
        assert.deepEqual(yield* store.getThreadAttachmentIds(threadId), ["attachment:old"]);
      }
      const page = yield* store.getTimelinePage(threadId, { view: "activity", limit: 1 });
      assert.deepEqual(
        page.items.map((row) => row.item),
        [item],
      );
      assert.equal(page.hasMore, storage === "sqlite");
      assert.equal(page.totalItems, storage === "sqlite" ? 2 : 1);
      assert.deepEqual(
        (yield* store.getTimelinePage(threadId, { view: "messages", limit: 1 })).items,
        [],
      );
      const context = yield* store.getTurnStartContext(threadId, runId);
      assert.equal(context.thread.id, threadId);
      assert.deepEqual(
        context.checkpointScopes.map((scope) => scope.id),
        [scopeId],
      );
      assert.equal(context.messages.find((m) => m.id === messageId)?.text, "Continue");
      assert.isTrue(context.hasConversation);
      assert.deepEqual(context.turnItems, []);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId), [item]);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, [oldRunId]), [item]);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, [runId]), []);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, []), []);
      // Oversized source rows are counted without decoding or deleting them.
      const budgetSql = yield* SqlClient.SqlClient;
      yield* budgetSql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, type, status, ordinal, updated_at, payload_json)
        VALUES ('oversized-history', ${threadId}, ${oldRunId}, 'assistant_message', 'completed', 3,
          ${DateTime.formatIso(now)}, ${"x".repeat(1_100_000)})`;
      const archived = compressText("y".repeat(1_100_000));
      // Deliberately leave the blob absent: inflating this reference would fail.
      yield* budgetSql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, type, status, ordinal, updated_at, payload_json)
        VALUES ('oversized-archive', ${threadId}, ${oldRunId}, 'assistant_message', 'completed', 4,
          ${DateTime.formatIso(now)}, ${payloadReference(archived)})`;
      const bounded = yield* store.getHandoffHistory(threadId, [oldRunId]);
      assert.deepEqual(bounded.items, [item]);
      assert.equal(bounded.omittedItems, 2);
      const retained = yield* budgetSql<{
        count: number;
      }>`SELECT count(*) AS count FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'oversized-history'`;
      assert.equal(retained[0]?.count, 1);
      yield* budgetSql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id IN ('oversized-history', 'oversized-archive')`;
      yield* budgetSql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, type, status, ordinal, updated_at, payload_json)
        WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 600)
        SELECT 'bulk:' || n, ${threadId}, ${oldRunId}, 'command_execution', 'completed', n + 10,
          ${DateTime.formatIso(now)}, json_set(payload_json, '$.id', 'bulk:' || n, '$.ordinal', n + 10)
        FROM orchestration_v2_projection_turn_items, seq WHERE turn_item_id = ${item.id}`;
      for (const [id, ordinal, text] of [
        ["brief", 0, "Original brief"],
        ["latest-user", 2, "Latest request"],
      ] as const) {
        yield* budgetSql`INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, type, status, ordinal, updated_at, payload_json)
          SELECT ${id}, ${threadId}, ${oldRunId}, 'user_message', 'completed', ${ordinal}, ${DateTime.formatIso(now)},
            json_set(payload_json, '$.id', ${id}, '$.ordinal', ${ordinal}, '$.type', 'user_message',
              '$.messageId', ${`message:${id}`}, '$.text', ${text}, '$.createdBy', 'user',
              '$.creationSource', 'server', '$.inputIntent', 'turn_start', '$.attachments', json('[]'))
          FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${item.id}`;
      }
      // More than one history window of nodes must not hide the queued run's root.
      yield* budgetSql`INSERT INTO orchestration_v2_projection_nodes
        (node_id, thread_id, run_id, parent_node_id, root_node_id, kind, status,
         provider_thread_id, provider_turn_id, runtime_request_id, checkpoint_scope_id,
         started_at, completed_at, payload_json)
        WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 600)
        SELECT 'bulk-node:' || printf('%04d', n), ${threadId}, ${runId}, ${run.rootNodeId},
          ${run.rootNodeId}, 'tool_call', 'pending', NULL, NULL, NULL, NULL, NULL, NULL,
          json_set(payload_json, '$.id', 'bulk-node:' || printf('%04d', n),
            '$.parentNodeId', ${run.rootNodeId}, '$.kind', 'tool_call', '$.countsForRun', json('false'))
        FROM orchestration_v2_projection_nodes, seq WHERE node_id = ${run.rootNodeId}`;
      const commandControls = yield* store.getThreadRecords(
        threadId,
        ["runs", "nodes", "turnItems"],
        {
          enforceCommandReadBudget: true,
          turnItemTypes: ["user_message", "error"],
          omitSettledLeafNodes: true,
          omitSettledSubagents: true,
        },
      );
      assert.equal(commandControls.nodes.length, 601);
      assert.equal(commandControls.nodes.at(-1)?.id, run.rootNodeId);
      assert.equal(
        commandControls.runs.find((value) => value.id === runId)?.rootNodeId,
        run.rootNodeId,
      );
      assert.equal(commandControls.runs.find((value) => value.id === runId)?.status, "queued");
      yield* budgetSql`DELETE FROM orchestration_v2_projection_nodes WHERE thread_id = ${threadId} AND node_id LIKE 'bulk-node:%'`;
      const recent = yield* store.getHandoffHistory(threadId, [oldRunId]);
      assert.equal(recent.items.length, 502);
      assert.equal(recent.omittedItems, 101);
      assert.deepEqual(
        recent.items.slice(0, 2).map((value) => value.id),
        ["brief", "latest-user"],
      );
      assert.equal(recent.items.at(-1)?.id, "bulk:600");
      yield* budgetSql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId} AND (turn_item_id LIKE 'bulk:%' OR turn_item_id IN ('brief', 'latest-user'))`;

      yield* budgetSql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, type, status, ordinal, updated_at, payload_json)
        WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 10)
        SELECT 'large:' || n, ${threadId}, ${oldRunId}, 'command_execution', 'completed', n + 10,
          ${DateTime.formatIso(now)}, json_set(payload_json, '$.id', 'large:' || n, '$.ordinal', n + 10, '$.input', ${"z".repeat(900_000)})
        FROM orchestration_v2_projection_turn_items, seq WHERE turn_item_id = ${item.id}`;
      const byteBounded = yield* store.getHandoffHistory(threadId, [oldRunId]);
      assert.equal(byteBounded.items.length, 9);
      assert.equal(byteBounded.omittedItems, 2);
      yield* budgetSql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId} AND turn_item_id LIKE 'large:%'`;

      const handoff = {
        ...item,
        id: TurnItemId.make("digest-handoff"),
        ordinal: 3,
        type: "handoff" as const,
        contextHandoffId: ContextHandoffId.make("handoff:digest"),
        fromProviderThreadIds: [],
        toProviderThreadId: ProviderThreadId.make("provider:digest"),
        fromProviderInstanceIds: [],
        toProviderInstanceId: instanceId,
        strategy: "full_thread_summary" as const,
        summary: "Earlier decision",
      };
      const checkpoint = {
        ...item,
        id: TurnItemId.make("digest-checkpoint"),
        ordinal: 4,
        type: "checkpoint" as const,
        checkpointId: CheckpointId.make("checkpoint:digest"),
        scopeId,
        files: [],
      };
      for (const [index, value] of [handoff, checkpoint].entries()) {
        yield* store.apply({
          id: EventId.make(`digest-event:${index}`),
          type: "turn-item.updated",
          threadId,
          runId: oldRunId,
          occurredAt: now,
          payload: value,
        });
      }
      // A digest-only large archived row must be counted without trying to inflate it.
      yield* budgetSql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, type, status, ordinal, updated_at, payload_json)
        VALUES ('digest-large', ${threadId}, ${oldRunId}, 'handoff', 'completed', 5,
          ${DateTime.formatIso(now)}, ${payloadReference(archived)})`;
      const digest = yield* store.getHandoffHistory(threadId, [oldRunId], 8388608, true);
      assert.deepEqual(
        digest.items.map((value) => value.id),
        [item.id, handoff.id, checkpoint.id],
      );
      assert.equal(digest.omittedItems, 1);
      const sideContext = ContextHandoffService.makeSideChatContext({
        parentThreadId: threadId,
        digest: digest.items,
        omittedItems: digest.omittedItems,
      });
      assert.include(sideContext, "Handoff: Earlier decision");
      assert.include(sideContext, "Checkpoint: 0 files");
      assert.include(sideContext, "1 source items omitted");
      assert.deepEqual((yield* store.getHandoffHistory(threadId, [oldRunId])).items, [item]);
      yield* budgetSql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id IN ('digest-handoff', 'digest-checkpoint', 'digest-large')`;

      // Authoritative controls are refused before an oversized archived body can be inflated.
      const controlRef = `arcwright:payload:v1:${"a".repeat(64)}:9000000`;
      yield* budgetSql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, type, status, ordinal, updated_at, payload_json)
        VALUES ('oversized-control', ${threadId}, ${oldRunId}, 'error', 'completed', 5,
          ${DateTime.formatIso(now)}, ${controlRef})`;
      const admission = yield* Effect.flip(store.assertCommandProjectionBudget(threadId));
      assert.equal(admission._tag, "ProjectionStoreReadError");
      const refusedRead = yield* Effect.flip(
        store.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["user_message", "error"],
          enforceCommandReadBudget: true,
        }),
      );
      assert.equal(refusedRead._tag, "ProjectionStoreReadError");
      assert.equal(
        (refusedRead.cause as { _tag?: string })._tag,
        "ProjectionStoreControlBudgetError",
      );
      assert.equal(
        (admission.cause as { _tag?: string })._tag,
        "ProjectionStoreControlBudgetError",
      );
      const preserved = yield* budgetSql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'oversized-control'`;
      assert.equal(preserved[0]?.payload_json, controlRef);
      yield* budgetSql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'oversized-control'`;
      yield* store.assertCommandProjectionBudget(threadId);

      yield* budgetSql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, type, status, ordinal, updated_at, payload_json)
        VALUES ('oversized-active', ${threadId}, ${oldRunId}, 'command_execution', 'running', 6,
          ${DateTime.formatIso(now)}, ${controlRef})`;
      for (const read of [
        store.getTurnStartContext(threadId, oldRunId).pipe(Effect.asVoid),
        store.getRuntimeRecoveryProjection(threadId).pipe(Effect.asVoid),
      ]) {
        const refused = yield* Effect.flip(read);
        assert.equal(refused._tag, "ProjectionStoreReadError");
        assert.equal(
          (refused.cause as { _tag?: string })._tag,
          "ProjectionStoreControlBudgetError",
        );
      }
      const activeRetained = yield* budgetSql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'oversized-active'`;
      assert.equal(activeRetained[0]?.payload_json, controlRef);
      yield* budgetSql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'oversized-active'`;

      const resultId = TurnItemId.make("interrupt-result");
      assert.isTrue(yield* store.hasUnpairedRunInterruptRequest(threadId, item.id, resultId));
      assert.isFalse(yield* store.hasUnpairedRunInterruptRequest(threadId, resultId, item.id));
      assert.isFalse(
        yield* store.hasUnpairedRunInterruptRequest(
          ThreadId.make("other-thread"),
          item.id,
          resultId,
        ),
      );
      yield* store.apply({
        id: EventId.make("interrupt-result-event"),
        type: "turn-item.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: { ...item, id: resultId },
      });
      assert.isFalse(yield* store.hasUnpairedRunInterruptRequest(threadId, item.id, resultId));
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        const original = yield* sql<{ payload_json: string }>`SELECT payload_json
          FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${item.id}`;
        yield* sql`UPDATE orchestration_v2_projection_turn_items
          SET payload_json = 'invalid JSON' WHERE turn_item_id = ${item.id}`;
        assert.isTrue(
          yield* store.hasUnpairedRunInterruptRequest(
            threadId,
            item.id,
            TurnItemId.make("absent-result"),
          ),
        );
        yield* sql`UPDATE orchestration_v2_projection_turn_items
          SET payload_json = ${original[0]!.payload_json} WHERE turn_item_id = ${item.id}`;
      }
      for (const text of ["/compact", " \t/COMPACT\n", "\u00a0/compact\u3000"]) {
        yield* store.apply({
          id: EventId.make("compact-input"),
          type: "message.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: { ...message, text },
        });
        assert.isFalse((yield* store.getTurnStartContext(threadId, runId)).hasConversation);
      }
      const marker = {
        ...message,
        id: MessageId.make("old-compact"),
        runId: oldRunId,
        text: "\t/COMPACT\n",
      };
      yield* store.apply({
        id: EventId.make("old-compact-input"),
        type: "message.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: marker,
      });
      assert.include(
        (yield* store.getTurnStartContext(threadId, runId)).messages.map((m) => m.id),
        marker.id,
      );
      const other = ThreadId.make("other");
      yield* putThread({ ...thread, id: other });
      assert.deepEqual((yield* store.getTurnStartContext(other, runId)).messages, []);
      assert.deepEqual(yield* store.getTurnStartHistory(other, [oldRunId]), []);
      assert.isFalse((yield* store.getTurnStartContext(other, runId)).hasConversation);
      assert.instanceOf(
        yield* store.getTurnStartContext(ThreadId.make("missing"), runId).pipe(Effect.flip),
        ProjectionStore.ProjectionStoreThreadNotFoundError,
      );
      const file = {
        type: "file" as const,
        id: "message-file",
        name: "notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 12,
      };
      yield* store.apply({
        id: EventId.make("attachment:message-event"),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: { ...message, attachments: [file] },
      });
      yield* store.apply({
        id: EventId.make("attachment:question-event"),
        type: "turn-item.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: {
          ...item,
          id: TurnItemId.make("attachment:question"),
          type: "user_input_request",
          requestId: RuntimeRequestId.make("attachment:request"),
          questions: [],
          questionAnswer: {
            requestId: "attachment:request",
            answers: { document: ["See document"], image: ["See image"] },
            attachmentsByQuestionId: {
              document: [{ ...file, id: "answer-document" }],
              image: [
                {
                  type: "image",
                  id: "answer-image",
                  name: "photo.png",
                  mimeType: "image/png",
                  sizeBytes: 8,
                },
              ],
            },
          },
        },
      });
      const recordingId = "thread-completion-reads-0b9f6c1e-3c1d-4f7a-9d2e-5a6b7c8d9e0f-webm";
      yield* store.apply({
        id: EventId.make("attachment:recording-event"),
        type: "turn-item.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: {
          ...item,
          id: TurnItemId.make("attachment:recording"),
          type: "dynamic_tool",
          toolName: "mcp__t3-code__preview_recording_stop",
          input: {},
          output: [
            { type: "text", text: JSON.stringify({ id: recordingId, mimeType: "video/webm" }) },
          ],
        },
      });
      assert.deepEqual((yield* store.getThreadAttachmentIds(threadId)).toSorted(), [
        "answer-document",
        "answer-image",
        "attachment:old",
        "message-file",
        recordingId,
      ]);
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "counts a native fork's inherited history as conversation for its first /compact in sqlite",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const sourceId = ThreadId.make("thread:fork-source");
      const forkId = ThreadId.make("thread:fork-target");
      const sourceRunId = RunId.make("run:fork-source-third");
      const forkRunId = RunId.make("run:fork-compact");
      const source: OrchestrationV2AppThread = {
        id: sourceId,
        projectId: ProjectId.make("project:fork-compact"),
        title: "Source",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "claude-opus-5-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: sourceId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const fork: OrchestrationV2AppThread = {
        ...source,
        id: forkId,
        title: "Fork",
        lineage: { parentThreadId: sourceId, relationshipToParent: "fork", rootThreadId: sourceId },
        forkedFrom: { type: "run", threadId: sourceId, runId: sourceRunId },
      };
      const run = (threadId: ThreadId, id: RunId, status: OrchestrationV2Run["status"]) =>
        ({
          id,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection: source.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`message:${id}`),
          rootNodeId: NodeId.make(`node:${id}`),
          activeAttemptId: null,
          status,
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        }) satisfies OrchestrationV2Run;
      const userMessage = (threadId: ThreadId, runId: RunId, text: string) =>
        store.apply({
          id: EventId.make(`event:message:${runId}`),
          type: "message.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: MessageId.make(`message:${runId}`),
            threadId,
            runId,
            nodeId: null,
            role: "user",
            text,
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
          },
        });
      for (const thread of [source, fork]) {
        yield* store.apply({
          id: EventId.make(`event:thread:${thread.id}`),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: now,
          payload: thread,
        });
      }
      for (const [threadId, value] of [
        [sourceId, run(sourceId, sourceRunId, "completed")],
        [forkId, run(forkId, forkRunId, "queued")],
      ] as const) {
        yield* store.apply({
          id: EventId.make(`event:run:${value.id}`),
          type: "run.updated",
          threadId,
          runId: value.id,
          occurredAt: now,
          payload: value,
        });
      }
      yield* userMessage(sourceId, sourceRunId, "THIRD");
      yield* store.apply({
        id: EventId.make("event:fork-transfer"),
        type: "context-transfer.created",
        threadId: forkId,
        occurredAt: now,
        payload: {
          id: ContextTransferId.make("transfer:fork-compact"),
          type: "fork",
          sourceThreadId: sourceId,
          targetThreadId: forkId,
          sourcePoint: { threadId: sourceId, runId: sourceRunId },
          basePoint: null,
          sourceProviderInstanceId: instanceId,
          targetProviderInstanceId: instanceId,
          targetRunId: forkRunId,
          status: "pending",
          resolution: {
            strategy: "native_fork",
            providerThreadRef: {
              driver: ProviderDriverKind.make("claudeAgent"),
              nativeId: "native-fork-source",
              strength: "strong",
            },
          },
          createdBy: "user",
          error: null,
          createdAt: now,
          updatedAt: now,
          consumedAt: null,
        },
      });
      yield* userMessage(forkId, forkRunId, "/compact");

      assert.isTrue((yield* store.getTurnStartContext(forkId, forkRunId)).hasConversation);
    }).pipe(Effect.provide(layerDatabase)),
);
