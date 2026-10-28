import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import type { SqlError } from "effect/sql/SqlError";

import * as RelayDb from "../db.ts";
import {
  relayEnvironmentLinks,
  relayManagedEndpointAllocations as table,
} from "../persistence/schema.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as EnvironmentCredentials from "./EnvironmentCredentials.ts";
import * as Lifecycle from "./ManagedEndpointLifecycle.ts";
import * as Limits from "./ManagedTunnelLimits.ts";
import {
  targetFor,
  type Claim,
  type MutationAction,
  type OperationKind,
} from "./managedEndpointLifecycleContracts.ts";
import { connectDatabase, fixtureFile, layerDb } from "./managedEndpointPostgresFixture.ts";
import { t3ChatDisabledLayer } from "./managedEndpointProviderTestFixture.ts";

const layer = Layer.merge(Lifecycle.layer, Limits.layer).pipe(
  Layer.provideMerge(Layer.merge(EnvironmentLinks.layer, EnvironmentCredentials.layer)),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(layerDb),
  Layer.provide(t3ChatDisabledLayer),
);
const fixture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.fresh(layer)));
const key = { userId: "lifecycle-user", environmentId: "lifecycle-env" };
const reservation = (environmentId = key.environmentId) => ({
  ...key,
  environmentId,
  hostname: `${environmentId}.fixture.test`,
  tunnelName: `${environmentId}-tunnel`,
});

// Only fixture rows with no provider dispatch are initialized as fresh protocol
// rows. No production classifier or owner reset is exposed by the service.
const fresh = Effect.fnUntraced(function* (environmentId = key.environmentId) {
  const db = yield* RelayDb.RelayDb;
  const limits = yield* Limits.ManagedTunnelLimits;
  const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
  const input = reservation(environmentId);
  yield* limits.reserveAllocation(input);
  yield* db
    .update(table)
    .set({ lifecycleState: "idle" })
    .where(eq(table.environmentId, environmentId));
  const row = yield* lifecycle.get(input);
  if (!row) throw new Error("Fixture allocation missing");
  return row;
});
const acquire = Effect.fnUntraced(function* (
  row: Lifecycle.LifecycleAllocation,
  kind: OperationKind = "provision",
) {
  const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
  const result = yield* lifecycle.acquireOperation({
    key: row,
    expectedTarget: targetFor(row),
    kind,
  });
  expect(result.status).toBe("Acquired");
  if (result.status !== "Acquired") throw new Error("Fixture owner missing");
  return result;
});
const begin = Effect.fnUntraced(function* (claim: Claim, mutation: MutationAction) {
  const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
  const result = yield* lifecycle.beginMutation({ claim, mutation });
  expect(result.status).toBe("Applied");
  if (result.status !== "Applied") throw new Error("Fixture step missing");
  return result.stepId;
});
const neverCreated = Effect.fnUntraced(function* (claim: Claim) {
  const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
  for (const resource of ["tunnel", "dns"] as const) {
    expect(
      yield* lifecycle.recordObservation({
        claim,
        observation: { resource, presence: "never_created" },
      }),
    ).toEqual({ status: "Applied" });
  }
});
const observeRecorded = Effect.fnUntraced(function* (claim: Claim) {
  const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
  const row = yield* lifecycle.get(claim);
  if (!row) throw new Error("Fixture allocation missing");
  expect(
    yield* lifecycle.recordObservation({
      claim,
      observation: {
        resource: "tunnel",
        presence: "recorded",
        tunnelId: "owned-tunnel",
        tunnelName: row.tunnelName,
      },
    }),
  ).toEqual({ status: "Applied" });
  expect(
    yield* lifecycle.recordObservation({
      claim,
      observation: {
        resource: "dns",
        presence: "recorded",
        dnsRecordId: "owned-dns",
        hostname: row.hostname,
        tunnelId: "owned-tunnel",
      },
    }),
  ).toEqual({ status: "Applied" });
});

