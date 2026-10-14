import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as RelayDb from "../db.ts";
import * as Fence from "./AccountDeletionFence.ts";
import * as Deletions from "./AccountDeletions.ts";
import {
  makeVerifiedSubjectPort,
  subjectFromMatchingBinding,
  validateOwnedSubject,
  type ConfiguredAccountAuthority,
  type OwnedSubject,
  type VerifiedDeletionSubject,
  type VerifiedOwnSessionSubject,
} from "./ownedSubject.ts";
import { counts, fixture, setup } from "./accountDeletionTestFixture.ts";

describe("owned account internal verified capability boundary", () => {
  it.effect(
    "bounds exact canonical HTTPS issuer/instance and strict owned subject without echoing input",
    () =>
      Effect.gen(function* () {
        for (const issuer of [
          "http://accounts.fixture.test",
          "https://ACCOUNTS.fixture.test",
          "https://accounts.fixture.test/",
          "https://accounts.fixture.test:443",
          "https://user:secret@accounts.fixture.test",
          "https://accounts.fixture.test?query",
          "https://accounts.fixture.test#fragment",
          "x".repeat(2049),
        ]) {
          const error = yield* Effect.flip(
            makeVerifiedSubjectPort({ issuer, instanceId: "ins_fixture" }),
          );
          expect(error).toMatchObject({
            _tag: "AccountInvalidSubject",
            reason: "invalid_identity",
          });
          expect(JSON.stringify(error)).not.toContain(issuer);
        }
        for (const instanceId of ["", "a".repeat(192), "bad instance", "bad\ninstance"])
          expect(
            yield* Effect.flip(
              makeVerifiedSubjectPort({ issuer: "https://accounts.fixture.test", instanceId }),
            ),
          ).toMatchObject({ _tag: "AccountInvalidSubject" });
        const port = yield* makeVerifiedSubjectPort({
          issuer: "https://accounts.fixture.test:8443",
          instanceId: "ins_fixture",
        });
        for (const userId of [
          "",
          "user_",
          "other_A",
          "user_a_b",
          "user_a-b",
          "user_a\n",
          `user_${"a".repeat(187)}`,
        ])
          expect(yield* Effect.flip(port.fromAlreadyVerifiedSession(userId))).toMatchObject({
            _tag: "AccountInvalidSubject",
          });
        expect(
          (yield* port.fromAlreadyVerifiedSession(`user_${"a".repeat(186)}`)).userId,
        ).toHaveLength(191);
        expect(
          yield* makeVerifiedSubjectPort({
            issuer: "https://[::1]:8443",
            instanceId: "ins_fixture",
          }),
        ).toBeDefined();
      }),
  );

  it.effect("forged plain/prototype subjects and wrong role capabilities fail before any SQL", () =>
    fixture(
      Effect.gen(function* () {
        const { db, port } = yield* setup;
        let sqlCalls = 0;
        const withTransaction: typeof db.$client.withTransaction = (effect) => {
          sqlCalls++;
          return db.$client.withTransaction(effect);
        };
        const client = new Proxy(db.$client, {
          apply(target, receiver, args) {
            sqlCalls++;
            return Reflect.apply(target, receiver, args);
          },
          get(target, property, receiver) {
            return property === "withTransaction"
              ? withTransaction
              : Reflect.get(target, property, receiver);
          },
        });
        const observed = new Proxy(db, {
          get(target, property, receiver) {
            return property === "$client" ? client : Reflect.get(target, property, receiver);
          },
        });
        const fence = yield* Fence.make(port.authority).pipe(
          Effect.provideService(RelayDb.RelayDb, observed),
        );
        const deletions = yield* Deletions.make(port.authority).pipe(
          Effect.provideService(RelayDb.RelayDb, observed),
        );
        const session = yield* port.fromAlreadyVerifiedSession("user_Valid");
        const prototypeOnly: unknown = Object.assign(
          Object.create(Object.getPrototypeOf(session)),
          { issuer: session.issuer, instanceId: session.instanceId, userId: session.userId },
        );
        const raw = {
          issuer: session.issuer,
          instanceId: session.instanceId,
          userId: session.userId,
        };
        for (const forged of [prototypeOnly, raw]) {
          expect(yield* Effect.flip(validateOwnedSubject(forged, port.authority))).toMatchObject({
            _tag: "AccountInvalidSubject",
            reason: "verification_required",
          });
          // Deliberately bypass compile-time capabilities only to test the actual
          // runtime boundary; ordinary callers cannot construct these types.
          expect(yield* Effect.flip(fence.checkAllowed(forged as OwnedSubject))).toMatchObject({
            _tag: "AccountInvalidSubject",
          });
          expect(
            yield* Effect.flip(
              fence.withSubjectWrite(forged as OwnedSubject, Effect.die("unreachable")),
            ),
          ).toMatchObject({ _tag: "AccountInvalidSubject" });
          expect(
            yield* Effect.flip(deletions.acceptManual(forged as VerifiedOwnSessionSubject)),
          ).toMatchObject({ _tag: "AccountInvalidSubject" });
          expect(
            yield* Effect.flip(
              deletions.acceptClerkDeletion({
                verifiedSubject: forged as VerifiedDeletionSubject,
                svixId: "msg_forged",
                eventTimestamp: 1,
              }),
            ),
          ).toMatchObject({ _tag: "AccountInvalidSubject" });
        }
        const authentication = yield* port.fromAlreadyVerifiedAuthentication(session.userId);
        const deletion = yield* port.fromAlreadyVerifiedDeletion(session.userId);
        const bound = yield* subjectFromMatchingBinding(port.authority, session.userId);
        for (const wrongRole of [authentication, deletion, bound])
          expect(
            yield* Effect.flip(
              deletions.acceptManual(wrongRole as unknown as VerifiedOwnSessionSubject),
            ),
          ).toMatchObject({ _tag: "AccountInvalidSubject", reason: "verification_required" });
        expect(
          yield* Effect.flip(
            deletions.acceptClerkDeletion({
              verifiedSubject: session as unknown as VerifiedDeletionSubject,
              svixId: "msg_wrong_role",
              eventTimestamp: 1,
            }),
          ),
        ).toMatchObject({ _tag: "AccountInvalidSubject", reason: "verification_required" });
        const forgedAuthority: unknown = Object.assign(
          Object.create(Object.getPrototypeOf(port.authority)),
          { issuer: session.issuer, instanceId: session.instanceId },
        );
        expect(
          yield* Effect.flip(
            subjectFromMatchingBinding(
              forgedAuthority as ConfiguredAccountAuthority,
              session.userId,
            ),
          ),
        ).toMatchObject({ _tag: "AccountInvalidSubject" });
        expect(sqlCalls).toBe(0);
        expect(yield* counts(db)).toEqual([{ authorities: 0, deletions: 0, events: 0, limits: 0 }]);
      }),
    ),
  );

  it.effect(
    "validates bounded exact delivery IDs and finite numeric event times before SQL, even on the trusted port",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, deletions } = yield* setup;
          const subject = yield* port.fromAlreadyVerifiedDeletion("user_Input");
          for (const svixId of [
            "",
            "x".repeat(256),
            "msg bad",
            "msg/bad",
            "msg\nbad",
            "msg,bad",
            "msg'bad",
          ])
            expect(
              yield* Effect.flip(
                deletions.acceptClerkDeletion({
                  verifiedSubject: subject,
                  svixId,
                  eventTimestamp: 1,
                }),
              ),
            ).toMatchObject({ _tag: "AccountInvalidReceipt", reason: "invalid_receipt" });
          for (const eventTimestamp of [NaN, Infinity, -Infinity])
            expect(
              yield* Effect.flip(
                deletions.acceptClerkDeletion({
                  verifiedSubject: subject,
                  svixId: "msg_input",
                  eventTimestamp,
                }),
              ),
            ).toMatchObject({ _tag: "AccountInvalidReceipt", reason: "invalid_receipt" });
          expect(yield* counts(db)).toEqual([
            { authorities: 0, deletions: 0, events: 0, limits: 0 },
          ]);
          yield* deletions.acceptClerkDeletion({
            verifiedSubject: subject,
            svixId: "x".repeat(255),
            eventTimestamp: Number.MAX_VALUE,
          });
          expect(yield* counts(db)).toEqual([
            { authorities: 1, deletions: 1, events: 1, limits: 0 },
          ]);
        }),
      ),
  );
});
