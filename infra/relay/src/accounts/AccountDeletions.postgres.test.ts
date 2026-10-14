import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as RelayDb from "../db.ts";
import * as Deletions from "./AccountDeletions.ts";
import { makeVerifiedSubjectPort } from "./ownedSubject.ts";
import {
  counts,
  fixture,
  independentSession,
  loseCommitAcknowledgement,
  observeSubjectLock,
  pauseAfterSubjectLock,
  setup,
} from "./accountDeletionTestFixture.ts";

describe("AccountDeletions durable convergent PostgreSQL intake", () => {
  it.effect(
    "manual/no-resource acceptance installs a permanent deny; feeds and reordered events retain the original intent",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, fence, deletions } = yield* setup;
          const session = yield* port.fromAlreadyVerifiedSession("user_NoResources"),
            deleted = yield* port.fromAlreadyVerifiedDeletion(session.userId);
          const accepted = yield* deletions.acceptManual(session);
          const original = yield* db.$client`SELECT * FROM relay_account_deletions`;
          expect(accepted.alreadyAccepted).toBe(false);
          expect(yield* deletions.acceptManual(session)).toEqual({
            ...accepted,
            alreadyAccepted: true,
          });
          const latest = yield* deletions.acceptClerkDeletion({
            verifiedSubject: deleted,
            svixId: "msg_latest",
            eventTimestamp: 9_999,
          });
          const older = yield* deletions.acceptClerkDeletion({
            verifiedSubject: deleted,
            svixId: "msg_older",
            eventTimestamp: -123.25,
          });
          const replay = yield* deletions.acceptClerkDeletion({
            verifiedSubject: deleted,
            svixId: "msg_latest",
            eventTimestamp: 1,
          });
          expect([latest, older, replay]).toEqual(
            Array.from({ length: 3 }, () => ({ ...accepted, alreadyAccepted: true })),
          );
          expect(yield* counts(db)).toEqual([
            { authorities: 1, deletions: 1, events: 2, limits: 0 },
          ]);
          const after = yield* db.$client`SELECT * FROM relay_account_deletions`;
          expect(after[0]).toMatchObject({
            ...original[0],
            source_webhook: true,
            identity_deleted_at: expect.anything(),
          });
          expect(after[0]?.identity_deleted_at).not.toBeNull();
          expect(
            yield* db.$client`SELECT identity_deleted_at >= requested_at AS server_time FROM relay_account_deletions`,
          ).toEqual([{ server_time: true }]);
          expect(
            yield* db.$client`SELECT svix_id, event_timestamp, intent_id FROM relay_account_deletion_events ORDER BY svix_id`,
          ).toEqual([
            { svix_id: "msg_latest", event_timestamp: 9_999, intent_id: accepted.intentId },
            { svix_id: "msg_older", event_timestamp: -123.25, intent_id: accepted.intentId },
          ]);
          expect(yield* Effect.flip(fence.checkAllowed(session))).toMatchObject({
            _tag: "AccountDenied",
          });
        }),
      ),
  );

  it.effect.each(["manual", "feed"] as const)(
    "%s wins manual/feed race on independent sessions with one UUID and both source flags",
    (winner) =>
      fixture(
        Effect.gen(function* () {
          const { db, port, deletions } = yield* setup;
          const subject = yield* port.fromAlreadyVerifiedSession("user_ManualFeed"),
            deleted = yield* port.fromAlreadyVerifiedDeletion(subject.userId);
          const held = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>(),
            entered = yield* Deferred.make<void>();
          const observed = yield* Deletions.make(port.authority).pipe(
            Effect.provideService(RelayDb.RelayDb, pauseAfterSubjectLock(db, held, release)),
          );
          const first = yield* Effect.forkChild(
            winner === "manual"
              ? observed.acceptManual(subject)
              : observed.acceptClerkDeletion({
                  verifiedSubject: deleted,
                  svixId: "msg_race",
                  eventTimestamp: 42,
                }),
          );
          yield* Deferred.await(held);
          const second = yield* Effect.forkChild(
            independentSession(
              Effect.gen(function* () {
                const separate = yield* RelayDb.RelayDb;
                const intake = yield* Deletions.make(port.authority).pipe(
                  Effect.provideService(RelayDb.RelayDb, observeSubjectLock(separate, entered)),
                );
                return yield* winner === "manual"
                  ? intake.acceptClerkDeletion({
                      verifiedSubject: deleted,
                      svixId: "msg_race",
                      eventTimestamp: 42,
                    })
                  : intake.acceptManual(subject);
              }),
            ),
          );
          yield* Deferred.await(entered);
          yield* Deferred.succeed(release, undefined);
          const one = yield* Fiber.join(first),
            two = yield* Fiber.join(second);
          expect(two).toEqual({ intentId: one.intentId, alreadyAccepted: true });
          expect(one.alreadyAccepted).toBe(false);
          expect(yield* counts(db)).toEqual([
            { authorities: 1, deletions: 1, events: 1, limits: 0 },
          ]);
          expect(
            yield* db.$client`SELECT source_manual, source_webhook, identity_deleted_at IS NOT NULL AS identity_gone FROM relay_account_deletions`,
          ).toEqual([{ source_manual: true, source_webhook: true, identity_gone: true }]);
          expect(yield* deletions.acceptManual(subject)).toEqual(two);
        }),
      ),
  );

  it.effect(
    "concurrent identical and distinct delivery IDs converge with immutable dedupe receipt timestamps",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port } = yield* setup;
          const subject = yield* port.fromAlreadyVerifiedDeletion("user_Events");
          const gate = yield* Deferred.make<void>();
          const jobs = yield* Effect.forEach(
            ["msg_same", "msg_same", "msg_other", "msg_third"],
            (svixId, i) =>
              Effect.forkChild(
                independentSession(
                  Effect.gen(function* () {
                    const { deletions } = yield* setup;
                    yield* Deferred.await(gate);
                    return yield* deletions.acceptClerkDeletion({
                      verifiedSubject: subject,
                      svixId,
                      eventTimestamp: i,
                    });
                  }),
                ),
              ),
          );
          yield* Deferred.succeed(gate, undefined);
          const results = yield* Effect.forEach(jobs, Fiber.join);
          expect(new Set(results.map((result) => result.intentId)).size).toBe(1);
          expect(results.filter((result) => !result.alreadyAccepted)).toHaveLength(1);
          expect(yield* counts(db)).toEqual([
            { authorities: 1, deletions: 1, events: 3, limits: 0 },
          ]);
        }),
      ),
  );

  it.effect(
    "a delivery ID reused for another subject rolls back the new deny/binding and never retargets",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, deletions } = yield* setup;
          const first = yield* port.fromAlreadyVerifiedDeletion("user_First"),
            second = yield* port.fromAlreadyVerifiedDeletion("user_Second");
          const gate = yield* Deferred.make<void>();
          const jobs = yield* Effect.forEach([first, second], (subject) =>
            Effect.forkChild(
              independentSession(
                Effect.gen(function* () {
                  const { deletions: intake } = yield* setup;
                  yield* Deferred.await(gate);
                  return yield* Effect.result(
                    intake.acceptClerkDeletion({
                      verifiedSubject: subject,
                      svixId: "msg_collision",
                      eventTimestamp: 1,
                    }),
                  );
                }),
              ),
            ),
          );
          yield* Deferred.succeed(gate, undefined);
          const results = yield* Effect.forEach(jobs, Fiber.join);
          expect(results.filter(Result.isSuccess)).toHaveLength(1);
          expect(results.filter(Result.isFailure).map((result) => result.failure)).toEqual([
            expect.objectContaining({ _tag: "AccountInvalidReceipt", reason: "receipt_conflict" }),
          ]);
          expect(yield* counts(db)).toEqual([
            { authorities: 1, deletions: 1, events: 1, limits: 0 },
          ]);
          const receipt = yield* db.$client<{
            user_id: string;
            intent_id: string;
          }>`SELECT d.user_id, d.intent_id FROM relay_account_deletion_events e JOIN relay_account_deletions d USING(intent_id)`;
          const rejected = receipt[0]?.user_id === first.userId ? second : first;
          expect(
            yield* Effect.flip(
              deletions.acceptClerkDeletion({
                verifiedSubject: rejected,
                svixId: "msg_collision",
                eventTimestamp: 0,
              }),
            ),
          ).toMatchObject({ _tag: "AccountInvalidReceipt", reason: "receipt_conflict" });
          expect(yield* counts(db)).toEqual([
            { authorities: 1, deletions: 1, events: 1, limits: 0 },
          ]);
        }),
      ),
  );

  it.effect("receipt conflict also rolls back source flags on an existing manual intent", () =>
    fixture(
      Effect.gen(function* () {
        const { db, port, deletions } = yield* setup;
        const owner = yield* port.fromAlreadyVerifiedDeletion("user_ReceiptOwner");
        yield* deletions.acceptClerkDeletion({
          verifiedSubject: owner,
          svixId: "msg_owned",
          eventTimestamp: 1,
        });
        const session = yield* port.fromAlreadyVerifiedSession("user_ManualOther");
        const manual = yield* deletions.acceptManual(session);
        const before =
          yield* db.$client`SELECT * FROM relay_account_deletions WHERE intent_id = ${manual.intentId}::uuid`;
        const deleted = yield* port.fromAlreadyVerifiedDeletion(session.userId);
        expect(
          yield* Effect.flip(
            deletions.acceptClerkDeletion({
              verifiedSubject: deleted,
              svixId: "msg_owned",
              eventTimestamp: 1,
            }),
          ),
        ).toMatchObject({ _tag: "AccountInvalidReceipt" });
        expect(
          yield* db.$client`SELECT * FROM relay_account_deletions WHERE intent_id = ${manual.intentId}::uuid`,
        ).toEqual(before);
      }),
    ),
  );

  it.effect(
    "exact instance dedupe does not cross instances; same-instance foreign issuer cannot adopt a receipt",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, deletions } = yield* setup;
          const subject = yield* port.fromAlreadyVerifiedDeletion("user_Authority");
          const original = yield* deletions.acceptClerkDeletion({
            verifiedSubject: subject,
            svixId: "msg_authority",
            eventTimestamp: 1,
          });
          const other = yield* makeVerifiedSubjectPort({
            issuer: "https://other.fixture.test",
            instanceId: "ins_other",
          });
          const intake = yield* Deletions.make(other.authority);
          const otherSubject = yield* other.fromAlreadyVerifiedDeletion(subject.userId);
          const accepted = yield* intake.acceptClerkDeletion({
            verifiedSubject: otherSubject,
            svixId: "msg_authority",
            eventTimestamp: 2,
          });
          expect(accepted.intentId).not.toBe(original.intentId);
          expect(
            yield* db.$client`SELECT status, reason FROM relay_account_deletions WHERE intent_id = ${accepted.intentId}::uuid`,
          ).toEqual([{ status: "blocked_repair", reason: "authority_unverified" }]);
          const wrongIssuer = yield* makeVerifiedSubjectPort({
            issuer: "https://foreign.fixture.test",
            instanceId: subject.instanceId,
          });
          const foreignIntake = yield* Deletions.make(wrongIssuer.authority);
          const foreign = yield* wrongIssuer.fromAlreadyVerifiedDeletion(subject.userId);
          expect(
            yield* Effect.flip(
              foreignIntake.acceptClerkDeletion({
                verifiedSubject: foreign,
                svixId: "msg_authority",
                eventTimestamp: 3,
              }),
            ),
          ).toMatchObject({ _tag: "AccountInvalidReceipt", reason: "receipt_conflict" });
          expect(yield* counts(db)).toEqual([
            { authorities: 1, deletions: 2, events: 2, limits: 0 },
          ]);
          expect(
            yield* Effect.flip(
              deletions.acceptClerkDeletion({
                verifiedSubject: otherSubject,
                svixId: "msg_foreign",
                eventTimestamp: 1,
              }),
            ),
          ).toMatchObject({ _tag: "AccountInvalidSubject", reason: "authority_mismatch" });
        }),
      ),
  );

  it.effect(
    "completion and work timestamps/counters are retained on manual retry and late/reordered feed",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, deletions, fence } = yield* setup;
          const session = yield* port.fromAlreadyVerifiedSession("user_Complete");
          const accepted = yield* deletions.acceptManual(session);
          yield* db.$client`UPDATE relay_account_deletions SET identity_deleted_at = '2026-01-01Z'::timestamptz, revoked_at = '2026-01-02Z'::timestamptz, local_purged_at = '2026-01-03Z'::timestamptz, completed_at = '2026-01-04Z'::timestamptz, status = 'complete', next_attempt_at = '2027-01-01Z'::timestamptz, attempt_count = 7 WHERE intent_id = ${accepted.intentId}::uuid`;
          const before = yield* db.$client`SELECT * FROM relay_account_deletions`;
          const deleted = yield* port.fromAlreadyVerifiedDeletion(session.userId);
          expect(
            yield* deletions.acceptClerkDeletion({
              verifiedSubject: deleted,
              svixId: "msg_late",
              eventTimestamp: 0,
            }),
          ).toEqual({ ...accepted, alreadyAccepted: true });
          yield* deletions.acceptClerkDeletion({
            verifiedSubject: deleted,
            svixId: "msg_earlier",
            eventTimestamp: -1,
          });
          yield* deletions.acceptManual(session);
          expect(yield* db.$client`SELECT * FROM relay_account_deletions`).toEqual(
            before.map((row) => ({ ...row, source_webhook: true })),
          );
          expect(yield* Effect.flip(fence.checkAllowed(session))).toMatchObject({
            _tag: "AccountDenied",
          });
        }),
      ),
  );

  it.effect.each(["insert", "receipt", "commit"] as const)(
    "actual SQL failure at %s rolls back intent/binding/receipt and yields no acceptance",
    (point) =>
      fixture(
        Effect.gen(function* () {
          const { db, port, deletions } = yield* setup;
          const subject = yield* port.fromAlreadyVerifiedDeletion("user_Rollback");
          yield* db.$client`CREATE FUNCTION fixture_reject_intake() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''fixture_rejected'' USING ERRCODE = ''23514''; END;'`;
          if (point === "commit")
            yield* db.$client`CREATE CONSTRAINT TRIGGER fixture_reject_commit AFTER INSERT ON relay_account_deletions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_reject_intake()`;
          else if (point === "insert")
            yield* db.$client`CREATE TRIGGER fixture_reject_insert BEFORE INSERT ON relay_account_deletions FOR EACH ROW EXECUTE FUNCTION fixture_reject_intake()`;
          else
            yield* db.$client`CREATE TRIGGER fixture_reject_receipt BEFORE INSERT ON relay_account_deletion_events FOR EACH ROW EXECUTE FUNCTION fixture_reject_intake()`;
          const error = yield* Effect.flip(
            deletions.acceptClerkDeletion({
              verifiedSubject: subject,
              svixId: "msg_rollback",
              eventTimestamp: 1,
            }),
          );
          expect(error).toMatchObject({ _tag: "AccountPersistenceError", retryable: true });
          expect(JSON.stringify(error)).not.toContain(subject.userId);
          expect(yield* counts(db)).toEqual([
            { authorities: 0, deletions: 0, events: 0, limits: 0 },
          ]);
        }),
      ),
  );

  it.effect(
    "actual committed intent with lost acknowledgement returns retryable failure; verified replay recovers the original UUID",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, deletions } = yield* setup;
          const subject = yield* port.fromAlreadyVerifiedDeletion("user_UnknownCommit");
          const uncertain = yield* Deletions.make(port.authority).pipe(
            Effect.provideService(RelayDb.RelayDb, loseCommitAcknowledgement(db)),
          );
          expect(
            yield* Effect.flip(
              uncertain.acceptClerkDeletion({
                verifiedSubject: subject,
                svixId: "msg_unknown",
                eventTimestamp: 10,
              }),
            ),
          ).toMatchObject({
            _tag: "AccountPersistenceError",
            operation: "transaction",
            retryable: true,
          });
          expect(yield* counts(db)).toEqual([
            { authorities: 1, deletions: 1, events: 1, limits: 0 },
          ]);
          const committed = yield* db.$client<{
            intent_id: string;
          }>`SELECT intent_id FROM relay_account_deletions`;
          const replay = yield* deletions.acceptClerkDeletion({
            verifiedSubject: subject,
            svixId: "msg_unknown",
            eventTimestamp: 11,
          });
          expect(replay).toEqual({ intentId: committed[0]?.intent_id, alreadyAccepted: true });
          expect(yield* counts(db)).toEqual([
            { authorities: 1, deletions: 1, events: 1, limits: 0 },
          ]);
        }),
      ),
  );
});
