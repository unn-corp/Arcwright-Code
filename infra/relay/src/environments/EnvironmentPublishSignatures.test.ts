// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or sign.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  RelayCloudMintCredentialProofPayload,
  RelayCloudEnvironmentHealthProofPayload,
  RelayHookDeliveryProofPayload,
  RelayEnvironmentHealthResponseProofPayload,
  RelayEnvironmentMintResponseProofPayload,
} from "@t3tools/contracts/relay";
import type {
  RelayAgentActivityPublishProofPayload,
  RelayAgentActivityPublishRequest,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import { signRelayJwt, verifyRelayJwt, RELAY_ACTIVITY_PUBLISH_TYP } from "@t3tools/shared/relayJwt";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentPublishSignatures from "./EnvironmentPublishSignatures.ts";

const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make(keyPair.privateKey),
  cloudMintPublicKey: keyPair.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const state: RelayAgentActivityState = {
  environmentId: "env" as RelayAgentActivityState["environmentId"],
  threadId: "thread" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Running",
  updatedAt: "2026-05-25T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};
const isEnvironmentPublishSignatureInvalid = Schema.is(
  EnvironmentPublishSignatures.EnvironmentPublishSignatureInvalid,
);

function signTestJwt(payload: object, privateKey: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: RELAY_ACTIVITY_PUBLISH_TYP }),
  ).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

const freshRequest = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const payload = {
    iss: "t3-env:env",
    aud: "https://relay.example.test",
    sub: "env",
    jti: "publish-jti",
    iat: Math.floor(now.epochMilliseconds / 1_000),
    exp: Math.floor(DateTime.add(now, { minutes: 5 }).epochMilliseconds / 1_000),
    environmentId: state.environmentId,
    threadId: state.threadId,
    state,
  } satisfies RelayAgentActivityPublishProofPayload;
  return {
    state,
    proof: signTestJwt(payload, keyPair.privateKey),
  } satisfies RelayAgentActivityPublishRequest;
});

