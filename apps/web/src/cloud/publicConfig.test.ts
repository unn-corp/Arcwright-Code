import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CloudPublicConfigMissingError,
  hasCloudPublicConfig,
  resolveRelayClerkTokenOptions,
  resolveCloudPublicConfig,
} from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hasCloudPublicConfig", () => {
  it("requires both public cloud values", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    expect(hasCloudPublicConfig()).toBe(true);
  });

  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  it("reports the missing Clerk JWT template as structured configuration", () => {
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");

    expect(() => resolveRelayClerkTokenOptions()).toThrowError(
      new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" }),
    );
  });
});

it("validates a complete owned web profile and keeps its remote origin separate", () => {
  vi.stubEnv("VITE_CONNECT_MODE", "owned");
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_test_${btoa("sample.accounts.dev$")}`);
  vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "arcwright-relay");
  vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "client_sample");
  vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
  vi.stubEnv("VITE_CONNECT_HOSTED_APP_URL", "https://app.example.test");
  vi.stubEnv("VITE_HOSTED_APP_URL", "https://appassets.androidplatform.net");
  expect(resolveCloudPublicConfig().hostedAppUrl).toBe("https://app.example.test");
  expect(hasCloudPublicConfig()).toBe(true);
  vi.stubEnv("VITE_CONNECT_HOSTED_APP_URL", "");
  expect(() => resolveCloudPublicConfig()).toThrow(/complete/);
});
it("cloudless web public config clears ambient managed values", () => {
  vi.stubEnv("VITE_CONNECT_MODE", "cloudless");
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "ambient-key");
  vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "ambient-template");
  vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.t3.codes");
  vi.stubEnv("VITE_CONNECT_HOSTED_APP_URL", "https://app.t3.codes");
  expect(resolveCloudPublicConfig()).toMatchObject({
    connectMode: "cloudless",
    clerkPublishableKey: null,
    clerkJwtTemplate: null,
    relayUrl: null,
    hostedAppUrl: null,
  });
  expect(hasCloudPublicConfig()).toBe(false);
});
