import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  CommandId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  SideThreadMessageId,
} from "@t3tools/contracts";
import { sideThreadIdForThread } from "@t3tools/shared/sideThread";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import migration from "../persistence/Migrations/208_TeamConversations.ts";
import { makeTeamConversation } from "./TeamConversation.ts";

const fixture = Effect.gen(function* () {
  yield* migration;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_command_receipts(command_id TEXT PRIMARY KEY,command_type TEXT,aggregate_kind TEXT,aggregate_id TEXT,collaboration_subject TEXT,status TEXT,result_sequence INTEGER)`;
  const service = yield* makeTeamConversation;
  const identity = { collaborationUser: { subject: "alice", displayName: "Alice" } };
  const createdAt = "2026-10-07T00:00:00.000Z";
  const projectId = ProjectId.make("project");
  const threadId = ThreadId.make("thread");
  yield* service.engine.dispatch(
    {
      type: "project.create",
      commandId: CommandId.make("project"),
      projectId,
      title: "Shared",
      workspaceRoot: "/workspace",
      createdAt,
    },
    identity,
  );
  yield* service.engine.dispatch(
    {
      type: "thread.create",
      commandId: CommandId.make("thread"),
      projectId,
      threadId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    },
    identity,
  );
  const base = { threadId, sideThreadId: sideThreadIdForThread(threadId), createdAt };
  yield* service.engine.dispatch(
    { ...base, type: "sidethread.create", commandId: CommandId.make("discussion") },
    identity,
  );
  return { service, identity, base, sql };
});
const layer = Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layer({ filename: ":memory:" }));
it.effect(
  "persists authenticated discussions, reactions, exact receipts and monotonic read state",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, identity, base } = yield* fixture;
        const post = {
          ...base,
          type: "sidethread.message.post" as const,
          commandId: CommandId.make("post"),
          messageId: SideThreadMessageId.make("message"),
          text: "Discuss",
        };
        const receipt = yield* service.engine.dispatch(post, identity);
        expect(
          yield* service.engine.dispatch(
            { ...post, createdAt: "2026-10-07T01:00:00.000Z" },
            identity,
          ),
        ).toEqual(receipt);
        expect(
          (yield* Effect.flip(service.engine.dispatch({ ...post, text: "Changed" }, identity)))
            ._tag,
        ).toBe("TeamConversationError");
        const other = { collaborationUser: { subject: "bob", displayName: "Bob" } };
        yield* Effect.flip(
          service.engine.dispatch({ ...post, commandId: CommandId.make("forged-post") }, other),
        );
        const edit = {
          ...base,
          type: "sidethread.message.edit" as const,
          commandId: CommandId.make("edit"),
          messageId: post.messageId,
          text: "Edited",
        };
        yield* Effect.flip(
          service.engine.dispatch({ ...edit, commandId: CommandId.make("forbidden-edit") }, other),
        );
        yield* service.engine.dispatch(edit, identity);
        const react = {
          ...base,
          type: "sidethread.message.react" as const,
          commandId: CommandId.make("react"),
          messageId: post.messageId,
          emoji: "eyes",
        };
        yield* service.engine.dispatch(react, identity);
        yield* service.engine.dispatch({ ...react, commandId: CommandId.make("react-bob") }, other);
        yield* service.engine.dispatch(
          { ...react, commandId: CommandId.make("unreact") },
          identity,
        );
        for (const [index, lastReadAt] of [
          "2099-01-01T00:00:00.000Z",
          "2000-01-01T00:00:00.000Z",
        ].entries())
          yield* service.engine.dispatch(
            {
              ...base,
              type: "sidethread.mark-read",
              commandId: CommandId.make(`read-${index}`),
              lastReadAt,
            },
            identity,
          );
        const reloaded = yield* makeTeamConversation;
        const discussion = (yield* reloaded.query.getSnapshot()).threads[0]!.sideThreads![0]!;
        expect(discussion.messages).toHaveLength(1);
        expect(discussion.messages[0]).toMatchObject({
          text: "Edited",
          author: identity.collaborationUser,
          reactions: [{ emoji: "eyes", users: [other.collaborationUser] }],
        });
        expect(discussion.readBy?.[0]?.lastReadAt).toBe(base.createdAt);
        expect(yield* reloaded.engine.dispatch(post, identity)).toEqual(receipt);
      }),
    ).pipe(Effect.provide(layer)),
);
it.effect(
  "rejects execution, missing replies, oversized content and archived writes without advancing events",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, identity, base } = yield* fixture;
        const before = yield* service.engine.latestSequence;
        const post = {
          ...base,
          type: "sidethread.message.post" as const,
          commandId: CommandId.make("post"),
          messageId: SideThreadMessageId.make("message"),
          text: "Discuss",
        };
        for (const command of [
          { ...post, text: "x".repeat(20001) },
          {
            ...post,
            commandId: CommandId.make("missing-reply"),
            replyToSideThreadMessageId: SideThreadMessageId.make("missing"),
          },
        ])
          yield* Effect.flip(service.engine.dispatch(command, identity));
        yield* Effect.flip(
          service.engine.dispatch(
            {
              type: "thread.turn.interrupt",
              commandId: CommandId.make("interrupt"),
              threadId: base.threadId,
              createdAt: base.createdAt,
            },
            identity,
          ),
        );
        expect(yield* service.engine.latestSequence).toBe(before);
        yield* service.engine.dispatch(
          { ...base, type: "sidethread.archive", commandId: CommandId.make("archive") },
          identity,
        );
        yield* Effect.flip(
          service.engine.dispatch(
            { ...post, commandId: CommandId.make("archived-post") },
            identity,
          ),
        );
        yield* service.engine.dispatch(
          { ...base, type: "sidethread.unarchive", commandId: CommandId.make("reopen") },
          identity,
        );
        yield* Effect.flip(
          service.engine.dispatch(
            { ...post, commandId: CommandId.make("archived-post") },
            identity,
          ),
        );
        yield* service.engine.dispatch(post, identity);
        expect(
          (yield* service.query.getSnapshot()).threads[0]!.sideThreads![0]!.messages,
        ).toHaveLength(1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "enforces canonical discussion identity, reply/link scope, authorship, message and reaction bounds",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, identity, base } = yield* fixture;
        const post = {
          ...base,
          type: "sidethread.message.post" as const,
          commandId: CommandId.make("bounded-post"),
          messageId: SideThreadMessageId.make("bounded-message"),
          text: "Discuss",
        };
        yield* Effect.flip(
          service.engine.dispatch({ ...post, commandId: CommandId.make("anonymous") }),
        );
        yield* Effect.flip(
          service.engine.dispatch(
            {
              ...post,
              commandId: CommandId.make("noncanonical"),
              sideThreadId: sideThreadIdForThread(ThreadId.make("different")),
            },
            identity,
          ),
        );
        yield* Effect.flip(
          service.engine.dispatch(
            {
              ...post,
              commandId: CommandId.make("missing-link"),
              linkedRef: { kind: "agent-thread", threadId: ThreadId.make("missing") },
            },
            identity,
          ),
        );
        yield* service.engine.dispatch(post, identity);
        for (let index = 0; index < 32; index++)
          yield* service.engine.dispatch(
            {
              ...base,
              type: "sidethread.message.react",
              commandId: CommandId.make(`reaction-${index}`),
              messageId: post.messageId,
              emoji: `reaction-${index}`,
            },
            identity,
          );
        yield* Effect.flip(
          service.engine.dispatch(
            {
              ...base,
              type: "sidethread.message.react",
              commandId: CommandId.make("reaction-overflow"),
              messageId: post.messageId,
              emoji: "overflow",
            },
            identity,
          ),
        );
        for (let index = 1; index < 500; index++)
          yield* service.engine.dispatch(
            {
              ...post,
              commandId: CommandId.make(`post-${index}`),
              messageId: SideThreadMessageId.make(`message-${index}`),
            },
            identity,
          );
        const sequence = yield* service.engine.latestSequence;
        yield* Effect.flip(
          service.engine.dispatch(
            {
              ...post,
              commandId: CommandId.make("overflow"),
              messageId: SideThreadMessageId.make("overflow"),
            },
            identity,
          ),
        );
        expect(yield* service.engine.latestSequence).toBe(sequence);
        expect(
          (yield* service.query.getSnapshot()).threads[0]?.sideThreads?.[0]?.messages,
        ).toHaveLength(500);
      }),
    ).pipe(Effect.provide(layer)),
);
