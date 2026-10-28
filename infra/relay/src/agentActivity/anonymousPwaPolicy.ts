import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RelayConfiguration, resolveClerkAuthPolicy } from "../Config.ts";

export class AnonymousPwaUnavailable extends Schema.TaggedError<AnonymousPwaUnavailable>()(
  "AnonymousPwaUnavailable",
  {},
) {}

/** No enable override: only a validated legacy deployment can fan out anonymously. */
export const anonymousPwaAllowed = Effect.gen(function* () {
  const configuration = yield* Effect.serviceOption(RelayConfiguration);
  // Older standalone service consumers predate configuration. The Worker always
  // supplies its authoritative RelayConfiguration to routes, services and queues.
  if (Option.isNone(configuration)) return true;
  return yield* resolveClerkAuthPolicy(configuration.value).pipe(
    Effect.map((policy) => policy.mode === "legacy"),
    Effect.orElseSucceed(() => false),
  );
});

type Ownership = {
  readonly userId: string;
  readonly environmentId: string | null;
  readonly installationId: string | null;
  readonly installationSecretHash: string | null;
};

export const hasAnonymousOwnership = (row: Ownership): boolean =>
  row.environmentId !== null || row.installationId !== null || row.installationSecretHash !== null;

/** Partial/residual installation authority on an account row can never authorize delivery. */
export const blocksWebPushDelivery = (row: Ownership, anonymousAllowed: boolean): boolean => {
  if (!hasAnonymousOwnership(row)) return false;
  return !(
    anonymousAllowed &&
    row.environmentId !== null &&
    row.installationId !== null &&
    row.installationSecretHash !== null &&
    row.userId === `pwa:${row.installationId}`
  );
};
