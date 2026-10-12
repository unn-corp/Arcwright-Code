// @effect-diagnostics nodeBuiltinImport:off - Isolated build-profile fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  mobileConnectBuildConfig,
  webSurfaceHostedAppUrl,
  resolveMobileVersionPolicy,
} from "./connect-build-surfaces.ts";
import {
  assertLegacyRecoveryConnectSelection,
  loadRepoEnv,
  connectProfileDigest,
  connectProfileReceipt,
} from "./public-config.ts";
import { androidManagedAuthBuildEnv } from "./android-pwa-public-config.ts";
import { resolvePublicConfig } from "./public-config.ts";

const fixtures: string[] = [];
const owned = {
  T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("sample.accounts.dev$")}`,
  T3CODE_CLERK_JWT_TEMPLATE: "arcwright-relay",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "client_sample",
  T3CODE_RELAY_URL: "https://relay.example.test/",
  T3CODE_HOSTED_APP_URL: "https://app.example.test/",
};
function fixture(files: Record<string, string> = {}) {
  const repoRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "connect-profile-"));
  fixtures.push(repoRoot);
  for (const [name, content] of Object.entries(files))
    NodeFS.writeFileSync(NodePath.join(repoRoot, name), content);
  return repoRoot;
}
const envText = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
afterEach(() =>
  fixtures.splice(0).forEach((path) => NodeFS.rmSync(path, { recursive: true, force: true })),
);

describe("owned Connect public profile", () => {
  it("selects a public file atomically over incidental upstream root env", () => {
    const repoRoot = fixture({
      "public.json": JSON.stringify(owned),
      ".env.local": envText({
        T3CODE_RELAY_URL: "https://relay.t3.codes",
        T3CODE_DEV_AUTH_TOKEN: "private-fixture",
      }),
    });
    const env = loadRepoEnv({
      repoRoot,
      baseEnv: {
        T3CODE_CONNECT_MODE: "owned",
        T3CODE_CONNECT_PROFILE_FILE: "public.json",
        VITE_ANDROID_PWA: "1",
      },
    });
    expect(env.T3CODE_RELAY_URL).toBe("https://relay.example.test");
    expect(env.T3CODE_DEV_AUTH_TOKEN).toBe("private-fixture");
    expect(env.VITE_CONNECT_HOSTED_APP_URL).toBe("https://app.example.test");
    expect(env.VITE_HOSTED_APP_URL).toBeUndefined();
    expect(androidManagedAuthBuildEnv(resolvePublicConfig(env))).toMatchObject({
      T3_PWA_CONNECT_MODE: "owned",
      T3_PWA_RELAY_URL: env.VITE_T3CODE_RELAY_URL,
      T3_PWA_CLERK_PUBLISHABLE_KEY: env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
      T3_PWA_HOSTED_APP_URL: env.VITE_CONNECT_HOSTED_APP_URL,
    });
  });
  it("rejects a partial process alternative to a file even when its value agrees", () => {
    expect(() =>
      loadRepoEnv({
        repoRoot: fixture({ "public.json": JSON.stringify(owned) }),
        baseEnv: {
          T3CODE_CONNECT_MODE: "owned",
          T3CODE_CONNECT_PROFILE_FILE: "public.json",
          T3CODE_RELAY_URL: owned.T3CODE_RELAY_URL,
        },
      }),
    ).toThrow(/complete/i);
  });
  it("accepts complete identical process projection beside a file", () => {
    expect(
      loadRepoEnv({
        repoRoot: fixture({ "public.json": JSON.stringify(owned) }),
        baseEnv: {
          ...owned,
          T3CODE_CONNECT_MODE: "owned",
          T3CODE_CONNECT_PROFILE_FILE: "public.json",
        },
      }).T3CODE_HOSTED_APP_URL,
    ).toBe("https://app.example.test");
  });
  it("rejects a conflicting complete process alternative to a file", () => {
    expect(() =>
      loadRepoEnv({
        repoRoot: fixture({ "public.json": JSON.stringify(owned) }),
        baseEnv: {
          ...owned,
          T3CODE_RELAY_URL: "https://other.example.test",
          T3CODE_CONNECT_MODE: "owned",
          T3CODE_CONNECT_PROFILE_FILE: "public.json",
        },
      }),
    ).toThrow(/conflict/i);
  });
  it("rejects a partial higher source instead of mixing lower sources", () => {
    expect(() =>
      loadRepoEnv({
        repoRoot: fixture({ ".env": envText(owned) }),
        baseEnv: { T3CODE_CONNECT_MODE: "owned", VITE_CLERK_JWT_TEMPLATE: "another" },
      }),
    ).toThrow(/complete/i);
    expect(() =>
      loadRepoEnv({
        repoRoot: fixture({ ".env": envText(owned), ".env.local": "T3CODE_RELAY_URL=" }),
        baseEnv: { T3CODE_CONNECT_MODE: "owned" },
      }),
    ).toThrow(/complete/i);
  });
  it("uses whole source precedence and deliberately accepts identical aliases", () => {
    expect(
      loadRepoEnv({
        repoRoot: fixture({
          ".env": envText({ ...owned, T3CODE_RELAY_URL: "https://lower.example.test" }),
          ".env.local": envText(owned),
        }),
        baseEnv: { T3CODE_CONNECT_MODE: "owned" },
      }).T3CODE_RELAY_URL,
    ).toBe("https://relay.example.test");
    expect(
      loadRepoEnv({
        repoRoot: fixture(),
        baseEnv: {
          ...owned,
          VITE_CLERK_JWT_TEMPLATE: owned.T3CODE_CLERK_JWT_TEMPLATE,
          T3CODE_CONNECT_MODE: "owned",
        },
      }).VITE_CLERK_JWT_TEMPLATE,
    ).toBe(owned.T3CODE_CLERK_JWT_TEMPLATE);
    expect(() =>
      loadRepoEnv({
        repoRoot: fixture(),
        baseEnv: { ...owned, VITE_CLERK_JWT_TEMPLATE: "conflicting", T3CODE_CONNECT_MODE: "owned" },
      }),
    ).toThrow(/conflict/i);
  });
  it.each(["no.json", "../outside.json", "bad.json", "secret.json", "large.json"])(
    "rejects missing, unsafe, malformed, unknown-key or oversized file %s without disclosing paths or values",
    (file) => {
      const repoRoot = fixture({
        "bad.json": "{secret-fixture",
        "secret.json": JSON.stringify({ ...owned, CLERK_SECRET_KEY: "secret-fixture" }),
        "large.json": " ".repeat(17000),
      });
      let error: unknown;
      try {
        loadRepoEnv({
          repoRoot,
          baseEnv: { T3CODE_CONNECT_MODE: "owned", T3CODE_CONNECT_PROFILE_FILE: file },
        });
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(repoRoot);
      expect(String(error)).not.toContain("secret-fixture");
      expect(String(error)).not.toContain(file);
    },
  );
  it.each([
    { T3CODE_CLERK_PUBLISHABLE_KEY: "pk_bad" },
    { T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("clerk.t3.codes$")}` },
    { T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("user@issuer.example.test$")}` },
    { T3CODE_CLERK_JWT_TEMPLATE: "with space" },
    { T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "a".repeat(257) },
    { T3CODE_RELAY_URL: "https://relay.t3.codes" },
    { T3CODE_RELAY_URL: "https://relay.t3.codes." },
    { T3CODE_HOSTED_APP_URL: "https://app.example.test#" },
    { T3CODE_HOSTED_APP_URL: "https://app.example.test?" },
    { T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("clerk.t3.codes.$")}` },
    { T3CODE_RELAY_URL: "https://relay.example.test/path" },
    { T3CODE_HOSTED_APP_URL: "http://localhost:5733" },
    { T3CODE_HOSTED_APP_URL: "https://app.t3.codes" },
    { T3CODE_HOSTED_APP_URL: "https://user:pass@example.test" },
    { T3CODE_HOSTED_APP_URL: "https://example.test?query=1" },
  ])("rejects invalid or upstream authority fields %#", (invalid) => {
    expect(() =>
      loadRepoEnv({
        repoRoot: fixture(),
        baseEnv: { ...owned, ...invalid, T3CODE_CONNECT_MODE: "owned" },
      }),
    ).toThrow();
  });
  it("requires all five owned public fields and rejects unknown modes", () => {
    expect(() =>
      loadRepoEnv({ repoRoot: fixture(), baseEnv: { T3CODE_CONNECT_MODE: "owned" } }),
    ).toThrow(/complete/i);
    expect(() =>
      loadRepoEnv({ repoRoot: fixture(), baseEnv: { T3CODE_CONNECT_MODE: "typo" } }),
    ).toThrow(/mode/i);
  });
});

