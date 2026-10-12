import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { wakeHeldHooks } from "./HeldHooksWaker.ts";

it.effect.each(["compatible", "foreign", "cloudless", "legacy", "locally-disabled"] as const)(
  "wakes held webhooks only when %s authority admits saved credentials",
  (admission) => {
    const url =
      admission === "compatible" || admission === "locally-disabled"
        ? "https://selected.example.test"
        : "https://old.example.test";
    const values = new Map<string, Uint8Array>([
      ["cloud-relay-url", new TextEncoder().encode(url)],
      ["cloud-relay-issuer", new TextEncoder().encode(url)],
      ["cloud-linked-user-id", new TextEncoder().encode("fixture-user")],
      [
        "cloud-relay-environment-credential",
        new TextEncoder().encode("fixture-environment-credential"),
      ],
      ["cloud-hold-webhooks-while-offline", new TextEncoder().encode("true")],
    ]);
    if (admission === "locally-disabled")
      values.set("cloud-local-disabled", new TextEncoder().encode("true"));
    let calls = 0;
    const fetch: typeof globalThis.fetch = Object.assign(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        calls++;
        assert.include(String(input), url);
        return Response.json({ pending: true });
      },
      { preconnect: () => {} },
    );
    return Effect.gen(function* () {
      const result = yield* wakeHeldHooks();
      const admitted = admission === "compatible" || admission === "legacy";
      assert.equal(calls, admitted ? 1 : 0);
      assert.equal(result, admitted);
      assert.isTrue(values.has("cloud-relay-environment-credential"));
    }).pipe(
      Effect.provideService(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (name) => Effect.succeed(Option.fromNullishOr(values.get(name))),
          set: () => Effect.die("unused"),
          remove: () => Effect.die("unused"),
          create: () => Effect.die("unused"),
          getOrCreateRandom: () => Effect.die("unused"),
        }),
      ),
      Effect.provideService(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env-one")),
          getDescriptor: Effect.die("unused"),
        }),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env:
              admission === "legacy"
                ? {}
                : {
                    T3CODE_CONNECT_MODE: admission === "cloudless" ? "cloudless" : "owned",
                    T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
                    T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_client_test",
                    T3CODE_CLERK_JWT_TEMPLATE: "connect",
                    T3CODE_RELAY_URL: "https://selected.example.test",
                    T3CODE_HOSTED_APP_URL: "https://hosted.example.test",
                  },
          }),
        ),
      ),
    );
  },
);
