import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityPublishProofPayload } from "@t3tools/contracts/relay";
import * as RelayJwt from "@t3tools/shared/relayJwt";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { config, counters, fixture, owner, send } from "./publicRelayAdmissions.test-fixture.ts";
import { relayKeys, signFixtureJwt } from "./publicRelayProofs.test-fixture.ts";

const encoder = new TextEncoder();
const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("thread");
const publishUrl = `${config.relayIssuer}/v1/environments/${environmentId}/threads/${threadId}/agent-activity`;

const freshPublishRequest = Effect.fnUntraced(function* (payloadBytes: number) {
  const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
  const claims = {
    iss: `t3-env:${environmentId}`,
    aud: config.relayIssuer,
    sub: environmentId,
    jti: "exact-cap-proof",
    iat: now,
    exp: now + 300,
    environmentId,
    threadId,
    state: null,
    padding: "",
  } satisfies RelayAgentActivityPublishProofPayload & { readonly padding: string };
  const remaining = payloadBytes - encoder.encode(JSON.stringify(claims)).byteLength;
  // An unknown bounded string preserves every real claim and makes UTF-8 bytes
  // differ from character count without adding depth, keys, or array entries.
  const payload = {
    ...claims,
    padding: "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2),
  };
  const proof = yield* Effect.promise(() =>
    signFixtureJwt(payload, relayKeys.privateKey, "EdDSA", RelayJwt.RELAY_ACTIVITY_PUBLISH_TYP),
  );
  const decoded = atob(proof.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"));
  const body = JSON.stringify({ state: null, proof });
  expect(decoded.length).toBe(payloadBytes);
  expect(encoder.encode(JSON.stringify(payload)).byteLength).toBe(payloadBytes);
  expect(JSON.stringify(payload).length).toBeLessThan(payloadBytes);
  const tokenBytes = encoder.encode(proof).byteLength;
  const bodyBytes = encoder.encode(body).byteLength;
  expect(tokenBytes).toBeLessThanOrEqual(49_152);
  expect(bodyBytes).toBeLessThanOrEqual(65_536);
  return {
    proof,
    tokenBytes,
    bodyBytes,
    request: new Request(publishUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer t3env_fixture:${environmentId}`,
        "content-type": "application/json",
        origin: "https://client.example.test",
      },
      body,
    }),
  };
});

const checkPublish = Effect.fnUntraced(function* (
  publicKey: string,
  input: Effect.Success<ReturnType<typeof freshPublishRequest>>,
  accepted: boolean,
) {
  // Observe the real shared verifier and WebCrypto; spies retain their original
  // implementations. Signing finishes before this bracket starts.
  yield* Effect.acquireUseRelease(
    Effect.sync(() => ({
      jwt: vi.spyOn(RelayJwt, "verifyRelayJwt"),
      importKey: vi.spyOn(globalThis.crypto.subtle, "importKey"),
      verify: vi.spyOn(globalThis.crypto.subtle, "verify"),
    })),
    (observed) =>
      Effect.gen(function* () {
        const c = counters();
        const admitted: string[] = [];
        const endpoint = yield* fixture({
          counts: c,
          environmentPublicKey: publicKey,
          owners: () => [{ ...owner(), environmentPublicKey: publicKey }],
          admit: (_, subject) =>
            Effect.sync(() => {
              admitted.push(subject.kind);
              expect(c.replay).toBe(0);
              expect(c.writes).toBe(0);
              expect(c.business).toBe(0);
              if (subject.kind === "edge") {
                expect(c.credentials).toBe(0);
                expect(observed.jwt).not.toHaveBeenCalled();
              } else {
                expect(observed.jwt).toHaveBeenCalledOnce();
                expect(observed.importKey).toHaveBeenCalledOnce();
                expect(observed.verify).toHaveBeenCalledOnce();
                expect(c.owners).toBe(1);
              }
            }),
        });
        const response = yield* send(endpoint, input.request);
        expect(response.status).toBe(accepted ? 200 : 401);
        expect(c.credentials).toBe(1);
        expect(c.provider).toBe(0);
        expect(c.queues).toBe(0);
        expect(c.uuid).toBe(0);
        expect(c.signing).toBe(0);
        if (accepted) {
          expect(yield* Effect.promise(() => response.json())).toMatchObject({ ok: true });
          expect(observed.jwt).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              publicKey,
              token: input.proof,
              typ: RelayJwt.RELAY_ACTIVITY_PUBLISH_TYP,
              issuer: `t3-env:${environmentId}`,
              audience: config.relayIssuer,
            }),
          );
          expect(observed.importKey).toHaveBeenCalledOnce();
          expect(observed.importKey.mock.calls[0]?.[0]).toBe("spki");
          expect(observed.verify).toHaveBeenCalledOnce();
          expect(admitted).toEqual(["edge", "environment", "user"]);
          expect(c.owners).toBe(1);
          expect(c.crypto).toBe(2);
          expect(c.replay).toBe(1);
          expect(c.writes).toBe(2);
          expect(c.business).toBe(2);
          expect(c.recipients).toEqual(["user_verified"]);
        } else {
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            _tag: "RelayAgentActivityPublishProofInvalidError",
            code: "agent_activity_publish_proof_invalid",
            reason: "invalid_signature_or_payload",
          });
          // No shared verification call also means no PEM normalization, JOSE,
          // public-key import, or signature verification was reached.
          expect(observed.jwt).not.toHaveBeenCalled();
          expect(observed.importKey).not.toHaveBeenCalled();
          expect(observed.verify).not.toHaveBeenCalled();
          expect(admitted).toEqual(["edge"]);
          expect(c.owners).toBe(0);
          expect(c.crypto).toBe(0);
          expect(c.replay).toBe(0);
          expect(c.writes).toBe(0);
          expect(c.business).toBe(0);
          expect(c.recipients).toEqual([]);
        }
      }),
    (observed) =>
      Effect.sync(() => {
        observed.jwt.mockRestore();
        observed.importKey.mockRestore();
        observed.verify.mockRestore();
      }),
  );
});

describe("exact public relay proof caps through production assembly", () => {
  it.effect.each([
    { representation: "real newlines", size: 2048, accepted: true },
    { representation: "real newlines", size: 2049, accepted: false },
    { representation: "literal escaped newlines", size: 2048, accepted: true },
    { representation: "literal escaped newlines", size: 2049, accepted: false },
  ] as const)("$representation SPKI supplied at $size characters", (entry) =>
    Effect.gen(function* () {
      const rawPem = relayKeys.publicKey.replace(/\\n/g, "\n");
      const base = entry.representation === "real newlines" ? rawPem : rawPem.replace(/\n/g, "\\n");
      const supplied = base + " ".repeat(entry.size - base.length);
      expect(supplied.length).toBe(entry.size);
      expect(encoder.encode(supplied).byteLength).toBe(entry.size);
      expect(supplied.includes("\n")).toBe(entry.representation === "real newlines");
      expect(supplied.includes("\\n")).toBe(entry.representation === "literal escaped newlines");
      const input = yield* freshPublishRequest(512);
      expect({ tokenBytes: input.tokenBytes, bodyBytes: input.bodyBytes }).toEqual({
        tokenBytes: 850,
        bodyBytes: 875,
      });
      yield* checkPublish(supplied, input, entry.accepted);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { size: 32_768, accepted: true },
    { size: 32_769, accepted: false },
  ] as const)("decoded activity proof payload at $size UTF-8 bytes", (entry) =>
    Effect.gen(function* () {
      const input = yield* freshPublishRequest(entry.size);
      // These genuine proofs exceed ordinary bearer/DPoP limits and reach the
      // decoded payload guard only through the activity proof's 49,152 cap.
      expect(input.tokenBytes).toBeGreaterThan(16_384);
      expect(input.tokenBytes).toBeGreaterThan(8192);
      expect({ tokenBytes: input.tokenBytes, bodyBytes: input.bodyBytes }).toEqual(
        entry.accepted
          ? { tokenBytes: 43_858, bodyBytes: 43_883 }
          : { tokenBytes: 43_859, bodyBytes: 43_884 },
      );
      yield* checkPublish(relayKeys.publicKey, input, entry.accepted);
    }).pipe(Effect.scoped),
  );
});
