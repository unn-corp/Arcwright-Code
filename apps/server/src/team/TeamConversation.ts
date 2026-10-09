import * as Crypto from "effect/Crypto";
import {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationThread,
  OrchestrationProject,
  type CollaborationUser,
  type ProjectId,
  type ThreadId,
  OrchestrationThreadShell,
  type OrchestrationThreadDetailWindow,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type SideThread,
} from "@t3tools/contracts";
import { sideThreadIdForThread, summarizeSideThreads } from "@t3tools/shared/sideThread";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

export class TeamConversationError extends Schema.TaggedError<TeamConversationError>()(
  "TeamConversationError",
  { reason: Schema.Literals(["invalid", "conflict", "unsupported"]) },
) {
  override get message() {
    return "The shared conversation command could not be applied.";
  }
}
const invalid = () => new TeamConversationError({ reason: "invalid" });
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeShell = Schema.encodeEffect(Schema.fromJsonString(OrchestrationThreadShell));
const decodeShell = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationThreadShell));
const encodeThread = Schema.encodeEffect(Schema.fromJsonString(OrchestrationThread));
const encodeProject = Schema.encodeEffect(Schema.fromJsonString(OrchestrationProject));
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(OrchestrationEvent));
const decodeThread = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationThread));
const decodeProject = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationProject));
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeStoredEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationEvent));
export const teamThreadShell = (thread: OrchestrationThread): OrchestrationThreadShell => {
  const {
    messages,
    activities: _activities,
    checkpoints: _checkpoints,
    proposedPlans: _plans,
    sideThreads,
    deletedAt: _deleted,
    ...fields
  } = thread;
  const discussion = summarizeSideThreads(thread.id, sideThreads ?? []);
  return {
    ...fields,
    latestUserMessageAt: messages.findLast((m) => m.role === "user")?.createdAt ?? null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...(discussion ? { teamDiscussion: discussion } : {}),
  };
};

