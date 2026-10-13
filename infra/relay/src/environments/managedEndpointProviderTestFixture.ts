import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import type { RelayDb } from "../db.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "test",
    keyId: "test",
    privateKey: Redacted.make("test"),
    bundleId: "test",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("test"),
  clerkSecretKey: Redacted.make("test"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make("test"),
  cloudMintPublicKey: "test",
  managedEndpointBaseDomain: "fixture.test",
  managedEndpointNamespace: "fixture",
});

// Every external operation is observable. Calling one on a denied request is a
// defect, so an unexpected list/get/delete cannot accidentally pass a test.
export const deniedProviderLayer = <E, R>(
  database: Layer.Layer<RelayDb, E, R>,
  calls: string[],
) => {
  const forbidden = (operation: string) =>
    Effect.suspend(() => {
      calls.push(operation);
      return Effect.die(new Error(`Unexpected Cloudflare ${operation}`));
    });
  const tunnels = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
    get: () => forbidden("get"),
    list: () => forbidden("list"),
    create: () => forbidden("create"),
    putConfiguration: () => forbidden("configuration"),
    getToken: () => forbidden("token"),
    delete: () => forbidden("delete"),
  });
  const dns = ManagedEndpointProvider.ManagedEndpointDnsClient.of({
    getRecord: () => Effect.die("Unexpected getRecord"),
    listRecordsPage: () => Effect.die("Unexpected listRecordsPage"),
    listExactRecords: () => Effect.die("Unexpected listExactRecords"),
    listRecords: () => forbidden("dns-list"),
    createRecord: () => forbidden("dns-create"),
    updateRecord: () => forbidden("dns-update"),
    deleteRecord: () => forbidden("dns-delete"),
  });
  return ManagedEndpointProvider.layer.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(RelayConfiguration.layer(config)),
    Layer.provide(ManagedEndpointProvider.layerTunnelClient(tunnels)),
    Layer.provide(ManagedEndpointProvider.layerDnsClient(dns)),
    Layer.provide(ManagedEndpointAllocations.layer),
    Layer.provideMerge(ManagedTunnelLimits.layer),
    Layer.provideMerge(database),
  );
};
