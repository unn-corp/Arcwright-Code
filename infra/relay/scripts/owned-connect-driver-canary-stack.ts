import * as Effect from "effect/Effect";
import canaryLayer, {
  OwnedConnectDriverCanary,
  CANARY_CONTRACT,
} from "../src/ownedConnectDriverCanary.ts";

/** The standalone operator entry and offline graph compile yield the same Worker. */
export const driverCanaryStackBody = Effect.gen(function* () {
  const worker = yield* OwnedConnectDriverCanary;
  return { workerName: worker.workerName, url: worker.url, contract: CANARY_CONTRACT };
}).pipe(Effect.provide(canaryLayer));
