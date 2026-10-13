// @effect-diagnostics-next-line nodeBuiltinImport:off -- Independent historical HMAC oracle in tests only.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as WebCrypto from "../WebCrypto.ts";
import {
  SignedWebPushDeliveryJob,
  WebPushDeliveryPayload,
  signWebPushDeliveryJob,
  verifyWebPushDeliveryJob,
} from "./webPushDeliveryJobs.ts";

const secret = Redacted.make("签名-secret-🙂");
const webCryptoLayer = Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle });
const encodeJson = Schema.encodeSync(Schema.fromJsonString(SignedWebPushDeliveryJob));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(SignedWebPushDeliveryJob));
const decodePayload = Schema.decodeUnknownSync(WebPushDeliveryPayload);
const decodePayloadEffect = Schema.decodeUnknownEffect(WebPushDeliveryPayload);
const v1 = {
  version: 1,
  jobId: "job-世界",
  userId: "user-1",
  subscriptionId: "subscription-1",
  eventId: "event-🙂",
  deepLink: "/threads/environment/thread",
  showProjectAndThreadNames: false,
  title: "Arcwright 世界",
  body: "Agent café 🙂",
  createdAt: "2026-08-02T00:00:00.000Z",
  expiresAt: "2026-08-02T00:10:00.000Z",
} as const;
const v1Canonical =
  '{"body":"Agent café 🙂","createdAt":"2026-08-02T00:00:00.000Z","deepLink":"/threads/environment/thread","eventId":"event-🙂","expiresAt":"2026-08-02T00:10:00.000Z","jobId":"job-世界","showProjectAndThreadNames":false,"subscriptionId":"subscription-1","title":"Arcwright 世界","userId":"user-1","version":1}';
const v1Mac = "8-XXvKGfDmvy5DkpMlGIN2E_DFcnLXuYG_T5F5o60Pk";
const activity = {
  version: 2,
  jobId: "job-世界",
  userId: "user-1",
  subscriptionId: "subscription-1",
  subscriptionIncarnationId: "00000000-0000-4000-8000-000000000001",
  createdAt: "2026-08-02T00:00:00.000Z",
  expiresAt: "2026-08-02T00:10:00.000Z",
  kind: "activity",
  eventId: "event-🙂",
  showProjectAndThreadNames: true,
  provenance: {
    environmentId: "env-世界",
    environmentPublicKey: "verified-key",
    threadId: "thread-🙂",
    notificationKind: "plan_ready",
    stateVersion: {
      updatedAt: "2026-08-02T00:00:00.000Z",
      phase: "running",
      hasActionableProposedPlan: true,
    },
    linkIncarnationId: "00000000-0000-4000-8000-000000000002",
  },
} as const;
const activityCanonical =
  '{"createdAt":"2026-08-02T00:00:00.000Z","eventId":"event-🙂","expiresAt":"2026-08-02T00:10:00.000Z","jobId":"job-世界","kind":"activity","provenance":{"environmentId":"env-世界","environmentPublicKey":"verified-key","linkIncarnationId":"00000000-0000-4000-8000-000000000002","notificationKind":"plan_ready","stateVersion":{"hasActionableProposedPlan":true,"phase":"running","updatedAt":"2026-08-02T00:00:00.000Z"},"threadId":"thread-🙂"},"showProjectAndThreadNames":true,"subscriptionId":"subscription-1","subscriptionIncarnationId":"00000000-0000-4000-8000-000000000001","userId":"user-1","version":2}';
const activityMac = "uKvRmvavoWIQ6Dxf2TqayRFrjhEfl7PzOuA6lTIkyhU";
const test = {
  version: 2,
  jobId: "job-世界",
  userId: "user-1",
  subscriptionId: "subscription-1",
  subscriptionIncarnationId: "00000000-0000-4000-8000-000000000001",
  createdAt: "2026-08-02T00:00:00.000Z",
  expiresAt: "2026-08-02T00:10:00.000Z",
  kind: "test",
} as const;
const testCanonical =
  '{"createdAt":"2026-08-02T00:00:00.000Z","expiresAt":"2026-08-02T00:10:00.000Z","jobId":"job-世界","kind":"test","subscriptionId":"subscription-1","subscriptionIncarnationId":"00000000-0000-4000-8000-000000000001","userId":"user-1","version":2}';
const testMac = "2m7QW4eTbRAwrcUsnQl2vCXzJKL5H6_ZLNU3WH35C5o";

