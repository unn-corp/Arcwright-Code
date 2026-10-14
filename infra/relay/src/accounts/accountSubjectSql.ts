import { and, eq } from "drizzle-orm";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { SqlError } from "effect/sql/SqlError";
import type * as RelayDb from "../db.ts";
import { relayAccountAuthorities, relayAccountDeletions } from "../persistence/schema.ts";
import { AccountPersistenceError, AccountTransactionRequired } from "./accountErrors.ts";
import type { OwnedSubject } from "./ownedSubject.ts";

const isSqlError = Schema.is(SqlError);
const isDrizzleQueryError = Schema.is(EffectDrizzleQueryError);

export const persistAccount = <A, E, R>(
  operation: AccountPersistenceError["operation"],
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.mapError(() => new AccountPersistenceError({ operation, retryable: true })),
    Effect.catchDefect(() =>
      Effect.fail(new AccountPersistenceError({ operation, retryable: true })),
    ),
  );
/** Own COMMIT, never a savepoint. SQL/commit/defect failures are retryable;
 * ordinary typed business errors retain their original type and value. */
export const withAccountTransaction = <A, E, R>(
  db: RelayDb.RelayDb["Service"],
  sqlOnly: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(db.$client.transactionService)))
      return yield* new AccountTransactionRequired({ reason: "ambient_transaction" });
    return yield* db.$client
      .withTransaction(
        Effect.gen(function* () {
          yield* persistAccount(
            "transaction",
            db.$client`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`,
          );
          return yield* sqlOnly;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isSqlError(error) || isDrizzleQueryError(error)
            ? new AccountPersistenceError({ operation: "transaction", retryable: true })
            : error,
        ),
        Effect.catchDefect(() =>
          Effect.fail(new AccountPersistenceError({ operation: "transaction", retryable: true })),
        ),
      );
  });
export const lockAccountSubject = (db: RelayDb.RelayDb["Service"], subject: OwnedSubject) =>
  Effect.gen(function* () {
    if (Option.isNone(yield* Effect.serviceOption(db.$client.transactionService)))
      return yield* new AccountTransactionRequired({ reason: "transaction_required" });
    const isolation = yield* persistAccount(
      "transaction",
      db.$client<{ transaction_isolation: string }>`SHOW transaction_isolation`,
    );
    if (isolation[0]?.transaction_isolation !== "read committed")
      return yield* new AccountTransactionRequired({ reason: "read_committed_required" });
    // This separate statement precedes all binding/deny reads. Waiters then get
    // fresh READ COMMITTED snapshots, sharing the quota/lifecycle subject lock.
    yield* persistAccount(
      "lock",
      db.$client`SELECT pg_advisory_xact_lock(hashtextextended(${`relay-managed-tunnel:${subject.userId}`}, 0))`,
    );
  });
export const loadBinding = (db: RelayDb.RelayDb["Service"], userId: string) =>
  persistAccount(
    "authority",
    db
      .select()
      .from(relayAccountAuthorities)
      .where(eq(relayAccountAuthorities.userId, userId))
      .limit(1),
  ).pipe(Effect.map((rows) => rows[0]));
export const loadDeny = (db: RelayDb.RelayDb["Service"], subject: OwnedSubject) =>
  persistAccount(
    "deny",
    db
      .select()
      .from(relayAccountDeletions)
      .where(
        and(
          eq(relayAccountDeletions.issuer, subject.issuer),
          eq(relayAccountDeletions.instanceId, subject.instanceId),
          eq(relayAccountDeletions.userId, subject.userId),
        ),
      )
      .limit(1),
  ).pipe(Effect.map((rows) => rows[0]));
/** No migration or current configuration can attribute preexisting old rows.
 * All seven subject-only account row classes participate, including revoked,
 * orphaned, incomplete and otherwise inactive rows. */
export const hasUnboundAccountRows = (db: RelayDb.RelayDb["Service"], userId: string) =>
  persistAccount(
    "authority",
    db.$client<{ present: boolean }>`SELECT (
    EXISTS(SELECT 1 FROM relay_environment_links WHERE user_id = ${userId}) OR
    EXISTS(SELECT 1 FROM relay_managed_endpoint_allocations WHERE user_id = ${userId}) OR
    EXISTS(SELECT 1 FROM relay_managed_tunnel_limits WHERE user_id = ${userId}) OR
    EXISTS(SELECT 1 FROM relay_mobile_devices WHERE user_id = ${userId}) OR
    EXISTS(SELECT 1 FROM relay_live_activities WHERE user_id = ${userId}) OR
    EXISTS(SELECT 1 FROM relay_web_push_subscriptions WHERE user_id = ${userId}) OR
    EXISTS(SELECT 1 FROM relay_delivery_attempts WHERE user_id = ${userId})
  ) AS present`,
  ).pipe(Effect.map((rows) => rows[0]?.present !== false));
export const bindingMatches = (
  binding: typeof relayAccountAuthorities.$inferSelect,
  subject: OwnedSubject,
) => binding.issuer === subject.issuer && binding.instanceId === subject.instanceId;
export const bindFreshSubject = (db: RelayDb.RelayDb["Service"], subject: OwnedSubject) =>
  persistAccount(
    "authority",
    db
      .insert(relayAccountAuthorities)
      .values({ issuer: subject.issuer, instanceId: subject.instanceId, userId: subject.userId }),
  );
