import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { computeDpopAccessTokenHash } from "@t3tools/shared/dpop";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { clerkKeys, dpopKey, signDpop } from "./publicRelayProofs.test-fixture.ts";
import {
  fixture,
  counters,
  config,
  owner,
  clerkToken,
  send,
  requestForOperation,
} from "./publicRelayAdmissions.test-fixture.ts";
import * as Limits from "./PublicRelayRateLimits.ts";
import { publicRelayOperations, publicRelayBuckets } from "./publicRelayPolicy.ts";
import type { PublicRelayOperation } from "./publicRelayPolicy.ts";
import * as Provider from "../environments/ManagedEndpointProvider.ts";
import * as TunnelLimits from "../environments/ManagedTunnelLimits.ts";
let authCalls = 0;
vi.mock("@clerk/backend", async (importOriginal) => {
  const original = await importOriginal<typeof import("@clerk/backend")>();
  return {
    ...original,
    verifyToken: (token: string, options: Parameters<typeof original.verifyToken>[1]) => {
      authCalls++;
      return original.verifyToken(token, { ...options, jwtKey: clerkKeys.publicKey });
    },
  };
});
function reject(mode: "deny" | "outage") {
  return mode === "deny"
    ? Effect.fail(new Limits.PublicRelayRateLimited({ retryAfterSeconds: 60 }))
    : Effect.fail(new Limits.PublicRelayLimiterUnavailable({}));
}
const accountOperations = [
  "listEnvironments",
  "listDevices",
  "listDevicesV2",
  "getWebPushConfig",
  "createEnvironmentLinkChallenge",
  "linkEnvironment",
  "unlinkEnvironment",
  "releaseEnvironmentTunnel",
  "registerWebPushSubscription",
  "unregisterWebPushSubscription",
  "testWebPushSubscription",
  "exchangeDpopAccessToken",
  "connectEnvironment",
  "getEnvironmentStatus",
  "registerDevice",
  "registerLiveActivity",
  "getAgentActivitySnapshot",
  "unregisterDevice",
] as const;
const ownerOperations = [
  "publishAgentActivity",
  "registerManagedEndpointRecovery",
  "recoverManagedEndpoint",
  "updateLinkPreferences",
  "wakeHeldHooks",
] as const;
const downstreamZero = (c: ReturnType<typeof counters>) => {
  expect(c.business).toBe(0);
  expect(c.writes).toBe(0);
  expect(c.replay).toBe(0);
  expect(c.provider).toBe(0);
  expect(c.queues).toBe(0);
  expect(c.uuid).toBe(0);
  expect(c.signing).toBe(0);
};
const assertLimited = Effect.fnUntraced(function* (response: Response, mode: "deny" | "outage") {
  expect(response.status).toBe(mode === "deny" ? 429 : 503);
  const body = yield* Effect.promise(() => response.json());
  expect(body).toMatchObject({
    code: mode === "deny" ? "relay_rate_limited" : "relay_unavailable",
    traceId: expect.stringMatching(/^[a-f0-9]{32}$/),
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  if (mode === "deny") {
    expect(body).toHaveProperty("retryAfterSeconds", 60);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("access-control-expose-headers")).toContain("retry-after");
  }
});
describe("verified public relay admissions through production assembly", () => {
  it.effect.each(["deny", "outage"] as const)(
    "%s before account business reads with real Clerk verification",
    (mode) =>
      Effect.gen(function* () {
        const c = counters();
        authCalls = 0;
        const subjects: Limits.PublicRelaySubject[] = [];
        const endpoint = yield* fixture({
          counts: c,
          admit: (op, subject) => {
            if (subject.kind === "edge") return Effect.void;
            expect(op).toBe("listEnvironments");
            subjects.push(subject);
            return reject(mode);
          },
        });
        yield* assertLimited(
          yield* send(endpoint, yield* requestForOperation("listEnvironments")),
          mode,
        );
        downstreamZero(c);
        expect(authCalls).toBe(1);
        expect(subjects).toEqual([{ kind: "user", userId: "user_verified" }]);
      }).pipe(Effect.scoped),
  );
  for (const operation of accountOperations) {
    it.effect.each(["deny", "outage"] as const)(
      `${operation} %s stops before replay and downstream work`,
      (mode) =>
        Effect.gen(function* () {
          const c = counters();
          const admitted: Limits.PublicRelaySubject[] = [];
          const endpoint = yield* fixture({
            counts: c,
            admit: (op, subject) => {
              if (subject.kind === "edge") return Effect.void;
              expect(op).toBe(operation);
              admitted.push(subject);
              return reject(mode);
            },
          });
          yield* assertLimited(yield* send(endpoint, yield* requestForOperation(operation)), mode);
          downstreamZero(c);
          expect(c.owners).toBe(0);
          expect(c.credentials).toBe(0);
          expect(admitted).toEqual([{ kind: "user", userId: "user_verified" }]);
        }).pipe(Effect.scoped),
    );
  }
  for (const operation of ownerOperations) {
    it.effect.each(["deny", "outage"] as const)(
      `${operation} %s allows authority reads and stops downstream effects`,
      (mode) =>
        Effect.gen(function* () {
          const c = counters();
          const admitted: Limits.PublicRelaySubject[] = [];
          const endpoint = yield* fixture({
            counts: c,
            owners: () => [owner("user_second"), owner(), owner("user_publishonly", false)],
            admit: (op, subject) => {
              expect(op).toBe(operation);
              if (subject.kind === "edge" || subject.kind === "environment") return Effect.void;
              admitted.push(subject);
              return reject(mode);
            },
          });
          yield* assertLimited(yield* send(endpoint, yield* requestForOperation(operation)), mode);
          downstreamZero(c);
          expect(c.credentials).toBe(1);
          expect(c.owners).toBe(1);
          expect(admitted).toHaveLength(1);
          if (operation.includes("Recovery") || operation === "recoverManagedEndpoint")
            expect(admitted).toEqual([{ kind: "user", userId: "user_verified" }]);
        }).pipe(Effect.scoped),
    );
  }
  it.effect.each(["deny", "outage"] as const)(
    "mandatory edge %s rejects every operation before auth, reads, crypto or queues",
    (mode) =>
      Effect.gen(function* () {
        const c = counters();
        authCalls = 0;
        const endpoint = yield* fixture({
          counts: c,
          admit: (_, subject) => {
            expect(subject.kind).toBe("edge");
            return reject(mode);
          },
        });
        for (const op of Object.keys(publicRelayOperations) as PublicRelayOperation[])
          yield* assertLimited(yield* send(endpoint, yield* requestForOperation(op)), mode);
        downstreamZero(c);
        expect(c.credentials).toBe(0);
        expect(c.owners).toBe(0);
        expect(c.crypto).toBe(0);
        expect(authCalls).toBe(0);
      }).pipe(Effect.scoped),
  );
  it.effect(
    "genuine Clerk success and invalid issuer/audience/oversized verified subject isolate admission",
    () =>
      Effect.gen(function* () {
        const c = counters();
        const users: string[] = [];
        const endpoint = yield* fixture({
          counts: c,
          admit: (_, subject) =>
            Effect.sync(() => {
              if (subject.kind === "user") users.push(subject.userId);
            }),
        });
        for (const [token, status] of [
          [clerkToken(), 200],
          [clerkToken("user_verified", "https://wrong.example.test"), 401],
          [clerkToken("user_verified", config.clerkAuthPolicy.issuer, "wrong"), 401],
          [clerkToken(`user_${"x".repeat(192)}`), 401],
        ] as const) {
          expect(
            (yield* send(
              endpoint,
              new Request(`${config.relayIssuer}/v1/environments`, {
                headers: { authorization: `Bearer ${yield* Effect.promise(() => token)}` },
              }),
            )).status,
          ).toBe(status);
        }
        expect(users).toEqual(["user_verified"]);
        expect(c.business).toBe(1);
      }).pipe(Effect.scoped),
  );
  it.effect.each(["connectEnvironment", "publishAgentActivity"] as const)(
    "%s saturated nonce remains retryable and admitted replay keeps its category",
    (operation) =>
      Effect.gen(function* () {
        const c = counters();
        let deny = true;
        const endpoint = yield* fixture({
          counts: c,
          admit: (_, subject) => (deny && subject.kind === "user" ? reject("deny") : Effect.void),
        });
        const request = yield* requestForOperation(operation);
        const body = yield* Effect.promise(() => request.text());
        const retry = () =>
          new Request(request.url, { method: request.method, headers: request.headers, body });
        yield* assertLimited(yield* send(endpoint, retry()), "deny");
        expect(c.replay).toBe(0);
        deny = false;
        expect((yield* send(endpoint, retry())).status).toBe(200);
        expect(c.replay).toBe(1);
        const replay = yield* send(endpoint, retry());
        expect(replay.status).toBe(401);
        expect(yield* Effect.promise(() => replay.json())).toMatchObject(
          operation === "connectEnvironment"
            ? { dpopFailureReason: "replay" }
            : { reason: "replayed_nonce" },
        );
      }).pipe(Effect.scoped),
  );
  it.effect.each([
    [{ htm: "GET" }, "request_mismatch"],
    [{ htu: "https://wrong.test" }, "request_mismatch"],
    [{ ath: "wrong" }, "token_mismatch"],
    [{ iat: -1000 }, "time_window"],
  ] as const)("invalid DPoP %j precedes user admission and retains %s", (entry) =>
    Effect.gen(function* () {
      const [claims, reason] = entry;
      const c = counters();
      let users = 0;
      const endpoint = yield* fixture({
        counts: c,
        admit: (_, subject) => {
          if (subject.kind === "user") users++;
          return subject.kind === "user" ? reject("deny") : Effect.void;
        },
      });
      const response = yield* send(
        endpoint,
        yield* requestForOperation("connectEnvironment", { dpopClaims: claims }),
      );
      expect(response.status).toBe(401);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        dpopFailureReason: reason,
      });
      expect(users).toBe(0);
      downstreamZero(c);
    }).pipe(Effect.scoped),
  );
  it.effect.each(["publishAgentActivity", "updateLinkPreferences", "wakeHeldHooks"] as const)(
    "%s awaits affected owners and carries only the admitted snapshot",
    (operation) =>
      Effect.gen(function* () {
        const c = counters();
        let current = [owner(), owner("user_publishonly", false)];
        const admitted: string[] = [];
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const endpoint = yield* fixture({
          counts: c,
          owners: () => current,
          admit: (_, subject) =>
            Effect.gen(function* () {
              if (subject.kind !== "user") return;
              admitted.push(subject.userId);
              if (admitted.length === 1) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(resume);
              }
            }),
        });
        const fiber = yield* send(endpoint, yield* requestForOperation(operation)).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        expect(c.replay).toBe(0);
        expect(c.writes).toBe(0);
        current = [...current, owner("user_ungated")];
        yield* Deferred.succeed(resume, undefined);
        expect((yield* Fiber.join(fiber)).status).toBe(200);
        expect(admitted).toEqual(
          operation === "wakeHeldHooks" ? ["user_verified"] : ["user_verified", "user_publishonly"],
        );
        if (operation === "publishAgentActivity") expect(c.recipients).toEqual(admitted);
        if (operation === "updateLinkPreferences") expect(c.affected).toEqual(admitted);
        expect(c.recipients).not.toContain("user_ungated");
        expect(c.affected).not.toContain("user_ungated");
      }).pipe(Effect.scoped),
  );
  it.effect.each(["missing", "wrong-key", "spoof", "multiple"] as const)(
    "recovery %s credits only the signed selector's matching active owner",
    (kind) =>
      Effect.gen(function* () {
        const c = counters();
        const credited: string[] = [];
        const selected =
          kind === "wrong-key" ? { ...owner(), environmentPublicKey: "wrong-key" } : owner();
        const endpoint = yield* fixture({
          counts: c,
          owners: () => (kind === "missing" ? [] : [owner("user_other"), selected]),
          admit: (_, subject) =>
            Effect.sync(() => {
              if (subject.kind === "user") credited.push(subject.userId);
            }),
        });
        const response = yield* send(
          endpoint,
          yield* requestForOperation("recoverManagedEndpoint", {
            selector: kind === "spoof" ? "user_spoof" : "user_verified",
          }),
        );
        expect(response.status).toBe(kind === "multiple" ? 200 : 401);
        expect(credited).toEqual(kind === "multiple" ? ["user_verified"] : []);
        expect(c.provider).toBe(kind === "multiple" ? 1 : 0);
      }).pipe(Effect.scoped),
  );
  it.effect.each(["quota", "deferred"] as const)(
    "recovery %s preserves declared domain status",
    (kind) =>
      Effect.gen(function* () {
        const c = counters();
        const endpoint = yield* fixture({
          counts: c,
          admit: () => Effect.void,
          provider: {
            provision: () =>
              kind === "quota"
                ? Effect.fail(
                    new TunnelLimits.ManagedTunnelLimitExceeded({
                      userId: "user_verified",
                      environmentId: "env",
                      maxTunnels: 20,
                      activeTunnels: 20,
                    }),
                  )
                : Effect.fail(
                    new Provider.ManagedEndpointProvisioningFailed({
                      stage: "reserve-allocation",
                      userId: "user_verified",
                      environmentId: "env",
                      cause: "fixture",
                    }),
                  ),
          },
        });
        const response = yield* send(
          endpoint,
          yield* requestForOperation("recoverManagedEndpoint"),
        );
        expect(response.status).toBe(kind === "quota" ? 403 : 503);
      }).pipe(Effect.scoped),
  );
  it.effect.each(["scope", "alias", "key"] as const)(
    "DPoP %s authority failure precedes user admission",
    (failure) =>
      Effect.gen(function* () {
        const c = counters();
        let admitted = 0;
        const endpoint = yield* fixture({
          counts: c,
          admit: (_, subject) => {
            if (subject.kind === "user") admitted++;
            return subject.kind === "user" ? reject("deny") : Effect.void;
          },
        });
        let request = yield* requestForOperation(
          "connectEnvironment",
          failure === "scope"
            ? { scopes: ["environment:status"] }
            : failure === "alias"
              ? { payload: { clientKeyThumbprint: "alias-A", clientProofKeyThumbprint: "alias-B" } }
              : {},
        );
        if (failure === "key") {
          const token = request.headers.get("authorization")!.slice("DPoP ".length);
          const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
          request.headers.set(
            "dpop",
            yield* Effect.promise(() =>
              signDpop(dpopKey(), {
                htm: request.method,
                htu: request.url,
                jti: "rotated-key-proof",
                iat: now,
                ath: computeDpopAccessTokenHash(token),
              }),
            ),
          );
        }
        const response = yield* send(endpoint, request);
        expect(response.status).toBe(401);
        expect(admitted).toBe(0);
        downstreamZero(c);
        if (failure === "key")
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            dpopFailureReason: "key_mismatch",
          });
      }).pipe(Effect.scoped),
  );
  it.effect.each(["deny", "outage"] as const)(
    "recovery environment %s precedes expensive invalid proof verification",
    (mode) =>
      Effect.gen(function* () {
        const c = counters();
        const endpoint = yield* fixture({
          counts: c,
          admit: (_, subject) => (subject.kind === "environment" ? reject(mode) : Effect.void),
        });
        yield* assertLimited(
          yield* send(
            endpoint,
            yield* requestForOperation("recoverManagedEndpoint", {
              proofOverride: "invalid-proof",
            }),
          ),
          mode,
        );
        expect(c.credentials).toBe(1);
        expect(c.owners).toBe(0);
        downstreamZero(c);
      }).pipe(Effect.scoped),
  );
  it.effect.each(["deny", "outage"] as const)(
    "publication later recipient %s prevents every fanout and replay",
    (mode) =>
      Effect.gen(function* () {
        const c = counters();
        const users: string[] = [];
        const endpoint = yield* fixture({
          counts: c,
          owners: () => [owner(), owner("user_second")],
          admit: (_, subject) => {
            if (subject.kind !== "user") return Effect.void;
            users.push(subject.userId);
            return subject.userId === "user_second" ? reject(mode) : Effect.void;
          },
        });
        yield* assertLimited(
          yield* send(endpoint, yield* requestForOperation("publishAgentActivity")),
          mode,
        );
        expect(users).toEqual(["user_verified", "user_second"]);
        downstreamZero(c);
      }).pipe(Effect.scoped),
  );
  it.effect(
    "publication deduplicates recipient users and still gates an ownerless environment",
    () =>
      Effect.gen(function* () {
        const c = counters();
        let current = [owner(), owner()];
        const subjects: Limits.PublicRelaySubject[] = [];
        const endpoint = yield* fixture({
          counts: c,
          owners: () => current,
          admit: (_, subject) =>
            Effect.sync(() => {
              if (subject.kind !== "edge") subjects.push(subject);
            }),
        });
        expect(
          (yield* send(endpoint, yield* requestForOperation("publishAgentActivity"))).status,
        ).toBe(200);
        expect(subjects.filter((subject) => subject.kind === "user")).toHaveLength(1);
        expect(c.recipients).toEqual(["user_verified"]);
        current = [];
        subjects.length = 0;
        expect(
          (yield* send(endpoint, yield* requestForOperation("publishAgentActivity"))).status,
        ).toBe(200);
        expect(subjects).toEqual([
          { kind: "environment", environmentId: "env", keyDigest: expect.any(String) },
        ]);
      }).pipe(Effect.scoped),
  );
  it.effect(
    "authenticated20-environment startup mix fits and operations exhaust independently with stable user keys",
    () =>
      Effect.gen(function* () {
        const c = counters();
        const bindings = new Map<string, number>();
        const endpoint = yield* fixture({
          counts: c,
          owners: () =>
            Array.from({ length: 20 }, (_, index) => owner("user_verified", true, `env-${index}`)),
          admit: (op, subject) => {
            const key = Limits.publicRelayLimiterKey(
              { issuer: config.relayIssuer, stage: "fixture" },
              op,
              subject,
            );
            const count = (bindings.get(key) ?? 0) + 1;
            bindings.set(key, count);
            return count >
              (subject.kind === "edge"
                ? 120
                : publicRelayBuckets[publicRelayOperations[op][2]].limit)
              ? reject("deny")
              : Effect.void;
          },
        });
        const mix = [
          "createEnvironmentLinkChallenge",
          "linkEnvironment",
          "exchangeDpopAccessToken",
          "connectEnvironment",
          "getEnvironmentStatus",
          "registerManagedEndpointRecovery",
          "recoverManagedEndpoint",
          "updateLinkPreferences",
          "wakeHeldHooks",
        ] as const;
        for (let environment = 0; environment < 20; environment++)
          for (const op of mix)
            expect(
              (yield* send(
                endpoint,
                yield* requestForOperation(op, {
                  key: dpopKey(),
                  environmentId: `env-${environment}`,
                }),
              )).status,
            ).toBe(200);
        for (let i = 20; i < 30; i++)
          expect(
            (yield* send(
              endpoint,
              yield* requestForOperation("recoverManagedEndpoint", { environmentId: "env-0" }),
            )).status,
          ).toBe(200);
        yield* assertLimited(
          yield* send(
            endpoint,
            yield* requestForOperation("recoverManagedEndpoint", { environmentId: "env-0" }),
          ),
          "deny",
        );
        expect(
          (yield* send(
            endpoint,
            yield* requestForOperation("registerManagedEndpointRecovery", {
              environmentId: "env-0",
            }),
          )).status,
        ).toBe(200);
        expect(
          (yield* send(
            endpoint,
            yield* requestForOperation("connectEnvironment", {
              userId: "user_second",
              environmentId: "env-rotated",
            }),
          )).status,
        ).toBe(200);
      }).pipe(Effect.scoped),
  );
});

