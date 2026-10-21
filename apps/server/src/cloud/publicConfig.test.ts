import { assert, it } from "@effect/vitest";
import { selectConnectProfile } from "@t3tools/shared/connectProfile";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  hostedAppUrlConfig,
  makeEffectiveConnectProfileConfig,
  makeHostedAppUrlConfig,
  makeCloudCliOAuthConfig,
  makeRelayUrlConfig,
  resolveRelayClientTracingConfig,
} from "./publicConfig.ts";

const provideEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

it.effect("rejects an insecure runtime relay URL override", () =>
  makeRelayUrlConfig("https://embedded.example.test").pipe(
    provideEnv({ T3CODE_RELAY_URL: "http://runtime.example.test" }),
    Effect.flip,
  ),
);

it.effect("rejects malformed or insecure hosted app URLs", () =>
  Effect.gen(function* () {
    for (const value of [
      "app.t3.codes",
      "http://app.t3.codes",
      "https://app.t3.codes/nested",
      "https://app.t3.codes?alias=true",
    ]) {
      const result = yield* hostedAppUrlConfig.pipe(
        provideEnv({ T3CODE_HOSTED_APP_URL: value }),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(result), value);
    }
  }),
);

it.effect("derives direct Clerk OAuth endpoints from statically injected public config", () =>
  Effect.gen(function* () {
    const config = yield* makeCloudCliOAuthConfig({
      clerkPublishableKeyFallback: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
      clerkCliOAuthClientIdFallback: "oauth_client_embedded",
    }).pipe(provideEnv({}));

    assert.deepEqual(config, {
      tokenEndpoint: "https://clerk.example.test/oauth/token",
      deviceAuthorizationEndpoint: "https://clerk.example.test/oauth/device_authorization",
      clientId: "oauth_client_embedded",
      loopbackPort: 34338,
      redirectUri: "http://127.0.0.1:34338/callback",
      scopes: ["openid", "profile", "email", "offline_access"],
    });
  }),
);

const ownedFields = {
  T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("sample.accounts.dev$")}`,
  T3CODE_CLERK_JWT_TEMPLATE: "arcwright-relay",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "client_sample",
  T3CODE_RELAY_URL: "https://relay.example.test",
  T3CODE_HOSTED_APP_URL: "https://app.example.test",
};
const ownedBuild = selectConnectProfile("owned", [ownedFields]);

it.effect(
  "uses the complete owned build profile for headless OAuth without upstream fallback",
  () =>
    Effect.gen(function* () {
      const profile = yield* makeEffectiveConnectProfileConfig(ownedBuild).pipe(provideEnv({}));
      assert.deepEqual(profile, ownedBuild);
      assert.equal(
        yield* makeHostedAppUrlConfig(undefined, ownedBuild).pipe(provideEnv({})),
        "https://app.example.test",
      );
      const oauth = yield* makeCloudCliOAuthConfig({
        connectProfileFallback: ownedBuild,
      }).pipe(provideEnv({}));
      assert.equal(oauth.tokenEndpoint, "https://sample.accounts.dev/oauth/token");
      assert.equal(oauth.clientId, "client_sample");
      assert.equal(
        yield* makeRelayUrlConfig(undefined, ownedBuild).pipe(provideEnv({})),
        ownedFields.T3CODE_RELAY_URL,
      );
    }),
);

it.effect("requires a complete atomic owned runtime alternative for every consumer", () =>
  Effect.gen(function* () {
    const replacement = {
      ...ownedFields,
      T3CODE_RELAY_URL: "https://replacement.example.test",
      T3CODE_HOSTED_APP_URL: "https://replacement-app.example.test",
    };
    assert.equal(
      yield* makeHostedAppUrlConfig(undefined, ownedBuild).pipe(provideEnv(replacement)),
      replacement.T3CODE_HOSTED_APP_URL,
    );
    for (const env of [
      { T3CODE_RELAY_URL: replacement.T3CODE_RELAY_URL },
      { T3CODE_HOSTED_APP_URL: replacement.T3CODE_HOSTED_APP_URL },
      { ...ownedFields, VITE_CLERK_JWT_TEMPLATE: "conflict" },
      { ...ownedFields, T3CODE_RELAY_URL: "https://relay.t3.codes" },
      { T3CODE_CONNECT_MODE: "legacy" },
      { T3CODE_CONNECT_MODE: "cloudless" },
    ]) {
      assert.isTrue(
        Result.isFailure(
          yield* makeEffectiveConnectProfileConfig(ownedBuild).pipe(provideEnv(env), Effect.result),
        ),
      );
    }
  }),
);

it.effect("allows a legacy build to select owned runtime mode only with a complete profile", () =>
  Effect.gen(function* () {
    const legacy = selectConnectProfile("legacy", []);
    assert.equal(
      (yield* makeEffectiveConnectProfileConfig(legacy).pipe(
        provideEnv({ ...ownedFields, T3CODE_CONNECT_MODE: "owned" }),
      )).mode,
      "owned",
    );
    assert.isTrue(
      Result.isFailure(
        yield* makeEffectiveConnectProfileConfig(legacy).pipe(
          provideEnv({
            T3CODE_CONNECT_MODE: "owned",
            T3CODE_RELAY_URL: ownedFields.T3CODE_RELAY_URL,
          }),
          Effect.result,
        ),
      ),
    );
  }),
);

it.effect("keeps cloudless build configuration empty despite ambient managed inputs", () =>
  Effect.gen(function* () {
    const cloudless = selectConnectProfile("cloudless", []);
    const profile = yield* makeEffectiveConnectProfileConfig(cloudless).pipe(
      provideEnv(ownedFields),
    );
    assert.equal(profile.T3CODE_CLERK_PUBLISHABLE_KEY, "");
    assert.equal(profile.T3CODE_HOSTED_APP_URL, "");
    assert.isTrue(
      Result.isFailure(
        yield* makeHostedAppUrlConfig(undefined, cloudless).pipe(
          provideEnv(ownedFields),
          Effect.result,
        ),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        yield* makeCloudCliOAuthConfig({
          connectProfileFallback: cloudless,
        }).pipe(provideEnv(ownedFields), Effect.result),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        yield* makeEffectiveConnectProfileConfig(cloudless).pipe(
          provideEnv({ ...ownedFields, T3CODE_CONNECT_MODE: "owned" }),
          Effect.result,
        ),
      ),
    );
  }),
);
it("product opt-out disables relay tracing with either built-in or runtime credentials", () => {
  const fallback = {
    tracesUrl: "https://embedded.example.test/v1/traces",
    tracesDataset: "embedded-dataset",
    tracesToken: "embedded-token",
  };
  const env = {
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "false",
  };

  assert.equal(resolveRelayClientTracingConfig(env, fallback), null);
  assert.equal(
    resolveRelayClientTracingConfig(
      {
        ...env,
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://runtime.example.test/v1/traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "runtime-dataset",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "runtime-token",
      },
      fallback,
    ),
    null,
  );
});
