import { teamThreadShell } from "./TeamConversation.ts";
import {
  OrchestrationEvent,
  OrchestrationProject,
  OrchestrationThread,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** Runs only in the native space's copied statev2 database. Original state.sqlite is untouched. */
export const importTeamConversation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if ((yield* sql`SELECT 1 FROM team_conversation_projects LIMIT 1`).length) return;
      const projects = yield* sql<{ state: string }>`SELECT json_object(
      'id',project_id,'title',title,'workspaceRoot',workspace_root,
      'defaultModelSelection',json(default_model_selection_json),'scripts',json(scripts_json),
      'createdAt',created_at,'updatedAt',updated_at,'deletedAt',deleted_at,
      'createdBy',json(created_by_json)) AS state FROM projection_projects`;
      if (!projects.length) return;
      for (const row of projects) {
        const project = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(OrchestrationProject),
        )(row.state);
        yield* sql`INSERT INTO team_conversation_projects(project_id,state_json) VALUES(${project.id},${row.state})`;
      }
      const threads = yield* sql<{ state: string }>`SELECT json_object(
      'id',t.thread_id,'projectId',t.project_id,'title',t.title,
      'modelSelection',json(t.model_selection_json),'runtimeMode','approval-required','interactionMode','default',
      'branch',NULL,'worktreePath',NULL,'latestTurn',NULL,'createdAt',t.created_at,'updatedAt',t.updated_at,
      'archivedAt',t.archived_at,'deletedAt',t.deleted_at,'session',NULL,'checkpoints',json('[]'),
      'createdBy',json(t.created_by_json),'sideThreads',json(COALESCE(d.side_threads_json,'[]')),
      'messages',json(COALESCE((SELECT json_group_array(json_object(
        'id',m.message_id,'role',m.role,'text',m.text,'turnId',m.turn_id,'streaming',json(CASE m.is_streaming WHEN 1 THEN 'true' ELSE 'false' END),
        'createdAt',m.created_at,'updatedAt',m.updated_at,'author',json(m.author_json)))
        FROM (SELECT * FROM projection_thread_messages WHERE thread_id=t.thread_id ORDER BY created_at,message_id) m),'[]')),
      'activities',json(COALESCE((SELECT json_group_array(json_object(
        'id',a.activity_id,'turnId',a.turn_id,'tone',a.tone,'kind',a.kind,'summary',a.summary,
        'payload',json(a.payload_json),'createdAt',a.created_at))
        FROM (SELECT * FROM projection_thread_activities WHERE thread_id=t.thread_id ORDER BY created_at,activity_id) a),'[]'))
      ) AS state FROM projection_threads t LEFT JOIN projection_thread_discussions d ON d.thread_id=t.thread_id`;
      for (const row of threads) {
        const thread = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(OrchestrationThread),
        )(row.state);
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(OrchestrationThread))(
          thread,
        );
        yield* sql`INSERT INTO team_conversation_threads(thread_id,project_id,state_json,shell_json) VALUES(${thread.id},${thread.projectId},${encoded},${yield* Schema.encodeEffect(Schema.fromJsonString(OrchestrationThreadShell))(teamThreadShell(thread))})`;
      }
      // Keep original watermarks: publication acknowledgements and reconnect cursors already refer to them.
      const events = yield* sql<{ state: string }>`SELECT json_object(
      'sequence',sequence,'eventId',event_id,'aggregateKind',aggregate_kind,'aggregateId',stream_id,
      'type',event_type,'occurredAt',occurred_at,'commandId',command_id,'causationEventId',causation_event_id,
      'correlationId',correlation_id,'metadata',json(metadata_json),'payload',json(payload_json)) AS state
      FROM orchestration_events WHERE application_event_version = 1 ORDER BY sequence`;
      for (const row of events) {
        const event = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationEvent))(
          row.state,
        );
        yield* sql`INSERT INTO team_conversation_events(sequence,aggregate_id,event_type,event_json) VALUES(${event.sequence},${event.aggregateId},${event.type},${row.state})`;
      }
      // Legacy receipts remain immutable in orchestration_command_receipts; dispatch checks their
      // original command type, aggregate and collaboration subject before returning a migrated acknowledgement.
    }),
  );
});
