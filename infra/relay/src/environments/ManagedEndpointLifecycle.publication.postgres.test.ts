import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { RelayEnvironmentLinkProofPayload } from "@t3tools/contracts/relay";
import type { RelayEnvironmentLinkRequest } from "@t3tools/contracts/relay";
import { eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { managedEndpointForHostname } from "../deploymentConfig.ts";
import {
  relayEnvironmentCredentials,
  relayEnvironmentLinks,
  relayManagedEndpointAllocations as table,
} from "../persistence/schema.ts";
import * as Credentials from "./EnvironmentCredentials.ts";
import * as Links from "./EnvironmentLinks.ts";
import * as Lifecycle from "./ManagedEndpointLifecycle.ts";
import * as Limits from "./ManagedTunnelLimits.ts";
import {
  acquireEnvironmentLinkWriteLocks,
  ENVIRONMENT_LINK_WRITE_LOCK_NAMESPACE,
} from "./environmentLinkWriteLocks.ts";
import {
  targetFor,
  type AllocationKey,
  type Claim,
  type ExpectedManagedLink,
} from "./managedEndpointLifecycleContracts.ts";
import { connectDatabase, fixtureFile, layerDb } from "./managedEndpointPostgresFixture.ts";
import { t3ChatDisabledLayer } from "./managedEndpointProviderTestFixture.ts";

const repositories = Layer.merge(Links.layer, Credentials.layer).pipe(
  Layer.provide(NodeCrypto.layer),
);
const services = Layer.merge(Lifecycle.layer, Limits.layer).pipe(
  Layer.provideMerge(repositories),
  Layer.provide(t3ChatDisabledLayer),
);
const fixture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.fresh(services.pipe(Layer.provideMerge(layerDb)))));
const key = { userId: "publication-a", environmentId: "publication-env" };
const second = { ...key, userId: "publication-b" };
const origin = { localHttpHost: "localhost" as const, localHttpPort: 3000 };
const nominalEndpoint = {
  providerKind: "manual" as const,
  httpBaseUrl: "http://localhost:3000/",
  wsBaseUrl: "ws://localhost:3000/ws",
};
const request: RelayEnvironmentLinkRequest = {
  proof: "verified-outside-sql",
  managedTunnelsEnabled: true,
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
};
const decodeProof = Schema.decodeUnknownSync(RelayEnvironmentLinkProofPayload);
const proof = (environmentPublicKey = "fixture-key", environmentId = key.environmentId) =>
  decodeProof({
    iss: `t3-env:${environmentId}`,
    aud: "https://relay.fixture.test",
    sub: environmentId,
    jti: "fixture-proof",
    iat: 1,
    exp: 2,
    challenge: "verified-outside-sql",
    environmentId,
    descriptor: {
      environmentId,
      label: "Fixture",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    environmentPublicKey,
    endpoint: nominalEndpoint,
    origin,
    scopes: ["agent_activity_notifications", "managed_tunnels"],
  });
const fresh = Effect.fnUntraced(function* (subject: AllocationKey = key) {
  const db = yield* RelayDb.RelayDb;
  const limits = yield* Limits.ManagedTunnelLimits;
  const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
  yield* limits.reserveAllocation({
    ...subject,
    hostname: `${subject.userId}.fixture.test`,
    tunnelName: `${subject.userId}-tunnel`,
  });
  yield* db.update(table).set({ lifecycleState: "idle" }).where(eq(table.userId, subject.userId));
  const row = yield* lifecycle.get(subject);
  if (!row) throw new Error("Fixture row absent");
  return row;
});
const acquire = Effect.fnUntraced(function* (
  row: Lifecycle.LifecycleAllocation,
  expectedLink?: ExpectedManagedLink,
  kind: "provision" | "reconcile" = "provision",
) {
  const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
  const result = yield* lifecycle.acquireOperation({
    key: row,
    expectedTarget: targetFor(row),
    kind,
    purpose: expectedLink
      ? { kind: kind === "reconcile" ? "reconcile" : "recover", ...expectedLink }
      : { kind: "link" },
  });
  if (result.status !== "Acquired") throw new Error(`Fixture owner: ${result.status}`);
  return result;
});
const configured = Effect.fnUntraced(function* (claim: Claim) {
  const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
  const row = yield* lifecycle.get(claim);
  if (!row) throw new Error("Fixture row absent");
  for (const observation of [
    {
      resource: "tunnel" as const,
      presence: "recorded" as const,
      tunnelId: "fixture-tunnel",
      tunnelName: row.tunnelName,
    },
    {
      resource: "dns" as const,
      presence: "recorded" as const,
      dnsRecordId: "fixture-dns",
      hostname: row.hostname,
      tunnelId: "fixture-tunnel",
    },
  ])
    expect(yield* lifecycle.recordObservation({ claim, observation })).toEqual({
      status: "Applied",
    });
  const begin = yield* lifecycle.beginMutation({
    claim,
    mutation: {
      action: "configure_tunnel",
      tunnelId: "fixture-tunnel",
      tunnelName: row.tunnelName,
      origin,
    },
  });
  if (begin.status !== "Applied") throw new Error("Fixture step absent");
  yield* lifecycle.completeMutation({
    claim,
    stepId: begin.stepId,
    outcome: { action: "configure_tunnel", tunnelId: "fixture-tunnel" },
  });
});
const publish = Effect.fnUntraced(function* (claim: Claim, environmentPublicKey = "fixture-key") {
  const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
  return yield* lifecycle.publishProvision({
    claim,
    origin,
    publication: { kind: "link", request, proof: proof(environmentPublicKey, claim.environmentId) },
  });
});
const readLink = (subject: AllocationKey = key) =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    const rows = yield* db
      .select()
      .from(relayEnvironmentLinks)
      .where(eq(relayEnvironmentLinks.userId, subject.userId));
    return rows[0] ?? null;
  });