describe("cloudless and public receipts", () => {
  it("explicitly empties managed aliases against Object.assign resurrection and preserves private inputs", () => {
    const baseEnv = {
      ...owned,
      T3CODE_CONNECT_MODE: "cloudless",
      VITE_CLERK_PUBLISHABLE_KEY: "ambient",
      T3_PWA_RELAY_URL: "ambient-native",
      EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: "ambient-google",
      T3_PWA_KEYSTORE: "private-signing",
    };
    const loaded = loadRepoEnv({ repoRoot: fixture({ ".env.local": envText(owned) }), baseEnv });
    const effective = Object.assign({ ...baseEnv }, loaded);
    for (const key of [
      ...Object.keys(owned),
      "VITE_CLERK_PUBLISHABLE_KEY",
      "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
      "T3_PWA_RELAY_URL",
      "EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID",
      "VITE_CONNECT_HOSTED_APP_URL",
    ])
      expect(effective[key]).toBe("");
    expect(effective.T3_PWA_KEYSTORE).toBe("private-signing");
    expect(baseEnv.T3CODE_RELAY_URL).toBe(owned.T3CODE_RELAY_URL);
    expect(
      androidManagedAuthBuildEnv(resolvePublicConfig(loaded)).T3_PWA_CLERK_PUBLISHABLE_KEY,
    ).toBe("");
  });
  it("creates stable normalized public-only receipts and digests", () => {
    const env = loadRepoEnv({
      repoRoot: fixture(),
      baseEnv: {
        ...owned,
        T3CODE_CONNECT_MODE: "owned",
        PRIVATE_TOKEN: "private",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "private-tracing",
      },
    });
    const receipt = connectProfileReceipt(env);
    expect(Object.keys(receipt)).toHaveLength(7);
    expect(JSON.stringify(receipt)).not.toContain("private");
    expect(connectProfileDigest(receipt)).toMatch(/^[a-f0-9]{64}$/);
    expect(connectProfileDigest(receipt)).toBe(
      connectProfileDigest(connectProfileReceipt({ ...owned, T3CODE_CONNECT_MODE: "owned" })),
    );
    expect(connectProfileDigest(receipt)).not.toBe(
      connectProfileDigest(connectProfileReceipt({ ...env, T3CODE_CONNECT_MODE: "cloudless" })),
    );
  });
});

