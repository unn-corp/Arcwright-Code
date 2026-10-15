import type * as RelayDb from "../db.ts";
import { transactionActive } from "../runtimePostgres.ts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

// Two-int advisory locks have a PostgreSQL key space disjoint from the bigint
// user/quota locks. Hash collisions serialize harmlessly; SQL predicates still
// compare the exact environment/key. Sort the actual IDs, including collisions.
export const ENVIRONMENT_LINK_WRITE_LOCK_NAMESPACE = 0x41574c4b;

export class EnvironmentLinkWriteTransactionRequired extends Schema.TaggedError<EnvironmentLinkWriteTransactionRequired>()(
  "EnvironmentLinkWriteTransactionRequired",
  {},
) {}

const encodeTuple = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);
const encodeTuples = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export const acquireEnvironmentLinkWriteLocks = (
  db: RelayDb.RelayDb["Service"],
  environmentId: string,
  publicKeys: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    if (!(yield* transactionActive(db)))
      return yield* new EnvironmentLinkWriteTransactionRequired();
    const tuples = publicKeys.map((key) => encodeTuple([environmentId, key]));
    const locks = yield* db.$client<{ lock_id: number }>`
      SELECT DISTINCT hashtext(tuple) AS lock_id
      FROM jsonb_array_elements_text(${encodeTuples(tuples)}::jsonb) AS tuples(tuple)
      ORDER BY lock_id`;
    for (const { lock_id } of locks) {
      yield* db.$client`SELECT pg_advisory_xact_lock(${ENVIRONMENT_LINK_WRITE_LOCK_NAMESPACE}::integer, ${lock_id}::integer)`;
    }
  });
