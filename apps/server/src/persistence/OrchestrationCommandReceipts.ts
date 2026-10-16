import { CommandId, IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  toPersistenceSqlError,
  type OrchestrationCommandReceiptRepositoryError,
} from "./Errors.ts";

export const OrchestrationCommandReceipt = Schema.Struct({
  commandId: CommandId,
  aggregateKind: Schema.Literals(["project", "thread"]),
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  commandType: Schema.String,
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  status: Schema.Literals(["accepted", "rejected"]),
  error: Schema.NullOr(Schema.String),
});
export type OrchestrationCommandReceipt = typeof OrchestrationCommandReceipt.Type;

export const GetByCommandIdInput = Schema.Struct({
  commandId: CommandId,
});
export type GetByCommandIdInput = typeof GetByCommandIdInput.Type;

export class OrchestrationCommandReceiptRepository extends Context.Service<
  OrchestrationCommandReceiptRepository,
  {
    readonly insertIfAbsent: (
      receipt: OrchestrationCommandReceipt,
    ) => Effect.Effect<boolean, OrchestrationCommandReceiptRepositoryError>;

    readonly upsert: (
      receipt: OrchestrationCommandReceipt,
    ) => Effect.Effect<void, OrchestrationCommandReceiptRepositoryError>;

    readonly getByCommandId: (
      input: GetByCommandIdInput,
    ) => Effect.Effect<
      Option.Option<OrchestrationCommandReceipt>,
      OrchestrationCommandReceiptRepositoryError
    >;
  }
>()("t3/persistence/OrchestrationCommandReceipts/OrchestrationCommandReceiptRepository") {}

const makeOrchestrationCommandReceiptRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertReceiptRow = SqlSchema.void({
    Request: OrchestrationCommandReceipt,
    execute: (receipt) =>
      sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          command_type,
          accepted_at,
          result_sequence,
          status,
          error
        )
        SELECT
          ${receipt.commandId},
          ${receipt.aggregateKind},
          ${receipt.aggregateId},
          ${receipt.commandType},
          ${receipt.acceptedAt},
          ${receipt.resultSequence},
          ${receipt.status},
          ${receipt.error}
        WHERE NOT EXISTS (SELECT 1 FROM arcwright_history_rows
          WHERE source='orchestration_command_receipts' AND row_key=${receipt.commandId})
        ON CONFLICT (command_id)
        DO UPDATE SET
          aggregate_kind = excluded.aggregate_kind,
            aggregate_id = excluded.aggregate_id,
            command_type = excluded.command_type,
          accepted_at = excluded.accepted_at,
          result_sequence = excluded.result_sequence,
          status = excluded.status,
          error = excluded.error
      `,
  });

  const findReceiptByCommandId = SqlSchema.findOneOption({
    Request: GetByCommandIdInput,
    Result: OrchestrationCommandReceipt,
    execute: ({ commandId }) =>
      sql`
        SELECT
          command_id AS "commandId",
          aggregate_kind AS "aggregateKind",
          aggregate_id AS "aggregateId",
          command_type AS "commandType",
          accepted_at AS "acceptedAt",
          result_sequence AS "resultSequence",
          status,
          error
        FROM orchestration_command_receipts
        WHERE command_id = ${commandId}
        UNION ALL
        SELECT
          json_extract(body, '$.command_id') AS "commandId",
          json_extract(body, '$.aggregate_kind') AS "aggregateKind",
          json_extract(body, '$.aggregate_id') AS "aggregateId",
          json_extract(body, '$.command_type') AS "commandType",
          json_extract(body, '$.accepted_at') AS "acceptedAt",
          json_extract(body, '$.result_sequence') AS "resultSequence",
          json_extract(body, '$.status') AS status,
          json_extract(body, '$.error') AS error
        FROM (SELECT arcwright_history_json(digest,raw_bytes,compressed) AS body
          FROM arcwright_history_rows WHERE source='orchestration_command_receipts' AND row_key=${commandId})
        LIMIT 1
      `,
  });

  const upsert: OrchestrationCommandReceiptRepository["Service"]["upsert"] = (receipt) =>
    upsertReceiptRow(receipt).pipe(
      Effect.mapError(toPersistenceSqlError("OrchestrationCommandReceiptRepository.upsert:query")),
    );

  const insertIfAbsent: OrchestrationCommandReceiptRepository["Service"]["insertIfAbsent"] = (
    receipt,
  ) =>
    sql<{ readonly command_id: string }>`
      INSERT INTO orchestration_command_receipts (
        command_id,
        aggregate_kind,
        aggregate_id,
        command_type,
        accepted_at,
        result_sequence,
        status,
        error
      )
      SELECT
        ${receipt.commandId},
        ${receipt.aggregateKind},
        ${receipt.aggregateId},
        ${receipt.commandType},
        ${receipt.acceptedAt},
        ${receipt.resultSequence},
        ${receipt.status},
        ${receipt.error}
      WHERE NOT EXISTS (SELECT 1 FROM arcwright_history_rows
        WHERE source='orchestration_command_receipts' AND row_key=${receipt.commandId})
      ON CONFLICT(command_id) DO NOTHING
      RETURNING command_id
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.insertIfAbsent:query"),
      ),
    );

  const getByCommandId: OrchestrationCommandReceiptRepository["Service"]["getByCommandId"] = (
    input,
  ) =>
    findReceiptByCommandId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.getByCommandId:query"),
      ),
    );

  return {
    insertIfAbsent,
    upsert,
    getByCommandId,
  } satisfies OrchestrationCommandReceiptRepository["Service"];
});

export const layer = Layer.effect(
  OrchestrationCommandReceiptRepository,
  makeOrchestrationCommandReceiptRepository,
);
