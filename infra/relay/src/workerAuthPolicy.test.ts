import * as Cloudflare from "@alchemy.run/cloudflare";
import { reifyBoundConfigProvider } from "alchemy/Runtime";
import { expect, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { clerkAuthPolicyConfig } from "./Config.ts";
import { loadWorkerClerkAuthPolicy } from "./workerAuthPolicy.ts";

const owned = {
  RELAY_CLERK_AUTH_MODE: "owned",
  RELAY_CLERK_ISSUER: "https://clerk.arcwright.space",
  RELAY_CLERK_CLI_CLIENT_ID: "VS3HcN01wPJotPrs",
};
const policy = {
  mode: "owned",
  issuer: owned.RELAY_CLERK_ISSUER,
  cliClientId: owned.RELAY_CLERK_CLI_CLIENT_ID,
};

it.effect.each([
  { name: "absent", env: {}, expected: { mode: "legacy" } },
  {
    name: "explicit legacy",
    env: { RELAY_CLERK_AUTH_MODE: "legacy" },
    expected: { mode: "legacy" },
  },
  { name: "complete owned", env: owned, expected: policy },
])("loads $name policy through actual provider/Worker environment seams", ({ env, expected }) =>
  Effect.gen(function* () {
    for (const provider of [ConfigProvider.fromEnv({ env }), ConfigProvider.fromUnknown(env)]) {
      expect(
        yield* clerkAuthPolicyConfig.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, provider),
        ),
      ).toEqual(expected);
    }
    // WorkerBridge installs fromUnknown(env) and provides the original raw environment.
    expect(
      yield* loadWorkerClerkAuthPolicy.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
        Effect.provideService(Cloudflare.WorkerEnvironment, env),
      ),
    ).toEqual(expected);
    // Plan provides {}, but must retain the already validated operator-owned policy.
    expect(
      yield* clerkAuthPolicyConfig.pipe(
        Effect.andThen(loadWorkerClerkAuthPolicy),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
        Effect.provideService(Cloudflare.WorkerEnvironment, {}),
      ),
    ).toEqual(expected);
  }),
);

it.effect.each([
  { RELAY_CLERK_AUTH_MODE: "" },
  { RELAY_CLERK_ISSUER: "" },
  { RELAY_CLERK_CLI_CLIENT_ID: "" },
  { RELAY_CLERK_AUTH_MODE: "", RELAY_CLERK_ISSUER: "", RELAY_CLERK_CLI_CLIENT_ID: "" },
  { RELAY_CLERK_AUTH_MODE: "owned" },
  { RELAY_CLERK_AUTH_MODE: "legacy", RELAY_CLERK_ISSUER: "" },
  { ...owned, RELAY_CLERK_ISSUER: "" },
  { ...owned, RELAY_CLERK_CLI_CLIENT_ID: "" },
])("rejects raw invalid policy before runtime/init %j", (env) =>
  Effect.gen(function* () {
    expect(
      (yield* Effect.flip(
        loadWorkerClerkAuthPolicy.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
          Effect.provideService(Cloudflare.WorkerEnvironment, env),
        ),
      ))._tag,
    ).toBe("ConfigError");
    let builtWorker = false;
    const workerLayer = Layer.effectDiscard(
      Effect.sync(() => {
        builtWorker = true;
      }),
    );
    // Same sequencing used by alchemy.run: preflight precedes Layer provisioning.
    yield* Effect.flip(
      clerkAuthPolicyConfig.pipe(
        Effect.andThen(loadWorkerClerkAuthPolicy.pipe(Effect.provide(workerLayer))),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
        Effect.provideService(Cloudflare.WorkerEnvironment, {}),
      ),
    );
    expect(builtWorker).toBe(false);
  }),
);

it.effect("guards only Clerk policy without changing unrelated empty-config defaults", () =>
  Effect.gen(function* () {
    const env = { OTHER_CONFIG: "" };
    yield* loadWorkerClerkAuthPolicy.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
      Effect.provideService(Cloudflare.WorkerEnvironment, env),
    );
    expect(
      yield* Config.String("OTHER_CONFIG").pipe(
        Config.withDefault("default"),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
      ),
    ).toBe("default");
  }),
);

it.effect(
  "accepts actual Alchemy marker reification without treating plan's empty env as policy",
  () =>
    Effect.gen(function* () {
      const raw = Object.fromEntries(
        Object.entries(owned).map(([key, value]) => [
          key,
          JSON.stringify({ _tag: "Redacted", value }),
        ]),
      );
      const provider = ConfigProvider.orElse(
        ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
        reifyBoundConfigProvider(ConfigProvider.fromUnknown(raw), raw),
      );
      expect(
        yield* loadWorkerClerkAuthPolicy.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, provider),
          Effect.provideService(Cloudflare.WorkerEnvironment, raw),
        ),
      ).toEqual(policy);
    }),
);

it.effect("Worker init reads only auth leaves and never auto-binds parent records", () =>
  Effect.gen(function* () {
    const base = ConfigProvider.fromEnv({ env: owned });
    // Simulate the installed interceptor's binding seam; parent lookups would fail the test.
    const captured: string[] = [];
    const provider = ConfigProvider.make((path) => {
      expect(path).toHaveLength(1);
      const key = path[0];
      expect(typeof key).toBe("string");
      return base.load(path).pipe(
        Effect.tap((node) =>
          Effect.sync(() => {
            expect(node?._tag).toBe("Value");
            expect(node?.value).not.toBeUndefined();
            if (typeof key === "string") captured.push(key);
          }),
        ),
      );
    });
    expect(
      yield* loadWorkerClerkAuthPolicy.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, provider),
        Effect.provideService(Cloudflare.WorkerEnvironment, {}),
      ),
    ).toEqual(policy);
    expect(captured).toEqual(Object.keys(owned));
  }),
);