/** Durable shared conversations. This service has no provider, process, or host-workspace dependency. */
export const makeTeamConversation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const writes = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<OrchestrationEvent>();
  const latestSequence = sql<{
    sequence: number;
  }>`SELECT COALESCE(MAX(sequence),0) AS sequence FROM team_conversation_events`.pipe(
    Effect.map((rows) => rows[0]!.sequence),
  );
  const threadById = (id: ThreadId) =>
    sql<{
      state_json: string;
    }>`SELECT state_json FROM team_conversation_threads WHERE thread_id=${id}`.pipe(
      Effect.flatMap((rows) =>
        rows[0]
          ? decodeThread(rows[0].state_json).pipe(Effect.map(Option.some))
          : Effect.succeed(Option.none()),
      ),
    );
  const projectById = (id: ProjectId) =>
    sql<{
      state_json: string;
    }>`SELECT state_json FROM team_conversation_projects WHERE project_id=${id}`.pipe(
      Effect.flatMap((rows) =>
        rows[0]
          ? decodeProject(rows[0].state_json).pipe(Effect.map(Option.some))
          : Effect.succeed(Option.none()),
      ),
    );
  const getSnapshot = () =>
    sql.withTransaction(
      Effect.gen(function* () {
        const projects = yield* sql<{
          state_json: string;
        }>`SELECT state_json FROM team_conversation_projects`.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, (r) => decodeProject(r.state_json))),
        );
        const threads = yield* sql<{
          state_json: string;
        }>`SELECT state_json FROM team_conversation_threads ORDER BY thread_id`.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, (r) => decodeThread(r.state_json))),
        );
        return {
          projects,
          threads,
          snapshotSequence: yield* latestSequence,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
      }),
    );
  const getThreadShellById = (id: ThreadId) =>
    sql<{
      shell_json: string;
    }>`SELECT shell_json FROM team_conversation_threads WHERE thread_id=${id} AND json_extract(state_json,'$.deletedAt') IS NULL`.pipe(
      Effect.flatMap((rows) =>
        rows[0] ? decodeShell(rows[0].shell_json).pipe(Effect.asSome) : Effect.succeedNone,
      ),
    );
  const getShellSnapshot = (archived = false) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const projects = yield* sql<{
          state_json: string;
        }>`SELECT state_json FROM team_conversation_projects`.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, (r) => decodeProject(r.state_json))),
        );
        const threads = yield* sql<{
          shell_json: string;
        }>`SELECT shell_json FROM team_conversation_threads WHERE json_extract(state_json,'$.deletedAt') IS NULL AND (json_extract(shell_json,'$.archivedAt') IS NOT NULL)=${archived ? 1 : 0}`.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, (r) => decodeShell(r.shell_json))),
        );
        return {
          projects,
          threads,
          snapshotSequence: yield* latestSequence,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
      }),
    );
  const getThreadDetailSnapshot = (id: ThreadId, window?: OrchestrationThreadDetailWindow) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const found = yield* threadById(id);
        if (Option.isNone(found)) return Option.none<OrchestrationThreadDetailSnapshot>();
        const snapshotSequence = yield* latestSequence;
        const threadSequence = (yield* sql<{
          sequence: number;
        }>`SELECT COALESCE(MAX(sequence),0) AS sequence FROM team_conversation_events WHERE aggregate_id=${id}`)[0]!
          .sequence;
        if (!window)
          return Option.some<OrchestrationThreadDetailSnapshot>({
            snapshotSequence,
            thread: found.value,
          });
        const messages = found.value.messages;
        // The cursor binds both the thread and its first message; later appends cannot shift a page.
        const cursor =
          window.beforeCursor === undefined
            ? null
            : yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(
                  Schema.Struct({ threadId: Schema.String, messageId: Schema.String }),
                ),
              )(window.beforeCursor).pipe(Effect.mapError(invalid));
        if (cursor && cursor.threadId !== id) return yield* invalid();
        const end = cursor ? messages.findIndex((m) => m.id === cursor.messageId) : messages.length;
        if (end < 0) return yield* invalid();
        let start = end;
        let turns = 0;
        const limit = Math.min(window.turnLimit ?? 30, 100);
        if (limit < 1) return yield* invalid();
        while (start > 0) {
          start--;
          if (messages[start]!.role === "user" && ++turns >= limit) break;
        }
        return Option.some<OrchestrationThreadDetailSnapshot>({
          snapshotSequence,
          thread: { ...found.value, messages: messages.slice(start, end) },
          page: {
            snapshotSequence,
            threadSequence,
            hasMore: start > 0,
            beforeCursor:
              start > 0
                ? yield* encodeJson({ threadId: id, messageId: messages[start]!.id })
                : null,
          },
        });
      }),
    );
  const dispatch = (
    raw: OrchestrationCommand,
    options?: { collaborationUser?: CollaborationUser },
  ) =>
    writes.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const command = yield* Schema.decodeUnknownEffect(OrchestrationCommand)(raw).pipe(
            Effect.mapError(invalid),
          );
          const member = options?.collaborationUser;
          // Native transport replaces timestamps on retries. They are not part of command identity.
          const identity = yield* encodeJson({
            command: {
              ...command,
              ...(!command.commandId.startsWith("publication:") && "createdAt" in command
                ? { createdAt: null }
                : {}),
            },
            subject: member?.subject ?? null,
          });
          const digest = Buffer.from(
            yield* crypto.digest("SHA-256", new TextEncoder().encode(identity)),
          ).toString("hex");
          const result = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const receipt = (yield* sql<{
                  digest: string;
                  sequence: number;
                  status: string;
                }>`SELECT digest,sequence,status FROM team_conversation_receipts WHERE command_id=${command.commandId}`)[0];
                if (receipt) {
                  if (receipt.digest !== digest)
                    return yield* new TeamConversationError({ reason: "conflict" });
                  if (receipt.status !== "accepted") return yield* invalid();
                  return { sequence: receipt.sequence, event: null };
                }
                const legacy = (yield* sql<{
                  command_type: string;
                  aggregate_kind: string;
                  aggregate_id: string;
                  collaboration_subject: string | null;
                  status: string;
                  result_sequence: number;
                }>`SELECT command_type,aggregate_kind,aggregate_id,collaboration_subject,status,result_sequence FROM orchestration_command_receipts WHERE command_id=${command.commandId}`)[0];
                if (legacy) {
                  let legacyType = legacy.command_type;
                  if (legacyType === "legacy") {
                    const original = (yield* sql<{
                      event_type: string;
                    }>`SELECT event_type FROM team_conversation_events WHERE sequence=${legacy.result_sequence} AND json_extract(event_json,'$.commandId')=${command.commandId}`)[0];
                    const publication = command.commandId.startsWith("publication:");
                    const types: Readonly<Record<string, string>> = {
                      "project.created": "project.create",
                      "thread.created": "thread.create",
                      "thread.meta-updated": "thread.meta.update",
                      "thread.archived": publication
                        ? "thread.publication.archive"
                        : "thread.archive",
                      "thread.unarchived": publication
                        ? "thread.publication.archive"
                        : "thread.unarchive",
                      "thread.message-sent": publication ? "thread.publication.message" : "",
                      "thread.activity-appended": "thread.activity.append",
                      "sidethread.created": "sidethread.create",
                      "sidethread.message-posted": "sidethread.message.post",
                      "sidethread.message-edited": "sidethread.message.edit",
                      "sidethread.message-reacted": "sidethread.message.react",
                      "sidethread.marked-read": "sidethread.mark-read",
                      "sidethread.archived": "sidethread.archive",
                      "sidethread.unarchived": "sidethread.unarchive",
                    };
                    legacyType = original ? (types[original.event_type] ?? "") : "";
                  }
                  const aggregate =
                    command.type === "project.create"
                      ? command.projectId
                      : "threadId" in command
                        ? command.threadId
                        : null;
                  if (
                    legacyType !== command.type ||
                    legacy.aggregate_kind !==
                      (command.type === "project.create" ? "project" : "thread") ||
                    legacy.aggregate_id !== aggregate ||
                    legacy.collaboration_subject !== (member?.subject ?? null)
                  )
                    return yield* new TeamConversationError({ reason: "conflict" });
                  if (legacy.status !== "accepted") return yield* invalid();
                  yield* sql`INSERT INTO team_conversation_receipts(command_id,digest,sequence) VALUES(${command.commandId},${digest},${legacy.result_sequence})`;
                  return { sequence: legacy.result_sequence, event: null };
                }
                const now = DateTime.formatIso(yield* DateTime.now);
                let eventType: string;
                let payload: unknown;
                let occurredAt = "createdAt" in command ? command.createdAt : now;
                let thread: OrchestrationThread | undefined;
                if (command.type === "project.create") {
                  if (Option.isSome(yield* projectById(command.projectId))) return yield* invalid();
                  const project = yield* Schema.decodeUnknownEffect(OrchestrationProject)({
                    id: command.projectId,
                    title: command.title,
                    workspaceRoot: "/workspace",
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: command.createdAt,
                    updatedAt: command.createdAt,
                    deletedAt: null,
                    ...(member ? { createdBy: member } : {}),
                  });
                  yield* sql`INSERT INTO team_conversation_projects(project_id,state_json) VALUES(${project.id},${yield* encodeProject(project)})`;
                  eventType = "project.created";
                  payload = { ...project, projectId: project.id };
                } else {
                  if (!("threadId" in command))
                    return yield* new TeamConversationError({ reason: "unsupported" });
                  const existing = yield* threadById(command.threadId);
                  if (command.type === "thread.create") {
                    if (
                      Option.isSome(existing) ||
                      Option.isNone(yield* projectById(command.projectId))
                    )
                      return yield* invalid();
                    thread = yield* Schema.decodeUnknownEffect(OrchestrationThread)({
                      id: command.threadId,
                      projectId: command.projectId,
                      title: command.title,
                      modelSelection: command.modelSelection,
                      runtimeMode: "approval-required",
                      interactionMode: "default",
                      branch: null,
                      worktreePath: null,
                      latestTurn: null,
                      createdAt: command.createdAt,
                      updatedAt: command.createdAt,
                      archivedAt: null,
                      deletedAt: null,
                      messages: [],
                      activities: [],
                      checkpoints: [],
                      session: null,
                      ...(member ? { createdBy: member } : {}),
                    });
                    eventType = "thread.created";
                    payload = { ...thread, threadId: thread.id };
                  } else {
                    // A deleted conversation accepts no further writes, including publications.
                    if (Option.isNone(existing) || existing.value.deletedAt !== null)
                      return yield* invalid();
                    thread = existing.value;
                    switch (command.type) {
                      case "thread.delete":
                        thread = { ...thread, deletedAt: now, updatedAt: now };
                        eventType = "thread.deleted";
                        payload = { threadId: thread.id, deletedAt: now };
                        break;
                      case "thread.meta.update":
                        thread = {
                          ...thread,
                          ...(command.title !== undefined ? { title: command.title } : {}),
                          ...(command.modelSelection
                            ? { modelSelection: command.modelSelection }
                            : {}),
                          updatedAt: now,
                        };
                        eventType = "thread.meta-updated";
                        payload = {
                          threadId: thread.id,
                          title: thread.title,
                          modelSelection: thread.modelSelection,
                          updatedAt: now,
                        };
                        break;
                      case "thread.archive":
                      case "thread.unarchive":
                      case "thread.publication.archive": {
                        const archived =
                          command.type === "thread.publication.archive"
                            ? command.archived
                            : command.type === "thread.archive";
                        occurredAt =
                          command.type === "thread.publication.archive" ? command.updatedAt : now;
                        thread = {
                          ...thread,
                          archivedAt: archived ? (thread.archivedAt ?? occurredAt) : null,
                          updatedAt: occurredAt,
                        };
                        eventType = archived ? "thread.archived" : "thread.unarchived";
                        payload = {
                          threadId: thread.id,
                          archivedAt: thread.archivedAt,
                          updatedAt: occurredAt,
                        };
                        break;
                      }
                      case "thread.publication.settle":
                        occurredAt = command.updatedAt;
                        thread = {
                          ...thread,
                          settledOverride: command.settled ? "settled" : null,
                          settledAt: command.settled ? command.updatedAt : null,
                        };
                        eventType = command.settled ? "thread.settled" : "thread.unsettled";
                        payload = command.settled
                          ? {
                              threadId: thread.id,
                              settledAt: command.updatedAt,
                              updatedAt: command.updatedAt,
                            }
                          : { threadId: thread.id, reason: "user", updatedAt: command.updatedAt };
                        break;
                      case "thread.publication.message": {
                        const previous = thread.messages.find((m) => m.id === command.messageId);
                        if (
                          previous &&
                          (previous.role !== command.role || previous.turnId !== command.turnId)
                        )
                          return yield* invalid();
                        const message = {
                          id: command.messageId,
                          role: command.role,
                          turnId: command.turnId,
                          text: previous
                            ? command.streaming
                              ? previous.text + command.text
                              : command.text || previous.text
                            : command.text,
                          streaming: command.streaming,
                          createdAt: previous?.createdAt ?? command.createdAt,
                          updatedAt: command.updatedAt,
                          attachments: [],
                          ...(member ? { author: member } : {}),
                        };
                        thread = {
                          ...thread,
                          messages: previous
                            ? thread.messages.map((m) => (m.id === message.id ? message : m))
                            : [...thread.messages, message],
                          updatedAt: command.updatedAt,
                        };
                        eventType = "thread.message-sent";
                        payload = {
                          ...message,
                          text: command.text,
                          threadId: thread.id,
                          messageId: message.id,
                        };
                        occurredAt = command.updatedAt;
                        break;
                      }
                      case "thread.activity.append":
                        thread = {
                          ...thread,
                          activities: [...thread.activities, command.activity],
                          updatedAt: command.createdAt,
                        };
                        eventType = "thread.activity-appended";
                        payload = { threadId: thread.id, activity: command.activity };
                        break;
                      default: {
                        if (!("sideThreadId" in command))
                          return yield* new TeamConversationError({ reason: "unsupported" });
                        if (
                          !member ||
                          command.sideThreadId !== sideThreadIdForThread(thread.id) ||
                          thread.archivedAt !== null ||
                          thread.deletedAt !== null
                        )
                          return yield* invalid();
                        let side = thread.sideThreads?.[0];
                        if (command.type === "sidethread.create") {
                          if (
                            side ||
                            (command.anchorMessageId &&
                              !thread.messages.some((m) => m.id === command.anchorMessageId))
                          )
                            return yield* invalid();
                          side = {
                            id: command.sideThreadId,
                            ...(command.anchorMessageId
                              ? { anchorMessageId: command.anchorMessageId }
                              : {}),
                            createdBy: member,
                            createdAt: command.createdAt,
                            updatedAt: command.createdAt,
                            archivedAt: null,
                            messages: [],
                          };
                          eventType = "sidethread.created";
                          payload = { ...command, createdBy: member };
                        } else {
                          if (!side) return yield* invalid();
                          const base = { threadId: thread.id, sideThreadId: side.id };
                          switch (command.type) {
                            case "sidethread.message.post": {
                              if (
                                side.archivedAt !== null ||
                                side.messages.length >= 500 ||
                                side.messages.some((m) => m.id === command.messageId) ||
                                !command.text.trim() ||
                                command.attachments?.length
                              )
                                return yield* invalid();
                              if (
                                command.quotedMessageId &&
                                !thread.messages.some((m) => m.id === command.quotedMessageId)
                              )
                                return yield* invalid();
                              if (
                                command.replyToSideThreadMessageId &&
                                !side.messages.some(
                                  (m) => m.id === command.replyToSideThreadMessageId,
                                )
                              )
                                return yield* invalid();
                              if (command.linkedRef) {
                                const linked = yield* threadById(command.linkedRef.threadId);
                                if (
                                  Option.isNone(linked) ||
                                  linked.value.projectId !== thread.projectId ||
                                  linked.value.archivedAt !== null ||
                                  linked.value.deletedAt !== null
                                )
                                  return yield* invalid();
                              }
                              const {
                                type: _type,
                                commandId: _command,
                                threadId: _thread,
                                sideThreadId: _side,
                                messageId,
                                ...content
                              } = command;
                              const message = {
                                ...content,
                                id: messageId,
                                author: member,
                                updatedAt: command.createdAt,
                              };
                              side = {
                                ...side,
                                messages: [...side.messages, message],
                                updatedAt: command.createdAt,
                              };
                              eventType = "sidethread.message-posted";
                              payload = { ...base, ...content, messageId, author: member };
                              break;
                            }
                            case "sidethread.message.edit":
                            case "sidethread.message.react": {
                              const message = side.messages.find((m) => m.id === command.messageId);
                              if (!message || side.archivedAt !== null) return yield* invalid();
                              if (command.type === "sidethread.message.edit") {
                                if (
                                  message.author.subject !== member.subject ||
                                  !command.text.trim()
                                )
                                  return yield* invalid();
                                side = {
                                  ...side,
                                  messages: side.messages.map((m) =>
                                    m.id === message.id
                                      ? {
                                          ...m,
                                          text: command.text,
                                          editedAt: command.createdAt,
                                          updatedAt: command.createdAt,
                                        }
                                      : m,
                                  ),
                                  updatedAt: command.createdAt,
                                };
                                eventType = "sidethread.message-edited";
                                payload = {
                                  ...base,
                                  messageId: message.id,
                                  text: command.text,
                                  editor: member,
                                  editedAt: command.createdAt,
                                };
                              } else {
                                const reactions = message.reactions ?? [];
                                const reaction = reactions.find((r) => r.emoji === command.emoji);
                                if (!reaction && reactions.length >= 32) return yield* invalid();
                                const removed =
                                  reaction?.users.some((u) => u.subject === member.subject) ??
                                  false;
                                const users = removed
                                  ? reaction!.users.filter((u) => u.subject !== member.subject)
                                  : [...(reaction?.users ?? []), member];
                                const next = [
                                  ...reactions.filter((r) => r.emoji !== command.emoji),
                                  ...(users.length ? [{ emoji: command.emoji, users }] : []),
                                ];
                                side = {
                                  ...side,
                                  messages: side.messages.map((m) =>
                                    m.id === message.id ? { ...m, reactions: next } : m,
                                  ),
                                  updatedAt: command.createdAt,
                                };
                                eventType = "sidethread.message-reacted";
                                payload = {
                                  ...base,
                                  messageId: message.id,
                                  user: member,
                                  emoji: command.emoji,
                                  action: removed ? "removed" : "added",
                                  createdAt: command.createdAt,
                                };
                              }
                              break;
                            }
                            case "sidethread.mark-read": {
                              const requested =
                                command.lastReadAt > command.createdAt
                                  ? command.createdAt
                                  : command.lastReadAt;
                              const previous = side.readBy?.find(
                                (r) => r.user.subject === member.subject,
                              )?.lastReadAt;
                              const lastReadAt =
                                previous && previous > requested ? previous : requested;
                              side = {
                                ...side,
                                readBy: [
                                  ...(side.readBy ?? []).filter(
                                    (r) => r.user.subject !== member.subject,
                                  ),
                                  { user: member, lastReadAt },
                                ],
                              };
                              eventType = "sidethread.marked-read";
                              payload = {
                                ...base,
                                user: member,
                                lastReadAt,
                                createdAt: command.createdAt,
                              };
                              break;
                            }
                            case "sidethread.archive":
                            case "sidethread.unarchive": {
                              const archived = command.type === "sidethread.archive";
                              if (archived === (side.archivedAt !== null)) return yield* invalid();
                              side = {
                                ...side,
                                archivedAt: archived ? command.createdAt : null,
                                updatedAt: command.createdAt,
                              };
                              eventType = archived
                                ? "sidethread.archived"
                                : "sidethread.unarchived";
                              payload = {
                                ...base,
                                ...(archived
                                  ? { archivedAt: command.createdAt }
                                  : { unarchivedAt: command.createdAt }),
                              };
                              break;
                            }
                          }
                        }
                        thread = {
                          ...thread,
                          sideThreads: [side satisfies SideThread],
                          ...(command.type === "sidethread.mark-read"
                            ? {}
                            : { updatedAt: command.createdAt }),
                        };
                      }
                    }
                  }
                  yield* sql`INSERT INTO team_conversation_threads(thread_id,project_id,state_json,shell_json) VALUES(${thread.id},${thread.projectId},${yield* encodeThread(thread)},${yield* encodeShell(teamThreadShell(thread))}) ON CONFLICT(thread_id) DO UPDATE SET state_json=excluded.state_json,shell_json=excluded.shell_json`;
                }
                const aggregateId =
                  command.type === "project.create"
                    ? command.projectId
                    : "threadId" in command
                      ? command.threadId
                      : "";
                const event = yield* decodeEvent({
                  sequence: (yield* latestSequence) + 1,
                  eventId: yield* crypto.randomUUIDv4,
                  aggregateKind: command.type === "project.create" ? "project" : "thread",
                  aggregateId,
                  type: eventType,
                  occurredAt,
                  commandId: command.commandId,
                  causationEventId: null,
                  correlationId: null,
                  metadata: {
                    ...(member ? { collaborationUser: member } : {}),
                    ...(command.type === "thread.publication.message" ? { publication: true } : {}),
                  },
                  payload,
                });
                yield* sql`INSERT INTO team_conversation_events(sequence,aggregate_id,event_type,event_json) VALUES(${event.sequence},${aggregateId},${event.type},${yield* encodeEvent(event)})`;
                yield* sql`INSERT INTO team_conversation_receipts(command_id,digest,sequence) VALUES(${command.commandId},${digest},${event.sequence})`;
                return { sequence: event.sequence, event };
              }),
            )
            .pipe(
              Effect.catchTags({
                TeamConversationError: (error) =>
                  Effect.gen(function* () {
                    yield* sql`INSERT INTO team_conversation_receipts(command_id,digest,sequence,status)
                SELECT ${command.commandId},${digest},${yield* latestSequence},'rejected'
                WHERE NOT EXISTS(SELECT 1 FROM orchestration_command_receipts WHERE command_id=${command.commandId})
                ON CONFLICT(command_id) DO NOTHING`;
                    return yield* error;
                  }),
              }),
            );
          if (result.event) yield* PubSub.publish(changes, result.event);
          return { sequence: result.sequence };
        }),
      ),
    );
  const readEvents = (afterSequence: number, limit: number) =>
    Stream.unwrap(
      sql<{
        event_json: string;
      }>`SELECT event_json FROM team_conversation_events WHERE sequence>${afterSequence} ORDER BY sequence LIMIT ${limit}`.pipe(
        Effect.map((rows) =>
          Stream.fromIterable(rows).pipe(Stream.mapEffect((r) => decodeStoredEvent(r.event_json))),
        ),
      ),
    );
  type Range = { fromSequenceExclusive: number; toSequenceInclusive: number; threadId?: ThreadId };
  const getEventReplayStats = (range: Range) =>
    sql<{
      eventCount: number;
      payloadBytes: number;
      hasCreateEvent: number;
    }>`SELECT COUNT(*) AS "eventCount",COALESCE(SUM(length(CAST(event_json AS BLOB))),0) AS "payloadBytes",COALESCE(MAX(event_type='thread.created'),0) AS "hasCreateEvent" FROM team_conversation_events WHERE sequence>${range.fromSequenceExclusive} AND sequence<=${range.toSequenceInclusive} AND (${range.threadId ?? null} IS NULL OR aggregate_id=${range.threadId ?? null})`.pipe(
      Effect.map((rows) => ({ ...rows[0]!, hasCreateEvent: rows[0]!.hasCreateEvent !== 0 })),
    );
  const searchThreads = (input: OrchestrationSearchThreadsInput) =>
    getSnapshot().pipe(
      Effect.map((snapshot): OrchestrationSearchThreadsResult => ({
        matches: snapshot.threads
          .filter((t) => t.archivedAt === null && t.deletedAt === null)
          .flatMap((t) =>
            t.messages
              .filter(
                (m) =>
                  (m.role === "user" || m.role === "assistant") &&
                  m.text.toLowerCase().includes(input.query.toLowerCase()),
              )
              .map((m) => ({
                threadId: t.id,
                projectId: t.projectId,
                source: m.role === "user" ? ("user" as const) : ("assistant" as const),
                snippet: m.text.slice(0, 240),
                messageCreatedAt: m.createdAt,
              })),
          )
          .slice(0, input.limit ?? 20),
      })),
    );
  return {
    engine: {
      dispatch,
      latestSequence,
      subscribeDomainEvents: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      readEvents,
      getThreadReplayStats: (range: Range & { maxEvents: number }) => getEventReplayStats(range),
      readThreadEvents: (range: Range & { limit: number }) =>
        Stream.unwrap(
          sql<{
            event_json: string;
          }>`SELECT event_json FROM team_conversation_events WHERE sequence>${range.fromSequenceExclusive} AND sequence<=${range.toSequenceInclusive} AND aggregate_id=${range.threadId ?? ""} ORDER BY sequence LIMIT ${range.limit}`.pipe(
            Effect.map((rows) =>
              Stream.fromIterable(rows).pipe(
                Stream.mapEffect((r) => decodeStoredEvent(r.event_json)),
              ),
            ),
          ),
        ),
    },
    query: {
      getSnapshot,
      getShellSnapshot: () => getShellSnapshot(),
      getArchivedShellSnapshot: () => getShellSnapshot(true),
      getThreadDetailSnapshot,
      getEventReplayStats,
      searchThreads,
      getThreadShellById,
      getProjectShellById: projectById,
    },
    threadById,
  };
});
export type TeamConversationEngine = Effect.Success<typeof makeTeamConversation>["engine"];
