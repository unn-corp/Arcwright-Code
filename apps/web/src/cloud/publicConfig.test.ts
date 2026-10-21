import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { hasCloudPublicConfig, resolveCloudPublicConfig } from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("hasCloudPublicConfig", () => {
  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  describe("browser origins", () => {
    beforeEach(() => {
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_live_${btoa("clerk.example.com$")}`);
      vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
      vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    });

    it.each(["https://example.com", "https://nightly.app.example.com:443"])(
      "enables production auth on the configured root and subdomains: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expect(hasCloudPublicConfig()).toBe(true);
      },
    );

    it.each(["http://localhost:3773", "https://machine.example.ts.net"])(
      "disables production auth on private browser origins: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expect(hasCloudPublicConfig()).toBe(false);
      },
    );

    it.each(["http://app.example.com:443", "https://app.example.com:3773"])(
      "rejects unsupported schemes and ports even on the configured domain: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expect(hasCloudPublicConfig()).toBe(false);
      },
    );

    it.each(["https://notexample.com", "https://example.com.evil.test"])(
      "rejects domain lookalikes: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expect(hasCloudPublicConfig()).toBe(false);
      },
    );

    it.each([
      ["https://tenant.clerk.accounts.dev", true],
      ["https://other.clerk.accounts.dev", false],
    ])("keeps a provider hostname scoped to its own instance: %s", (origin, expected) => {
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_live_${btoa("tenant.clerk.accounts.dev$")}`);
      vi.stubGlobal("window", { location: new URL(origin) });

      expect(hasCloudPublicConfig()).toBe(expected);
    });

    it("keeps production keys available in the Electron auth shell", () => {
      vi.stubGlobal("window", { location: new URL("file:///app/index.html"), desktopBridge: {} });

      expect(hasCloudPublicConfig()).toBe(true);
    });

    it("keeps production keys available to the bundled Android native auth shell", () => {
      vi.stubEnv("VITE_ANDROID_PWA", "1");
      vi.stubGlobal("window", { location: new URL("https://appassets.androidplatform.net") });

      expect(hasCloudPublicConfig()).toBe(true);
    });
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