describe("wake eligible-owner admission", () => {
  it.effect.each(["deny", "outage"] as const)(
    "%s for publish-only owners cannot deny the managed wake snapshot",
    (mode) =>
      Effect.gen(function* () {
        const c = counters();
        const current = [
          owner("user_managed"),
          owner("user_publishonly", false),
          { ...owner("user_noncloudflare"), endpoint: owner("user_noncloudflare", false).endpoint },
        ];
        const subjects: Limits.PublicRelaySubject[] = [];
        const endpoint = yield* fixture({
          counts: c,
          owners: () => current,
          admit: (_, subject) => {
            subjects.push(subject);
            return subject.kind === "user" && subject.userId !== "user_managed"
              ? reject(mode)
              : Effect.void;
          },
        });
        const response = yield* send(endpoint, yield* requestForOperation("wakeHeldHooks"));
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({ pending: false });
        expect(subjects.filter((subject) => subject.kind === "user")).toEqual([
          { kind: "user", userId: "user_managed" },
        ]);
        expect(c.allocationOwners).toEqual(["user_managed"]);
        expect(c.writes).toBe(0);
        expect(c.queues).toBe(0);
      }).pipe(Effect.scoped),
  );
  it.effect.each(["deny", "outage"] as const)(
    "%s for publish-only preferences still denies before every affected-row write",
    (mode) =>
      Effect.gen(function* () {
        const c = counters();
        const endpoint = yield* fixture({
          counts: c,
          owners: () => [owner("user_publishonly", false)],
          admit: (_, subject) => (subject.kind === "user" ? reject(mode) : Effect.void),
        });
        yield* assertLimited(
          yield* send(endpoint, yield* requestForOperation("updateLinkPreferences")),
          mode,
        );
        downstreamZero(c);
      }).pipe(Effect.scoped),
  );
  it.effect.each(["deny", "outage"] as const)(
    "%s for eligible managed wake still denies before endpoint effects",
    (mode) =>
      Effect.gen(function* () {
        const c = counters();
        const endpoint = yield* fixture({
          counts: c,
          owners: () => [owner("user_managed")],
          admit: (_, subject) => (subject.kind === "user" ? reject(mode) : Effect.void),
        });
        yield* assertLimited(
          yield* send(endpoint, yield* requestForOperation("wakeHeldHooks")),
          mode,
        );
        downstreamZero(c);
        expect(c.allocationOwners).toEqual([]);
      }).pipe(Effect.scoped),
  );
  it.effect.each(["deny", "outage"] as const)(
    "%s with no eligible wake owners retains environment admission and invents no user",
    (mode) =>
      Effect.gen(function* () {
        const c = counters();
        const subjects: Limits.PublicRelaySubject[] = [];
        const endpoint = yield* fixture({
          counts: c,
          owners: () => [owner("user_publishonly", false)],
          admit: (_, subject) => {
            subjects.push(subject);
            return subject.kind === "user" ? reject(mode) : Effect.void;
          },
        });
        const response = yield* send(endpoint, yield* requestForOperation("wakeHeldHooks"));
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({ pending: false });
        expect(subjects.map((subject) => subject.kind)).toEqual(["edge", "environment"]);
        expect(c.allocationOwners).toEqual([]);
        downstreamZero(c);
      }).pipe(Effect.scoped),
  );
});
