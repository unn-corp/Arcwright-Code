import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { isBoundedDpopProof } from "../http/publicRelayInputBounds.ts";
import { lt } from "drizzle-orm";

import { DpopVerificationFailureCode, verifyDpopProof } from "@t3tools/shared/dpop";
import * as RelayDb from "../db.ts";
import { relayDpopProofs } from "../persistence/schema.ts";

export class DpopProofReplayPersistenceError extends Schema.TaggedError<DpopProofReplayPersistenceError>()(
  "DpopProofReplayPersistenceError",
  {
    operation: Schema.Literals(["consume", "prune-expired"]),
    thumbprint: Schema.optionalKey(Schema.String),
    jti: Schema.optionalKey(Schema.String),
    iat: Schema.optionalKey(Schema.Number),
    expiresBefore: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist DPoP proof replay state during '${this.operation}'`;
  }
}

export const DpopProofFailureCode = Schema.Union([
  DpopVerificationFailureCode,
  Schema.Literal("replayed"),
]);
export type DpopProofFailureCode = typeof DpopProofFailureCode.Type;

export class DpopProofRejected extends Schema.TaggedError<DpopProofRejected>()(
  "DpopProofRejected",
  {
    code: DpopProofFailureCode,
  },
) {
  override get message(): string {
    return `DPoP proof rejected: ${this.code}`;
  }
}

export interface VerifiedDpopProof {
  readonly thumbprint: string;
  readonly jti: string;
  readonly iat: number;
  readonly expiresAt: DateTime.DateTime;
}

export class DpopProofReplay extends Context.Service<
  DpopProofReplay,
  {
    readonly verifyAndConsume: (input: {
      readonly proof: string | undefined;
      readonly method: string;
      readonly url: string;
      readonly expectedThumbprint?: string;
      readonly expectedAccessToken?: string;
      readonly now: DateTime.DateTime;
    }) => Effect.Effect<string, DpopProofRejected | DpopProofReplayPersistenceError>;
    readonly verify: (input: {
      readonly proof: string | undefined;
      readonly method: string;
      readonly url: string;
      readonly expectedThumbprint?: string;
      readonly expectedAccessToken?: string;
      readonly now: DateTime.DateTime;
    }) => Effect.Effect<VerifiedDpopProof, DpopProofRejected>;
    readonly consumeVerified: (
      proof: VerifiedDpopProof,
    ) => Effect.Effect<string, DpopProofRejected | DpopProofReplayPersistenceError>;
    readonly consume: (input: {
      readonly thumbprint: string;
      readonly jti: string;
      readonly iat: number;
      readonly expiresAt: DateTime.DateTime;
    }) => Effect.Effect<boolean, DpopProofReplayPersistenceError>;
    readonly pruneExpired: Effect.Effect<void, DpopProofReplayPersistenceError>;
  }
>()("t3code-relay/auth/DpopProofs/DpopProofReplay") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  const consume: DpopProofReplay["Service"]["consume"] = Effect.fn("relay.dpop_proofs.consume")(
    function* (input) {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* db
        .insert(relayDpopProofs)
        .values({
          thumbprint: input.thumbprint,
          jti: input.jti,
          iat: input.iat,
          expiresAt: DateTime.formatIso(input.expiresAt),
          createdAt,
        })
        .onConflictDoNothing()
        .returning({ jti: relayDpopProofs.jti })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DpopProofReplayPersistenceError({
                operation: "consume",
                thumbprint: input.thumbprint,
                jti: input.jti,
                iat: input.iat,
                cause,
              }),
          ),
        );
      return inserted.length > 0;
    },
  );

  const verify: DpopProofReplay["Service"]["verify"] = Effect.fn("relay.dpop_proofs.verify")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.dpop.method": input.method,
        "relay.dpop.expected_thumbprint_present": input.expectedThumbprint !== undefined,
        "relay.dpop.expected_access_token_present": input.expectedAccessToken !== undefined,
      });
      if (input.proof !== undefined && !isBoundedDpopProof(input.proof))
        return yield* new DpopProofRejected({ code: "malformed_proof" });
      const result = verifyDpopProof({
        proof: input.proof,
        method: input.method,
        url: input.url,
        nowEpochSeconds: Math.floor(input.now.epochMilliseconds / 1_000),
        ...(input.expectedThumbprint ? { expectedThumbprint: input.expectedThumbprint } : {}),
        ...(input.expectedAccessToken ? { expectedAccessToken: input.expectedAccessToken } : {}),
      });
      if (!result.ok) {
        yield* Effect.logWarning("relay dpop proof rejected", {
          code: result.code,
          reason: result.reason,
          method: input.method,
          url: input.url,
          expectedThumbprintPresent: input.expectedThumbprint !== undefined,
          expectedAccessTokenPresent: input.expectedAccessToken !== undefined,
        });
        return yield* new DpopProofRejected({
          code: result.code,
        });
      }
      return {
        thumbprint: result.thumbprint,
        jti: result.jti,
        iat: result.iat,
        expiresAt: DateTime.add(input.now, { minutes: 5 }),
      };
    },
  );

  const consumeVerified: DpopProofReplay["Service"]["consumeVerified"] = Effect.fn(
    "relay.dpop_proofs.consume_verified",
  )(function* (result) {
    const consumed = yield* consume(result);
    if (!consumed) {
      yield* Effect.logWarning("relay dpop proof replay rejected", {
        thumbprint: result.thumbprint,
        jti: result.jti,
        iat: result.iat,
      });
      return yield* new DpopProofRejected({
        code: "replayed",
      });
    }
    yield* Effect.annotateCurrentSpan({
      "relay.dpop.thumbprint": result.thumbprint,
      "relay.dpop.iat": result.iat,
    });
    return result.thumbprint;
  });

  const pruneExpired: DpopProofReplay["Service"]["pruneExpired"] = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.annotateCurrentSpan({ "relay.dpop_prune.before": now });
    yield* db
      .delete(relayDpopProofs)
      .where(lt(relayDpopProofs.expiresAt, now))
      .pipe(
        Effect.mapError(
          (cause) =>
            new DpopProofReplayPersistenceError({
              operation: "prune-expired",
              expiresBefore: now,
              cause,
            }),
        ),
      );
  }).pipe(Effect.withSpan("relay.dpop_proofs.prune_expired"));

  return DpopProofReplay.of({
    verify,
    consumeVerified,
    verifyAndConsume: (input) => verify(input).pipe(Effect.flatMap(consumeVerified)),
    consume,
    pruneExpired,
  });
});

export const layer = Layer.effect(DpopProofReplay, make);