describe("build surface projections", () => {
  it("supports a frozen public profile outside the checkout", () => {
    const profileRoot = fixture({ "frozen.json": JSON.stringify(owned) });
    const env = loadRepoEnv({
      repoRoot: fixture(),
      baseEnv: {
        T3CODE_CONNECT_MODE: "owned",
        T3CODE_CONNECT_PROFILE_FILE: NodePath.join(profileRoot, "frozen.json"),
      },
    });
    expect(env.T3CODE_RELAY_URL).toBe("https://relay.example.test");
  });
  it("uses the configured Expo issuer and removes cloudless credential associations", () => {
    const env = loadRepoEnv({
      repoRoot: fixture(),
      baseEnv: { ...owned, T3CODE_CONNECT_MODE: "owned" },
    });
    const mobile = mobileConnectBuildConfig(env);
    expect(mobile.associatedDomains).toEqual([
      "applinks:sample.accounts.dev",
      "webcredentials:sample.accounts.dev",
    ]);
    expect(mobile.profile).toEqual(connectProfileReceipt(env));
    const cloudless = mobileConnectBuildConfig({ ...env, T3CODE_CONNECT_MODE: "cloudless" });
    expect(cloudless.associatedDomains).toEqual([]);
    expect(cloudless.clerkPluginEnabled).toBe(false);
    expect(mobileConnectBuildConfig({}).associatedDomains).toEqual([
      "applinks:clerk.t3.codes",
      "webcredentials:clerk.t3.codes",
    ]);
  });
  it("keeps Android, desktop and local web classification apart from the remote auth origin", () => {
    expect(webSurfaceHostedAppUrl(owned, true)).toBe("https://appassets.androidplatform.net");
    expect(webSurfaceHostedAppUrl(owned, false)).toBeUndefined();
    expect(
      webSurfaceHostedAppUrl({ ...owned, VITE_HOSTED_APP_URL: owned.T3CODE_HOSTED_APP_URL }, false),
    ).toBe(owned.T3CODE_HOSTED_APP_URL);
    expect(webSurfaceHostedAppUrl({ ...owned, VERCEL_URL: "deployment.example.test" }, false)).toBe(
      "https://deployment.example.test",
    );
  });
  it("blocks historical recovery from inheriting a current owned or cloudless profile", () => {
    expect(() =>
      assertLegacyRecoveryConnectSelection({ ...owned, T3CODE_CONNECT_MODE: "owned" }),
    ).toThrow(/original artifact/);
    expect(() =>
      assertLegacyRecoveryConnectSelection({ T3CODE_CONNECT_MODE: "cloudless" }),
    ).toThrow(/original artifact/);
    expect(() =>
      assertLegacyRecoveryConnectSelection({ T3CODE_CONNECT_PROFILE_FILE: "frozen.json" }),
    ).toThrow(/original artifact/);
    expect(() => assertLegacyRecoveryConnectSelection({})).not.toThrow();
  });
});

it("retains valid Expo runtime policies and rejects invalid input without disclosing its value", () => {
  expect(resolveMobileVersionPolicy(undefined, true)).toBe("appVersion");
  expect(resolveMobileVersionPolicy(undefined, false)).toBe("fingerprint");
  for (const policy of ["appVersion", "fingerprint", "nativeVersion", "sdkVersion"])
    expect(resolveMobileVersionPolicy(policy, false)).toBe(policy);
  expect(() => resolveMobileVersionPolicy("private-fixture", false)).toThrow(
    "Invalid MOBILE_VERSION_POLICY; require an Expo runtime version policy.",
  );
});
