import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  clerkAuthPolicyConfig,
  legacyManagedEndpointCleanupModeConfig,
  legacyTunnelGraceMinutesConfig,
  managedEndpointCleanupModeConfig,
} from "./Config.ts";

const ownedAuthEnv = {
  RELAY_CLERK_AUTH_MODE: "owned",
  RELAY_CLERK_ISSUER: "https://clerk.arcwright.space",
  RELAY_CLERK_CLI_CLIENT_ID: "VS3HcN01wPJotPrs",
};

it.effect(
  "defaults an untouched deployment deliberately to legacy, or selects complete owned policy",
  () =>
    Effect.gen(function* () {
      expect(yield* clerkAuthPolicyConfig.parse(ConfigProvider.fromEnv({ env: {} }))).toEqual({
        mode: "legacy",
      });
      expect(
        yield* clerkAuthPolicyConfig.parse(ConfigProvider.fromEnv({ env: ownedAuthEnv })),
      ).toEqual({
        mode: "owned",
        issuer: ownedAuthEnv.RELAY_CLERK_ISSUER,
        cliClientId: ownedAuthEnv.RELAY_CLERK_CLI_CLIENT_ID,
      });
    }),
);

it.effect.each([
  { RELAY_CLERK_AUTH_MODE: "unknown" },
  { RELAY_CLERK_AUTH_MODE: "" },
  { RELAY_CLERK_AUTH_MODE: "owned" },
  { RELAY_CLERK_AUTH_MODE: "owned", RELAY_CLERK_ISSUER: ownedAuthEnv.RELAY_CLERK_ISSUER },
  {
    RELAY_CLERK_AUTH_MODE: "owned",
    RELAY_CLERK_CLI_CLIENT_ID: ownedAuthEnv.RELAY_CLERK_CLI_CLIENT_ID,
  },
  { RELAY_CLERK_ISSUER: ownedAuthEnv.RELAY_CLERK_ISSUER },
  {
    RELAY_CLERK_AUTH_MODE: "legacy",
    RELAY_CLERK_CLI_CLIENT_ID: ownedAuthEnv.RELAY_CLERK_CLI_CLIENT_ID,
  },
  { ...ownedAuthEnv, RELAY_CLERK_CLI_CLIENT_ID: "" },
  { ...ownedAuthEnv, RELAY_CLERK_CLI_CLIENT_ID: "oa_resourceId" },
  { ...ownedAuthEnv, RELAY_CLERK_CLI_CLIENT_ID: "client id" },
])("rejects partial or invalid auth deployment configuration %j", (env) =>
  Effect.gen(function* () {
    expect(
      (yield* Effect.flip(
        clerkAuthPolicyConfig.parse(ConfigProvider.fromEnv({ env, preserveEmptyStrings: true })),
      ))._tag,
    ).toBe("ConfigError");
  }),
);

it.effect.each([
  "http://clerk.arcwright.space",
  "https://clerk.arcwright.space/",
  "https://clerk.arcwright.space/path",
  "https://clerk.arcwright.space?query",
  "https://clerk.arcwright.space#hash",
  "https://user@clerk.arcwright.space",
  "https://clerk.arcwright.space/../",
  "https://clerk.arcwright.space\\path",
  "https://",
  "not-a-url",
])("rejects issuer %s rather than normalizing attacker syntax", (issuer) =>
  Effect.gen(function* () {
    expect(
      (yield* Effect.flip(
        clerkAuthPolicyConfig.parse(
          ConfigProvider.fromEnv({ env: { ...ownedAuthEnv, RELAY_CLERK_ISSUER: issuer } }),
        ),
      ))._tag,
    ).toBe("ConfigError");
  }),
);

it.effect.each([
  { name: "missing", env: {}, expected: "off" },
  { name: "empty", env: { RELAY_TUNNEL_CLEANUP_MODE: "" }, expected: "off" },
  { name: "whitespace", env: { RELAY_TUNNEL_CLEANUP_MODE: "  \t" }, expected: "off" },
  { name: "off", env: { RELAY_TUNNEL_CLEANUP_MODE: "off" }, expected: "off" },
  {
    name: "dry-run",
    env: { RELAY_TUNNEL_CLEANUP_MODE: "dry-run" },
    expected: "dry-run",
  },
  { name: "enabled", env: { RELAY_TUNNEL_CLEANUP_MODE: "enabled" }, expected: "enabled" },
] as const)("loads $name cleanup mode as $expected", ({ env, expected }) =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromEnv({ env });
    expect(yield* managedEndpointCleanupModeConfig.parse(provider)).toBe(expected);
  }),
);

it.effect("rejects an invalid cleanup mode", () =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromEnv({
      env: { RELAY_TUNNEL_CLEANUP_MODE: "delete-everything" },
    });
    const error = yield* Effect.flip(managedEndpointCleanupModeConfig.parse(provider));

    expect(error._tag).toBe("ConfigError");
    expect(error.message).toContain('Expected "off" | "dry-run" | "enabled"');
  }),
);

it.effect("reads the legacy cleanup mode independently of the main one", () =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromEnv({
      env: { RELAY_TUNNEL_CLEANUP_MODE: "enabled", RELAY_LEGACY_TUNNEL_CLEANUP_MODE: "dry-run" },
    });
    expect(yield* managedEndpointCleanupModeConfig.parse(provider)).toBe("enabled");
    expect(yield* legacyManagedEndpointCleanupModeConfig.parse(provider)).toBe("dry-run");
    expect(
      yield* legacyManagedEndpointCleanupModeConfig.parse(ConfigProvider.fromEnv({ env: {} })),
    ).toBe("off");
  }),
);

it.effect.each([
  { name: "missing", env: {}, expected: Option.none() },
  {
    name: "positive",
    env: { RELAY_LEGACY_TUNNEL_GRACE_MINUTES: "10" },
    expected: Option.some(10),
  },
] as const)("loads a $name legacy grace override", ({ env, expected }) =>
  Effect.gen(function* () {
    const minutes = yield* legacyTunnelGraceMinutesConfig.parse(ConfigProvider.fromEnv({ env }));
    expect(minutes).toEqual(expected);
  }),
);

it.effect.each(["0", "-10"])("rejects a grace override of %s minutes", (value) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      legacyTunnelGraceMinutesConfig.parse(
        ConfigProvider.fromEnv({ env: { RELAY_LEGACY_TUNNEL_GRACE_MINUTES: value } }),
      ),
    );
    expect(error._tag).toBe("ConfigError");
  }),
);