describe.skipIf(!fixtureFile)("ManagedEndpointLifecycle owned PostgreSQL protocol", () => {
  it.effect("twenty simultaneous captures acquire one durable owner", () =>
    fixture(
      Effect.gen(function* () {
        const row = yield* fresh();
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        const gate = yield* Deferred.make<void>();
        const fibers = yield* Effect.forEach(Array.from({ length: 20 }), () =>
          Effect.forkChild(
            Deferred.await(gate).pipe(
              Effect.andThen(
                lifecycle.acquireOperation({
                  key,
                  kind: "provision",
                  expectedTarget: targetFor(row),
                }),
              ),
            ),
          ),
        );
        yield* Deferred.succeed(gate, undefined);
        const results = yield* Effect.forEach(fibers, Fiber.join);
        expect(results.filter((result) => result.status === "Acquired")).toHaveLength(1);
        expect(
          results.filter((result) => result.status === "Stale" || result.status === "Busy"),
        ).toHaveLength(19);
        const owned = yield* lifecycle.get(key);
        expect(owned).toMatchObject({
          lifecycleState: "owned",
          generation: 1,
          operationKind: "provision",
          pendingMutation: null,
        });
        expect(owned?.operationId).toMatch(/^[0-9a-f-]{36}$/u);
      }),
    ),
  );

  it.effect("every competing operation kind is busy after an exact owner capture", () =>
    fixture(
      Effect.gen(function* () {
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        const owner = yield* acquire(yield* fresh());
        for (const kind of ["provision", "release", "deprovision", "reconcile"] as const) {
          expect(
            yield* lifecycle.acquireOperation({
              key,
              kind,
              expectedTarget: targetFor(owner.allocation),
            }),
          ).toEqual({ status: "Busy" });
        }
        expect(yield* lifecycle.finishIdle(owner.claim)).toEqual({ status: "Applied" });
        expect(yield* lifecycle.get(key)).toMatchObject({
          lifecycleState: "idle",
          generation: 2,
          operationId: null,
        });
      }),
    ),
  );

  it.effect(
    "remove/reinsert ABA with identical logical target and generation fails immutable identity",
    () =>
      fixture(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const old = yield* fresh();
          const owner = yield* acquire(old, "deprovision");
          yield* neverCreated(owner.claim);
          expect(yield* lifecycle.requestCleanup(targetFor(owner.allocation))).toEqual({
            status: "Applied",
          });
          expect(yield* lifecycle.removeClaimed(owner.claim)).toEqual({ status: "Applied" });
          const replacement = yield* fresh();
          expect(replacement.generation).toBe(old.generation);
          expect(replacement.tunnelId).toBe(old.tunnelId);
          expect(replacement.allocationId).not.toBe(old.allocationId);
          expect(
            yield* lifecycle.acquireOperation({
              key,
              kind: "provision",
              expectedTarget: targetFor(old),
            }),
          ).toEqual({ status: "Stale" });
          expect(yield* lifecycle.requestCleanup(targetFor(old))).toEqual({ status: "Stale" });
          expect(yield* lifecycle.removeClaimed(owner.claim)).toEqual({ status: "Stale" });
          expect(yield* lifecycle.get(key)).toMatchObject({
            allocationId: replacement.allocationId,
            lifecycleState: "idle",
            cleanupRequested: false,
          });
        }),
      ),
  );

  it.effect(
    "stale generation, tunnel identity, key, owner and step cannot mutate a newer operation",
    () =>
      fixture(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const first = yield* acquire(yield* fresh());
          yield* neverCreated(first.claim);
          yield* lifecycle.finishIdle(first.claim);
          const row = yield* lifecycle.get(key);
          if (!row) throw new Error("Fixture allocation missing");
          for (const target of [
            { ...targetFor(row), generation: row.generation - 1 },
            { ...targetFor(row), tunnelId: "foreign" },
            { ...targetFor(row), key: { ...key, environmentId: "other" } },
          ]) {
            expect(
              yield* lifecycle.acquireOperation({ key, kind: "provision", expectedTarget: target }),
            ).toEqual({ status: "Stale" });
          }
          const second = yield* acquire(row);
          const stepId = yield* begin(second.claim, {
            action: "create_tunnel",
            tunnelName: row.tunnelName,
          });
          for (const claim of [
            first.claim,
            { ...second.claim, operationId: "00000000-0000-4000-8000-000000000001" },
            { ...second.claim, kind: "release" as const },
          ]) {
            expect(yield* lifecycle.finishIdle(claim)).toEqual({ status: "Stale" });
            expect(yield* lifecycle.retainUncertain(claim)).toEqual({ status: "Stale" });
            expect(
              yield* lifecycle.completeMutation({
                claim,
                stepId,
                outcome: { action: "rejected_no_effect" },
              }),
            ).toEqual({ status: "Stale" });
          }
          expect(
            yield* lifecycle.completeMutation({
              claim: second.claim,
              stepId: "00000000-0000-4000-8000-000000000002",
              outcome: { action: "rejected_no_effect" },
            }),
          ).toEqual({ status: "Stale" });
          expect((yield* lifecycle.get(key))?.pendingMutation?.stepId).toBe(stepId);
        }),
      ),
  );

  it.effect(
    "intent commits before return, one step remains fixed-generation and blocks observations/finalizers",
    () =>
      fixture(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const owner = yield* acquire(yield* fresh());
          yield* neverCreated(owner.claim);
          const stepId = yield* begin(owner.claim, {
            action: "create_tunnel",
            tunnelName: owner.allocation.tunnelName,
          });
          const secondDb = Context.get(
            yield* Layer.build(Layer.fresh(connectDatabase())),
            RelayDb.RelayDb,
          );
          const rows = yield* secondDb.select().from(table);
          expect(rows[0]).toMatchObject({
            lifecycleState: "owned",
            operationId: owner.claim.operationId,
            generation: owner.claim.generation,
            pendingMutation: { action: "create_tunnel", stepId },
          });
          expect(
            yield* lifecycle.beginMutation({
              claim: owner.claim,
              mutation: { action: "create_tunnel", tunnelName: owner.allocation.tunnelName },
            }),
          ).toEqual({ status: "Stale" });
          expect(
            yield* lifecycle.recordObservation({
              claim: owner.claim,
              observation: {
                resource: "tunnel",
                presence: "recorded",
                tunnelId: "unproven",
                tunnelName: owner.allocation.tunnelName,
              },
            }),
          ).toEqual({ status: "Stale" });
          expect(yield* lifecycle.finishIdle(owner.claim)).toEqual({ status: "Stale" });
          expect(
            yield* lifecycle.completeMutation({
              claim: owner.claim,
              stepId,
              outcome: {
                action: "create_tunnel",
                tunnelId: "created-id",
                tunnelName: owner.allocation.tunnelName,
              },
            }),
          ).toEqual({ status: "Applied" });
          expect(yield* lifecycle.get(key)).toMatchObject({
            generation: owner.claim.generation,
            pendingMutation: null,
            tunnelPresence: "recorded",
            tunnelId: "created-id",
          });
          const next = yield* begin(owner.claim, {
            action: "configure_tunnel",
            tunnelId: "created-id",
            tunnelName: owner.allocation.tunnelName,
            origin: { localHttpHost: "localhost", localHttpPort: 3000 },
          });
          expect(next).not.toBe(stepId);
          expect(
            yield* lifecycle.completeMutation({
              claim: owner.claim,
              stepId,
              outcome: { action: "rejected_no_effect" },
            }),
          ).toEqual({ status: "Stale" });
        }),
      ),
  );

  it.effect(
    "null resource IDs do not authorize create until safe-history observations are checkpointed",
    () =>
      fixture(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const owner = yield* acquire(yield* fresh());
          expect(
            yield* lifecycle.beginMutation({
              claim: owner.claim,
              mutation: { action: "create_tunnel", tunnelName: owner.allocation.tunnelName },
            }),
          ).toEqual({ status: "Stale" });
          expect(
            yield* lifecycle.recordObservation({
              claim: owner.claim,
              observation: {
                resource: "tunnel",
                presence: "recorded",
                tunnelId: "candidate",
                tunnelName: "wrong-name",
              },
            }),
          ).toEqual({ status: "Stale" });
          yield* neverCreated(owner.claim);
          const tunnelStep = yield* begin(owner.claim, {
            action: "create_tunnel",
            tunnelName: owner.allocation.tunnelName,
          });
          yield* lifecycle.completeMutation({
            claim: owner.claim,
            stepId: tunnelStep,
            outcome: {
              action: "create_tunnel",
              tunnelId: "new-tunnel",
              tunnelName: owner.allocation.tunnelName,
            },
          });
          const configStep = yield* begin(owner.claim, {
            action: "configure_tunnel",
            tunnelId: "new-tunnel",
            tunnelName: owner.allocation.tunnelName,
            origin: { localHttpHost: "127.0.0.1", localHttpPort: 3000 },
          });
          yield* lifecycle.completeMutation({
            claim: owner.claim,
            stepId: configStep,
            outcome: { action: "configure_tunnel", tunnelId: "new-tunnel" },
          });
          const dnsStep = yield* begin(owner.claim, {
            action: "create_dns",
            hostname: owner.allocation.hostname,
            tunnelId: "new-tunnel",
          });
          expect(
            yield* lifecycle.completeMutation({
              claim: owner.claim,
              stepId: dnsStep,
              outcome: {
                action: "create_dns",
                dnsRecordId: "new-dns",
                hostname: "wrong-host",
                tunnelId: "new-tunnel",
              },
            }),
          ).toEqual({ status: "Stale" });
          yield* lifecycle.completeMutation({
            claim: owner.claim,
            stepId: dnsStep,
            outcome: {
              action: "create_dns",
              dnsRecordId: "new-dns",
              hostname: owner.allocation.hostname,
              tunnelId: "new-tunnel",
            },
          });
          expect(yield* lifecycle.get(key)).toMatchObject({
            generation: owner.claim.generation,
            tunnelId: "new-tunnel",
            dnsRecordId: "new-dns",
            dnsTargetTunnelId: "new-tunnel",
            tunnelPresence: "recorded",
            dnsPresence: "recorded",
            readyAt: null,
            pendingMutation: null,
          });
        }),
      ),
  );

  it.effect(
    "unknown outcomes retain exact owner and step indefinitely, including simulated process death",
    () =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const owner = yield* acquire(yield* fresh());
          yield* neverCreated(owner.claim);
          const stepId = yield* begin(owner.claim, {
            action: "create_tunnel",
            tunnelName: owner.allocation.tunnelName,
          });
          yield* db
            .update(table)
            .set({ operationStartedAt: "1900-01-01T00:00:00.000Z" })
            .where(eq(table.allocationId, owner.claim.allocationId));
          expect(
            yield* lifecycle.acquireOperation({
              key,
              kind: "deprovision",
              expectedTarget: targetFor(owner.allocation),
            }),
          ).toEqual({ status: "Busy" });
          expect(yield* lifecycle.retainUncertain(owner.claim)).toEqual({ status: "Applied" });
          expect(yield* lifecycle.retainUncertain(owner.claim)).toEqual({ status: "Applied" });
          expect(
            yield* lifecycle.acquireOperation({
              key,
              kind: "release",
              expectedTarget: targetFor(owner.allocation),
            }),
          ).toEqual({ status: "RepairRequired" });
          expect(yield* lifecycle.finishIdle(owner.claim)).toEqual({ status: "Stale" });
          expect(
            yield* lifecycle.completeMutation({
              claim: owner.claim,
              stepId,
              outcome: { action: "rejected_no_effect" },
            }),
          ).toEqual({ status: "Stale" });
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "uncertain",
            generation: owner.claim.generation,
            operationId: owner.claim.operationId,
            pendingMutation: { stepId },
            operationStartedAt: "1900-01-01T00:00:00.000Z",
          });
        }),
      ),
  );

  it.effect(
    "cleanup intent preserves a running step, allows its checkpoint and cancels the next dispatch",
    () =>
      fixture(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const owner = yield* acquire(yield* fresh());
          yield* neverCreated(owner.claim);
          const stepId = yield* begin(owner.claim, {
            action: "create_tunnel",
            tunnelName: owner.allocation.tunnelName,
          });
          expect(yield* lifecycle.requestCleanup(targetFor(owner.allocation))).toEqual({
            status: "Applied",
          });
          expect(yield* lifecycle.get(key)).toMatchObject({
            cleanupRequested: true,
            operationId: owner.claim.operationId,
            pendingMutation: { stepId },
            generation: owner.claim.generation,
          });
          yield* lifecycle.completeMutation({
            claim: owner.claim,
            stepId,
            outcome: {
              action: "create_tunnel",
              tunnelId: "late-created",
              tunnelName: owner.allocation.tunnelName,
            },
          });
          expect(
            yield* lifecycle.beginMutation({
              claim: owner.claim,
              mutation: {
                action: "configure_tunnel",
                tunnelId: "late-created",
                tunnelName: owner.allocation.tunnelName,
                origin: { localHttpHost: "localhost", localHttpPort: 3000 },
              },
            }),
          ).toEqual({ status: "Cancelled" });
          expect(yield* lifecycle.finishIdle(owner.claim)).toEqual({ status: "Applied" });
          const row = yield* lifecycle.get(key);
          if (!row) throw new Error("Fixture allocation missing");
          for (const kind of ["provision", "reconcile"] as const)
            expect(
              yield* lifecycle.acquireOperation({ key, kind, expectedTarget: targetFor(row) }),
            ).toEqual({ status: "Busy" });
          expect(row).toMatchObject({
            cleanupRequested: true,
            tunnelPresence: "recorded",
            tunnelId: "late-created",
            lifecycleState: "idle",
          });
        }),
      ),
  );

  it.effect(
    "partial exact teardown persists DNS absence and resumes the same tunnel after a known no-effect rejection",
    () =>
      fixture(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const owner = yield* acquire(yield* fresh(), "deprovision");
          yield* observeRecorded(owner.claim);
          let row = yield* lifecycle.get(key);
          if (!row) throw new Error("Fixture allocation missing");
          yield* lifecycle.requestCleanup(targetFor(row));
          const dnsStep = yield* begin(owner.claim, {
            action: "delete_dns",
            dnsRecordId: "owned-dns",
            hostname: row.hostname,
            previousTunnelId: "owned-tunnel",
          });
          yield* lifecycle.completeMutation({
            claim: owner.claim,
            stepId: dnsStep,
            outcome: { action: "delete_dns", dnsRecordId: "owned-dns" },
          });
          const tunnelStep = yield* begin(owner.claim, {
            action: "delete_tunnel",
            tunnelId: "owned-tunnel",
            tunnelName: row.tunnelName,
          });
          expect(
            yield* lifecycle.completeMutation({
              claim: owner.claim,
              stepId: tunnelStep,
              outcome: { action: "delete_tunnel", tunnelId: "foreign" },
            }),
          ).toEqual({ status: "Stale" });
          yield* lifecycle.completeMutation({
            claim: owner.claim,
            stepId: tunnelStep,
            outcome: { action: "rejected_no_effect" },
          });
          yield* lifecycle.finishIdle(owner.claim);
          row = yield* lifecycle.get(key);
          if (!row) throw new Error("Fixture allocation missing");
          expect(row).toMatchObject({
            dnsPresence: "absent",
            dnsRecordId: "owned-dns",
            dnsTargetTunnelId: "owned-tunnel",
            tunnelPresence: "recorded",
            tunnelId: "owned-tunnel",
          });
          const resumed = yield* acquire(row, "deprovision");
          expect(
            yield* lifecycle.recordObservation({
              claim: resumed.claim,
              observation: {
                resource: "dns",
                presence: "recorded",
                dnsRecordId: "different-dns",
                hostname: row.hostname,
                tunnelId: "owned-tunnel",
              },
            }),
          ).toEqual({ status: "Stale" });
          expect(
            yield* lifecycle.beginMutation({
              claim: resumed.claim,
              mutation: {
                action: "delete_dns",
                dnsRecordId: "owned-dns",
                hostname: row.hostname,
                previousTunnelId: "owned-tunnel",
              },
            }),
          ).toEqual({ status: "Stale" });
          const stepId = yield* begin(resumed.claim, {
            action: "delete_tunnel",
            tunnelId: "owned-tunnel",
            tunnelName: row.tunnelName,
          });
          yield* lifecycle.completeMutation({
            claim: resumed.claim,
            stepId,
            outcome: { action: "delete_tunnel", tunnelId: "owned-tunnel" },
          });
          expect(yield* lifecycle.removeClaimed(resumed.claim)).toEqual({ status: "Applied" });
          expect(yield* lifecycle.get(key)).toBeNull();
        }),
      ),
  );

  it.effect(
    "capacity is retained until exact deprovision removal proves both absences and cleanup intent",
    () =>
      fixture(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const limits = yield* Limits.ManagedTunnelLimits;
          const owner = yield* acquire(yield* fresh(), "deprovision");
          yield* fresh("second");
          yield* fresh("third");
          expect(yield* Effect.flip(limits.reserveAllocation(reservation("fourth")))).toMatchObject(
            { activeTunnels: 3 },
          );
          expect(yield* lifecycle.removeClaimed(owner.claim)).toEqual({ status: "Stale" });
          yield* neverCreated(owner.claim);
          expect(yield* lifecycle.removeClaimed(owner.claim)).toEqual({ status: "Stale" });
          yield* lifecycle.requestCleanup(targetFor(owner.allocation));
          expect(yield* lifecycle.removeClaimed(owner.claim)).toEqual({ status: "Applied" });
          yield* limits.reserveAllocation(reservation("fourth"));
        }),
      ),
  );

  it.effect(
    "never-created release completes without inventing a marker when marking is requested",
    () =>
      fixture(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const owner = yield* acquire(yield* fresh(), "release");
          yield* neverCreated(owner.claim);
          expect(
            yield* lifecycle.finishReleased({ claim: owner.claim, markReleased: true }),
          ).toEqual({ status: "Applied" });
          expect(yield* lifecycle.get(key)).toMatchObject({
            allocationId: owner.claim.allocationId,
            lifecycleState: "idle",
            operationId: null,
            generation: owner.claim.generation + 1,
            tunnelPresence: "never_created",
            tunnelId: null,
            tunnelReleasedAt: null,
          });
        }),
      ),
  );

  it.effect.each([true, false])(
    "never-created release preserves its historical marker with markReleased=%s",
    (markReleased) =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const owner = yield* acquire(yield* fresh(), "release");
          yield* neverCreated(owner.claim);
          yield* db
            .update(table)
            .set({ tunnelReleasedAt: "historical-marker" })
            .where(eq(table.allocationId, owner.claim.allocationId));
          expect(yield* lifecycle.finishReleased({ claim: owner.claim, markReleased })).toEqual({
            status: "Applied",
          });
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "idle",
            tunnelId: null,
            tunnelPresence: "never_created",
            tunnelReleasedAt: "historical-marker",
          });
        }),
      ),
  );

  it.effect.each([true, false])(
    "recorded exact absence permits release and changes its historical marker only with markReleased=%s",
    (markReleased) =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const owner = yield* acquire(yield* fresh(), "release");
          yield* observeRecorded(owner.claim);
          expect(
            yield* lifecycle.recordObservation({
              claim: owner.claim,
              observation: { resource: "tunnel", presence: "absent", tunnelId: "owned-tunnel" },
            }),
          ).toEqual({ status: "Applied" });
          yield* db
            .update(table)
            .set({ tunnelReleasedAt: "historical-marker" })
            .where(eq(table.allocationId, owner.claim.allocationId));
          expect(yield* lifecycle.finishReleased({ claim: owner.claim, markReleased })).toEqual({
            status: "Applied",
          });
          const row = yield* lifecycle.get(key);
          expect(row).toMatchObject({
            lifecycleState: "idle",
            tunnelId: "owned-tunnel",
            tunnelPresence: "absent",
            dnsRecordId: "owned-dns",
          });
          if (markReleased) {
            expect(row?.tunnelReleasedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
            expect(row?.tunnelReleasedAt).not.toBe("historical-marker");
          } else {
            expect(row?.tunnelReleasedAt).toBe("historical-marker");
          }
        }),
      ),
  );

  it.effect(
    "release requires proven absence, preserves recorded IDs/readiness and never frees capacity",
    () =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const owner = yield* acquire(yield* fresh(), "release");
          expect(
            yield* lifecycle.finishReleased({ claim: owner.claim, markReleased: true }),
          ).toEqual({ status: "Stale" });
          yield* observeRecorded(owner.claim);
          yield* db
            .update(table)
            .set({
              readyAt: "historical-ready",
              origin: { localHttpHost: "localhost", localHttpPort: 3000 },
            })
            .where(eq(table.allocationId, owner.claim.allocationId));
          const stepId = yield* begin(owner.claim, {
            action: "delete_tunnel",
            tunnelId: "owned-tunnel",
            tunnelName: owner.allocation.tunnelName,
          });
          expect(
            yield* lifecycle.finishReleased({ claim: owner.claim, markReleased: true }),
          ).toEqual({ status: "Stale" });
          yield* lifecycle.completeMutation({
            claim: owner.claim,
            stepId,
            outcome: { action: "delete_tunnel", tunnelId: "owned-tunnel" },
          });
          expect(
            yield* lifecycle.finishReleased({ claim: owner.claim, markReleased: true }),
          ).toEqual({ status: "Applied" });
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "idle",
            generation: 2,
            tunnelPresence: "absent",
            tunnelId: "owned-tunnel",
            dnsRecordId: "owned-dns",
            readyAt: "historical-ready",
            origin: { localHttpHost: "localhost", localHttpPort: 3000 },
          });
          expect((yield* lifecycle.get(key))?.tunnelReleasedAt).not.toBeNull();
          const counts = yield* db.$client<{
            count: number;
          }>`SELECT count(*)::int AS count FROM relay_managed_endpoint_allocations`;
          expect(counts[0]?.count).toBe(1);
        }),
      ),
  );

  it.effect("a no-effect release rejection leaves its existing marker unchanged", () =>
    fixture(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        const owner = yield* acquire(yield* fresh(), "release");
        yield* observeRecorded(owner.claim);
        yield* db
          .update(table)
          .set({ tunnelReleasedAt: "historical-marker" })
          .where(eq(table.allocationId, owner.claim.allocationId));
        const stepId = yield* begin(owner.claim, {
          action: "delete_tunnel",
          tunnelId: "owned-tunnel",
          tunnelName: owner.allocation.tunnelName,
        });
        yield* lifecycle.completeMutation({
          claim: owner.claim,
          stepId,
          outcome: { action: "rejected_no_effect" },
        });
        expect(yield* lifecycle.finishReleased({ claim: owner.claim, markReleased: true })).toEqual(
          { status: "Stale" },
        );
        yield* lifecycle.finishIdle(owner.claim);
        expect(yield* lifecycle.get(key)).toMatchObject({
          tunnelPresence: "recorded",
          tunnelReleasedAt: "historical-marker",
        });
      }),
    ),
  );

  it.effect(
    "exact DNS ownership rejects foreign observations, retargets only a checkpointed previous target",
    () =>
      fixture(
        Effect.gen(function* () {
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const owner = yield* acquire(yield* fresh());
          yield* observeRecorded(owner.claim);
          expect(
            yield* lifecycle.recordObservation({
              claim: owner.claim,
              observation: {
                resource: "dns",
                presence: "recorded",
                dnsRecordId: "owned-dns",
                hostname: owner.allocation.hostname,
                tunnelId: "foreign",
              },
            }),
          ).toEqual({ status: "Stale" });
          expect(
            yield* lifecycle.recordObservation({
              claim: owner.claim,
              observation: {
                resource: "tunnel",
                presence: "recorded",
                tunnelId: "replacement",
                tunnelName: owner.allocation.tunnelName,
              },
            }),
          ).toEqual({ status: "Stale" });
          yield* lifecycle.recordObservation({
            claim: owner.claim,
            observation: { resource: "tunnel", presence: "absent", tunnelId: "owned-tunnel" },
          });
          const stepId = yield* begin(owner.claim, {
            action: "create_tunnel",
            tunnelName: owner.allocation.tunnelName,
          });
          yield* lifecycle.completeMutation({
            claim: owner.claim,
            stepId,
            outcome: {
              action: "create_tunnel",
              tunnelId: "replacement",
              tunnelName: owner.allocation.tunnelName,
            },
          });
          expect(
            yield* lifecycle.beginMutation({
              claim: owner.claim,
              mutation: {
                action: "update_dns",
                dnsRecordId: "owned-dns",
                hostname: owner.allocation.hostname,
                previousTunnelId: "foreign",
                nextTunnelId: "replacement",
              },
            }),
          ).toEqual({ status: "Stale" });
          const dnsStep = yield* begin(owner.claim, {
            action: "update_dns",
            dnsRecordId: "owned-dns",
            hostname: owner.allocation.hostname,
            previousTunnelId: "owned-tunnel",
            nextTunnelId: "replacement",
          });
          expect(
            yield* lifecycle.completeMutation({
              claim: owner.claim,
              stepId: dnsStep,
              outcome: {
                action: "update_dns",
                dnsRecordId: "other-dns",
                hostname: owner.allocation.hostname,
                tunnelId: "replacement",
              },
            }),
          ).toEqual({ status: "Stale" });
          yield* lifecycle.completeMutation({
            claim: owner.claim,
            stepId: dnsStep,
            outcome: {
              action: "update_dns",
              dnsRecordId: "owned-dns",
              hostname: owner.allocation.hostname,
              tunnelId: "replacement",
            },
          });
          expect(yield* lifecycle.get(key)).toMatchObject({
            tunnelId: "replacement",
            dnsRecordId: "owned-dns",
            dnsTargetTunnelId: "replacement",
            pendingMutation: null,
            generation: owner.claim.generation,
          });
        }),
      ),
  );

  it.effect("a new active managed link blocks deprovision acquisition and final removal", () =>
    fixture(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        const owner = yield* acquire(yield* fresh(), "deprovision");
        yield* neverCreated(owner.claim);
        yield* lifecycle.requestCleanup(targetFor(owner.allocation));
        yield* db.insert(relayEnvironmentLinks).values({
          ...key,
          environmentPublicKey: "environment-key",
          endpointHttpBaseUrl: "https://lifecycle-env.fixture.test",
          endpointWsBaseUrl: "wss://lifecycle-env.fixture.test",
          endpointProviderKind: "cloudflare_tunnel",
          managedTunnelsEnabled: true,
          linkedAt: "2026-10-13T00:00:00.000Z",
          createdAt: "2026-10-13T00:00:00.000Z",
          updatedAt: "2026-10-13T00:00:00.000Z",
        });
        expect(yield* lifecycle.removeClaimed(owner.claim)).toEqual({ status: "Stale" });
        yield* lifecycle.finishIdle(owner.claim);
        const row = yield* lifecycle.get(key);
        if (!row) throw new Error("Fixture allocation missing");
        expect(
          yield* lifecycle.acquireOperation({
            key,
            kind: "deprovision",
            expectedTarget: targetFor(row),
          }),
        ).toEqual({ status: "Busy" });
      }),
    ),
  );

  it.effect("no SQL locks survive a committed intent or a durable owner", () =>
    fixture(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const owner = yield* acquire(yield* fresh());
        yield* neverCreated(owner.claim);
        yield* begin(owner.claim, {
          action: "create_tunnel",
          tunnelName: owner.allocation.tunnelName,
        });
        const contender = Context.get(
          yield* Layer.build(Layer.fresh(connectDatabase("100ms"))),
          RelayDb.RelayDb,
        );
        const released = yield* Deferred.make<void>();
        const held = yield* Deferred.make<number, SqlError>();
        const fiber = yield* Effect.forkChild(
          contender.$client
            .withTransaction(
              Effect.gen(function* () {
                yield* contender.$client`SELECT pg_advisory_xact_lock(hashtextextended(${`relay-managed-tunnel:${key.userId}`}, 0))`;
                yield* contender.$client`SELECT * FROM relay_managed_endpoint_allocations WHERE allocation_id = ${owner.claim.allocationId}::uuid FOR UPDATE NOWAIT`;
                const pid = yield* contender.$client<{
                  pid: number;
                }>`SELECT pg_backend_pid() AS pid`;
                yield* Deferred.succeed(held, pid[0]?.pid ?? 0);
                yield* Deferred.await(released);
              }),
            )
            .pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Deferred.failCause(held, exit.cause) : Effect.void,
              ),
            ),
        );
        yield* Effect.gen(function* () {
          const holderPid = yield* Deferred.await(held);
          const ownPid = yield* db.$client<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
          expect(holderPid).toBeGreaterThan(0);
          expect(ownPid[0]?.pid).not.toBe(holderPid);
        }).pipe(Effect.ensuring(Deferred.succeed(released, undefined)));
        yield* Fiber.join(fiber);
      }),
    ),
  );

  it.effect("ambient transactions are rejected before mutation", () =>
    fixture(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        const row = yield* fresh();
        const result = yield* db.$client.withTransaction(
          Effect.result(
            lifecycle.acquireOperation({ key, kind: "provision", expectedTarget: targetFor(row) }),
          ),
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(yield* lifecycle.get(key)).toMatchObject({
          lifecycleState: "idle",
          generation: 0,
          operationId: null,
        });
      }),
    ),
  );

  it.effect("generation overflow fails closed without resetting identity or ownership", () =>
    fixture(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        const row = yield* fresh();
        yield* db
          .update(table)
          .set({ generation: 2_147_483_647 })
          .where(eq(table.allocationId, row.allocationId));
        const current = yield* lifecycle.get(key);
        if (!current) throw new Error("Fixture allocation missing");
        expect(
          yield* Effect.flip(
            lifecycle.acquireOperation({
              key,
              kind: "provision",
              expectedTarget: targetFor(current),
            }),
          ),
        ).toMatchObject({ operation: "acquire" });
        expect(yield* lifecycle.get(key)).toMatchObject({
          allocationId: row.allocationId,
          generation: 2_147_483_647,
          lifecycleState: "idle",
          operationId: null,
        });
      }),
    ),
  );

  it.effect("a checkpoint SQL failure leaves the pending intent and owner intact", () =>
    fixture(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        const owner = yield* acquire(yield* fresh());
        yield* neverCreated(owner.claim);
        const stepId = yield* begin(owner.claim, {
          action: "create_tunnel",
          tunnelName: owner.allocation.tunnelName,
        });
        yield* db.$client`CREATE FUNCTION task4c_managed_endpoints.reject_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.pending_mutation IS NULL AND OLD.pending_mutation IS NOT NULL THEN RAISE EXCEPTION 'fixture checkpoint rejected'; END IF; RETURN NEW; END $$`;
        yield* db.$client`CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON relay_managed_endpoint_allocations FOR EACH ROW EXECUTE FUNCTION task4c_managed_endpoints.reject_checkpoint()`;
        expect(
          yield* Effect.flip(
            lifecycle.completeMutation({
              claim: owner.claim,
              stepId,
              outcome: {
                action: "create_tunnel",
                tunnelId: "success-in-ram",
                tunnelName: owner.allocation.tunnelName,
              },
            }),
          ),
        ).toMatchObject({ operation: "complete" });
        expect(yield* lifecycle.get(key)).toMatchObject({
          operationId: owner.claim.operationId,
          pendingMutation: { stepId },
          tunnelId: null,
          lifecycleState: "owned",
        });
        yield* db.$client`DROP TRIGGER reject_checkpoint ON relay_managed_endpoint_allocations`;
        yield* db.$client`DROP FUNCTION task4c_managed_endpoints.reject_checkpoint()`;
      }),
    ),
  );

  it.effect(
    "SQL failures roll back intent and cancellation writes without losing the live owner",
    () =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const owner = yield* acquire(yield* fresh());
          yield* neverCreated(owner.claim);
          yield* db.$client`CREATE FUNCTION task4c_managed_endpoints.reject_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.pending_mutation IS NOT NULL OR NEW.cleanup_requested THEN RAISE EXCEPTION 'fixture intent rejected'; END IF; RETURN NEW; END $$`;
          yield* db.$client`CREATE TRIGGER reject_intent BEFORE UPDATE ON relay_managed_endpoint_allocations FOR EACH ROW EXECUTE FUNCTION task4c_managed_endpoints.reject_intent()`;
          expect(
            yield* Effect.flip(
              lifecycle.beginMutation({
                claim: owner.claim,
                mutation: { action: "create_tunnel", tunnelName: owner.allocation.tunnelName },
              }),
            ),
          ).toMatchObject({ operation: "begin" });
          expect(
            yield* Effect.flip(lifecycle.requestCleanup(targetFor(owner.allocation))),
          ).toMatchObject({ operation: "cleanup-intent" });
          expect(yield* lifecycle.get(key)).toMatchObject({
            operationId: owner.claim.operationId,
            generation: owner.claim.generation,
            lifecycleState: "owned",
            pendingMutation: null,
            cleanupRequested: false,
          });
          yield* db.$client`DROP TRIGGER reject_intent ON relay_managed_endpoint_allocations`;
          yield* db.$client`DROP FUNCTION task4c_managed_endpoints.reject_intent()`;
          yield* begin(owner.claim, {
            action: "create_tunnel",
            tunnelName: owner.allocation.tunnelName,
          });
        }),
      ),
  );

  it.effect("finish generation overflow rolls back owner clearing", () =>
    fixture(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        const owner = yield* acquire(yield* fresh());
        yield* db
          .update(table)
          .set({ generation: 2_147_483_647 })
          .where(eq(table.allocationId, owner.claim.allocationId));
        const claim = { ...owner.claim, generation: 2_147_483_647 };
        expect(yield* Effect.flip(lifecycle.finishIdle(claim))).toMatchObject({
          operation: "finish-idle",
        });
        expect(yield* lifecycle.get(key)).toMatchObject({
          operationId: claim.operationId,
          generation: claim.generation,
          lifecycleState: "owned",
          pendingMutation: null,
        });
      }),
    ),
  );

  it.effect("failed uncertainty checkpoint preserves the already-blocking pending owner", () =>
    fixture(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        const owner = yield* acquire(yield* fresh());
        yield* neverCreated(owner.claim);
        const stepId = yield* begin(owner.claim, {
          action: "create_tunnel",
          tunnelName: owner.allocation.tunnelName,
        });
        yield* db.$client`CREATE FUNCTION task4c_managed_endpoints.reject_uncertain() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.lifecycle_state = 'uncertain' THEN RAISE EXCEPTION 'fixture uncertain rejected'; END IF; RETURN NEW; END $$`;
        yield* db.$client`CREATE TRIGGER reject_uncertain BEFORE UPDATE ON relay_managed_endpoint_allocations FOR EACH ROW EXECUTE FUNCTION task4c_managed_endpoints.reject_uncertain()`;
        expect(yield* Effect.flip(lifecycle.retainUncertain(owner.claim))).toMatchObject({
          operation: "uncertain",
        });
        expect(yield* lifecycle.get(key)).toMatchObject({
          operationId: owner.claim.operationId,
          pendingMutation: { stepId },
          lifecycleState: "owned",
        });
        expect(yield* lifecycle.finishIdle(owner.claim)).toEqual({ status: "Stale" });
      }),
    ),
  );

  it.effect(
    "legacy defaults remain quarantined even when old IDs and misleading readiness/markers are present",
    () =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          yield* db.insert(table).values({ ...reservation(), createdAt: "now", updatedAt: "now" });
          yield* db
            .update(table)
            .set({
              tunnelId: "legacy-tunnel",
              dnsRecordId: "legacy-dns",
              readyAt: "legacy-ready",
              tunnelReleasedAt: "misleading-marker",
            })
            .where(eq(table.environmentId, key.environmentId));
          const row = yield* lifecycle.get(key);
          if (!row) throw new Error("Fixture allocation missing");
          for (const kind of ["provision", "release", "deprovision", "reconcile"] as const)
            expect(
              yield* lifecycle.acquireOperation({ key, kind, expectedTarget: targetFor(row) }),
            ).toEqual({ status: "RepairRequired" });
          expect(row).toMatchObject({
            lifecycleState: "legacy_unverified",
            tunnelPresence: "unresolved",
            dnsPresence: "unresolved",
            tunnelId: "legacy-tunnel",
            dnsRecordId: "legacy-dns",
          });
        }),
      ),
  );
  it.effect.each([
    "begin",
    "complete",
    "observe",
    "idle",
    "released",
    "remove",
    "cleanup",
    "uncertain",
  ] as const)(
    "reports a suppressed $0 transition as Stale, preserving the actual row",
    (transition) =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const row = yield* fresh();
          if (transition === "remove") yield* lifecycle.requestCleanup(targetFor(row));
          const owner = yield* acquire(
            row,
            transition === "remove"
              ? "deprovision"
              : transition === "released"
                ? "release"
                : "provision",
          );
          yield* neverCreated(owner.claim);
          const stepId =
            transition === "complete"
              ? yield* begin(owner.claim, { action: "create_tunnel", tunnelName: row.tunnelName })
              : null;
          const before = yield* lifecycle.get(key);
          yield* db.$client`CREATE FUNCTION task4c_managed_endpoints.suppress_lifecycle_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`;
          yield* db.$client`CREATE TRIGGER suppress_lifecycle_transition BEFORE UPDATE OR DELETE ON relay_managed_endpoint_allocations FOR EACH ROW EXECUTE FUNCTION task4c_managed_endpoints.suppress_lifecycle_transition()`;
          const result =
            transition === "begin"
              ? yield* lifecycle.beginMutation({
                  claim: owner.claim,
                  mutation: { action: "create_tunnel", tunnelName: row.tunnelName },
                })
              : transition === "complete"
                ? yield* lifecycle.completeMutation({
                    claim: owner.claim,
                    stepId: stepId ?? "",
                    outcome: {
                      action: "create_tunnel",
                      tunnelId: "suppressed",
                      tunnelName: row.tunnelName,
                    },
                  })
                : transition === "observe"
                  ? yield* lifecycle.recordObservation({
                      claim: owner.claim,
                      observation: {
                        resource: "tunnel",
                        presence: "recorded",
                        tunnelId: "suppressed",
                        tunnelName: row.tunnelName,
                      },
                    })
                  : transition === "idle"
                    ? yield* lifecycle.finishIdle(owner.claim)
                    : transition === "released"
                      ? yield* lifecycle.finishReleased({ claim: owner.claim, markReleased: true })
                      : transition === "remove"
                        ? yield* lifecycle.removeClaimed(owner.claim)
                        : transition === "uncertain"
                          ? yield* lifecycle.retainUncertain(owner.claim)
                          : yield* lifecycle.requestCleanup(targetFor(owner.allocation));
          expect(result).toEqual({ status: "Stale" });
          expect(yield* lifecycle.get(key)).toEqual(before);
        }),
      ),
  );
});
