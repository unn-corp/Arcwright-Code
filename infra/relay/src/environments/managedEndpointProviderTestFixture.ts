import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import type { RelayDb } from "../db.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import * as Lifecycle from "./ManagedEndpointLifecycle.ts";
import * as Links from "./EnvironmentLinks.ts";
import * as Credentials from "./EnvironmentCredentials.ts";
import { RelayEnvironmentLinkProofPayload } from "@t3tools/contracts/relay";
import type { ProvisionPublication } from "./managedEndpointLifecycleContracts.ts";
import * as Schema from "effect/Schema";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";
import * as T3ChatAccounts from "../t3chat/T3ChatAccounts.ts";

export const t3ChatDisabledLayer = Layer.mock(T3ChatAccounts.T3ChatAccounts, {
  available: false,
});

export const config = RelayConfiguration.RelayConfiguration.of({
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
    get: Effect.fn("ManagedEndpointProvider.ManagedEndpointTunnelClient.get")(() =>
      forbidden("get"),
    ),
    list: Effect.fn("ManagedEndpointProvider.ManagedEndpointTunnelClient.list")(() =>
      forbidden("list"),
    ),
    create: Effect.fn("ManagedEndpointProvider.ManagedEndpointTunnelClient.create")(() =>
      forbidden("create"),
    ),
    putConfiguration: Effect.fn(
      "ManagedEndpointProvider.ManagedEndpointTunnelClient.putConfiguration",
    )(() => forbidden("configuration")),
    getToken: Effect.fn("ManagedEndpointProvider.ManagedEndpointTunnelClient.getToken")(() =>
      forbidden("token"),
    ),
    delete: Effect.fn("ManagedEndpointProvider.ManagedEndpointTunnelClient.delete")(() =>
      forbidden("delete"),
    ),
  });
  const dns = ManagedEndpointProvider.ManagedEndpointDnsClient.of({
    getRecord: Effect.fn("ManagedEndpointProvider.ManagedEndpointDnsClient.getRecord")(() =>
      Effect.die("Unexpected getRecord"),
    ),
    listRecordsPage: Effect.fn("ManagedEndpointProvider.ManagedEndpointDnsClient.listRecordsPage")(
      () => Effect.die("Unexpected listRecordsPage"),
    ),
    listExactRecords: Effect.fn(
      "ManagedEndpointProvider.ManagedEndpointDnsClient.listExactRecords",
    )(() => Effect.die("Unexpected listExactRecords")),
    listRecords: Effect.fn("ManagedEndpointProvider.ManagedEndpointDnsClient.listRecords")(() =>
      forbidden("dns-list"),
    ),
    createRecord: Effect.fn("ManagedEndpointProvider.ManagedEndpointDnsClient.createRecord")(() =>
      forbidden("dns-create"),
    ),
    updateRecord: Effect.fn("ManagedEndpointProvider.ManagedEndpointDnsClient.updateRecord")(() =>
      forbidden("dns-update"),
    ),
    deleteRecord: Effect.fn("ManagedEndpointProvider.ManagedEndpointDnsClient.deleteRecord")(() =>
      forbidden("dns-delete"),
    ),
  });
  return ManagedEndpointProvider.layer.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(RelayConfiguration.layer(config)),
    Layer.provide(ManagedEndpointProvider.layerTunnelClient(tunnels)),
    Layer.provide(ManagedEndpointProvider.layerDnsClient(dns)),
    Layer.provide(Lifecycle.layer),
    Layer.provide(Layer.merge(Links.layer, Credentials.layer)),
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(ManagedTunnelLimits.layer),
    Layer.provide(t3ChatDisabledLayer),
    Layer.provideMerge(database),
  );
};

export const settledAllocationFacts = (tunnelId: string | null) => ({
  allocationId: "00000000-0000-4000-8000-000000000001",
  lifecycleState: "idle" as const,
  operationId: null,
  operationKind: null,
  operationStartedAt: null,
  pendingMutation: null,
  cleanupRequested: false,
  tunnelPresence: "recorded" as const,
  dnsPresence: "recorded" as const,
  dnsTargetTunnelId: tunnelId,
  recoveryEnabledAt: null,
  recoveryEnvironmentPublicKey: null,
});
const decodeFixtureProof = Schema.decodeSync(RelayEnvironmentLinkProofPayload);
export const publicationFor = (environmentId: string): ProvisionPublication => ({
  kind: "link",
  request: {
    proof: "verified-fixture",
    managedTunnelsEnabled: true,
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
  },
  proof: decodeFixtureProof({
    iss: `t3-env:${environmentId}`,
    aud: "https://relay.example.test",
    sub: environmentId,
    jti: "fixture-proof",
    iat: 1,
    exp: 2,
    challenge: "verified-fixture",
    environmentId,
    descriptor: {
      environmentId,
      label: "Fixture",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    environmentPublicKey: "fixture-key",
    endpoint: {
      providerKind: "manual",
      httpBaseUrl: "http://localhost:3000/",
      wsBaseUrl: "ws://localhost:3000/ws",
    },
    origin: { localHttpHost: "localhost", localHttpPort: 3000 },
    scopes: ["agent_activity_notifications", "managed_tunnels"],
  }),
});
