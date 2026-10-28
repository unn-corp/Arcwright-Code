import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  publicRelayBuckets,
  publicRelayOperations,
  type PublicRelayOperation,
  type PublicRelayClass,
} from "./publicRelayPolicy.ts";

export class PublicRelayRateLimited extends Schema.TaggedError<PublicRelayRateLimited>()(
  "PublicRelayRateLimited",
  {
    retryAfterSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
  },
) {}
export class PublicRelayLimiterUnavailable extends Schema.TaggedError<PublicRelayLimiterUnavailable>()(
  "PublicRelayLimiterUnavailable",
  {},
) {}
export type PublicRelaySubject =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "environment"; readonly environmentId: string; readonly keyDigest: string }
  | { readonly kind: "installation"; readonly installationId: string }
  | { readonly kind: "edge"; readonly ip: string };

export class TrustedEdgeIdentity extends Context.Service<
  TrustedEdgeIdentity,
  { readonly status: "available"; readonly ip: string } | { readonly status: "unavailable" }
>()("t3code-relay/http/PublicRelayRateLimits/TrustedEdgeIdentity") {}

export class PublicRelayRateLimits extends Context.Service<
  PublicRelayRateLimits,
  {
    readonly admit: (
      operation: PublicRelayOperation,
      subject: PublicRelaySubject,
    ) => Effect.Effect<void, PublicRelayRateLimited | PublicRelayLimiterUnavailable>;
  }
>()("t3code-relay/http/PublicRelayRateLimits") {}

/** Length-prefixed tuple avoids ambiguous identity/namespace concatenation. Never log it. */
export function publicRelayLimiterKey(
  config: { readonly issuer: string; readonly stage: string },
  operation: PublicRelayOperation,
  subject: PublicRelaySubject,
): string {
  const identity =
    subject.kind === "user"
      ? [subject.userId]
      : subject.kind === "environment"
        ? [subject.environmentId, subject.keyDigest]
        : subject.kind === "installation"
          ? [subject.installationId]
          : [subject.ip];
  const parts = [
    "relay-public-v1",
    config.issuer,
    config.stage,
    subject.kind,
    subject.kind === "edge" ? publicRelayOperations[operation][2] : operation,
    ...identity,
  ];
  return parts.map((part) => `${part.length}:${part}`).join("");
}

type Binding = {
  readonly limit: (options: {
    readonly key: string;
  }) => Effect.Effect<{ readonly success: boolean }, { readonly _tag: string }>;
};
/** Production bindings are mandatory; failure and defects fail closed, interruption survives. */
export function layerCloudflare(
  config: { readonly issuer: string; readonly stage: string },
  bindings: Readonly<Partial<Record<30 | 120 | 240 | 60 | 10 | "edge", Binding>>>,
) {
  return Layer.succeed(PublicRelayRateLimits, {
    admit: Effect.fn("PublicRelayRateLimits.admit")(
      (operation: PublicRelayOperation, subject: PublicRelaySubject) =>
        Effect.suspend(() => {
          const kind: PublicRelayClass = publicRelayOperations[operation][2];
          const binding =
            bindings[subject.kind === "edge" ? "edge" : publicRelayBuckets[kind].limit];
          if (!binding) return Effect.fail(new PublicRelayLimiterUnavailable({}));
          return Effect.suspend(() =>
            binding.limit({ key: publicRelayLimiterKey(config, operation, subject) }),
          ).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.fail(new PublicRelayLimiterUnavailable({})),
            ),
            Effect.flatMap(
              (
                result,
              ): Effect.Effect<void, PublicRelayRateLimited | PublicRelayLimiterUnavailable> =>
                result?.success === true
                  ? Effect.void
                  : result?.success === false
                    ? Effect.fail(new PublicRelayRateLimited({ retryAfterSeconds: 60 }))
                    : Effect.fail(new PublicRelayLimiterUnavailable({})),
            ),
          );
        }),
    ),
  });
}
