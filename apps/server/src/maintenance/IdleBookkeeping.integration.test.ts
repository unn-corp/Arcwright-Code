// @effect-diagnostics nodeBuiltinImport:off — isolated filesystem coordinator fixture.
import { afterEach, assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { CoordinatorStore } from "@t3tools/shared/forkMaintenanceStore";
import { newJournal } from "@t3tools/shared/forkMaintenanceJournal";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { workAdmissionFor } from "./MaintenanceCoordinator.ts";
import { MaintenanceWorkHeld, WorkAdmission } from "./WorkAdmission.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});
const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Bookkeeping tests never launch a provider"),
} as ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "idle-bookkeeping" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.effect(
  "automatic settlement preserves five idle minutes but still respects the update fence",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-idle-bookkeeping-")),
      );
      directories.push(directory);
      const store = yield* Effect.promise(() =>
        CoordinatorStore.open(directory, async () => "fixture:100", 100),
      );
      const coordinatorId = yield* Effect.promise(() =>
        store.register(
          {
            id: "fixture-runtime",
            label: "Fixture",
            kind: "desktop",
            homes: [directory],
            updateTarget: true,
          },
          0,
        ),
      );
      yield* Effect.promise(() => store.confirmBootstrap());
      const admission = workAdmissionFor({
        mode: "active",
        store,
        coordinatorId,
        participantId: "fixture-runtime",
        home: directory,
        kind: "desktop",
        updateTarget: true,
        trial: null,
        successorOf: null,
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = ThreadId.make("thread:idle-bookkeeping");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:bookkeeping"),
          title: "Idle thread",
          modelSelection: { instanceId, model: "gpt-6.1-sol" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const thread = yield* projections.getThread(threadId);
        yield* Effect.promise(() => store.observe("fixture-runtime", [], 0));
        yield* Effect.promise(() => store.observe("fixture-runtime", [], 299_000));
        yield* orchestrator.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("automatic"),
          threadId,
          snapshotAt: thread.updatedAt,
        });
        assert.equal((yield* projections.getThread(threadId)).settledOverride, "settled");
        const idle = yield* Effect.promise(() => store.status(300_000));
        assert.equal(idle.participants[0]?.idleSince, 0);
        assert.deepEqual(idle.blockers, []);
        const intent = newJournal({
          id: "tx",
          kind: "update",
          homes: [directory],
          previous: { version: "1", artifactSha256: "a" },
          target: null,
          now: 300_000,
        });
        yield* Effect.promise(() => store.freeze("tx", 300_000, { intent }));
        const held = yield* orchestrator
          .dispatch({
            type: "thread.auto-settle",
            commandId: CommandId.make("fenced-automatic"),
            threadId,
            snapshotAt: thread.updatedAt,
          })
          .pipe(Effect.flip);
        assert.instanceOf(held, Orchestrator.OrchestratorDispatchError);
        assert.instanceOf(held.cause, MaintenanceWorkHeld);
        yield* Effect.promise(async () => {
          await store.writeJournal({ ...intent, phase: "aborted" });
          await store.releaseFence("tx");
        });
        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("manual"),
          threadId,
        });
        assert.equal(
          (yield* Effect.promise(() => store.status(300_000))).participants[0]?.idleSince,
          null,
        );
      }).pipe(Effect.provideService(WorkAdmission, admission), Effect.provide(testLayer));
    }),
);
