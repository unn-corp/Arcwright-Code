import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Redacted from "effect/Redacted";
import { RelayConfiguration } from "../Config.ts";
import type { WebPushNotification } from "./WebPushSubscriptions.ts";

export const config = {
  relayIssuer: "https://relay.arcwright.space",
  apns: null,
  clerkSecretKey: Redacted.make("fixture-secret"),
  clerkPublishableKey: `pk_test_${btoa("clerk.arcwright.space$")}`,
  clerkJwtAudience: "arcwright-code-relay",
  clerkAuthPolicy: {
    mode: "owned",
    issuer: "https://clerk.arcwright.space",
    cliClientId: "fixture_cli",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("fixture-delivery-secret"),
  webPush: {
    subject: "mailto:fixture@example.test",
    publicKey: "fixture-key",
    privateKey: Redacted.make("fixture-key"),
  },
  cloudMintPrivateKey: Redacted.make("fixture-key"),
  cloudMintPublicKey: "fixture-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
} satisfies RelayConfiguration["Service"];
export const preferences = {
  enabled: true,
  notifyOnCompletion: true,
  notifyOnPlanReady: true,
  notifyOnInput: true,
  notifyOnFailure: true,
  showProjectAndThreadNames: true,
};
export const registration = {
  endpoint: "https://push.example.test/consumer",
  keys: { p256dh: "fixture-key", auth: "fixture-auth" },
  preferences,
};
export const state: RelayAgentActivityState = {
  environmentId: EnvironmentId.make("consumer-env"),
  threadId: ThreadId.make("consumer-thread"),
  projectTitle: "Current Project",
  threadTitle: "Current Thread",
  modelTitle: "Codex",
  phase: "waiting_for_input",
  headline: "Current headline",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/current-thread",
};
export const subscription: WebPushNotification["subscription"] = {
  id: "consumer-sub",
  incarnationId: "00000000-0000-4000-8000-000000000001",
  userId: "account-A",
  environmentId: null,
  installationId: null,
  installationSecretHash: null,
  endpoint: registration.endpoint,
  p256dh: registration.keys.p256dh,
  auth: registration.keys.auth,
  preferencesJson: preferences,
  createdAt: state.updatedAt,
  updatedAt: state.updatedAt,
};
export const linkIncarnationId = "00000000-0000-4000-8000-000000000002";