describe("Web Push versioned HMAC", () => {
  it.effect.each([
    { payload: v1, canonical: v1Canonical, mac: v1Mac },
    { payload: activity, canonical: activityCanonical, mac: activityMac },
    { payload: test, canonical: testCanonical, mac: testMac },
  ])(
    "preserves full golden canonical bytes/MAC, JSON roundtrip and Node↔Workers verification $payload.version/$payload.kind",
    ({ payload, canonical, mac }) =>
      Effect.gen(function* () {
        expect(stableStringify(payload)).toBe(canonical);
        const signed = yield* signWebPushDeliveryJob({ secret, payload });
        expect(signed.signature).toBe(mac);
        expect(
          NodeCrypto.createHmac("sha256", Redacted.value(secret))
            .update(canonical)
            .digest("base64url"),
        ).toBe(mac);
        const decoded = decodeJson(encodeJson(signed));
        expect(stableStringify(decoded.payload)).toBe(canonical);
        expect(yield* verifyWebPushDeliveryJob({ secret, job: decoded, nowMs: 0 })).toEqual(
          payload,
        );
        expect(
          yield* verifyWebPushDeliveryJob({
            secret,
            job: { ...decoded, signature: mac },
            nowMs: 0,
          }),
        ).toEqual(payload);
      }).pipe(Effect.provide(webCryptoLayer)),
  );

  it.effect.each([
    { ...activity, version: 1 },
    { ...activity, kind: "test" },
    { ...activity, userId: "user-other" },
    { ...activity, subscriptionId: "other" },
    { ...activity, subscriptionIncarnationId: "00000000-0000-4000-8000-000000000003" },
    { ...activity, showProjectAndThreadNames: false },
    { ...activity, provenance: { ...activity.provenance, environmentId: "other" } },
    { ...activity, provenance: { ...activity.provenance, environmentPublicKey: "other" } },
    { ...activity, provenance: { ...activity.provenance, threadId: "other" } },
    { ...activity, provenance: { ...activity.provenance, notificationKind: "input_required" } },
    {
      ...activity,
      provenance: {
        ...activity.provenance,
        linkIncarnationId: "00000000-0000-4000-8000-000000000004",
      },
    },
    {
      ...activity,
      provenance: {
        ...activity.provenance,
        stateVersion: { ...activity.provenance.stateVersion, updatedAt: "later" },
      },
    },
    {
      ...activity,
      provenance: {
        ...activity.provenance,
        stateVersion: { ...activity.provenance.stateVersion, phase: "failed" },
      },
    },
    {
      ...activity,
      provenance: {
        ...activity.provenance,
        stateVersion: { ...activity.provenance.stateVersion, hasActionableProposedPlan: false },
      },
    },
  ])("rejects tampering with signed discriminator/authority/state %#", (tampered) =>
    Effect.gen(function* () {
      const decoded = yield* Effect.result(decodePayloadEffect(tampered));
      if (decoded._tag === "Failure") return;
      const job = {
        algorithm: "hmac-sha256",
        payload: decoded.success,
        signature: activityMac,
      } as const;
      expect(yield* verifyWebPushDeliveryJob({ secret, job, nowMs: 0 })).toBeNull();
    }).pipe(Effect.provide(webCryptoLayer)),
  );

  it.each([
    { ...activity, version: 3 },
    { ...activity, kind: "unknown" },
    { ...activity, provenance: undefined },
    { ...activity, provenance: { ...activity.provenance, stateVersion: undefined } },
    { ...activity, provenance: { ...activity.provenance, linkIncarnationId: null } },
    { ...activity, provenance: { ...activity.provenance, linkIncarnationId: "invalid" } },
    { ...activity, subscriptionIncarnationId: "invalid" },
    { ...activity, userId: "pwa:installation" },
  ])("rejects unknown/incomplete/anonymous authority %#", (value) => {
    expect(() => decodePayload(value)).toThrow();
  });

  it.effect(
    "strips test copy, links and activity before signing; anonymous activity requires explicit null",
    () =>
      Effect.gen(function* () {
        const extraTestFields = { ...v1, ...test, provenance: activity.provenance };
        const signed = yield* signWebPushDeliveryJob({ secret, payload: extraTestFields });
        expect(signed.payload).toEqual(test);
        expect(signed.signature).toBe(testMac);
        expect(
          decodePayload({
            ...activity,
            userId: "pwa:installation",
            provenance: { ...activity.provenance, linkIncarnationId: null },
          }),
        ).toMatchObject({ provenance: { linkIncarnationId: null } });
      }).pipe(Effect.provide(webCryptoLayer)),
  );

  it.effect.each(["!invalid", "", "AA", "A".repeat(42), "A".repeat(44), "A".repeat(43)])(
    "permanently rejects malformed/wrong-length/invalid MAC %s",
    (signature) =>
      Effect.gen(function* () {
        const signed = yield* signWebPushDeliveryJob({ secret, payload: test });
        expect(
          yield* verifyWebPushDeliveryJob({ secret, job: { ...signed, signature }, nowMs: 0 }),
        ).toBeNull();
      }).pipe(Effect.provide(webCryptoLayer)),
  );

  it.effect.each([
    { createdAt: "invalid", expiresAt: test.expiresAt, nowMs: 0, valid: false },
    { createdAt: test.createdAt, expiresAt: "invalid", nowMs: 0, valid: false },
    { createdAt: test.createdAt, expiresAt: test.createdAt, nowMs: 0, valid: false },
    { createdAt: test.expiresAt, expiresAt: test.createdAt, nowMs: 0, valid: false },
    { createdAt: test.createdAt, expiresAt: "2026-08-02T00:10:00.001Z", nowMs: 0, valid: false },
    {
      createdAt: test.createdAt,
      expiresAt: test.expiresAt,
      nowMs: Date.parse(test.expiresAt),
      valid: false,
    },
    {
      createdAt: test.createdAt,
      expiresAt: test.expiresAt,
      nowMs: Date.parse(test.expiresAt) - 1,
      valid: true,
    },
    { createdAt: test.createdAt, expiresAt: test.expiresAt, nowMs: 0, valid: true },
  ])("preserves V1/V2 invalid-date, 10-minute and future-createdAt semantics %#", (window) =>
    Effect.gen(function* () {
      for (const payload of [v1, test]) {
        const signed = yield* signWebPushDeliveryJob({
          secret,
          payload: { ...payload, createdAt: window.createdAt, expiresAt: window.expiresAt },
        });
        expect(
          (yield* verifyWebPushDeliveryJob({ secret, job: signed, nowMs: window.nowMs })) !== null,
        ).toBe(window.valid);
      }
    }).pipe(Effect.provide(webCryptoLayer)),
  );

  it.effect("wrong key is a permanent drop", () =>
    Effect.gen(function* () {
      const signed = yield* signWebPushDeliveryJob({ secret, payload: v1 });
      expect(
        yield* verifyWebPushDeliveryJob({ secret: Redacted.make("other"), job: signed, nowMs: 0 }),
      ).toBeNull();
    }).pipe(Effect.provide(webCryptoLayer)),
  );

  it.effect.each(["importKey", "sign", "verify"] as const)(
    "keeps provider %s rejection typed for retry",
    (method) =>
      Effect.gen(function* () {
        const signed = yield* signWebPushDeliveryJob({ secret, payload: test });
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi
              .spyOn(globalThis.crypto.subtle, method)
              .mockRejectedValue(new Error("provider unavailable")),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        const result =
          method === "verify"
            ? yield* Effect.result(verifyWebPushDeliveryJob({ secret, job: signed, nowMs: 0 }))
            : yield* Effect.result(signWebPushDeliveryJob({ secret, payload: test }));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({
            _tag: "WebPushJobCryptoError",
            operation: method === "importKey" ? "import" : method,
          });
      }).pipe(Effect.provide(webCryptoLayer), Effect.scoped),
  );

  it.effect(
    "permanently drops expired/invalid windows without calling an unavailable crypto provider",
    () =>
      Effect.gen(function* () {
        const signed = yield* signWebPushDeliveryJob({ secret, payload: test });
        const spy = yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi
              .spyOn(globalThis.crypto.subtle, "importKey")
              .mockRejectedValue(new Error("provider unavailable")),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        expect(
          yield* verifyWebPushDeliveryJob({
            secret,
            job: signed,
            nowMs: Date.parse(test.expiresAt),
          }),
        ).toBeNull();
        expect(
          yield* verifyWebPushDeliveryJob({
            secret,
            job: { ...signed, payload: { ...test, createdAt: "invalid" } },
            nowMs: 0,
          }),
        ).toBeNull();
        expect(spy).not.toHaveBeenCalled();
      }).pipe(Effect.provide(webCryptoLayer), Effect.scoped),
  );
});
