import { and, eq, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RelayDb from "../db.ts";
import { relayAccountDeletionEvents, relayAccountDeletions } from "../persistence/schema.ts";
import { AccountInvalidReceipt, type AccountFenceError } from "./accountErrors.ts";
import {
  bindingMatches,
  bindFreshSubject,
  hasUnboundAccountRows,
  loadBinding,
  loadDeny,
  lockAccountSubject,
  persistAccount,
  withAccountTransaction,
} from "./accountSubjectSql.ts";
import {
  validateOwnedSubject,
  type ConfiguredAccountAuthority,
  type VerifiedDeletionSubject,
  type VerifiedOwnSessionSubject,
} from "./ownedSubject.ts";

export interface DeletionAcceptance {
  readonly intentId: string;
  readonly alreadyAccepted: boolean;
}
export class AccountDeletions extends Context.Service<
  AccountDeletions,
  {
    readonly acceptManual: (
      subject: VerifiedOwnSessionSubject,
    ) => Effect.Effect<DeletionAcceptance, AccountFenceError | AccountInvalidReceipt>;
    readonly acceptClerkDeletion: (input: {
      readonly verifiedSubject: VerifiedDeletionSubject;
      readonly svixId: string;
      readonly eventTimestamp: number;
    }) => Effect.Effect<DeletionAcceptance, AccountFenceError | AccountInvalidReceipt>;
  }
>()("t3code-relay/accounts/AccountDeletions") {}

export const make = Effect.fn("AccountDeletions.make")(function* (
  authority: ConfiguredAccountAuthority,
) {
  const db = yield* RelayDb.RelayDb;
  type Intake =
    | { readonly kind: "manual"; readonly subject: VerifiedOwnSessionSubject }
    | {
        readonly kind: "webhook";
        readonly subject: VerifiedDeletionSubject;
        readonly svixId: string;
        readonly eventTimestamp: number;
      };
  const receiptFor = (instanceId: string, svixId: string) =>
    persistAccount(
      "receipt",
      db
        .select({
          intentId: relayAccountDeletions.intentId,
          issuer: relayAccountDeletions.issuer,
          instanceId: relayAccountDeletions.instanceId,
          userId: relayAccountDeletions.userId,
        })
        .from(relayAccountDeletionEvents)
        .innerJoin(
          relayAccountDeletions,
          eq(relayAccountDeletionEvents.intentId, relayAccountDeletions.intentId),
        )
        .where(
          and(
            eq(relayAccountDeletionEvents.instanceId, instanceId),
            eq(relayAccountDeletionEvents.svixId, svixId),
          ),
        )
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]));
  const accept = Effect.fn("AccountDeletions.accept")(function* (input: Intake) {
    const subject = input.subject;
    yield* validateOwnedSubject(
      subject,
      authority,
      input.kind === "manual" ? "session" : "deletion",
    );
    if (
      input.kind === "webhook" &&
      (typeof input.svixId !== "string" ||
        input.svixId.length > 255 ||
        !/^[A-Za-z0-9._:-]+$/.test(input.svixId) ||
        typeof input.eventTimestamp !== "number" ||
        !Number.isFinite(input.eventTimestamp))
    )
      return yield* new AccountInvalidReceipt({ reason: "invalid_receipt" });
    return yield* withAccountTransaction(
      db,
      Effect.gen(function* () {
        yield* lockAccountSubject(db, subject);
        const binding = yield* loadBinding(db, subject.userId);
        const previous = yield* loadDeny(db, subject);
        if (input.kind === "webhook") {
          const receipt = yield* receiptFor(subject.instanceId, input.svixId);
          if (receipt) {
            if (
              receipt.issuer !== subject.issuer ||
              receipt.instanceId !== subject.instanceId ||
              receipt.userId !== subject.userId ||
              receipt.intentId !== previous?.intentId
            )
              return yield* new AccountInvalidReceipt({ reason: "receipt_conflict" });
            return { intentId: receipt.intentId, alreadyAccepted: true };
          }
        }
        if (!previous) {
          const unverified = binding
            ? !bindingMatches(binding, subject)
            : yield* hasUnboundAccountRows(db, subject.userId);
          if (!binding && !unverified) yield* bindFreshSubject(db, subject);
          yield* persistAccount(
            "intake",
            db.insert(relayAccountDeletions).values({
              issuer: subject.issuer,
              instanceId: subject.instanceId,
              userId: subject.userId,
              sourceManual: input.kind === "manual",
              sourceWebhook: input.kind === "webhook",
              ...(input.kind === "webhook" ? { identityDeletedAt: sql`CURRENT_TIMESTAMP` } : {}),
              status: unverified ? "blocked_repair" : "pending",
              reason: unverified ? "authority_unverified" : null,
            }),
          );
        } else {
          // Preserve UUID, request time, completion, scheduling and all work. The
          // signed event time is audit metadata, never an ordering/cutoff rule.
          yield* persistAccount(
            "intake",
            db
              .update(relayAccountDeletions)
              .set(
                input.kind === "manual"
                  ? { sourceManual: true }
                  : {
                      sourceWebhook: true,
                      identityDeletedAt: sql`COALESCE(${relayAccountDeletions.identityDeletedAt}, CURRENT_TIMESTAMP)`,
                    },
              )
              .where(eq(relayAccountDeletions.intentId, previous.intentId)),
          );
        }
        const accepted = yield* loadDeny(db, subject);
        if (!accepted) return yield* new AccountInvalidReceipt({ reason: "receipt_conflict" });
        if (input.kind === "webhook") {
          const inserted = yield* persistAccount(
            "receipt",
            db
              .insert(relayAccountDeletionEvents)
              .values({
                instanceId: subject.instanceId,
                svixId: input.svixId,
                intentId: accepted.intentId,
                eventTimestamp: input.eventTimestamp,
              })
              .onConflictDoNothing()
              .returning({ intentId: relayAccountDeletionEvents.intentId }),
          );
          if (inserted.length === 0) {
            // A different subject can race on the same delivery ID without our
            // subject lock. Compare the committed receipt after the unique wait;
            // conflict rolls back this entire intent/binding/flags transaction.
            const receipt = yield* receiptFor(subject.instanceId, input.svixId);
            if (
              !receipt ||
              receipt.intentId !== accepted.intentId ||
              receipt.issuer !== subject.issuer ||
              receipt.instanceId !== subject.instanceId ||
              receipt.userId !== subject.userId
            )
              return yield* new AccountInvalidReceipt({ reason: "receipt_conflict" });
          }
        }
        return { intentId: accepted.intentId, alreadyAccepted: previous !== undefined };
      }),
    );
  });
  return AccountDeletions.of({
    acceptManual: Effect.fn("AccountDeletions.acceptManual")((subject) =>
      accept({ kind: "manual", subject }),
    ),
    acceptClerkDeletion: Effect.fn("AccountDeletions.acceptClerkDeletion")(
      ({ verifiedSubject: subject, svixId, eventTimestamp }) =>
        accept({ kind: "webhook", subject, svixId, eventTimestamp }),
    ),
  });
});
export const layer = (authority: ConfiguredAccountAuthority) =>
  Layer.effect(AccountDeletions, make(authority));
