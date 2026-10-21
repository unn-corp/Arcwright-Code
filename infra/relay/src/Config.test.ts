import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { parseClerkAuthPolicyConfig } from "./Config.ts";

const ownedAuthEnv = {
  RELAY_CLERK_AUTH_MODE: "owned",
  RELAY_CLERK_ISSUER: "https://clerk.arcwright.space",
  RELAY_CLERK_CLI_CLIENT_ID: "VS3HcN01wPJotPrs",
};

it.effect(
  "defaults an untouched deployment deliberately to legacy, or selects complete owned policy",
  () =>
    Effect.gen(function* () {
      expect(yield* parseClerkAuthPolicyConfig(ConfigProvider.fromEnv({ env: {} }))).toEqual({
        mode: "legacy",
      });
      expect(
        yield* parseClerkAuthPolicyConfig(ConfigProvider.fromEnv({ env: ownedAuthEnv })),
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
  { RELAY_CLERK_ISSUER: "" },
  { RELAY_CLERK_CLI_CLIENT_ID: "" },
  { RELAY_CLERK_AUTH_MODE: "", RELAY_CLERK_ISSUER: "", RELAY_CLERK_CLI_CLIENT_ID: "" },
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
    for (const provider of [ConfigProvider.fromEnv({ env }), ConfigProvider.fromUnknown(env)]) {
      expect((yield* Effect.flip(parseClerkAuthPolicyConfig(provider)))._tag).toBe("ConfigError");
    }
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
        parseClerkAuthPolicyConfig(
          ConfigProvider.fromEnv({ env: { ...ownedAuthEnv, RELAY_CLERK_ISSUER: issuer } }),
        ),
      ))._tag,
    ).toBe("ConfigError");
  }),
);
