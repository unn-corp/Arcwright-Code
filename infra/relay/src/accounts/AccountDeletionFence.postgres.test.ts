import { describe, expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as RelayDb from "../db.ts";
import * as Fence from "./AccountDeletionFence.ts";
import * as Deletions from "./AccountDeletions.ts";
import { makeVerifiedSubjectPort } from "./ownedSubject.ts";
import {
  counts,
  fixture,
  independentSession,
  observeSubjectLock,
  pauseAfterSubjectLock,
  oldRowClasses,
  seedOldRow,
  setup,
  writeLimit,
} from "./accountDeletionTestFixture.ts";

describe("AccountDeletionFence owned PostgreSQL authority and writes", () => {
  it.effect(
    "top-level allow check rejects an older ambient REPEATABLE READ snapshot after independent committed intake",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, fence } = yield* setup;
          const subject = yield* port.fromAlreadyVerifiedSession("user_OldSnapshot");
          yield* fence.checkAllowed(subject);
          yield* db.$client.withTransaction(
            Effect.gen(function* () {
              yield* db.$client`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
              expect(
                yield* db.$client`SELECT count(*)::integer AS visible FROM relay_account_deletions`,
              ).toEqual([{ visible: 0 }]);
              yield* independentSession(
                Effect.gen(function* () {
                  const { deletions } = yield* setup;
                  yield* deletions.acceptManual(subject);
                }),
              );
              // The real inherited snapshot remains old even after the other COMMIT.
              expect(
                yield* db.$client`SELECT count(*)::integer AS visible FROM relay_account_deletions`,
              ).toEqual([{ visible: 0 }]);
              expect(yield* Effect.flip(fence.checkAllowed(subject))).toMatchObject({
                _tag: "AccountTransactionRequired",
                reason: "ambient_transaction",
              });
            }),
          );
          expect(yield* Effect.flip(fence.checkAllowed(subject))).toMatchObject({
            _tag: "AccountDenied",
          });
        }),
      ),
  );
  it.effect(
    "read-only allows fresh verified signup without an allowlist; first SQL write binds automatically",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, fence } = yield* setup;
          const subject = yield* port.fromAlreadyVerifiedAuthentication("user_Fresh");
          yield* fence.checkAllowed(subject);
          expect(yield* counts(db)).toEqual([
            { authorities: 0, deletions: 0, events: 0, limits: 0 },
          ]);
          const written = yield* fence.withSubjectWrite(
            subject,
            Effect.gen(function* () {
              expect(
                Option.isSome(yield* Effect.serviceOption(db.$client.transactionService)),
              ).toBe(true);
              yield* writeLimit(db, subject.userId);
              return "written";
            }),
          );
          expect(written).toBe("written");
          expect(yield* fence.resolveBoundSubject(subject.userId)).toMatchObject({
            issuer: subject.issuer,
            instanceId: subject.instanceId,
            userId: subject.userId,
          });
          expect(yield* counts(db)).toEqual([
            { authorities: 1, deletions: 0, events: 0, limits: 1 },
          ]);
          // External dispatch belongs after the known COMMIT, outside the wrapper.
          const provider = Effect.gen(function* () {
            expect(Option.isNone(yield* Effect.serviceOption(db.$client.transactionService))).toBe(
              true,
            );
          });
          yield* provider;
        }),
      ),
  );

  it.effect.each(oldRowClasses)("refuses automatic attribution of preexisting %s", (kind) =>
    fixture(
      Effect.gen(function* () {
        const { db, port, fence, deletions } = yield* setup;
        const userId = `user_Old${kind.replaceAll("_", "")}`;
        const subject = yield* port.fromAlreadyVerifiedSession(userId);
        yield* seedOldRow(db, kind, userId);
        expect(
          yield* Effect.flip(fence.withSubjectWrite(subject, Effect.die("effect_must_not_run"))),
        ).toMatchObject({ _tag: "AccountAuthorityConflict", reason: "unbound_rows" });
        expect(yield* Effect.flip(fence.resolveBoundSubject(userId))).toMatchObject({
          _tag: "AccountAuthorityConflict",
          reason: "missing_binding",
        });
        const acceptance = yield* deletions.acceptManual(subject);
        expect(
          yield* db.$client`SELECT status, reason FROM relay_account_deletions WHERE intent_id = ${acceptance.intentId}::uuid`,
        ).toEqual([{ status: "blocked_repair", reason: "authority_unverified" }]);
        expect(yield* db.$client`SELECT user_id FROM relay_account_authorities`).toEqual([]);
        expect(yield* Effect.flip(fence.checkAllowed(subject))).toMatchObject({
          _tag: "AccountDenied",
        });
        // No D1 intake purges or changes any old row.
        expect(
          yield* db.$client`SELECT user_id FROM ${db.$client(kind === "links" ? "relay_environment_links" : kind === "allocations" ? "relay_managed_endpoint_allocations" : kind === "limits" ? "relay_managed_tunnel_limits" : kind === "devices" ? "relay_mobile_devices" : kind === "live_activities" ? "relay_live_activities" : kind === "subscriptions" ? "relay_web_push_subscriptions" : "relay_delivery_attempts")}`,
        ).toEqual([{ user_id: userId }]);
      }),
    ),
  );

  it.effect(
    "a different configured authority cannot relabel the subject; intake retains a blocked exact deny",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, fence } = yield* setup;
          const subject = yield* port.fromAlreadyVerifiedSession("user_Collision");
          yield* fence.withSubjectWrite(subject, writeLimit(db, subject.userId));
          const foreignPort = yield* makeVerifiedSubjectPort({
            issuer: "https://foreign.fixture.test",
            instanceId: "ins_other",
          });
          const foreignFence = yield* Fence.make(foreignPort.authority);
          const foreignDeletion = yield* Deletions.make(foreignPort.authority);
          const foreign = yield* foreignPort.fromAlreadyVerifiedSession(subject.userId);
          expect(yield* Effect.flip(foreignFence.checkAllowed(foreign))).toMatchObject({
            _tag: "AccountAuthorityConflict",
          });
          expect(
            yield* Effect.flip(foreignFence.withSubjectWrite(foreign, Effect.void)),
          ).toMatchObject({ _tag: "AccountAuthorityConflict" });
          const accepted = yield* foreignDeletion.acceptManual(foreign);
          expect(
            yield* db.$client`SELECT issuer, instance_id FROM relay_account_authorities`,
          ).toEqual([{ issuer: subject.issuer, instance_id: subject.instanceId }]);
          expect(
            yield* db.$client`SELECT status, reason FROM relay_account_deletions WHERE intent_id = ${accepted.intentId}::uuid`,
          ).toEqual([{ status: "blocked_repair", reason: "authority_unverified" }]);
          yield* fence.checkAllowed(subject);
          expect(yield* Effect.flip(foreignFence.checkAllowed(foreign))).toMatchObject({
            _tag: "AccountDenied",
          });
        }),
      ),
  );

  it.effect(
    "uncached allow checks and a stale allow never authorize a write after permanent deny, including complete",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, fence, deletions } = yield* setup;
          const subject = yield* port.fromAlreadyVerifiedSession("user_Denied");
          yield* fence.checkAllowed(subject);
          const accepted = yield* deletions.acceptManual(subject);
          expect(yield* Effect.flip(fence.checkAllowed(subject))).toMatchObject({
            _tag: "AccountDenied",
          });
          expect(
            yield* Effect.flip(fence.withSubjectWrite(subject, writeLimit(db, subject.userId))),
          ).toMatchObject({ _tag: "AccountDenied" });
          yield* db.$client`UPDATE relay_account_deletions SET identity_deleted_at = CURRENT_TIMESTAMP, revoked_at = CURRENT_TIMESTAMP, local_purged_at = CURRENT_TIMESTAMP, status = 'complete', completed_at = CURRENT_TIMESTAMP WHERE intent_id = ${accepted.intentId}::uuid`;
          expect(
            yield* Effect.flip(fence.withSubjectWrite(subject, writeLimit(db, subject.userId))),
          ).toMatchObject({ _tag: "AccountDenied" });
          expect(yield* counts(db)).toEqual([
            { authorities: 1, deletions: 1, events: 0, limits: 0 },
          ]);
        }),
      ),
  );

  it.effect(
    "requires actual transaction context, rejects ambient top-level writes and non-READ-COMMITTED helpers",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, fence, deletions } = yield* setup;
          const subject = yield* port.fromAlreadyVerifiedSession("user_Transaction");
          expect(yield* Effect.flip(fence.lockAndCheckSubject(subject))).toMatchObject({
            _tag: "AccountTransactionRequired",
            reason: "transaction_required",
          });
          yield* db.$client.withTransaction(
            Effect.gen(function* () {
              expect(
                yield* Effect.flip(fence.withSubjectWrite(subject, writeLimit(db, subject.userId))),
              ).toMatchObject({
                _tag: "AccountTransactionRequired",
                reason: "ambient_transaction",
              });
              expect(yield* Effect.flip(deletions.acceptManual(subject))).toMatchObject({
                _tag: "AccountTransactionRequired",
                reason: "ambient_transaction",
              });
            }),
          );
          yield* db.$client.withTransaction(
            Effect.gen(function* () {
              yield* db.$client`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
              expect(yield* Effect.flip(fence.lockAndCheckSubject(subject))).toMatchObject({
                _tag: "AccountTransactionRequired",
                reason: "read_committed_required",
              });
            }),
          );
          yield* db.$client.withTransaction(
            Effect.gen(function* () {
              yield* db.$client`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`;
              yield* fence.lockAndCheckSubject(subject);
              yield* writeLimit(db, subject.userId);
            }),
          );
          expect(yield* counts(db)).toEqual([
            { authorities: 1, deletions: 0, events: 0, limits: 1 },
          ]);
        }),
      ),
  );

  it.effect(
    "preserves typed business failure and rolls back binding/write; SQL and defects are bounded retryable failures",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, fence } = yield* setup;
          const subject = yield* port.fromAlreadyVerifiedSession("user_Failure");
          class BusinessDenied extends Data.TaggedError("BusinessDenied") {}
          const business = new BusinessDenied();
          expect(
            yield* Effect.flip(
              fence.withSubjectWrite(
                subject,
                writeLimit(db, subject.userId).pipe(Effect.andThen(Effect.fail(business))),
              ),
            ),
          ).toBe(business);
          for (const operation of [
            db.$client`INSERT INTO relay_managed_tunnel_limits(user_id, max_tunnels, created_at, updated_at) VALUES (${subject.userId}, NULL, 'created', 'updated')`,
            Effect.die(new Error("private_fixture_defect")),
          ]) {
            const error = yield* Effect.flip(fence.withSubjectWrite(subject, operation));
            expect(error).toMatchObject({ _tag: "AccountPersistenceError", retryable: true });
            expect(JSON.stringify(error)).not.toContain(subject.userId);
            expect(JSON.stringify(error)).not.toContain("private_fixture_defect");
          }
          expect(yield* counts(db)).toEqual([
            { authorities: 0, deletions: 0, events: 0, limits: 0 },
          ]);
          yield* db.$client`ALTER TABLE relay_account_deletions RENAME TO unavailable_account_deletions`;
          expect(yield* Effect.flip(fence.checkAllowed(subject))).toMatchObject({
            _tag: "AccountPersistenceError",
            operation: "deny",
          });
        }),
      ),
  );

  it.effect(
    "write wins common subject lock before intake on independent sessions; SQL commits before deny",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, fence } = yield* setup;
          const subject = yield* port.fromAlreadyVerifiedSession("user_WriteFirst");
          const holding = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const entered = yield* Deferred.make<void>();
          const writer = yield* Effect.forkChild(
            fence.withSubjectWrite(
              subject,
              Effect.gen(function* () {
                yield* writeLimit(db, subject.userId);
                yield* Deferred.succeed(holding, undefined);
                yield* Deferred.await(release);
              }),
            ),
          );
          yield* Deferred.await(holding);
          const deletion = yield* Effect.forkChild(
            independentSession(
              Effect.gen(function* () {
                const other = yield* RelayDb.RelayDb;
                const service = yield* Deletions.make(port.authority).pipe(
                  Effect.provideService(RelayDb.RelayDb, observeSubjectLock(other, entered)),
                );
                return yield* service.acceptManual(subject);
              }),
            ),
          );
          yield* Deferred.await(entered);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(writer);
          yield* Fiber.join(deletion);
          expect(yield* counts(db)).toEqual([
            { authorities: 1, deletions: 1, events: 0, limits: 1 },
          ]);
          expect(yield* Effect.flip(fence.withSubjectWrite(subject, Effect.void))).toMatchObject({
            _tag: "AccountDenied",
          });
        }),
      ),
  );

  it.effect(
    "intake wins the common lock before a waiting write; fresh post-wait deny blocks it",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, fence } = yield* setup;
          const subject = yield* port.fromAlreadyVerifiedSession("user_DeleteFirst");
          const entered = yield* Deferred.make<void>();
          const waiting = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const intake = yield* Deletions.make(port.authority).pipe(
            Effect.provideService(RelayDb.RelayDb, pauseAfterSubjectLock(db, entered, release)),
          );
          const holder = yield* Effect.forkChild(intake.acceptManual(subject));
          yield* Deferred.await(entered);
          const writer = yield* Effect.forkChild(
            independentSession(
              Effect.gen(function* () {
                const other = yield* RelayDb.RelayDb;
                const service = yield* Fence.make(port.authority).pipe(
                  Effect.provideService(RelayDb.RelayDb, observeSubjectLock(other, waiting)),
                );
                return yield* Effect.flip(
                  service.withSubjectWrite(subject, writeLimit(other, subject.userId)),
                );
              }),
            ),
          );
          yield* Deferred.await(waiting);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(holder);
          expect(yield* Fiber.join(writer)).toMatchObject({ _tag: "AccountDenied" });
          expect(yield* counts(db)).toEqual([
            { authorities: 1, deletions: 1, events: 0, limits: 0 },
          ]);
          expect(yield* Effect.flip(fence.checkAllowed(subject))).toMatchObject({
            _tag: "AccountDenied",
          });
        }),
      ),
  );

  it.effect("common-lock SQL failure fails closed for both fence and intake", () =>
    fixture(
      Effect.gen(function* () {
        const { db, port, fence } = yield* setup;
        const subject = yield* port.fromAlreadyVerifiedSession("user_Locked");
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const writer = yield* Effect.forkChild(
          fence.withSubjectWrite(
            subject,
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(held);
        yield* independentSession(
          Effect.gen(function* () {
            const other = yield* setup;
            expect(
              yield* Effect.flip(
                other.fence.withSubjectWrite(subject, writeLimit(other.db, subject.userId)),
              ),
            ).toMatchObject({ _tag: "AccountPersistenceError", operation: "lock" });
            expect(yield* Effect.flip(other.deletions.acceptManual(subject))).toMatchObject({
              _tag: "AccountPersistenceError",
              operation: "lock",
            });
          }),
          "1ms",
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(writer);
        expect(yield* counts(db)).toEqual([{ authorities: 1, deletions: 0, events: 0, limits: 0 }]);
      }),
    ),
  );

  it.effect.each(["first", "second"] as const)(
    "serializes fresh cross-authority collision with %s authority winning",
    (winner) =>
      fixture(
        Effect.gen(function* () {
          const { db, port } = yield* setup;
          const second = yield* makeVerifiedSubjectPort({
            issuer: "https://other.fixture.test",
            instanceId: "ins_other",
          });
          const winning = winner === "first" ? port : second,
            losing = winner === "first" ? second : port;
          const subject = yield* winning.fromAlreadyVerifiedAuthentication("user_FreshCollision");
          const otherSubject = yield* losing.fromAlreadyVerifiedAuthentication(subject.userId);
          const held = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>(),
            entered = yield* Deferred.make<void>();
          const service = yield* Fence.make(winning.authority);
          const writer = yield* Effect.forkChild(
            service.withSubjectWrite(
              subject,
              writeLimit(db, subject.userId).pipe(
                Effect.andThen(Deferred.succeed(held, undefined)),
                Effect.andThen(Deferred.await(release)),
              ),
            ),
          );
          yield* Deferred.await(held);
          const other = yield* Effect.forkChild(
            independentSession(
              Effect.gen(function* () {
                const separate = yield* RelayDb.RelayDb;
                const losingService = yield* Fence.make(losing.authority).pipe(
                  Effect.provideService(RelayDb.RelayDb, observeSubjectLock(separate, entered)),
                );
                return yield* Effect.flip(
                  losingService.withSubjectWrite(otherSubject, Effect.void),
                );
              }),
            ),
          );
          yield* Deferred.await(entered);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(writer);
          expect(yield* Fiber.join(other)).toMatchObject({
            _tag: "AccountAuthorityConflict",
            reason: "authority_conflict",
          });
          expect(
            yield* db.$client`SELECT issuer, instance_id FROM relay_account_authorities`,
          ).toEqual([{ issuer: subject.issuer, instance_id: subject.instanceId }]);
          expect(yield* counts(db)).toEqual([
            { authorities: 1, deletions: 0, events: 0, limits: 1 },
          ]);
        }),
      ),
  );
});
