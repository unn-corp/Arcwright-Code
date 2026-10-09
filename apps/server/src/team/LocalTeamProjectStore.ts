import * as DateTime from "effect/DateTime";
import { LocalTeamFilesControl } from "@t3tools/contracts/teamFiles";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import {
  layer as layerCommandReceipts,
  CommandReceiptStoreV2,
} from "../orchestration-v2/CommandReceiptStore.ts";
import {
  CommandId,
  ProjectId,
  ThreadId,
  NonNegativeInt,
  ModelSelection,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import {
  TeamPublicationChange,
  TeamPublicationDisplay,
  TEAM_PUBLICATION_MAX_BYTES,
} from "@t3tools/contracts/teamPublication";
import { TeamSyncStatus, type LocalTeamProjectState } from "@t3tools/contracts/teamProjects";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import { publicationHash } from "./TeamPublications.ts";
import { localTeamError, type TeamProjectCredential } from "./TeamProjectTransport.ts";

const decodePublicationModel = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const encodeFileCreation = Schema.encodeEffect(Schema.fromJsonString(LocalTeamFilesControl));
export const publicationDisplay = (model: ModelSelection): TeamPublicationDisplay => {
  const provider = decodeDisplayProvider(model.instanceId);
  const display = decodeDisplayModel(model.model);
  return {
    provider: Option.getOrElse(provider, () => "other" as const),
    model: Option.getOrElse(display, () => "Shared model"),
  };
};
// Personal asset references have no shared upload/read authority. They remain
// unavailable even when embedded in otherwise publishable chat text.
export const publicationText = (text: string) =>
  text.replace(
    /(?:https?:\/\/[^\s<>)]*)?\/(?:api\/)?(?:attachments|assets)\/[^\s<>)]*|(?:attachment|t3-attachment|asset):\/\/[^\s<>)]*/gi,
    "[shared attachment unavailable]",
  );
const secretKey = (id: string) => `teams-publication-${id}`;

export interface LocalTeamLinkRow {
  link_id: string;
  project_id: string;
  space_id: string;
  service_url: string;
  issuer: string;
  client_id: string;
  subject: string;
  generation: string;
  installation_id: string;
  workspace_root: string;
  canonical_root: string;
  role: "owner" | "contributor" | "viewer";
  status: typeof TeamSyncStatus.Type;
}
export interface LocalTeamPublicationRow {
  paused: number;
  publication_id: string;
  link_id: string;
  thread_id: string;
  shared_thread_id: string | null;
  revision: number;
  source_cursor: number;
  history_cursor: number;
  history_offset: number;
  initial_json: string;
  pending_json: string | null;
  status: typeof TeamSyncStatus.Type;
}
const Pending = Schema.Struct({
  fromRevision: NonNegativeInt,
  changes: Schema.Array(TeamPublicationChange),
  sourceCursor: NonNegativeInt,
  historyCursor: NonNegativeInt,
  historyOffset: NonNegativeInt,
});
export type TeamPendingPublication = typeof Pending.Type;
const PendingJson = Schema.fromJsonString(Pending);
const encodeChanges = Schema.encodeSync(Schema.fromJsonString(Schema.Array(TeamPublicationChange)));
const InitialJson = Schema.fromJsonString(TeamPublicationChange);
const decodeDisplayProvider = Schema.decodeUnknownOption(TeamPublicationDisplay.fields.provider);
const decodeDisplayModel = Schema.decodeUnknownOption(TeamPublicationDisplay.fields.model);
const encodeInitial = Schema.encodeEffect(InitialJson);
const decodeInitial = Schema.decodeEffect(InitialJson);
const decodePending = Schema.decodeEffect(PendingJson);
const encodePending = Schema.encodeEffect(PendingJson);

