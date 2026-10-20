import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RelayDb from "../db.ts";
import { transactionActive } from "../runtimePostgres.ts";
import {
  AccountAuthorityConflict,
  AccountDenied,
  AccountTransactionRequired,
  type AccountFenceError,
} from "./accountErrors.ts";
import {
  bindingMatches,
  bindFreshSubject,
  hasUnboundAccountRows,
  loadBinding,
  loadDeny,
  lockAccountSubject,
  withAccountTransaction,
} from "./accountSubjectSql.ts";
import {
  subjectFromMatchingBinding,
  validateOwnedSubject,
  validateOwnedUserId,
  type BoundOwnedSubject,
  type ConfiguredAccountAuthority,
  type OwnedSubject,
} from "./ownedSubject.ts";

export class AccountDeletionFence extends Context.Service<
  AccountDeletionFence,
  {
    readonly checkAllowed: (subject: OwnedSubject) => Effect.Effect<void, AccountFenceError>;
    /** SQL only. No provider, queue, network or public lifecycle calls may run
     * here. B2/D2 adds lockAndCheckSubject INSIDE its existing short bodies. */
    readonly withSubjectWrite: <A, E, R>(
      subject: OwnedSubject,
      sqlOnlyEffect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | AccountFenceError, R>;
    readonly lockAndCheckSubject: (subject: OwnedSubject) => Effect.Effect<void, AccountFenceError>;
    /** Resolves provenance, not authorization. Each use still checks the deny. */
    readonly resolveBoundSubject: (
      userId: string,
    ) => Effect.Effect<BoundOwnedSubject, AccountFenceError>;
  }
>()("t3code-relay/accounts/AccountDeletionFence") {}

export const make = Effect.fn("AccountDeletionFence.make")(function* (
  authority: ConfiguredAccountAuthority,
) {
  const db = yield* RelayDb.RelayDb;
  const inspectAllowed = Effect.fn("AccountDeletionFence.inspectAllowed")(function* (
    subject: OwnedSubject,
    bind: boolean,
  ) {
    const binding = yield* loadBinding(db, subject.userId);
    if (yield* loadDeny(db, subject)) return yield* new AccountDenied();
    if (binding) {
      if (!bindingMatches(binding, subject))
        return yield* new AccountAuthorityConflict({ reason: "authority_conflict" });
    } else {
      if (yield* hasUnboundAccountRows(db, subject.userId))
        return yield* new AccountAuthorityConflict({ reason: "unbound_rows" });
      if (bind) yield* bindFreshSubject(db, subject);
    }
  });
  const lockAndCheckSubject = Effect.fn("AccountDeletionFence.lockAndCheckSubject")(function* (
    subject: OwnedSubject,
  ) {
    yield* validateOwnedSubject(subject, authority);
    yield* lockAccountSubject(db, subject);
    yield* inspectAllowed(subject, true);
  });
  return AccountDeletionFence.of({
    checkAllowed: Effect.fn("AccountDeletionFence.checkAllowed")(function* (subject) {
      yield* validateOwnedSubject(subject, authority);
      // Auth reads must not inherit an older REPEATABLE READ snapshot.
      // Controlled transaction callers use lockAndCheckSubject instead.
      if (yield* transactionActive(db))
        return yield* new AccountTransactionRequired({ reason: "ambient_transaction" });
      yield* inspectAllowed(subject, false);
    }),
    withSubjectWrite: Effect.fn("AccountDeletionFence.withSubjectWrite")(
      function* (subject, sqlOnlyEffect) {
        yield* validateOwnedSubject(subject, authority);
        return yield* withAccountTransaction(
          db,
          Effect.gen(function* () {
            yield* lockAndCheckSubject(subject);
            return yield* sqlOnlyEffect;
          }),
        );
      },
    ),
    lockAndCheckSubject,
    resolveBoundSubject: Effect.fn("AccountDeletionFence.resolveBoundSubject")(function* (userId) {
      yield* validateOwnedUserId(userId);
      const binding = yield* loadBinding(db, userId);
      if (!binding) return yield* new AccountAuthorityConflict({ reason: "missing_binding" });
      if (binding.issuer !== authority.issuer || binding.instanceId !== authority.instanceId)
        return yield* new AccountAuthorityConflict({ reason: "authority_conflict" });
      return yield* subjectFromMatchingBinding(authority, userId);
    }),
  });
});
export const layer = (authority: ConfiguredAccountAuthority) =>
  Layer.effect(AccountDeletionFence, make(authority));
