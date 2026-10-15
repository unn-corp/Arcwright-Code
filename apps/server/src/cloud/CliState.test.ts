import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as CliState from "./CliState.ts";
import {
  CLOUD_PUBLIC_AUTHORITY_SECRET,
  CLOUD_LOCAL_DISABLED_SECRET,
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINK_REVOKED,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";

const persistedCloudLinkSecrets = [
  CLOUD_PUBLIC_AUTHORITY_SECRET,
  CLOUD_LOCAL_DISABLED_SECRET,
  CLOUD_LINKED_USER_ID,
  RELAY_URL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  CLOUD_MINT_PUBLIC_KEY,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET,
] as const;

const layerTest = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-cloud-cli-state-test-",
      }),
    ),
  );

it.layer(NodeServices.layer)("CliState", (it) => {
  it.effect("persists desired exposure and clears provisioned relay state", () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;

      assert.isFalse(yield* CliState.readCliDesiredCloudLink);
      yield* CliState.setCliDesiredCloudLink(true);
      assert.isTrue(yield* CliState.readCliDesiredCloudLink);

      for (const name of persistedCloudLinkSecrets) {
        yield* secrets.set(name, new TextEncoder().encode(name));
      }
      yield* CliState.clearPersistedCloudLink;

      assert.isFalse(yield* CliState.readCliDesiredCloudLink);
      for (const name of persistedCloudLinkSecrets) {
        assert.isTrue(Option.isNone(yield* secrets.get(name)));
      }
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("drops only a revoked link, keeping the sign-in and preferences", () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const dropped = [
        CLOUD_LINKED_USER_ID,
        RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
        CLOUD_MINT_PUBLIC_KEY,
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
      ];
      const kept = [RELAY_URL_SECRET, PUBLISH_AGENT_ACTIVITY_SECRET];
      for (const name of [...dropped, ...kept]) {
        yield* secrets.set(name, new TextEncoder().encode(name));
      }
      yield* CliState.setCliDesiredCloudLink(true);

      assert.isFalse(yield* CliState.dropRevokedCloudLink);
      assert.isTrue(Option.isSome(yield* secrets.get(CLOUD_LINKED_USER_ID)));

      yield* secrets.set(CLOUD_LINK_REVOKED, new TextEncoder().encode("true"));
      assert.isTrue(yield* CliState.dropRevokedCloudLink);
      for (const name of [...dropped, CLOUD_LINK_REVOKED]) {
        assert.isTrue(Option.isNone(yield* secrets.get(name)));
      }
      for (const name of kept) {
        assert.isTrue(Option.isSome(yield* secrets.get(name)));
      }
      assert.isTrue(yield* CliState.readCliDesiredCloudLink);
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("round-trips the desired link mode and defaults legacy links to managed", () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;

      assert.equal(yield* CliState.readCliDesiredLinkMode, "managed");

      yield* CliState.setCliDesiredCloudLink(true, "publish_only");
      assert.isTrue(yield* CliState.readCliDesiredCloudLink);
      assert.equal(yield* CliState.readCliDesiredLinkMode, "publish_only");

      yield* CliState.setCliDesiredCloudLink(true, "managed");
      assert.equal(yield* CliState.readCliDesiredLinkMode, "managed");

      // A pre-existing link persisted the literal "true"; treat it as managed.
      yield* secrets.set(CliState.CLOUD_CLI_DESIRED_LINK_SECRET, new TextEncoder().encode("true"));
      assert.isTrue(yield* CliState.readCliDesiredCloudLink);
      assert.equal(yield* CliState.readCliDesiredLinkMode, "managed");

      yield* CliState.setCliDesiredCloudLink(false);
      assert.equal(yield* CliState.readCliDesiredLinkMode, "managed");
    }).pipe(Effect.provide(layerTest())),
  );
  it.effect("keeps the authority binding when authorization material cannot be removed", () =>
    Effect.gen(function* () {
      const values = new Map<string, Uint8Array>([
        [CLOUD_PUBLIC_AUTHORITY_SECRET, new TextEncoder().encode("known-authority")],
        [CLOUD_LOCAL_DISABLED_SECRET, new TextEncoder().encode("true")],
        [CLOUD_MINT_PUBLIC_KEY, new TextEncoder().encode("old-mint-key")],
      ]);
      const store = ServerSecretStore.ServerSecretStore.of({
        get: (name) => Effect.succeed(Option.fromNullishOr(values.get(name))),
        set: () => Effect.die("unused"),
        create: () => Effect.die("unused"),
        getOrCreateRandom: () => Effect.die("unused"),
        remove: (name) =>
          name === CLOUD_MINT_PUBLIC_KEY
            ? Effect.fail(
                new ServerSecretStore.SecretStoreRemoveError({
                  resource: name,
                  cause: "fixture-denied",
                }),
              )
            : Effect.sync(() => {
                values.delete(name);
              }),
      });
      yield* Effect.flip(
        CliState.clearPersistedCloudLink.pipe(
          Effect.provideService(ServerSecretStore.ServerSecretStore, store),
        ),
      );
      assert.isTrue(values.has(CLOUD_PUBLIC_AUTHORITY_SECRET));
      assert.isTrue(values.has(CLOUD_LOCAL_DISABLED_SECRET));
      assert.isTrue(values.has(CLOUD_MINT_PUBLIC_KEY));
    }),
  );
});