const expectedFor = Effect.fnUntraced(function* (subject: AllocationKey = key) {
  const link = yield* readLink(subject);
  if (!link) throw new Error("Fixture link absent");
  return {
    environmentPublicKey: link.environmentPublicKey,
    expectedLinkIncarnationId: link.incarnationId,
    endpoint: {
      providerKind: "cloudflare_tunnel" as const,
      httpBaseUrl: link.endpointHttpBaseUrl,
      wsBaseUrl: link.endpointWsBaseUrl,
    },
  } satisfies ExpectedManagedLink;
});
const credentialRows = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  return yield* db.select().from(relayEnvironmentCredentials);
});
const linked = Effect.fnUntraced(function* () {
  const owner = yield* acquire(yield* fresh());
  yield* configured(owner.claim);
  const result = yield* publish(owner.claim);
  if (result.status !== "Applied" || result.kind !== "link")
    throw new Error("Fixture publication absent");
  return result;
});
const publishOnly = Effect.fnUntraced(function* (
  subject: AllocationKey = second,
  publicKey = "fixture-key",
) {
  const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
  return yield* lifecycle.publishWithoutTunnel({
    userId: subject.userId,
    request: { ...request, managedTunnelsEnabled: false },
    verifiedProof: proof(publicKey, subject.environmentId),
    endpoint: nominalEndpoint,
  });
});

// Faults are scoped to this owned schema and disappear at the fixture reset.
const trigger = (
  tableName:
    | "relay_managed_endpoint_allocations"
    | "relay_environment_links"
    | "relay_environment_credentials",
  body: string,
) =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    yield* db.$client.unsafe(
      `CREATE FUNCTION task4c_managed_endpoints.publication_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`,
    );
    yield* db.$client.unsafe(
      `CREATE TRIGGER publication_fault BEFORE INSERT OR UPDATE ON ${tableName} FOR EACH ROW EXECUTE FUNCTION task4c_managed_endpoints.publication_fault()`,
    );
  });

