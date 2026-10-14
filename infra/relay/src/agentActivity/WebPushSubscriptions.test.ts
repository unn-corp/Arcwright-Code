import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EnvironmentId } from "@t3tools/contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import * as WebPushSubscriptions from "./WebPushSubscriptions.ts";
import { relayWebPushSubscriptions } from "../persistence/schema.ts";

it.effect(
  "preserves persisted SHA-256 installation credentials with the public Base64Url encoder",
  () => {
    // Isolated DB adapter: exercise registration/removal rather than testing the encoder itself.
    const knownHash = "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"; // SHA-256("abc"), unpadded base64url.
    let saved:
      | {
          installationSecretHash: string;
          installationId: string;
          endpoint: string;
          userId: string;
          incarnationId?: string;
        }
      | undefined;
    const db = {
      $client: { withTransaction: (effect: Effect.Effect<unknown>) => effect },
      execute: () => Effect.void,
      select: () => ({
        from: () => ({
          where: (condition: SQL) => ({
            orderBy: () => ({
              for: () => Effect.succeed(saved ? [{ ...saved, id: "subscription-fixture" }] : []),
            }),
            limit: () =>
              Effect.succeed(
                saved &&
                  new PgDialect()
                    .sqlToQuery(condition)
                    .params.includes(saved.installationSecretHash)
                  ? [
                      {
                        id: "subscription-fixture",
                        ...saved,
                      },
                    ]
                  : [],
              ),
          }),
        }),
      }),
      insert: () => ({
        values: (values: {
          installationSecretHash: string;
          installationId: string;
          endpoint: string;
          userId: string;
        }) => {
          saved = values;
          return {
            onConflictDoNothing: () => Effect.void,
            onConflictDoUpdate: () => ({
              returning: () => Effect.succeed([{ id: "subscription-fixture" }]),
            }),
          };
        },
      }),
      delete: (table: unknown) => ({
        where: (where: SQL) =>
          table === relayWebPushSubscriptions
            ? {
                returning: () =>
                  Effect.succeed(
                    new PgDialect().sqlToQuery(where).params.includes(knownHash)
                      ? [{ id: "subscription-fixture" }]
                      : [],
                  ),
              }
            : Effect.void,
      }),
    } as unknown as RelayDb.RelayDb["Service"];
    return Effect.gen(function* () {
      const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
      const installation = { installationId: "installation-fixture", installationSecret: "abc" };
      expect(
        yield* subscriptions.registerPwa({
          payload: {
            installation,
            environmentId: EnvironmentId.make("env-fixture"),
            endpoint: "https://push.example.test/fixture",
            keys: { p256dh: "fixture-key", auth: "fixture-auth" },
            preferences: {
              enabled: true,
              notifyOnCompletion: true,
              notifyOnPlanReady: true,
              notifyOnInput: true,
              notifyOnFailure: true,
              showProjectAndThreadNames: false,
            },
          },
        }),
      ).toEqual({ subscriptionId: "subscription-fixture" });
      expect(saved?.installationSecretHash).toBe(knownHash);
      expect(
        yield* subscriptions.removePwa({ ...installation, subscriptionId: "subscription-fixture" }),
      ).toBe(true);
      expect(
        yield* subscriptions.removePwa({
          ...installation,
          installationSecret: "wrong",
          subscriptionId: "subscription-fixture",
        }),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        WebPushSubscriptions.layer.pipe(
          Layer.provide(Layer.mergeAll(NodeCrypto.layer, Layer.succeed(RelayDb.RelayDb, db))),
        ),
      ),
    );
  },
);
