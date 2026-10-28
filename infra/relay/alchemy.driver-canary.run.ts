import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Secrets from "alchemy/Secrets";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  readDriverCanaryConfig,
  assertDriverCanaryOperatorContext,
} from "./scripts/owned-connect-driver-canary-config.ts";
import {
  ownedPrivateAlchemyState,
  withOwnedPrivateAlchemyContext,
} from "./scripts/owned-connect-web-state.ts";
import { CANARY_STACK } from "./src/ownedConnectDriverCanary.ts";
import { driverCanaryStackBody } from "./scripts/owned-connect-driver-canary-stack.ts";

const configFile = process.env.ARCWRIGHT_CONNECT_DRIVER_CANARY_CONFIG;
if (!configFile) throw new Error("Require explicit ARCWRIGHT_CONNECT_DRIVER_CANARY_CONFIG.");
const config = await Effect.runPromise(
  readDriverCanaryConfig(configFile).pipe(Effect.provide(NodeServices.layer)),
);
await Effect.runPromise(
  assertDriverCanaryOperatorContext(config, config.stage).pipe(Effect.provide(NodeServices.layer)),
);
const { context, state } = ownedPrivateAlchemyState(config.privateStateRoot);

const stack = Alchemy.Stack(
  CANARY_STACK,
  {
    providers: Cloudflare.providers(),
    state,
    secrets: [Secrets.ProcessEnv()],
  },
  Effect.gen(function* () {
    yield* assertDriverCanaryOperatorContext(config, yield* Alchemy.Stage).pipe(Effect.orDie);
    return yield* driverCanaryStackBody;
  }),
);

export default withOwnedPrivateAlchemyContext(stack, context);
