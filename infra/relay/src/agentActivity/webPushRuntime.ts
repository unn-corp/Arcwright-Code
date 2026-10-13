import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RelayConfiguration } from "../Config.ts";
import * as WebPushSubscriptions from "./WebPushSubscriptions.ts";
import * as WebPushDeliveries from "./WebPushDeliveries.ts";

/** The Worker assembly requires and captures its authoritative deployment config. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const configuration = yield* RelayConfiguration;
    return Layer.merge(
      WebPushSubscriptions.layer,
      WebPushDeliveries.layer.pipe(Layer.provide(WebPushSubscriptions.layer)),
    ).pipe(Layer.provide(Layer.succeed(RelayConfiguration, configuration)));
  }),
);
