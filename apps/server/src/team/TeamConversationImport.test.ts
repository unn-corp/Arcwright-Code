import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, SideThread, SideThreadMessageId, ThreadId } from "@t3tools/contracts";
import { sideThreadIdForThread } from "@t3tools/shared/sideThread";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import { makeTeamConversation } from "./TeamConversation.ts";
import { importTeamConversation } from "./TeamConversationImport.ts";

it.effect(
  "imports legacy shared history and keeps publication cursors, discussions and identity-bound receipts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        const threadId = ThreadId.make("shared:legacy");
        const author = { subject: "owner", displayName: "Owner" };
        const discussion = {
          id: sideThreadIdForThread(threadId),
          createdBy: author,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          messages: [
            {
              id: SideThreadMessageId.make("message"),
              author,
              text: "Preserve discussion",
              createdAt: now,
            },
          ],
          readBy: [{ user: author, lastReadAt: now }],
        };
        const side = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(SideThread)))([
          discussion,
        ]);
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at,created_by_json) VALUES('project','Shared','/workspace','[]',${now},${now},'{"subject":"owner","displayName":"Owner"}')`;
        yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at,created_by_json) VALUES(${threadId},'project','Published','{"instanceId":"codex","model":"model"}','full-access','default',${now},${now},'{"subject":"owner","displayName":"Owner"}')`;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at,author_json) VALUES('agent-message',${threadId},'assistant','Published history',0,${now},${now},'{"subject":"owner","displayName":"Owner"}')`;
        yield* sql`INSERT INTO projection_thread_discussions(thread_id,side_threads_json) VALUES(${threadId},${side})`;
        yield* sql`INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,actor_kind,payload_json,metadata_json)
    VALUES(42,'event','thread',${threadId},1,'sidethread.created',${now},'legacy-command','user',${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ threadId, sideThreadId: discussion.id, createdBy: author, createdAt: now })},'{"collaborationUser":{"subject":"owner","displayName":"Owner"}}')`;
        yield* sql`INSERT INTO orchestration_command_receipts(command_id,aggregate_kind,aggregate_id,accepted_at,result_sequence,status,collaboration_subject) VALUES('legacy-command','thread',${threadId},${now},42,'accepted','owner')`;
        yield* sql`INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,actor_kind,payload_json,metadata_json,application_event_version)
          VALUES(99,'v2-event','thread','personal-v2',1,'message.updated',${now},'v2-command','user','{}','{}',2)`;
        yield* importTeamConversation;
        yield* importTeamConversation;
        const { query, engine } = yield* makeTeamConversation;
        const snapshot = yield* query.getSnapshot();
        expect(snapshot.snapshotSequence).toBe(42);
        expect(yield* sql`SELECT 1 FROM team_conversation_events WHERE sequence=99`).toHaveLength(
          0,
        );
        expect(snapshot.threads[0]?.messages[0]?.text).toBe("Published history");
        expect(snapshot.threads[0]?.sideThreads?.[0]).toEqual(discussion);
        const retry = {
          type: "sidethread.create" as const,
          commandId: CommandId.make("legacy-command"),
          threadId,
          sideThreadId: discussion.id,
          createdAt: now,
        };
        yield* Effect.flip(
          engine.dispatch(retry, {
            collaborationUser: { subject: "intruder", displayName: "Intruder" },
          }),
        );
        yield* Effect.flip(
          engine.dispatch(
            { type: "thread.archive", commandId: retry.commandId, threadId },
            { collaborationUser: author },
          ),
        );
        expect(yield* engine.dispatch(retry, { collaborationUser: author })).toEqual({
          sequence: 42,
        });
        yield* sql`INSERT INTO orchestration_command_receipts(command_id,command_type,aggregate_kind,aggregate_id,accepted_at,result_sequence,status,collaboration_subject) VALUES('typed-command','sidethread.create','thread',${threadId},${now},42,'accepted','owner')`;
        const typedRetry = { ...retry, commandId: CommandId.make("typed-command") };
        yield* sql`UPDATE orchestration_command_receipts SET aggregate_kind='project' WHERE command_id='typed-command'`;
        yield* Effect.flip(engine.dispatch(typedRetry, { collaborationUser: author }));
        expect(
          yield* sql`SELECT 1 FROM team_conversation_receipts WHERE command_id='typed-command'`,
        ).toEqual([]);
        yield* sql`UPDATE orchestration_command_receipts SET aggregate_kind='thread' WHERE command_id='typed-command'`;

        yield* Effect.flip(
          engine.dispatch(
            { type: "thread.archive", commandId: typedRetry.commandId, threadId },
            { collaborationUser: author },
          ),
        );
        expect(yield* engine.dispatch(typedRetry, { collaborationUser: author })).toEqual({
          sequence: 42,
        });
        const receipt = yield* engine.dispatch(
          {
            type: "sidethread.message.post",
            commandId: CommandId.make("after-import"),
            threadId,
            sideThreadId: discussion.id,
            messageId: SideThreadMessageId.make("new-message"),
            text: "After import",
            createdAt: now,
          },
          { collaborationUser: author },
        );
        expect(receipt.sequence).toBe(43);
        expect(
          (yield* sql<{
            side_threads_json: string;
          }>`SELECT side_threads_json FROM projection_thread_discussions`)[0]?.side_threads_json,
        ).toBe(side);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, NodeServices.layer))),
);
