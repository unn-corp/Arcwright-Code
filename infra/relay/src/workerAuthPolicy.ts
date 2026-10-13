import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import { clerkAuthPolicyFromWorkerEnvironment } from "./Config.ts";

/** WorkerBridge provides raw env during runtime and {} during plan. */
export const loadWorkerClerkAuthPolicy = Effect.gen(function* () {
  return yield* clerkAuthPolicyFromWorkerEnvironment(yield* Cloudflare.WorkerEnvironment);
});