describe.skipIf(!fixtureFile)("ManagedEndpointLifecycle PostgreSQL aggregates", () => {
  it.effect(
    "new link publishes canonical authority, credential and readiness after configure without inventing recovery",
    () =>
      fixture(
        Effect.gen(function* () {
          const result = yield* linked();
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const credentials = yield* Credentials.EnvironmentCredentials;
          const db = yield* RelayDb.RelayDb;
          const row = yield* lifecycle.get(key);
          expect(row).toMatchObject({
            lifecycleState: "idle",
            operationId: null,
            generation: 2,
            origin,
            tunnelId: "fixture-tunnel",
            dnsRecordId: "fixture-dns",
          });
          expect(row?.readyAt).not.toBeNull();
          expect(result.endpoint).toEqual(managedEndpointForHostname(`${key.userId}.fixture.test`));
          const metadata = yield* db
            .select({ at: table.recoveryEnabledAt, key: table.recoveryEnvironmentPublicKey })
            .from(table);
          expect(metadata).toEqual([{ at: null, key: null }]);
          expect(Option.isSome(yield* credentials.authenticate(result.environmentCredential))).toBe(
            true,
          );
          expect(yield* readLink()).toMatchObject({ managedTunnelsEnabled: true, revokedAt: null });
        }),
      ),
  );

  it.effect(
    "same active key preserves incarnation; replacement and revoked relink rotate exactly as repository SQL",
    () =>
      fixture(
        Effect.gen(function* () {
          yield* linked();
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const original = yield* readLink();
          for (const publicKey of ["fixture-key", "replacement-key"]) {
            const row = yield* lifecycle.get(key);
            if (!row) throw new Error("Fixture row absent");
            const owner = yield* acquire(row);
            yield* publish(owner.claim, publicKey);
            const link = yield* readLink();
            if (publicKey === "fixture-key")
              expect(link?.incarnationId).toBe(original?.incarnationId);
            else expect(link?.incarnationId).not.toBe(original?.incarnationId);
          }
          expect(
            (yield* credentialRows).filter(
              (row) => row.environmentPublicKey === "fixture-key" && row.revokedAt === null,
            ),
          ).toHaveLength(0);
          const before = yield* readLink();
          yield* lifecycle.revokeAndRequestCleanup(key);
          const db = yield* RelayDb.RelayDb;
          yield* db
            .update(table)
            .set({ cleanupRequested: false })
            .where(eq(table.userId, key.userId));
          const row = yield* lifecycle.get(key);
          if (!row) throw new Error("Fixture row absent");
          yield* publish((yield* acquire(row)).claim, "replacement-key");
          const after = yield* readLink();
          expect(after?.incarnationId).not.toBe(before?.incarnationId);
          expect(after?.linkedAt).not.toBe(before?.linkedAt);
        }),
      ),
  );

  it.effect.each(["recover", "reconcile"] as const)(
    "%s validates current authority and enables recovery without link or credential writes",
    (kind) =>
      fixture(
        Effect.gen(function* () {
          yield* linked();
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const db = yield* RelayDb.RelayDb;
          const before = yield* readLink();
          const credentialsBefore = yield* credentialRows;
          const row = yield* lifecycle.get(key);
          if (!row) throw new Error("Fixture row absent");
          const expectedLink = yield* expectedFor();
          const owner = yield* acquire(
            row,
            expectedLink,
            kind === "recover" ? "provision" : "reconcile",
          );
          const result =
            kind === "recover"
              ? yield* lifecycle.publishProvision({
                  claim: owner.claim,
                  origin,
                  publication: { kind, ...expectedLink },
                })
              : yield* lifecycle.completeReconcile({ claim: owner.claim, origin, expectedLink });
          expect(result.status).toBe("Applied");
          expect("environmentCredential" in result).toBe(false);
          expect(yield* readLink()).toEqual(before);
          expect(yield* credentialRows).toEqual(credentialsBefore);
          const metadata = yield* db
            .select({ at: table.recoveryEnabledAt, key: table.recoveryEnvironmentPublicKey })
            .from(table);
          expect(metadata[0]?.at).not.toBeNull();
          expect(metadata[0]?.key).toBe(expectedLink.environmentPublicKey);
        }),
      ),
  );

  it.effect.each(
    (["recover", "reconcile"] as const).flatMap((mode) =>
      (["key", "incarnation", "endpoint", "revoked", "nonmanaged", "provider"] as const).map(
        (change) => ({ mode, change }),
      ),
    ),
  )(
    "stale $change $mode authority rejects before owner acquisition and again at completion",
    ({ mode, change }) =>
      fixture(
        Effect.gen(function* () {
          yield* linked();
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const db = yield* RelayDb.RelayDb;
          const expectedLink = yield* expectedFor();
          const original = yield* readLink();
          const row = yield* lifecycle.get(key);
          if (!row || !original) throw new Error("Fixture absent");
          const patch =
            change === "key"
              ? { environmentPublicKey: "foreign-key" }
              : change === "incarnation"
                ? { incarnationId: "00000000-0000-4000-8000-000000000001" }
                : change === "endpoint"
                  ? { endpointHttpBaseUrl: "https://unrelated.fixture.test/" }
                  : change === "revoked"
                    ? { revokedAt: "2026-10-13T00:00:00.000Z" }
                    : change === "nonmanaged"
                      ? { managedTunnelsEnabled: false }
                      : { endpointProviderKind: "manual" };
          yield* db
            .update(relayEnvironmentLinks)
            .set(patch)
            .where(eq(relayEnvironmentLinks.userId, key.userId));
          expect(
            yield* lifecycle.acquireOperation({
              key,
              kind: mode === "recover" ? "provision" : "reconcile",
              expectedTarget: targetFor(row),
              purpose: { kind: mode, ...expectedLink },
            }),
          ).toEqual({ status: "Stale" });
          yield* db
            .update(relayEnvironmentLinks)
            .set(original)
            .where(eq(relayEnvironmentLinks.userId, key.userId));
          const owner = yield* acquire(
            row,
            expectedLink,
            mode === "recover" ? "provision" : "reconcile",
          );
          yield* db
            .update(relayEnvironmentLinks)
            .set(patch)
            .where(eq(relayEnvironmentLinks.userId, key.userId));
          expect(
            yield* mode === "recover"
              ? lifecycle.publishProvision({
                  claim: owner.claim,
                  origin,
                  publication: { kind: "recover", ...expectedLink },
                })
              : lifecycle.completeReconcile({ claim: owner.claim, origin, expectedLink }),
          ).toEqual({ status: "Stale" });
          expect((yield* lifecycle.get(key))?.operationId).toBe(owner.claim.operationId);
          expect(yield* credentialRows).toHaveLength(1);
        }),
      ),
  );

  it.effect(
    "a fresh idle allocation after unlink cannot authorize recovery against revoked authority",
    () =>
      fixture(
        Effect.gen(function* () {
          yield* linked();
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const db = yield* RelayDb.RelayDb;
          const expectedLink = yield* expectedFor();
          yield* lifecycle.revokeAndRequestCleanup(key);
          yield* db.delete(table).where(eq(table.userId, key.userId));
          const row = yield* fresh();
          expect(
            yield* lifecycle.acquireOperation({
              key,
              kind: "provision",
              expectedTarget: targetFor(row),
              purpose: { kind: "recover", ...expectedLink },
            }),
          ).toEqual({ status: "Stale" });
        }),
      ),
  );

  it.effect.each([
    "pending",
    "cleanup",
    "uncertain",
    "uuid",
    "generation",
    "operation",
    "dns-target",
    "unconfigured",
    "origin",
  ] as const)("%s blocks terminal publication without authority writes", (blocker) =>
    fixture(
      Effect.gen(function* () {
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        const db = yield* RelayDb.RelayDb;
        const owner = yield* acquire(yield* fresh());
        yield* configured(owner.claim);
        let claim = owner.claim;
        if (blocker === "pending")
          yield* lifecycle.beginMutation({
            claim,
            mutation: {
              action: "configure_tunnel",
              tunnelId: "fixture-tunnel",
              tunnelName: owner.allocation.tunnelName,
              origin,
            },
          });
        if (blocker === "cleanup") {
          const current = yield* lifecycle.get(key);
          if (!current) throw new Error("Fixture absent");
          yield* lifecycle.requestCleanup(targetFor(current));
        }
        if (blocker === "uncertain") yield* lifecycle.retainUncertain(claim);
        if (blocker === "uuid")
          claim = { ...claim, allocationId: "00000000-0000-4000-8000-000000000001" };
        if (blocker === "generation") claim = { ...claim, generation: claim.generation + 1 };
        if (blocker === "operation")
          claim = { ...claim, operationId: "00000000-0000-4000-8000-000000000001" };
        if (blocker === "dns-target")
          yield* db
            .update(table)
            .set({ dnsTargetTunnelId: "foreign" })
            .where(eq(table.userId, key.userId));
        if (blocker === "unconfigured")
          yield* db.update(table).set({ origin: null }).where(eq(table.userId, key.userId));
        if (blocker === "origin")
          yield* db
            .update(table)
            .set({ origin: { ...origin, localHttpPort: 4000 } })
            .where(eq(table.userId, key.userId));
        expect(yield* publish(claim)).toEqual({ status: "Stale" });
        expect(yield* readLink()).toBeNull();
        expect(yield* credentialRows).toHaveLength(0);
      }),
    ),
  );

  it.effect.each(["link", "credential", "finish-zero"] as const)(
    "%s rolls back publication and credential while retaining counted owner",
    (fault) =>
      fixture(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const owner = yield* acquire(yield* fresh());
          yield* configured(owner.claim);
          yield* trigger(
            fault === "link"
              ? "relay_environment_links"
              : fault === "credential"
                ? "relay_environment_credentials"
                : "relay_managed_endpoint_allocations",
            fault === "finish-zero"
              ? "IF OLD.lifecycle_state = 'owned' AND NEW.lifecycle_state = 'idle' THEN RETURN NULL; END IF;"
              : "RAISE EXCEPTION 'fixture rejected';",
          );
          expect(yield* Effect.flip(publish(owner.claim))).toMatchObject({
            operation: "publish-provision",
          });
          expect(yield* readLink()).toBeNull();
          expect(yield* credentialRows).toHaveLength(0);
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "owned",
            operationId: owner.claim.operationId,
            generation: owner.claim.generation,
            readyAt: null,
          });
        }),
      ),
  );

  it.effect(
    "already revoked retry uses persisted key; missing link cannot invent a key and missing allocation returns no deletion target",
    () =>
      fixture(
        Effect.gen(function* () {
          yield* linked();
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const credentials = yield* Credentials.EnvironmentCredentials;
          const original = yield* readLink();
          const first = yield* lifecycle.revokeAndRequestCleanup(key);
          expect(first.revoked).toBe(true);
          const token = yield* credentials.create({
            environmentId: key.environmentId,
            environmentPublicKey: "fixture-key",
          });
          const retry = yield* lifecycle.revokeAndRequestCleanup(key);
          expect(retry).toEqual({ ...first, revoked: false });
          expect(yield* readLink()).toMatchObject({
            incarnationId: original?.incarnationId,
            linkedAt: original?.linkedAt,
          });
          expect((yield* credentialRows).every((row) => row.revokedAt !== null)).toBe(true);
          expect(Option.isNone(yield* credentials.authenticate(token))).toBe(true);
          const db = yield* RelayDb.RelayDb;
          yield* db
            .delete(relayEnvironmentLinks)
            .where(eq(relayEnvironmentLinks.userId, key.userId));
          yield* credentials.create({
            environmentId: key.environmentId,
            environmentPublicKey: "unrelated",
          });
          expect((yield* lifecycle.revokeAndRequestCleanup(key)).target).toEqual(first.target);
          expect(
            (yield* credentialRows).filter(
              (row) => row.environmentPublicKey === "unrelated" && row.revokedAt === null,
            ),
          ).toHaveLength(1);
          yield* db.delete(table).where(eq(table.userId, key.userId));
          expect(yield* lifecycle.revokeAndRequestCleanup(key)).toEqual({
            revoked: false,
            target: null,
            tunnelName: null,
          });
        }),
      ),
  );

  it.effect(
    "revocation and publish-only keep a pending owner, generation and resource history intact",
    () =>
      fixture(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const owner = yield* acquire(yield* fresh());
          yield* configured(owner.claim);
          yield* lifecycle.beginMutation({
            claim: owner.claim,
            mutation: {
              action: "configure_tunnel",
              tunnelId: "fixture-tunnel",
              tunnelName: owner.allocation.tunnelName,
              origin,
            },
          });
          const before = yield* lifecycle.get(key);
          const result = yield* publishOnly(key);
          expect(result.target).toEqual(before && targetFor(before));
          expect(result.tunnelName).toBe(before?.tunnelName);
          expect(yield* readLink()).toMatchObject({
            managedTunnelsEnabled: false,
            endpointHttpBaseUrl: nominalEndpoint.httpBaseUrl,
          });
          const after = yield* lifecycle.get(key);
          expect(after).toEqual({ ...before, cleanupRequested: true, updatedAt: after?.updatedAt });
          yield* lifecycle.revokeAndRequestCleanup(key);
          const revoked = yield* lifecycle.get(key);
          expect(revoked).toEqual({ ...after, updatedAt: revoked?.updatedAt });
        }),
      ),
  );

  it.effect.each(["revoke", "publish-only"] as const)(
    "%s cleanup failure rolls back authority and credentials together",
    (action) =>
      fixture(
        Effect.gen(function* () {
          yield* linked();
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const beforeLink = yield* readLink();
          const beforeCredentials = yield* credentialRows;
          const beforeRow = yield* lifecycle.get(key);
          yield* trigger(
            "relay_managed_endpoint_allocations",
            "IF NEW.cleanup_requested THEN RAISE EXCEPTION 'fixture rejected'; END IF;",
          );
          yield* Effect.flip(
            action === "revoke"
              ? lifecycle.revokeAndRequestCleanup(key).pipe(Effect.asVoid)
              : publishOnly(key, "replacement-key").pipe(Effect.asVoid),
          );
          expect(yield* readLink()).toEqual(beforeLink);
          expect(yield* credentialRows).toEqual(beforeCredentials);
          expect(yield* lifecycle.get(key)).toEqual(beforeRow);
        }),
      ),
  );

  it.effect(
    "new-link publication preserves valid same-key recovery metadata and clears stale-key metadata",
    () =>
      fixture(
        Effect.gen(function* () {
          yield* linked();
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const expectedLink = yield* expectedFor();
          let row = yield* lifecycle.get(key);
          if (!row) throw new Error("Fixture absent");
          const recovered = yield* acquire(row, expectedLink);
          yield* lifecycle.publishProvision({
            claim: recovered.claim,
            origin,
            publication: { kind: "recover", ...expectedLink },
          });
          const db = yield* RelayDb.RelayDb;
          const initial = yield* db
            .select({ at: table.recoveryEnabledAt, key: table.recoveryEnvironmentPublicKey })
            .from(table);
          for (const publicKey of ["fixture-key", "replacement-key"]) {
            row = yield* lifecycle.get(key);
            if (!row) throw new Error("Fixture absent");
            yield* publish((yield* acquire(row)).claim, publicKey);
            const metadata = yield* db
              .select({ at: table.recoveryEnabledAt, key: table.recoveryEnvironmentPublicKey })
              .from(table);
            expect(metadata).toEqual(
              publicKey === "fixture-key" ? initial : [{ at: null, key: null }],
            );
          }
        }),
      ),
  );

  it.effect(
    "configure checkpoint records exact successful origin; no-effect and SQL failure preserve the previous fact",
    () =>
      fixture(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const owner = yield* acquire(yield* fresh());
          yield* configured(owner.claim);
          expect((yield* lifecycle.get(key))?.origin).toEqual(origin);
          const next = { ...origin, localHttpPort: 4000 };
          let step = yield* lifecycle.beginMutation({
            claim: owner.claim,
            mutation: {
              action: "configure_tunnel",
              tunnelId: "fixture-tunnel",
              tunnelName: owner.allocation.tunnelName,
              origin: next,
            },
          });
          if (step.status !== "Applied") throw new Error("Fixture absent");
          yield* lifecycle.completeMutation({
            claim: owner.claim,
            stepId: step.stepId,
            outcome: { action: "rejected_no_effect" },
          });
          expect((yield* lifecycle.get(key))?.origin).toEqual(origin);
          step = yield* lifecycle.beginMutation({
            claim: owner.claim,
            mutation: {
              action: "configure_tunnel",
              tunnelId: "fixture-tunnel",
              tunnelName: owner.allocation.tunnelName,
              origin: next,
            },
          });
          if (step.status !== "Applied") throw new Error("Fixture absent");
          yield* trigger(
            "relay_managed_endpoint_allocations",
            "IF NEW.origin IS DISTINCT FROM OLD.origin THEN RAISE EXCEPTION 'fixture rejected'; END IF;",
          );
          yield* Effect.flip(
            lifecycle.completeMutation({
              claim: owner.claim,
              stepId: step.stepId,
              outcome: { action: "configure_tunnel", tunnelId: "fixture-tunnel" },
            }),
          );
          expect(yield* lifecycle.get(key)).toMatchObject({
            origin,
            pendingMutation: { stepId: step.stepId },
            generation: owner.claim.generation,
          });
        }),
      ),
  );

  it.effect("all aggregate and lookup entry points reject an ambient transaction", () =>
    fixture(
      Effect.gen(function* () {
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        const db = yield* RelayDb.RelayDb;
        const owner = yield* acquire(yield* fresh());
        yield* configured(owner.claim);
        const expectedLink = {
          environmentPublicKey: "fixture-key",
          expectedLinkIncarnationId: "00000000-0000-4000-8000-000000000001",
          endpoint: managedEndpointForHostname(owner.allocation.hostname),
        };
        const effects = [
          lifecycle.get(key).pipe(Effect.asVoid),
          publish(owner.claim).pipe(Effect.asVoid),
          lifecycle
            .completeReconcile({ claim: owner.claim, origin, expectedLink })
            .pipe(Effect.asVoid),
          lifecycle.revokeAndRequestCleanup(key).pipe(Effect.asVoid),
          publishOnly(key).pipe(Effect.asVoid),
        ];
        for (const effect of effects) {
          const error = yield* db.$client.withTransaction(Effect.flip(effect));
          expect(error.cause).toMatchObject({ reason: "ambient-transaction" });
        }
        expect(yield* readLink()).toBeNull();
        expect(yield* credentialRows).toHaveLength(0);
      }),
    ),
  );
  it.effect.each([
    "publication-first",
    "last-revoke-first",
    "two-last-unlinks",
    "key-replacement",
  ] as const)(
    "%s: distinct-session shared-key contention and fresh post-commit aggregate visibility",
    (order) =>
      fixture(
        Effect.gen(function* () {
          const initial = yield* linked();
          if (order === "two-last-unlinks" || order === "key-replacement")
            yield* publishOnly(second);
          const db = yield* RelayDb.RelayDb;
          const realCredentials = yield* Credentials.EnvironmentCredentials;
          const links = yield* Links.EnvironmentLinks;
          const release = yield* Deferred.make<void>();
          const entered = yield* Deferred.make<number, Lifecycle.LifecyclePersistenceError>();
          const pause = Effect.gen(function* () {
            const pids = yield* db.$client<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
            const pid = pids[0]?.pid ?? 0;
            const held = yield* db.$client<{
              count: number;
            }>`SELECT count(*)::int AS count FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted AND classid = ${ENVIRONMENT_LINK_WRITE_LOCK_NAMESPACE}::oid AND objsubid = 2`;
            expect(held[0]?.count).toBe(order === "key-replacement" ? 2 : 1);
            yield* Deferred.succeed(entered, pid);
            yield* Deferred.await(release);
          });
          // The barrier only decorates a real repository call. All locks and SQL,
          // including the holder's COMMIT, belong to the public aggregate.
          const decorated = Credentials.EnvironmentCredentials.of({
            ...realCredentials,
            create: (input) =>
              pause.pipe(Effect.orDie, Effect.andThen(realCredentials.create(input))),
            revokeForEnvironmentPublicKey: (input) =>
              pause.pipe(
                Effect.orDie,
                Effect.andThen(realCredentials.revokeForEnvironmentPublicKey(input)),
              ),
          });
          const holderContext = yield* Layer.build(
            Lifecycle.layer.pipe(
              Layer.provide(Layer.succeed(RelayDb.RelayDb, db)),
              Layer.provide(Layer.succeed(Links.EnvironmentLinks, links)),
              Layer.provide(Layer.succeed(Credentials.EnvironmentCredentials, decorated)),
            ),
          );
          const holder = Context.get(holderContext, Lifecycle.ManagedEndpointLifecycle);
          const publishInput = (subject: AllocationKey, publicKey = "fixture-key") => ({
            userId: subject.userId,
            request: { ...request, managedTunnelsEnabled: false },
            verifiedProof: proof(publicKey),
            endpoint: nominalEndpoint,
          });
          const holderEffect =
            order === "publication-first"
              ? holder.publishWithoutTunnel(publishInput(second)).pipe(Effect.asVoid)
              : order === "key-replacement"
                ? holder
                    .publishWithoutTunnel(publishInput(key, "replacement-key"))
                    .pipe(Effect.asVoid)
                : holder.revokeAndRequestCleanup(key).pipe(Effect.asVoid);
          const fiber = yield* Effect.forkChild(
            holderEffect.pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Deferred.failCause(entered, exit.cause) : Effect.void,
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const holderPid = yield* Deferred.await(entered);
            expect(holderPid).toBeGreaterThan(0);
            const contenderContext = yield* Layer.build(
              Layer.fresh(services.pipe(Layer.provideMerge(connectDatabase("100ms")))),
            );
            const contenderDb = Context.get(contenderContext, RelayDb.RelayDb);
            const contender = Context.get(contenderContext, Lifecycle.ManagedEndpointLifecycle);
            const pids = yield* contenderDb.$client<{
              pid: number;
            }>`SELECT pg_backend_pid() AS pid`;
            expect(pids[0]?.pid).not.toBe(holderPid);
            yield* Effect.logInfo("Owned fixture shared-key contention", {
              order,
              holderPid,
              contenderPid: pids[0]?.pid,
              namespace: ENVIRONMENT_LINK_WRITE_LOCK_NAMESPACE,
            });
            // Per-user bigint locks differ. A different exact key remains available
            // while the holder retains the shared environment/key lock.
            const independent = { ...second, userId: "independent-user" };
            yield* contender.publishWithoutTunnel(publishInput(independent, "independent-key"));
            const contenderEffect =
              order === "last-revoke-first"
                ? contender.publishWithoutTunnel(publishInput(second)).pipe(Effect.asVoid)
                : contender
                    .revokeAndRequestCleanup(order === "publication-first" ? key : second)
                    .pipe(Effect.asVoid);
            const error = yield* Effect.flip(contenderEffect);
            // Inspect the actual pg driver SQLSTATE retained by Effect's SqlError.
            const sqlState = (cause: unknown): string | undefined => {
              if (typeof cause !== "object" || cause === null) return undefined;
              if ("code" in cause && typeof cause.code === "string") return cause.code;
              if ("cause" in cause) return sqlState(cause.cause);
              if ("reason" in cause) return sqlState(cause.reason);
              return undefined;
            };
            expect(sqlState(error)).toBe("55P03");
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
          yield* Fiber.join(fiber);
          // A separate fresh transaction retries after holder COMMIT. This proves
          // contention + fresh visibility, not a continuously waiting snapshot.
          const freshContext = yield* Layer.build(
            Layer.fresh(services.pipe(Layer.provideMerge(connectDatabase("100ms")))),
          );
          const retry = Context.get(freshContext, Lifecycle.ManagedEndpointLifecycle);
          if (order === "publication-first") {
            const credentials = Context.get(freshContext, Credentials.EnvironmentCredentials);
            const current = (yield* credentialRows).filter(
              (row) => row.environmentPublicKey === "fixture-key" && row.revokedAt === null,
            );
            expect(current).toHaveLength(1);
            yield* retry.revokeAndRequestCleanup(key);
            expect(
              (yield* credentialRows).filter(
                (row) => row.environmentPublicKey === "fixture-key" && row.revokedAt === null,
              ),
            ).toEqual(current);
            expect(
              Option.isNone(yield* credentials.authenticate(initial.environmentCredential)),
            ).toBe(true);
          } else if (order === "last-revoke-first") {
            expect(
              (yield* credentialRows).filter(
                (row) => row.environmentPublicKey === "fixture-key" && row.revokedAt === null,
              ),
            ).toHaveLength(0);
            const result = yield* retry.publishWithoutTunnel(publishInput(second));
            const credentials = Context.get(freshContext, Credentials.EnvironmentCredentials);
            expect(
              Option.isSome(yield* credentials.authenticate(result.environmentCredential)),
            ).toBe(true);
          } else {
            if (order === "key-replacement")
              expect(
                (yield* credentialRows).filter(
                  (row) => row.environmentPublicKey === "fixture-key" && row.revokedAt === null,
                ),
              ).toHaveLength(1);
            yield* retry.revokeAndRequestCleanup(second);
            expect(
              (yield* credentialRows).filter(
                (row) => row.environmentPublicKey === "fixture-key" && row.revokedAt === null,
              ),
            ).toHaveLength(0);
            if (order === "key-replacement")
              expect(
                (yield* credentialRows).filter(
                  (row) => row.environmentPublicKey === "replacement-key" && row.revokedAt === null,
                ),
              ).toHaveLength(1);
          }
        }),
      ),
  );
  it.effect.each(["link-revoke", "credential-revoke", "cleanup-zero"] as const)(
    "%s rolls back revocation, persisted key cleanup and allocation intent",
    (fault) =>
      fixture(
        Effect.gen(function* () {
          yield* linked();
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const beforeLink = yield* readLink();
          const beforeCredentials = yield* credentialRows;
          const beforeRow = yield* lifecycle.get(key);
          yield* trigger(
            fault === "link-revoke"
              ? "relay_environment_links"
              : fault === "credential-revoke"
                ? "relay_environment_credentials"
                : "relay_managed_endpoint_allocations",
            fault === "cleanup-zero"
              ? "IF NEW.cleanup_requested THEN RETURN NULL; END IF;"
              : "RAISE EXCEPTION 'fixture rejected';",
          );
          expect(yield* Effect.flip(lifecycle.revokeAndRequestCleanup(key))).toMatchObject({
            operation: "revoke-cleanup",
          });
          expect(yield* readLink()).toEqual(beforeLink);
          expect(yield* credentialRows).toEqual(beforeCredentials);
          expect(yield* lifecycle.get(key)).toEqual(beforeRow);
        }),
      ),
  );

  it.effect(
    "a deferred COMMIT failure returns no publication result and rolls back authority, secret and readiness",
    () =>
      fixture(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const db = yield* RelayDb.RelayDb;
          const owner = yield* acquire(yield* fresh());
          yield* configured(owner.claim);
          yield* db.$client`CREATE FUNCTION task4c_managed_endpoints.reject_publication_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture commit rejected'; END $$`;
          yield* db.$client`CREATE CONSTRAINT TRIGGER reject_publication_commit AFTER INSERT ON relay_environment_credentials DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION task4c_managed_endpoints.reject_publication_commit()`;
          expect(yield* Effect.flip(publish(owner.claim))).toMatchObject({
            operation: "publish-provision",
          });
          expect(yield* readLink()).toBeNull();
          expect(yield* credentialRows).toHaveLength(0);
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "owned",
            operationId: owner.claim.operationId,
            readyAt: null,
          });
        }),
      ),
  );

  it.effect(
    "a suppressed terminal CAS preserves prior active authority and credential on key replacement",
    () =>
      fixture(
        Effect.gen(function* () {
          yield* linked();
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const beforeLink = yield* readLink();
          const beforeCredentials = yield* credentialRows;
          const row = yield* lifecycle.get(key);
          if (!row) throw new Error("Fixture absent");
          const owner = yield* acquire(row);
          yield* trigger(
            "relay_managed_endpoint_allocations",
            "IF OLD.lifecycle_state = 'owned' AND NEW.lifecycle_state = 'idle' THEN RETURN NULL; END IF;",
          );
          yield* Effect.flip(publish(owner.claim, "replacement-key"));
          expect(yield* readLink()).toEqual(beforeLink);
          expect(yield* credentialRows).toEqual(beforeCredentials);
          expect((yield* lifecycle.get(key))?.operationId).toBe(owner.claim.operationId);
        }),
      ),
  );

  it.effect.each([
    "environment",
    "subject",
    "descriptor",
    "scope",
    "origin",
    "managed-request",
  ] as const)("%s publication inconsistency fails closed before any authority write", (mismatch) =>
    fixture(
      Effect.gen(function* () {
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        const owner = yield* acquire(yield* fresh());
        yield* configured(owner.claim);
        const original = proof();
        const verified =
          mismatch === "environment"
            ? proof("fixture-key", "other-environment")
            : mismatch === "subject"
              ? { ...original, sub: "other-environment" }
              : mismatch === "descriptor"
                ? {
                    ...original,
                    descriptor: proof("fixture-key", "other-environment").descriptor,
                  }
                : mismatch === "scope"
                  ? { ...original, scopes: [] }
                  : mismatch === "origin"
                    ? { ...original, origin: { ...origin, localHttpPort: 4000 } }
                    : original;
        yield* Effect.flip(
          lifecycle.publishProvision({
            claim: owner.claim,
            origin,
            publication: {
              kind: "link",
              request:
                mismatch === "managed-request"
                  ? { ...request, managedTunnelsEnabled: false }
                  : request,
              proof: verified,
            },
          }),
        );
        expect(yield* readLink()).toBeNull();
        expect(yield* credentialRows).toHaveLength(0);
        expect((yield* lifecycle.get(key))?.operationId).toBe(owner.claim.operationId);
      }),
    ),
  );

  it.effect.each(["idle", "uncertain", "legacy_unverified"] as const)(
    "captured cleanup intent preserves %s allocation readiness, resources, history and pending generation",
    (state) =>
      fixture(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const db = yield* RelayDb.RelayDb;
          if (state === "legacy_unverified") {
            const limits = yield* Limits.ManagedTunnelLimits;
            yield* limits.reserveAllocation({
              ...key,
              hostname: "legacy.fixture.test",
              tunnelName: "legacy-tunnel",
            });
          } else {
            const owner = yield* acquire(yield* fresh());
            yield* configured(owner.claim);
            if (state === "uncertain") {
              yield* lifecycle.beginMutation({
                claim: owner.claim,
                mutation: {
                  action: "configure_tunnel",
                  tunnelId: "fixture-tunnel",
                  tunnelName: owner.allocation.tunnelName,
                  origin,
                },
              });
              yield* lifecycle.retainUncertain(owner.claim);
            } else yield* lifecycle.finishIdle(owner.claim);
          }
          yield* db
            .update(table)
            .set({ readyAt: "historical-ready", tunnelReleasedAt: "historical-marker" })
            .where(eq(table.userId, key.userId));
          const before = yield* lifecycle.get(key);
          const result = yield* lifecycle.revokeAndRequestCleanup(key);
          const after = yield* lifecycle.get(key);
          expect(result).toEqual({
            revoked: false,
            target: before && targetFor(before),
            tunnelName: before?.tunnelName,
          });
          expect(after).toEqual({
            ...before,
            cleanupRequested: true,
            updatedAt: after?.updatedAt,
          });
        }),
      ),
  );
  it.effect("the shared-key SQL helper rejects autocommit before acquiring ephemeral guards", () =>
    fixture(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        expect(
          yield* Effect.flip(
            acquireEnvironmentLinkWriteLocks(db, key.environmentId, ["fixture-key"]),
          ),
        ).toMatchObject({ _tag: "EnvironmentLinkWriteTransactionRequired" });
      }),
    ),
  );
});
