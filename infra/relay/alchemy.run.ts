// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Planetscale from "alchemy/Planetscale";
import * as Redacted from "effect/Redacted";
import * as Config from "effect/Config";

import { PublishClientConfig, tokenDigest } from "./src/clientConfig.ts";
import * as RelayDb from "./src/db.ts";
import { RelayObservability } from "./src/observability.ts";
import { ManagedEndpointZone, RelayApiZone } from "./src/zone.ts";
import * as RelayWorker from "./src/worker.ts";
import { clerkAuthPolicyConfig } from "./src/Config.ts";
import {
  relayDatabaseProviderConfig,
  relayHyperdriveIdConfig,
  relayTracingEnabledConfig,
  relayZoneOwnerStageConfig,
  relayRuntimeTokenModeConfig,
} from "./src/deploymentOptions.ts";
import {
  ownedPrivateAlchemyState,
  withOwnedPrivateAlchemyContext,
} from "./scripts/owned-connect-web-state.ts";

const privateStateRoot = process.env.ARCWRIGHT_CONNECT_RELAY_STATE_ROOT;
const privateDeployment = privateStateRoot ? ownedPrivateAlchemyState(privateStateRoot) : undefined;

const preflight = Effect.gen(function* () {
  yield* clerkAuthPolicyConfig;
  const databaseProvider = yield* relayDatabaseProviderConfig;
  if (databaseProvider === "existing-hyperdrive") yield* relayHyperdriveIdConfig;
  yield* relayTracingEnabledConfig;
  yield* relayZoneOwnerStageConfig;
  if ((yield* relayRuntimeTokenModeConfig) === "existing") {
    yield* Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID");
    yield* Config.Redacted("RELAY_TUNNEL_API_TOKEN");
    yield* Config.Redacted("RELAY_DNS_API_TOKEN");
  }
});

const stack = Alchemy.Stack(
  "T3CodeRelay",
  {
    providers: Layer.unwrap(
      Effect.gen(function* () {
        const externalDatabase = (yield* relayDatabaseProviderConfig) === "existing-hyperdrive";
        const tracingEnabled = yield* relayTracingEnabledConfig;
        return Layer.mergeAll(
          Cloudflare.providers(),
          externalDatabase
            ? Layer.empty
            : Layer.mergeAll(Drizzle.providers(), Planetscale.providers()),
          tracingEnabled ? Axiom.providers() : Layer.empty,
        );
      }).pipe(Effect.orDie),
    ),
    state: privateDeployment?.state ?? Cloudflare.state(),
  },
  preflight.pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const externalDatabase = (yield* relayDatabaseProviderConfig) === "existing-hyperdrive";
        const db = externalDatabase ? undefined : yield* RelayDb.PlanetscaleDatabase;
        const hyperdrive = externalDatabase ? undefined : yield* RelayDb.RelayHyperdrive;
        const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
        const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
        const observability = yield* RelayObservability;
        const api = yield* RelayWorker.Api;
        const tracing =
          observability === null
            ? {
                mobileTracingUrl: "",
                mobileTracingDataset: "",
                mobileTracingToken: Redacted.make(""),
                clientTracingUrl: "",
                clientTracingDataset: "",
                clientTracingToken: Redacted.make(""),
              }
            : {
                mobileTracingUrl: observability.traces.otelTracesEndpoint,
                mobileTracingDataset: observability.traces.name,
                mobileTracingToken: observability.mobileIngestToken.token,
                clientTracingUrl: observability.traces.otelTracesEndpoint,
                clientTracingDataset: observability.traces.name,
                clientTracingToken: observability.clientIngestToken.token,
              };
        yield* PublishClientConfig({
          url: api.url,
          ...tracing,
          tokenDigest:
            observability === null
              ? tokenDigest([Redacted.make(""), Redacted.make("")])
              : Output.map(
                  Output.all(
                    observability.mobileIngestToken.token,
                    observability.clientIngestToken.token,
                  ),
                  tokenDigest,
                ),
        });

        return {
          databaseName: db?.database.name ?? "external-postgres",
          databaseBranchName: db?.branch?.name ?? "main",
          hyperdriveName: hyperdrive?.name ?? "existing-hyperdrive",
          workerName: api.workerName,
          url: api.url,
          relayApiZoneId: relayApiZone.zoneId,
          managedEndpointZoneId: managedEndpointZone.zoneId,
          ...tracing,
        };
      }).pipe(Effect.provide(RelayWorker.layer)),
    ),
  ),
);

export default privateDeployment
  ? withOwnedPrivateAlchemyContext(stack, privateDeployment.context)
  : stack;
