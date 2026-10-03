import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  ThreadId,
  CheckpointId,
  CheckpointScopeId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ServerConfig from "../config.ts";

export const localSourceLayer = (sql: SqlClient.SqlClient) => {
  const database = Layer.succeed(SqlClient.SqlClient, sql);
  const project = RuntimeLayer.layerProjectService.pipe(
    Layer.provide(
      ProjectEnrichment.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
              resolve: () => Effect.succeed(null),
            }),
            Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
              resolvePath: () => Effect.succeed(null),
            }),
          ),
        ),
      ),
    ),
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(ThreadCommandExecutor.layer),
    Layer.provide(database),
  );
  return Layer.mergeAll(
    CommandReceiptStore.layer.pipe(Layer.provide(database)),
    project,
    ProjectStore.layer.pipe(Layer.provide(database)),
    ApplicationEvents.layer.pipe(Layer.provide(database)),
    database,
    ProviderReplayHarness.layerWithRegistry(
      { name: "local-teams" },
      ProviderAdapterRegistry.layerFromAdapters([]),
      { databaseLayer: database, runEffectWorker: false },
    ),
  ).pipe(
    Layer.provide(ServerConfig.layerTest("/workspace", { prefix: "team-local-v2-" })),
    Layer.provide(NodeServices.layer),
  );
};

/** Fixture adapter translates historical test operations into canonical V2 commands/events. */
export const makeLocalSource = Effect.gen(function* () {
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const projectService = yield* ProjectService.ProjectService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const events = yield* ApplicationEvents.OrchestrationEventStore;
  const sql = yield* SqlClient.SqlClient;
  let eventCounter = 0;
  const message = (
    command: Extract<
      OrchestrationCommand,
      { type: "thread.publication.message" | "thread.turn.start" }
    >,
  ) =>
    Effect.gen(function* () {
      const now = DateTime.makeUnsafe(command.createdAt);
      const thread = yield* orchestrator.getThreadProjection(command.threadId);
      const id =
        command.type === "thread.turn.start" ? command.message.messageId : command.messageId;
      const prior = thread.messages.find((m) => m.id === id);
      const text =
        command.type === "thread.turn.start"
          ? command.message.text
          : command.streaming
            ? (prior?.text ?? "") + command.text
            : command.text || prior?.text || "";
      const committed = yield* eventSink.commitCommand({
        commandId: command.commandId,
        threadId: command.threadId,
        commandType: "message.dispatch",
        acceptedAt: now,
        effects: [],
        events: [
          {
            id: EventId.make(`fixture:${++eventCounter}`),
            type: "message.updated",
            threadId: command.threadId,
            occurredAt: now,
            payload: {
              id,
              threadId: command.threadId,
              runId: null,
              nodeId: null,
              role: command.type === "thread.turn.start" ? "user" : command.role,
              text,
              streaming: command.type === "thread.turn.start" ? false : command.streaming,
              attachments: [],
              createdAt: prior?.createdAt ?? now,
              updatedAt: now,
              createdBy:
                command.type === "thread.turn.start" || command.role === "user" ? "user" : "agent",
              creationSource: "provider",
            },
          },
        ],
      });
      return { sequence: committed.receipt.resultSequence };
    });
  const dispatch = (command: OrchestrationCommand) =>
    Effect.gen(function* () {
      switch (command.type) {
        case "project.create":
          yield* projectService.create(command);
          break;
        case "project.meta.update":
          yield* projectService.update(command);
          break;
        case "project.delete":
          yield* projectService.delete({ ...command, force: true });
          break;
        case "thread.create":
          return yield* orchestrator.dispatch({
            ...command,
            createdBy: "user",
            creationSource: "web",
          });
        case "thread.meta.update":
          return yield* orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: command.commandId,
            threadId: command.threadId,
            ...(command.title ? { title: command.title } : {}),
            ...(command.branch !== undefined ? { branch: command.branch } : {}),
          });
        case "thread.publication.message":
        case "thread.turn.start":
          return yield* message(command);
        case "thread.revert.complete": {
          const now = DateTime.makeUnsafe(command.createdAt);
          yield* eventSink.write({
            commandId: command.commandId,
            events: [
              {
                id: EventId.make(`fixture:${++eventCounter}`),
                threadId: command.threadId,
                occurredAt: now,
                type: "checkpoint.rollback-requested",
                payload: {
                  scopeId: CheckpointScopeId.make("fixture-scope"),
                  checkpointId: CheckpointId.make("fixture-checkpoint"),
                  requestedAt: now,
                },
              },
            ],
          });
          break;
        }
        default:
          return yield* Effect.die(`Fixture command not mapped: ${command.type}`);
      }
      return { sequence: yield* events.latestApplicationSequence };
    });
  const getSnapshot = () =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        thread_id: string;
      }>`SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL`;
      return {
        threads: yield* Effect.forEach(rows, (r) =>
          orchestrator.getThreadProjection(ThreadId.make(r.thread_id)).pipe(
            Effect.map((projection) => ({
              ...projection.thread,
              messages: projection.messages,
              session: null,
            })),
          ),
        ),
      };
    });
  return {
    sql,
    engine: {
      dispatch,
      latestSequence: events.latestApplicationSequence,
      readEvents: (afterSequence: number) => events.readAgentEvents({ afterSequence }),
    },
    query: {
      getSnapshot,
      getThreadShellById: (id: ThreadId) =>
        orchestrator.getThreadShell(id).pipe(Effect.map(Option.fromNullishOr)),
    },
    dependencies: Layer.mergeAll(
      Layer.succeed(CommandReceiptStore.CommandReceiptStoreV2, receipts),
      Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
      Layer.succeed(EventSink.EventSinkV2, eventSink),
      Layer.succeed(ProjectService.ProjectService, projectService),
      Layer.succeed(ProjectStore.ProjectStoreV2, projectStore),
      Layer.succeed(ApplicationEvents.OrchestrationEventStore, events),
      Layer.succeed(SqlClient.SqlClient, sql),
    ),
  };
});
