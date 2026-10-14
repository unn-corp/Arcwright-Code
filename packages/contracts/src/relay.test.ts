import { describe, expect, it } from "vite-plus/test";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Schema from "effect/Schema";

import {
  RelayApi,
  RelayDeviceRegistrationRequest,
  RelayEnvironmentConnectRequest,
  RelayAgentActivityPublishRequest,
  RelayPwaAgentActivityPublishRequest,
  RelayManagedEndpointRecoveryRequest,
  RelayManagedEndpointRecoveryProofPayload,
  RelayLinkProofRequest,
  RelayListDevicesResponse,
  RelayListDevicesResponseV1,
} from "./relay.ts";

const decodeDevice = Schema.decodeUnknownExit(RelayDeviceRegistrationRequest);
const device = {
  deviceId: "device",
  label: "Phone",
  pushToken: "token",
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

describe("mobile device platforms", () => {
  it.each([
    [23, "Failure"],
    [24, "Success"],
    [37, "Success"],
  ])("enforces the Android minimum without an upper bound (API %i)", (androidApiLevel, result) => {
    expect(decodeDevice({ ...device, platform: "android", androidApiLevel })._tag).toBe(result);
  });

  it("accepts Android tokens without Apple routing and preserves older iOS registrations", () => {
    expect(decodeDevice({ ...device, platform: "android", androidApiLevel: 36 })._tag).toBe(
      "Success",
    );
    expect(decodeDevice({ ...device, platform: "ios", iosMajorVersion: 18 })._tag).toBe("Success");
  });
  it("rejects missing platform versions and Apple activity tokens on Android", () => {
    expect(decodeDevice({ ...device, platform: "ios" })._tag).toBe("Failure");
    expect(decodeDevice({ ...device, platform: "android" })._tag).toBe("Failure");
    expect(
      decodeDevice({
        ...device,
        platform: "android",
        androidApiLevel: 36,
        pushToStartToken: "apple-token",
      })._tag,
    ).toBe("Failure");
  });
});

describe("RelayApi security", () => {
  it("describes DPoP access tokens using the HTTP DPoP authorization scheme", () => {
    const document = OpenApi.fromApi(RelayApi);

    expect(document.components.securitySchemes?.relayDpop).toEqual({
      type: "http",
      scheme: "DPoP",
      description: "DPoP-bound access token. Requests must also include the DPoP proof JWT header.",
    });
  });
});

it("declares additive public boundary errors on every public endpoint and leaves hook contracts unchanged", () => {
  const document = OpenApi.fromApi(RelayApi);
  for (const [path, methods] of Object.entries(document.paths))
    for (const operation of Object.values(methods)) {
      if (!operation || typeof operation !== "object" || !("responses" in operation)) continue;
      const statuses = Object.keys(operation.responses as object);
      if (path.startsWith("/v1/hooks/")) expect(statuses).not.toContain("429");
      else
        for (const status of ["400", "413", "429", "431", "503"])
          expect(statuses).toContain(status);
    }
});
it("bounds input identifiers/tokens without narrowing platform registration or the frozen/outbound device lists", () => {
  expect(
    decodeDevice({
      ...device,
      deviceId: "x".repeat(255),
      pushToken: "x".repeat(4096),
      platform: "ios",
      iosMajorVersion: 18,
    })._tag,
  ).toBe("Success");
  expect(
    decodeDevice({ ...device, deviceId: "x".repeat(256), platform: "ios", iosMajorVersion: 18 })
      ._tag,
  ).toBe("Failure");
  expect(
    decodeDevice({
      ...device,
      pushToken: "x".repeat(4097),
      platform: "android",
      androidApiLevel: 100,
    })._tag,
  ).toBe("Failure");
  const decodeConnect = Schema.decodeUnknownExit(RelayEnvironmentConnectRequest);
  expect(
    decodeConnect({ deviceId: "x".repeat(191), clientKeyThumbprint: "t".repeat(128) })._tag,
  ).toBe("Success");
  expect(decodeConnect({ deviceId: "x".repeat(192) })._tag).toBe("Failure");
  expect(decodeConnect({ clientProofKeyThumbprint: "t".repeat(129) })._tag).toBe("Failure");
  const state = {
    environmentId: "env",
    threadId: "x".repeat(512),
    projectTitle: "project",
    threadTitle: "thread",
    modelTitle: "model",
    phase: "running",
    headline: "headline",
    updatedAt: "timestamp",
    deepLink: "https://example.test",
  };
  expect(
    Schema.decodeUnknownExit(RelayAgentActivityPublishRequest)({ state, proof: "proof" })._tag,
  ).toBe("Success");
  expect(
    Schema.decodeUnknownExit(RelayPwaAgentActivityPublishRequest)({
      state,
      proof: "proof",
      environmentPublicKey: "pem",
    })._tag,
  ).toBe("Failure");
  expect(
    Schema.decodeUnknownExit(RelayPwaAgentActivityPublishRequest)({
      state: { ...state, threadId: "x".repeat(191) },
      proof: "proof",
      environmentPublicKey: "pem",
    })._tag,
  ).toBe("Success");
  expect(
    Schema.decodeUnknownExit(RelayManagedEndpointRecoveryRequest)({
      cloudUserId: "x".repeat(192),
      origin: { localHttpHost: "127.0.0.1", localHttpPort: 65535 },
      proof: "proof",
    })._tag,
  ).toBe("Failure");
  const record = {
    deviceId: "device",
    label: "phone",
    platform: "ios",
    iosMajorVersion: 18,
    appVersion: null,
    notifications: {
      enabled: true,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    },
    liveActivities: { enabled: false },
    updatedAt: "timestamp",
  };
  expect(
    Schema.decodeUnknownExit(RelayListDevicesResponse)({
      devices: Array.from({ length: 129 }, () => record),
    })._tag,
  ).toBe("Success");
  expect(
    Schema.decodeUnknownExit(RelayListDevicesResponseV1)({
      devices: [{ ...record, platform: "android", androidApiLevel: 37, iosMajorVersion: null }],
    })._tag,
  ).toBe("Failure");
});

it("bounds public relay origin inputs while preserving the local link-proof transport schema", () => {
  const origin = { localHttpHost: "x".repeat(254), localHttpPort: 65535 };
  expect(
    Schema.decodeUnknownExit(RelayManagedEndpointRecoveryRequest)({
      cloudUserId: "user",
      origin,
      proof: "proof",
    })._tag,
  ).toBe("Failure");
  const proof = {
    iss: "https://relay.test",
    aud: "https://relay.test",
    sub: "env",
    jti: "proof-id",
    iat: 1,
    exp: 2,
    action: "recover",
    environmentId: "env",
    cloudUserId: "user",
    origin,
  };
  expect(Schema.decodeUnknownExit(RelayManagedEndpointRecoveryProofPayload)(proof)._tag).toBe(
    "Failure",
  );
  expect(
    Schema.decodeUnknownExit(RelayManagedEndpointRecoveryProofPayload)({
      ...proof,
      origin: { ...origin, localHttpHost: "x".repeat(253) },
    })._tag,
  ).toBe("Success");
  expect(
    Schema.decodeUnknownExit(RelayLinkProofRequest)({
      challenge: "challenge",
      relayIssuer: "https://relay.test",
      endpoint: {
        httpBaseUrl: "http://127.0.0.1",
        wsBaseUrl: "ws://127.0.0.1",
        providerKind: "manual",
      },
      origin,
    })._tag,
  ).toBe("Success");
});