export const makeLocalTeamProjectStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const receipts = yield* CommandReceiptStoreV2;
  const crypto = yield* Crypto.Crypto;
  const randomId = crypto.randomBytes(16).pipe(
    Effect.map((bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")),
    Effect.orDie,
  );
  const platform = yield* HostProcessPlatform;
  const secrets = yield* ServerSecretStore;
  const engine = yield* Orchestrator.OrchestratorV2;
  const events = yield* ApplicationEvents.OrchestrationEventStore;
  const query = {
    getThreadShellById: (threadId: ThreadId) =>
      engine.getThreadShell(threadId).pipe(Effect.map(Option.fromNullishOr)),
  };
  const savedInstallation = yield* secrets.get("teams-installation-v1");
  const installationId = Option.isSome(savedInstallation)
    ? new TextDecoder().decode(savedInstallation.value)
    : yield* randomId;
  if (!/^[a-f0-9]{32}$/.test(installationId)) return yield* localTeamError("storage");
  if (Option.isNone(savedInstallation))
    yield* secrets.set("teams-installation-v1", new TextEncoder().encode(installationId));
  const links = sql<LocalTeamLinkRow>`SELECT * FROM local_team_project_links ORDER BY project_id`;
  const link = (projectId: ProjectId) =>
    sql<LocalTeamLinkRow>`SELECT * FROM local_team_project_links WHERE project_id=${projectId}`.pipe(
      Effect.map((rows) => rows[0]),
    );
  const intents = (linkId: string) =>
    sql<{
      thread_id: string;
      status: "pending" | "error";
    }>`SELECT thread_id,status FROM local_team_publication_intents WHERE link_id=${linkId}`;
  const intent = (linkId: string, threadId: ThreadId, shared: boolean) =>
    Effect.gen(function* () {
      if (shared) {
        const count =
          (yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM local_team_publication_intents WHERE link_id=${linkId}`)[0]
            ?.count ?? 0;
        const existing = (yield* intents(linkId)).some((item) => item.thread_id === threadId);
        if (!existing && count >= 1000) return yield* localTeamError("limit");
        yield* sql`INSERT INTO local_team_publication_intents(link_id,thread_id) VALUES(${linkId},${threadId}) ON CONFLICT(link_id,thread_id) DO UPDATE SET status='pending'`;
      } else
        yield* sql`DELETE FROM local_team_publication_intents WHERE link_id=${linkId} AND thread_id=${threadId}`;
    });
  const creationIntent = (linkId: string, threadId: ThreadId) =>
    sql<{
      command_id: string;
      shared: number;
      root_identity: string;
    }>`SELECT command_id,shared,root_identity FROM local_team_creation_intents WHERE link_id=${linkId} AND thread_id=${threadId}`.pipe(
      Effect.map((rows) => rows[0]),
    );
  const acceptedCreation = (commandId: string, threadId: ThreadId) =>
    receipts
      .getByCommandId(CommandId.make(commandId))
      .pipe(
        Effect.map((receipt) =>
          Option.isSome(receipt) &&
          receipt.value.threadId === threadId &&
          receipt.value.commandType === "thread.create" &&
          receipt.value.status === "accepted"
            ? { result_sequence: receipt.value.resultSequence }
            : undefined,
        ),
      );
  const saveCreationIntent = (
    linkId: string,
    threadId: ThreadId,
    commandId: CommandId,
    shared: boolean,
    rootIdentity: string,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO local_team_creation_intents(link_id,thread_id,command_id,shared,root_identity) VALUES(${linkId},${threadId},${commandId},${shared ? 1 : 0},${rootIdentity}) ON CONFLICT(link_id,thread_id) DO UPDATE SET command_id=excluded.command_id,shared=excluded.shared,root_identity=excluded.root_identity`;
        yield* intent(linkId, threadId, shared);
      }),
    );
  const intentError = (linkId: string, threadId: ThreadId) =>
    sql`UPDATE local_team_publication_intents SET status='error' WHERE link_id=${linkId} AND thread_id=${threadId}`.pipe(
      Effect.asVoid,
    );
  const publications = (linkId: string) =>
    sql<LocalTeamPublicationRow>`SELECT * FROM local_team_thread_publications WHERE link_id=${linkId} ORDER BY publication_id`;
  const status = (linkId: string, value: typeof TeamSyncStatus.Type) =>
    sql`UPDATE local_team_project_links SET status=${value} WHERE link_id=${linkId}`.pipe(
      Effect.asVoid,
    );
  const role = (linkId: string, value: LocalTeamLinkRow["role"]) =>
    sql`UPDATE local_team_project_links SET role=${value} WHERE link_id=${linkId}`.pipe(
      Effect.asVoid,
    );
  const publicationStatus = (publicationId: string, value: typeof TeamSyncStatus.Type) =>
    sql`UPDATE local_team_thread_publications SET status=${value} WHERE publication_id=${publicationId}`.pipe(
      Effect.asVoid,
    );
  const describe = Effect.fnUntraced(function* (
    row: LocalTeamLinkRow,
  ): Effect.fn.Return<LocalTeamProjectState, import("effect/sql/SqlError").SqlError> {
    return {
      link: {
        id: row.link_id,
        projectId: ProjectId.make(row.project_id),
        sharedProjectId: row.space_id,
        serviceUrl: row.service_url,
        subject: row.subject,
        generation: row.generation,
        role: row.role,
        status: row.status,
        publicationPolicy: "explicit-threads",
        repositorySync: platform === "linux" ? "available" : "unavailable",
      },
      publicationIntents: (yield* intents(row.link_id)).map((item) => ({
        threadId: ThreadId.make(item.thread_id),
        status: item.status,
      })),
      publications: (yield* publications(row.link_id)).map((item) => ({
        publicationId: item.publication_id,
        threadId: ThreadId.make(item.thread_id),
        sharedThreadId:
          item.shared_thread_id === null ? null : ThreadId.make(item.shared_thread_id),
        revision: item.revision,
        paused: item.paused === 1,
        status: item.status,
      })),
    };
  });
  const create = Effect.fnUntraced(function* (input: {
    projectId: ProjectId;
    sharedProjectId: string;
    workspaceRoot: string;
    canonicalRoot: string;
    credential: TeamProjectCredential;
    role: LocalTeamLinkRow["role"];
  }) {
    const row: LocalTeamLinkRow = {
      link_id: yield* randomId,
      project_id: input.projectId,
      space_id: input.sharedProjectId,
      service_url: input.credential.serviceUrl,
      issuer: input.credential.issuer,
      client_id: input.credential.clientId,
      subject: input.credential.subject,
      generation: input.credential.generation,
      installation_id: installationId,
      workspace_root: input.workspaceRoot,
      canonical_root: input.canonicalRoot,
      role: input.role,
      status: "not-synced",
    };
    yield* sql`INSERT INTO local_team_project_links ${sql.insert({ ...row })}`;
    return row;
  });
  const detach = Effect.fnUntraced(function* (row: LocalTeamLinkRow) {
    const mappings = yield* publications(row.link_id);
    yield* sql`DELETE FROM local_team_project_links WHERE link_id=${row.link_id}`;
    for (const mapping of mappings) yield* secrets.remove(secretKey(mapping.publication_id));
  });
  const prepare = Effect.fnUntraced(function* (row: LocalTeamLinkRow, threadId: ThreadId) {
    const existing = (yield* publications(row.link_id)).find((item) => item.thread_id === threadId);
    if (existing) return existing;
    const id = yield* randomId;
    yield* secrets.set(
      secretKey(id),
      new TextEncoder().encode((yield* randomId) + (yield* randomId)),
    );
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const thread = yield* query.getThreadShellById(threadId);
          if (
            Option.isNone(thread) ||
            thread.value.projectId !== row.project_id ||
            thread.value.archivedAt !== null
          )
            return yield* localTeamError("invalid");
          const currentLink = yield* link(ProjectId.make(row.project_id));
          if (currentLink?.link_id !== row.link_id) return yield* localTeamError("changed");
          const head = yield* events.latestApplicationSequence;
          const size = (yield* sql<{
            bytes: number;
            count: number;
            largest: number;
          }>`SELECT COALESCE(SUM(length(CAST(json_extract(payload_json,'$.text') AS BLOB))),0) AS bytes, COUNT(*) AS count, COALESCE(MAX(length(CAST(json_extract(payload_json,'$.text') AS BLOB))),0) AS largest FROM orchestration_v2_projection_messages WHERE thread_id=${threadId}`)[0]!;
          if (size.bytes > 16 * 1024 * 1024 || size.count > 10000 || size.largest > 4 * 1024 * 1024)
            return yield* localTeamError("limit");
          const initial: TeamPublicationChange = {
            kind: "create",
            title: thread.value.title.slice(0, 500),
            display: publicationDisplay(thread.value.modelSelection),
            createdAt: DateTime.formatIso(thread.value.createdAt),
          };
          const encoded = yield* encodeInitial(initial);
          yield* sql`INSERT INTO local_team_thread_publications(publication_id,link_id,thread_id,source_cursor,initial_json) VALUES(${id},${row.link_id},${threadId},${head},${encoded})`;
          yield* sql`INSERT INTO local_team_publication_history(publication_id,ordinal,message_id,turn_id,role,text,is_streaming,created_at,updated_at)
            SELECT ${id}, ROW_NUMBER() OVER(ORDER BY message.created_at,message.message_id), message.message_id,
              CASE WHEN message.role='user' THEN message.message_id ELSE COALESCE(
                (SELECT json_extract(payload_json,'$.userMessageId') FROM orchestration_v2_projection_runs WHERE run_id=message.run_id LIMIT 1), message.message_id) END,
              message.role,json_extract(message.payload_json,'$.text'),message.streaming,message.created_at,message.updated_at
            FROM orchestration_v2_projection_messages message WHERE message.thread_id=${threadId} AND message.role IN ('user','assistant')`;
          // Sanitize complete messages before paging so an asset URL split across
          // a chunk boundary cannot escape the safe text projection.
          let ordinal = 0;
          while (true) {
            const message = (yield* sql<{
              ordinal: number;
              text: string;
            }>`SELECT ordinal,text FROM local_team_publication_history WHERE publication_id=${id} AND ordinal>${ordinal} ORDER BY ordinal LIMIT 1`)[0];
            if (!message) break;
            const text = publicationText(message.text);
            if (text !== message.text)
              yield* sql`UPDATE local_team_publication_history SET text=${text} WHERE publication_id=${id} AND ordinal=${message.ordinal}`;
            ordinal = message.ordinal;
          }
          return (yield* publications(row.link_id)).find((item) => item.publication_id === id)!;
        }),
      )
      .pipe(Effect.onError(() => secrets.remove(secretKey(id)).pipe(Effect.ignore)));
  });
  const registration = Effect.fnUntraced(function* (
    row: LocalTeamLinkRow,
    mapping: LocalTeamPublicationRow,
  ) {
    const capability = yield* secrets.get(secretKey(mapping.publication_id));
    if (Option.isNone(capability)) return yield* localTeamError("storage");
    return {
      publicationId: mapping.publication_id,
      installationId: row.installation_id,
      capability: new TextDecoder().decode(capability.value),
    };
  });
  const messageKey = (id: string, messageId: string) => publicationHash(id, "message", messageId);
  const turnKey = Effect.fnUntraced(function* (
    mapping: LocalTeamPublicationRow,
    messageId: string,
    turnId: string | null,
    role: string,
    createdAt: string,
    knownAnchor?: string | null,
  ) {
    const previous = (yield* sql<{
      turn_key: string;
    }>`SELECT turn_key FROM local_team_publication_messages WHERE publication_id=${mapping.publication_id} AND message_id=${messageId}`)[0];
    if (previous) return previous.turn_key;
    const anchor =
      role === "user"
        ? messageId
        : (knownAnchor ??
          (yield* sql<{ anchor: string | null }>`SELECT COALESCE(
            (SELECT json_extract(payload_json,'$.userMessageId') FROM orchestration_v2_projection_runs WHERE thread_id=${mapping.thread_id} AND run_id=${turnId} LIMIT 1),
            (SELECT message_id FROM orchestration_v2_projection_messages WHERE thread_id=${mapping.thread_id} AND role='user' AND created_at<=${createdAt} ORDER BY created_at DESC,message_id DESC LIMIT 1)) AS anchor`)[0]
            ?.anchor ??
          messageId);
    const key = publicationHash(mapping.publication_id, "turn", anchor);
    yield* sql`INSERT INTO local_team_publication_messages(publication_id,message_id,turn_key) VALUES(${mapping.publication_id},${messageId},${key})`;
    return key;
  });
  const projectEvent = Effect.fnUntraced(function* (
    mapping: LocalTeamPublicationRow,
    stored: OrchestrationV2StoredEvent,
  ) {
    const event = stored.event;
    const updatedAt = DateTime.formatIso(event.occurredAt);
    const changes: TeamPublicationChange[] = [];
    switch (event.type) {
      case "thread.created":
      case "thread.deleted":
      case "checkpoint.rollback-requested":
        return yield* localTeamError("reset_required");
      case "thread.metadata-updated":
      case "thread.model-selection-updated": {
        const title = event.payload.title.slice(0, 500);
        const display = publicationDisplay(event.payload.modelSelection);
        const prior = (yield* sql<{ title: string; model: string }>`
          SELECT json_extract(payload_json,'$.title') AS title, json_extract(payload_json,'$.modelSelection') AS model
          FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread'
            AND stream_id=${mapping.thread_id} AND sequence<${stored.sequence}
            AND event_type IN ('thread.created','thread.metadata-updated','thread.model-selection-updated')
          ORDER BY sequence DESC LIMIT 1`)[0];
        const previousModel = prior ? yield* decodePublicationModel(prior.model) : undefined;
        const previousDisplay = previousModel ? publicationDisplay(previousModel) : undefined;
        if (
          !prior ||
          prior.title.slice(0, 500) !== title ||
          previousDisplay?.provider !== display.provider ||
          previousDisplay?.model !== display.model
        )
          changes.push({ kind: "metadata", title, display, updatedAt });
        break;
      }
      case "message.updated": {
        const message = event.payload;
        if (message.role === "system") break;
        const text = publicationText(message.text);
        if (text.length > 120000) return yield* localTeamError("limit");
        // V2 publishes complete message revisions. The Teams protocol appends assistant chunks.
        // Read the preceding committed revision, never a newer live projection, to derive the delta.
        const previous = (yield* sql<{
          text: string;
        }>`SELECT json_extract(payload_json,'$.text') AS text
          FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread'
            AND stream_id=${mapping.thread_id} AND event_type='message.updated' AND sequence<${stored.sequence}
            AND json_extract(payload_json,'$.id')=${message.id} ORDER BY sequence DESC LIMIT 1`)[0];
        const previousText = previous ? publicationText(previous.text) : "";

        const delta = message.role === "assistant" ? text.slice(previousText.length) : text;
        const common = {
          key: messageKey(mapping.publication_id, message.id),
          turnKey: yield* turnKey(
            mapping,
            message.id,
            message.runId,
            message.role,
            DateTime.formatIso(message.createdAt),
          ),
          role: message.role,
          createdAt: DateTime.formatIso(message.createdAt),
          updatedAt: DateTime.formatIso(message.updatedAt),
        };
        if (message.role === "assistant") {
          if (!text.startsWith(previousText)) {
            // Nonempty final chunks replace text in the existing Teams wire protocol.
            // An empty replacement cannot be represented without retaining old text.
            if (!text) return yield* localTeamError("reset_required");
            changes.push({ kind: "message", ...common, text, streaming: false });
            if (message.streaming)
              changes.push({ kind: "message", ...common, text: "", streaming: true });
            break;
          }
          if (delta) changes.push({ kind: "message", ...common, text: delta, streaming: true });
          if (!message.streaming)
            changes.push({ kind: "message", ...common, text: "", streaming: false });
        } else changes.push({ kind: "message", ...common, text, streaming: false });
        break;
      }
      case "run.updated":
        changes.push({
          kind: "status",
          status: ["preparing", "starting", "running", "waiting"].includes(event.payload.status)
            ? "working"
            : event.payload.status === "failed"
              ? "failed"
              : event.payload.status === "completed"
                ? "completed"
                : "stopped",
          updatedAt,
        });
        break;
      case "thread.archived":
      case "thread.unarchived":
        changes.push({ kind: "archive", archived: event.type === "thread.archived", updatedAt });
        break;
      case "thread.settled":
      case "thread.unsettled":
        changes.push({ kind: "settle", settled: event.type === "thread.settled", updatedAt });
        break;
    }
    return changes;
  });
  const assertHistory = Effect.fnUntraced(function* (mapping: LocalTeamPublicationRow) {
    const destructive =
      yield* sql`SELECT 1 FROM orchestration_events WHERE stream_id=${mapping.thread_id} AND sequence>${mapping.source_cursor} AND application_event_version=2 AND event_type IN ('thread.deleted','checkpoint.rollback-requested') LIMIT 1`;
    if (mapping.status === "reset-required" || destructive.length > 0) {
      yield* publicationStatus(mapping.publication_id, "reset-required");
      return yield* localTeamError("reset_required");
    }
  });
  const next = Effect.fnUntraced(function* (mapping: LocalTeamPublicationRow) {
    if (mapping.pending_json) return yield* decodePending(mapping.pending_json);
    const changes: Array<TeamPublicationChange> = [];
    let sourceCursor = mapping.source_cursor;
    let drained = true;
    let historyCursor = mapping.history_cursor;
    let historyOffset = mapping.history_offset;
    if (mapping.revision === 0) {
      changes.push(yield* decodeInitial(mapping.initial_json));
      // Later settle events replay from the cursor; carry the state at sharing time.
      const shell = yield* query.getThreadShellById(ThreadId.make(mapping.thread_id));
      if (Option.isSome(shell) && shell.value.settledAt !== null)
        changes.push({
          kind: "settle",
          settled: true,
          updatedAt: DateTime.formatIso(shell.value.settledAt),
        });
    }
    const history = (yield* sql<{
      ordinal: number;
      message_id: string;
      turn_id: string | null;
      role: "user" | "assistant";
      text: string;
      total: number;
      is_streaming: number;
      created_at: string;
      updated_at: string;
    }>`SELECT ordinal,message_id,turn_id,role,
      CASE WHEN role='user' THEN substr(text,1,120001) ELSE substr(text,${historyOffset + 1},16384) END AS text,
      length(text) AS total,is_streaming,created_at,updated_at FROM local_team_publication_history
      WHERE publication_id=${mapping.publication_id} AND ordinal>${historyCursor} ORDER BY ordinal LIMIT 1`)[0];
    if (history) {
      if (history.role === "user" && history.total > 120000) return yield* localTeamError("limit");
      const key = messageKey(mapping.publication_id, history.message_id);
      const keyTurn = yield* turnKey(
        mapping,
        history.message_id,
        null,
        history.role,
        history.created_at,
        history.turn_id,
      );
      const last = historyOffset + [...history.text].length >= history.total;
      changes.push({
        kind: "message",
        key,
        turnKey: keyTurn,
        role: history.role,
        text: publicationText(history.text),
        streaming: history.role === "assistant",
        createdAt: history.created_at,
        updatedAt: history.updated_at,
      });
      if (last && history.role === "assistant" && !history.is_streaming)
        changes.push({
          kind: "message",
          key,
          turnKey: keyTurn,
          role: "assistant",
          text: "",
          streaming: false,
          createdAt: history.created_at,
          updatedAt: history.updated_at,
        });
      historyCursor = last ? history.ordinal : historyCursor;
      historyOffset = last ? 0 : historyOffset + [...history.text].length;
    } else {
      const head = yield* events.latestApplicationSequence;
      if (mapping.source_cursor > head) return yield* localTeamError("reset_required");
      let bytes = Buffer.byteLength(encodeChanges(changes));
      const projected = yield* events
        .readAgentEvents({
          threadId: ThreadId.make(mapping.thread_id),
          afterSequence: mapping.source_cursor,
          throughSequence: head,
          limit: 64,
        })
        .pipe(
          Stream.mapEffect((event) =>
            projectEvent(mapping, event).pipe(
              Effect.map((changes) => ({ sequence: event.sequence, changes })),
            ),
          ),
          Stream.runCollect,
        );
      for (const event of projected) {
        const size = Buffer.byteLength(encodeChanges(event.changes));
        if (
          changes.length + event.changes.length > 64 ||
          bytes + size > TEAM_PUBLICATION_MAX_BYTES - 2048
        ) {
          if (changes.length === 0 && event.changes.length > 0)
            return yield* localTeamError("limit");
          break;
        }
        bytes += size;
        for (const change of event.changes) {
          const previous = changes.at(-1);
          if (
            change.kind === "message" &&
            change.streaming &&
            previous?.kind === "message" &&
            previous.streaming &&
            previous.key === change.key &&
            previous.turnKey === change.turnKey &&
            previous.text.length + change.text.length <= 120000
          )
            changes[changes.length - 1] = {
              ...previous,
              text: previous.text + change.text,
              updatedAt: change.updatedAt,
            };
          else changes.push(change);
        }
        sourceCursor = event.sequence;
      }
      if (projected.length === 0) sourceCursor = head;
      drained = sourceCursor >= head;
    }
    if (changes.length === 0) {
      yield* sql`UPDATE local_team_thread_publications SET source_cursor=${sourceCursor},status=${drained ? "synced" : "syncing"} WHERE publication_id=${mapping.publication_id}`;
      return drained
        ? null
        : { fromRevision: mapping.revision, changes, sourceCursor, historyCursor, historyOffset };
    }
    const pending: TeamPendingPublication = {
      fromRevision: mapping.revision,
      changes,
      sourceCursor,
      historyCursor,
      historyOffset,
    };
    const encoded = yield* encodePending(pending);
    if (Buffer.byteLength(encoded) > TEAM_PUBLICATION_MAX_BYTES - 1024)
      return yield* localTeamError("limit");
    yield* sql`UPDATE local_team_thread_publications SET pending_json=${encoded},status='syncing' WHERE publication_id=${mapping.publication_id}`;
    return pending;
  }, sql.withTransaction);
  const acknowledge = Effect.fnUntraced(function* (
    mapping: LocalTeamPublicationRow,
    pending: TeamPendingPublication,
    threadId: ThreadId,
    revision: number,
  ) {
    if (revision !== pending.fromRevision + pending.changes.length)
      return yield* localTeamError("reset_required");
    yield* sql`UPDATE local_team_thread_publications SET revision=${revision},source_cursor=${pending.sourceCursor},history_cursor=${pending.historyCursor},history_offset=${pending.historyOffset},shared_thread_id=${threadId},pending_json=NULL,status='syncing' WHERE publication_id=${mapping.publication_id} AND revision=${pending.fromRevision}`;
    yield* sql`DELETE FROM local_team_publication_history WHERE publication_id=${mapping.publication_id} AND ordinal<=${pending.historyCursor}`;
  }, sql.withTransaction);
  const reserveFileCreation = Effect.fnUntraced(function* (
    credential: TeamProjectCredential,
    input: Extract<LocalTeamFilesControl, { action: "create" | "share" }>,
  ) {
    const common = {
      name: input.name.trim(),
      members: [...(input.members ?? [])].sort((a, b) => a.userId.localeCompare(b.userId)),
    };
    const spec =
      input.action === "create"
        ? { action: input.action, destination: input.destination, ...common }
        : {
            action: input.action,
            projectId: input.projectId,
            expectedBranch: input.expectedBranch,
            expectedCommit: input.expectedCommit,
            ...common,
          };
    const encoded = yield* encodeFileCreation(spec).pipe(
      Effect.mapError(() => localTeamError("invalid")),
    );
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(encoded)).pipe(
      Effect.map((bytes) =>
        Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
      Effect.orDie,
    );
    if (input.requestId) {
      const exact = (yield* sql<{
        digest: string;
      }>`SELECT digest FROM local_team_file_creation_requests WHERE service_url=${credential.serviceUrl} AND subject=${credential.subject} AND generation=${credential.generation} AND request_id=${input.requestId}`)[0];
      if (exact && exact.digest !== digest) return yield* localTeamError("changed");
    }
    const previous = (yield* sql<{
      requestId: string;
    }>`SELECT request_id AS "requestId" FROM local_team_file_creation_requests WHERE service_url=${credential.serviceUrl} AND subject=${credential.subject} AND generation=${credential.generation} AND digest=${digest}`)[0];
    if (previous) return previous.requestId;
    const requestId = input.requestId ?? (yield* randomId);
    yield* sql`INSERT INTO local_team_file_creation_requests(service_url,subject,generation,request_id,digest,spec_json) VALUES(${credential.serviceUrl},${credential.subject},${credential.generation},${requestId},${digest},${encoded})`;
    return requestId;
  }, sql.withTransaction);
  return {
    installationId,
    assertHistory,
    role,
    links,
    link,
    pause: (publicationId: string, paused: boolean) =>
      sql`UPDATE local_team_thread_publications SET paused=${paused ? 1 : 0} WHERE publication_id=${publicationId}`.pipe(
        Effect.asVoid,
      ),
    publications,
    intents,
    intent,
    reserveFileCreation,
    creationIntent,
    acceptedCreation,
    saveCreationIntent,
    intentError,
    status,
    publicationStatus,
    describe,
    create,
    detach,
    prepare,
    registration,
    next,
    acknowledge,
  };
});
export class LocalTeamProjectStore extends Context.Service<
  LocalTeamProjectStore,
  Effect.Success<typeof makeLocalTeamProjectStore>
>()("t3/team/LocalTeamProjectStore") {
  static readonly layer = Layer.effect(this, makeLocalTeamProjectStore).pipe(
    Layer.provide(layerCommandReceipts),
  );
}
