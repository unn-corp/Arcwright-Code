import { assert, it } from "@effect/vitest";

import { shouldPrepareLegacyImportHandoff } from "./Orchestrator.ts";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Deferred migration commands do not open a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "migration" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it("reissues imported context until a V2 run completes", () => {
  assert.isTrue(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: true,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: undefined,
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 0,
    }),
  );
});

it.effect("replays receipts only on their original thread without changing either thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const create = {
      type: "thread.create",
      commandId: CommandId.make("migration-receipt"),
      threadId: ThreadId.make("migration-receipt-original"),
      projectId: ProjectId.make("migration-project"),
      title: "Original",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    } as const;
    const original = yield* orchestrator.dispatch(create);
    const before = yield* orchestrator.getThreadProjection(create.threadId);
    assert.deepEqual(yield* orchestrator.dispatch(create), { ...original, replayed: true });
    const foreignThreadId = ThreadId.make("migration-receipt-foreign");
    const failure = yield* orchestrator
      .dispatch({ ...create, threadId: foreignThreadId })
      .pipe(Effect.flip);
    assert.equal(failure._tag, "OrchestratorCommandIdConflictError");
    if (failure._tag !== "OrchestratorCommandIdConflictError")
      return assert.fail("Expected receipt thread conflict");
    assert.equal(failure.receiptThreadId, create.threadId);
    assert.equal(failure.commandThreadId, foreignThreadId);
    assert.deepEqual(yield* orchestrator.getThreadProjection(create.threadId), before);
    assert.equal(yield* orchestrator.getThreadEventSequence(foreignThreadId), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "retains reissued legacy handoff IDs on an existing provider thread and deduplicates replay",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("migration-handoff-thread");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("migration-handoff-create"),
        threadId,
        projectId: ProjectId.make("migration-project"),
        title: "Imported",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const now = yield* DateTime.now;
      const thread = (yield* orchestrator.getThreadProjection(threadId)).thread;
      yield* projections.apply({
        id: EventId.make("migration-handoff-import"),
        type: "thread.metadata-updated",
        threadId,
        occurredAt: now,
        payload: { ...thread, historyOrigin: "v1_import" },
      });
      yield* projections.apply({
        id: EventId.make("migration-handoff-item"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("migration-imported-question"),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          messageId: MessageId.make("migration-imported-message"),
          text: "Keep the imported decision",
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          inputIntent: "turn_start",
          attachments: [],
        },
      });
      const dispatch = (id: string) =>
        ({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          threadId,
          messageId: MessageId.make(id),
          text: "Continue",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        }) as const;
      yield* orchestrator.dispatch(dispatch("migration-handoff-first"));
      const first = yield* orchestrator.getThreadProjection(threadId);
      const firstRun = first.runs[0]!;
      assert.isNotNull(firstRun.contextHandoffId);
      const providerThreadId = first.providerThreads[0]!.id;
      assert.deepEqual(first.providerThreads[0]!.handoffIds, [firstRun.contextHandoffId]);
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("migration-handoff-interrupt"),
        threadId,
        runId: firstRun.id,
      });
      const secondCommand = dispatch("migration-handoff-reissued");
      const result = yield* orchestrator.dispatch(secondCommand);
      const second = yield* orchestrator.getThreadProjection(threadId);
      const reissuedId = second.runs.at(-1)!.contextHandoffId;
      assert.isNotNull(reissuedId);
      assert.notEqual(reissuedId, firstRun.contextHandoffId);
      const provider = second.providerThreads.find(
        (candidate) => candidate.id === providerThreadId,
      )!;
      assert.deepEqual(provider.handoffIds, [firstRun.contextHandoffId, reissuedId]);
      assert.deepEqual(yield* orchestrator.dispatch(secondCommand), { ...result, replayed: true });
      const replayed = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        replayed.providerThreads.find((candidate) => candidate.id === providerThreadId)!.handoffIds,
        [firstRun.contextHandoffId, reissuedId],
      );
    }).pipe(Effect.provide(layerTest)),
);