function layer(replay?: Partial<DpopProofs.DpopProofReplay["Service"]>) {
  return EnvironmentPublishSignatures.layer.pipe(
    Layer.provide(
      Layer.merge(
        RelayConfiguration.layer(config),
        Layer.succeed(DpopProofs.DpopProofReplay, {
          verify: () => Effect.die("unexpected stateless DPoP verification"),
          consumeVerified: () => Effect.die("unexpected DPoP consumption"),
          verifyAndConsume:
            replay?.verifyAndConsume ?? (() => Effect.die("unexpected DPoP proof verification")),
          consume: replay?.consume ?? (() => Effect.succeed(true)),
          pruneExpired: replay?.pruneExpired ?? Effect.void,
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("EnvironmentPublishSignatures", () => {
  it.effect("verifies activity JWTs and scopes replay storage to the environment key", () => {
    let replayThumbprint: string | null = null;
    return Effect.gen(function* () {
      const request = yield* freshRequest;
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      yield* signatures.verify({
        environmentId: state.environmentId,
        environmentPublicKey: keyPair.publicKey,
        threadId: state.threadId,
        request,
      });
      expect(replayThumbprint).toBe(
        `env-publish:${NodeCrypto.createHash("sha256")
          .update(
            stableStringify({
              environmentId: state.environmentId,
              environmentPublicKey: keyPair.publicKey,
            }),
          )
          .digest("base64url")}`,
      );
    }).pipe(
      Effect.provide(
        layer({
          consume: (input) =>
            Effect.sync(() => {
              replayThumbprint = input.thumbprint;
              return true;
            }),
        }),
      ),
    );
  });

  it.effect("rejects top-level state tampering", () =>
    Effect.gen(function* () {
      const request = yield* freshRequest;
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      const result = yield* Effect.result(
        signatures.verify({
          environmentId: state.environmentId,
          environmentPublicKey: keyPair.publicKey,
          threadId: state.threadId,
          request: { ...request, state: { ...state, headline: "Tampered" } },
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentPublishSignatureInvalid(result.failure)).toBe(true);
        if (isEnvironmentPublishSignatureInvalid(result.failure)) {
          expect(result.failure).toMatchObject({
            environmentId: state.environmentId,
            threadId: state.threadId,
            reason: "invalid_signature_or_payload",
            stage: "validate_claims",
          });
        }
      }
    }).pipe(Effect.provide(layer())),
  );

  it.effect("preserves the JWT verification failure", () =>
    Effect.gen(function* () {
      const request = yield* freshRequest;
      const segments = request.proof.split(".");
      const signature = segments[2]!;
      segments[2] = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      const result = yield* Effect.result(
        signatures.verify({
          environmentId: state.environmentId,
          environmentPublicKey: keyPair.publicKey,
          threadId: state.threadId,
          request: { ...request, proof: segments.join(".") },
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentPublishSignatureInvalid(result.failure)).toBe(true);
        if (isEnvironmentPublishSignatureInvalid(result.failure)) {
          expect(result.failure).toMatchObject({
            environmentId: state.environmentId,
            threadId: state.threadId,
            reason: "invalid_signature_or_payload",
            stage: "verify_proof",
            cause: { _tag: "RelayJwtError" },
          });
        }
      }
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rejects replayed activity JWT ids", () =>
    Effect.gen(function* () {
      const request = yield* freshRequest;
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      const result = yield* Effect.result(
        signatures.verify({
          environmentId: state.environmentId,
          environmentPublicKey: keyPair.publicKey,
          threadId: state.threadId,
          request,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentPublishSignatureInvalid(result.failure)).toBe(true);
        if (isEnvironmentPublishSignatureInvalid(result.failure)) {
          expect(result.failure).toMatchObject({
            environmentId: state.environmentId,
            threadId: state.threadId,
            reason: "replayed_nonce",
            stage: "consume_nonce",
          });
        }
      }
    }).pipe(Effect.provide(layer({ consume: () => Effect.succeed(false) }))),
  );
});

const localClaimFixtures: ReadonlyArray<{
  readonly name: string;
  readonly decode: (
    input: unknown,
  ) => Effect.Effect<
    { readonly iss: string; readonly aud: string; readonly sub: string; readonly jti: string },
    Schema.SchemaError
  >;
  readonly fields: Readonly<Record<string, unknown>>;
}> = [
  {
    name: "cloud mint",
    decode: Schema.decodeUnknownEffect(RelayCloudMintCredentialProofPayload),
    fields: {
      clientProofKeyThumbprint: "thumb",
      cnf: { jkt: "thumb" },
      nonce: "nonce",
      scope: ["environment:connect"],
    },
  },
  {
    name: "cloud health",
    decode: Schema.decodeUnknownEffect(RelayCloudEnvironmentHealthProofPayload),
    fields: { nonce: "nonce", scope: ["environment:status"] },
  },
  {
    name: "forwarded hook",
    decode: Schema.decodeUnknownEffect(RelayHookDeliveryProofPayload),
    fields: { deliveryId: "delivery", receivedAt: "2026-10-14T00:00:00Z", hookId: "hook" },
  },
  {
    name: "health response",
    decode: Schema.decodeUnknownEffect(RelayEnvironmentHealthResponseProofPayload),
    fields: {
      requestNonce: "nonce",
      status: "online",
      checkedAt: "2026-10-14T00:00:00Z",
      descriptor: {
        environmentId: "env",
        label: "Fixture",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "fixture",
        capabilities: { repositoryIdentity: true },
      },
    },
  },
  {
    name: "mint response",
    decode: Schema.decodeUnknownEffect(RelayEnvironmentMintResponseProofPayload),
    fields: { clientProofKeyThumbprint: "thumb", requestNonce: "nonce", credential: "credential" },
  },
];
it.effect.each(localClaimFixtures)(
  "preserves genuinely verified $name proof registered-claim compatibility",
  ({ decode, fields }) =>
    Effect.gen(function* () {
      const ordinary = {
        iss: "https://relay.test",
        aud: "t3-env:env",
        sub: "user",
        jti: "ordinary",
        iat: 1791936000,
        exp: 1791936060,
        environmentId: "env",
        ...fields,
      };
      const overLimits = {
        iss: "i".repeat(4097),
        aud: "a".repeat(4097),
        sub: "s".repeat(192),
        jti: "j".repeat(256),
      };
      for (const claims of [
        ordinary,
        ...Object.entries(overLimits).map(([name, value]) => ({ ...ordinary, [name]: value })),
        { ...ordinary, ...overLimits },
      ]) {
        const token = yield* signRelayJwt({
          privateKey: keyPair.privateKey,
          typ: "compatibility-local-proof+jwt",
          payload: claims,
        });
        const verified = yield* verifyRelayJwt({
          publicKey: keyPair.publicKey,
          token,
          typ: "compatibility-local-proof+jwt",
          issuer: claims.iss,
          audience: claims.aud,
          nowEpochSeconds: claims.iat,
        });
        const decoded = yield* decode(verified);
        expect(decoded).toMatchObject({
          iss: claims.iss,
          aud: claims.aud,
          sub: claims.sub,
          jti: claims.jti,
        });
      }
      expect((yield* Effect.exit(decode({ ...ordinary, jti: " " })))._tag).toBe("Failure");
    }),
);

it.effect(
  "stateless EdDSA publication verification postpones replay persistence until consumeVerified",
  () => {
    let consumed = 0;
    return Effect.gen(function* () {
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      const request = yield* freshRequest;
      const input = {
        environmentId: state.environmentId,
        environmentPublicKey: keyPair.publicKey,
        threadId: state.threadId,
        request,
      };
      const proof = yield* signatures.verifyStateless(input);
      expect(yield* signatures.verifyStateless(input)).toEqual(proof);
      expect(consumed).toBe(0);
      yield* signatures.consumeVerified(proof);
      expect(consumed).toBe(1);
      expect(yield* Effect.flip(signatures.consumeVerified(proof))).toMatchObject({
        _tag: "EnvironmentPublishSignatureInvalid",
        reason: "replayed_nonce",
        stage: "consume_nonce",
      });
      expect(consumed).toBe(2);
    }).pipe(Effect.provide(layer({ consume: () => Effect.sync(() => ++consumed === 1) })));
  },
);
