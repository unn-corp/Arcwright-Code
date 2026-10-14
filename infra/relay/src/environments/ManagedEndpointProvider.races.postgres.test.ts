import { describe, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as RelayDb from "../db.ts";
import {
  relayManagedEndpointAllocations as table,
  relayEnvironmentLinks,
} from "../persistence/schema.ts";
import * as Lifecycle from "./ManagedEndpointLifecycle.ts";
import * as Limits from "./ManagedTunnelLimits.ts";
import * as Credentials from "./EnvironmentCredentials.ts";
import * as Links from "./EnvironmentLinks.ts";
import { targetFor } from "./managedEndpointLifecycleContracts.ts";
import { connectDatabase, fixtureFile } from "./managedEndpointPostgresFixture.ts";
import {
  awaitBarrier,
  fixture,
  key,
  origin,
  request,
  makeRuntime,
  ready,
} from "./managedEndpointRuntimeTestFixture.ts";
import { publicationFor } from "./managedEndpointProviderTestFixture.ts";

const mutations = (calls: readonly string[]) =>
  calls.filter((call) =>
    [
      "tunnel-create",
      "tunnel-configure",
      "dns-create",
      "dns-update",
      "dns-delete",
      "tunnel-delete",
    ].includes(call),
  );
const winners = ["provision", "release", "reconcile", "deprovision", "reaper"] as const;

describe.skipIf(!fixtureFile)("Managed endpoint public lifecycle races PostgreSQL", () => {
  it.effect.each(["tunnel-list", "dns-list"] as const)(
    "owner spans held %s discovery until final publication",
    (stage) =>
      fixture(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const runtime = yield* makeRuntime({
            before: (op) =>
              op === stage
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
          });
          const fiber = yield* Effect.forkChild(runtime.provider.provision(request));
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(resume, undefined).pipe(
              Effect.andThen(Fiber.interrupt(fiber)),
              Effect.asVoid,
            ),
          );
          yield* awaitBarrier(entered, fiber);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const held = yield* lifecycle.get(key);
          expect(held).toMatchObject({
            lifecycleState: "owned",
            operationKind: "provision",
            pendingMutation: null,
          });
          expect(yield* runtime.provider.release(key)).toBe(false);
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(request)))).toBe(
            true,
          );
          expect(yield* lifecycle.get(key)).toEqual(held);
          const dispatched = mutations(runtime.calls);
          yield* Deferred.succeed(resume, undefined);
          expect((yield* Fiber.join(fiber)).kind).toBe("linked");
          expect(dispatched).toEqual(
            stage === "tunnel-list" ? [] : ["tunnel-create", "tunnel-configure"],
          );
          expect(yield* lifecycle.get(key)).toMatchObject({
            allocationId: held?.allocationId,
            lifecycleState: "idle",
            operationId: null,
          });
        }),
      ),
  );

  it.effect(
    "twenty concurrent public provisions dispatch exactly one create and publish one allocation",
    () =>
      fixture(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const losersDone = yield* Deferred.make<void>();
          let completed = 0;
          const runtime = yield* makeRuntime({
            before: (op) =>
              op === "tunnel-create"
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
          });
          const fibers = yield* Effect.forEach(Array.from({ length: 20 }), () =>
            Effect.forkChild(
              Deferred.await(gate).pipe(
                Effect.andThen(Effect.exit(runtime.provider.provision(request))),
                Effect.tap(() =>
                  Effect.gen(function* () {
                    completed++;
                    if (completed === 19) yield* Deferred.succeed(losersDone, undefined);
                  }),
                ),
              ),
            ),
          );
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(resume, undefined).pipe(
              Effect.andThen(Effect.forEach(fibers, Fiber.interrupt)),
              Effect.asVoid,
            ),
          );
          yield* Deferred.succeed(gate, undefined);
          yield* Effect.raceFirst(
            Deferred.await(entered),
            Effect.forEach(fibers, Fiber.join).pipe(
              Effect.andThen(Effect.die("All public provisions settled without create barrier")),
            ),
          );
          yield* Deferred.await(losersDone);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const db = yield* RelayDb.RelayDb;
          const held = yield* lifecycle.get(key);
          expect(held).toMatchObject({
            lifecycleState: "owned",
            operationKind: "provision",
            tunnelId: null,
            pendingMutation: { action: "create_tunnel" },
          });
          expect(held?.operationId).toBeTypeOf("string");
          expect(held?.pendingMutation?.stepId).toBeTypeOf("string");
          expect(yield* db.select().from(table)).toHaveLength(1);
          expect(mutations(runtime.calls)).toEqual(["tunnel-create"]);
          yield* Deferred.succeed(resume, undefined);
          const exits = yield* Effect.forEach(fibers, Fiber.join);
          expect(exits.filter(Exit.isSuccess)).toHaveLength(1);
          expect(exits.filter(Exit.isFailure)).toHaveLength(19);
          expect(yield* lifecycle.get(key)).toMatchObject({
            allocationId: held?.allocationId,
            lifecycleState: "idle",
            operationId: null,
            pendingMutation: null,
            tunnelId: "tunnel-1",
            dnsRecordId: "dns-1",
          });
          expect(yield* db.select().from(relayEnvironmentLinks)).toHaveLength(1);
        }),
      ),
  );

  it.effect.each(winners)(
    "held public %s excludes all other public mutations with valid authority",
    (winner) =>
      fixture(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          let holding = false;
          const stage =
            winner === "provision" || winner === "reconcile"
              ? "tunnel-configure"
              : winner === "deprovision"
                ? "dns-delete"
                : "tunnel-delete";
          const runtime = yield* makeRuntime({
            before: (op) =>
              holding && op === stage
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
          });
          const { row, expectedLink } = yield* ready(runtime);
          yield* runtime.provider.reconcileOrigin({
            ...key,
            origin,
            tunnelId: row.tunnelId!,
            expectedLink,
          });
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const registered = yield* lifecycle.get(key);
          if (!registered) throw new Error("Missing registration");
          const cleanup =
            winner === "deprovision" ? yield* lifecycle.revokeAndRequestCleanup(key) : null;
          holding = true;
          runtime.calls.length = 0;
          const work = Effect.gen(function* () {
            if (winner === "provision")
              yield* runtime.provider.provision({
                ...key,
                origin,
                publication: { kind: "recover", ...expectedLink },
              });
            else if (winner === "reconcile")
              yield* runtime.provider.reconcileOrigin({
                ...key,
                origin: { ...origin, localHttpPort: 3001 },
                tunnelId: row.tunnelId!,
                expectedLink,
              });
            else if (winner === "deprovision")
              yield* runtime.provider.deprovision({ ...key, target: cleanup!.target });
            else if (winner === "reaper") yield* runtime.reaper.sweep;
            else
              yield* runtime.provider.release({
                ...key,
                expectedTarget: targetFor(registered),
                markReleased: true,
              });
          });
          const fiber = yield* Effect.forkChild(Effect.exit(work));
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(resume, undefined).pipe(
              Effect.andThen(Fiber.interrupt(fiber)),
              Effect.asVoid,
            ),
          );
          yield* awaitBarrier(entered, fiber);
          const held = yield* lifecycle.get(key);
          const dispatched = mutations(runtime.calls);
          expect(dispatched).toEqual([stage]);
          expect(held?.pendingMutation?.stepId).toBeTypeOf("string");
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(request)))).toBe(
            true,
          );
          expect(yield* runtime.provider.release(key)).toBe(false);
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                runtime.provider.reconcileOrigin({
                  ...key,
                  origin,
                  tunnelId: row.tunnelId!,
                  expectedLink,
                }),
              ),
            ),
          ).toBe(true);
          expect((yield* runtime.reaper.sweep).attempted).toBe(0);
          const capture = yield* lifecycle.revokeAndRequestCleanup(key);
          expect(yield* runtime.provider.deprovision({ ...key, target: capture.target })).toBe(
            false,
          );
          const after = yield* lifecycle.get(key);
          expect(after).toMatchObject({
            allocationId: held?.allocationId,
            operationId: held?.operationId,
            generation: held?.generation,
            pendingMutation: held?.pendingMutation,
            cleanupRequested: true,
          });
          expect(mutations(runtime.calls)).toEqual(dispatched);
          yield* Deferred.succeed(resume, undefined);
          const exit = yield* Fiber.join(fiber);
          expect(Exit.isSuccess(exit)).toBe(winner !== "provision" && winner !== "reconcile");
          expect((yield* lifecycle.get(key))?.operationId ?? null).toBeNull();
        }),
      ),
  );

  it.effect(
    "held mutating create permits a distinct backend to lock the same user and exact allocation",
    () =>
      fixture(
        Effect.gen(function* () {
          const limits = yield* Limits.ManagedTunnelLimits;
          const unrelated = yield* limits.reserveAllocation({
            userId: "unrelated",
            environmentId: "unrelated",
            hostname: "unrelated.fixture.test",
            tunnelName: "unrelated",
          });
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const runtime = yield* makeRuntime({
            before: (op) =>
              op === "tunnel-create"
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
          });
          const fiber = yield* Effect.forkChild(runtime.provider.provision(request));
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(resume, undefined).pipe(
              Effect.andThen(Fiber.interrupt(fiber)),
              Effect.asVoid,
            ),
          );
          yield* awaitBarrier(entered, fiber);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const row = yield* lifecycle.get(key);
          if (!row) throw new Error("Missing held row");
          const db = yield* RelayDb.RelayDb;
          const localPid = (yield* db.$client<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]
            ?.pid;
          const otherPid = yield* Effect.gen(function* () {
            const other = yield* RelayDb.RelayDb;
            return yield* other.$client.withTransaction(
              Effect.gen(function* () {
                yield* other.$client`SELECT pg_advisory_xact_lock(hashtextextended(${`relay-managed-tunnel:${key.userId}`}, 0))`;
                expect(
                  yield* other.$client`SELECT allocation_id FROM relay_managed_endpoint_allocations WHERE allocation_id = ${row.allocationId}::uuid FOR UPDATE NOWAIT`,
                ).toHaveLength(1);
                expect(
                  yield* other.$client`UPDATE relay_managed_endpoint_allocations SET updated_at = 'unrelated-held-mutation-proof' WHERE allocation_id = ${unrelated.allocationId}::uuid RETURNING allocation_id`,
                ).toHaveLength(1);
                return (yield* other.$client<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]
                  ?.pid;
              }),
            );
          }).pipe(Effect.provide(Layer.fresh(connectDatabase("1s"))));
          expect(localPid).toBeTypeOf("number");
          expect(otherPid).toBeTypeOf("number");
          expect(otherPid).not.toBe(localPid);
          expect(yield* runtime.provider.release(key)).toBe(false);
          expect(yield* lifecycle.get(key)).toEqual(row);
          yield* Deferred.succeed(resume, undefined);
          expect((yield* Fiber.join(fiber)).kind).toBe("linked");
        }),
      ),
  );

  it.effect("different environment and user provision while the original create is held", () =>
    fixture(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let first = true;
        const runtime = yield* makeRuntime({
          before: (op) => {
            if (op !== "tunnel-create" || !first) return Effect.void;
            first = false;
            return Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(resume)),
            );
          },
        });
        const fiber = yield* Effect.forkChild(runtime.provider.provision(request));
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(resume, undefined).pipe(
            Effect.andThen(Fiber.interrupt(fiber)),
            Effect.asVoid,
          ),
        );
        yield* awaitBarrier(entered, fiber);
        for (const other of [
          { ...key, environmentId: "other-env" },
          { userId: "other-user", environmentId: "third-env" },
        ])
          expect(
            (yield* runtime.provider.provision({
              ...other,
              origin,
              publication: publicationFor(other.environmentId),
            })).kind,
          ).toBe("linked");
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(fiber);
        const db = yield* RelayDb.RelayDb;
        expect(yield* db.select().from(table)).toHaveLength(3);
      }),
    ),
  );

  it.effect(
    "actual guarded removal and admission reinsert reject old UUID owner step and target",
    () =>
      fixture(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime();
          const { row } = yield* ready(runtime);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const owner = yield* lifecycle.acquireOperation({
            key,
            kind: "release",
            expectedTarget: targetFor(row),
          });
          if (owner.status !== "Acquired") throw new Error("Owner missing");
          const intent = yield* lifecycle.beginMutation({
            claim: owner.claim,
            mutation: {
              action: "delete_tunnel",
              tunnelId: row.tunnelId!,
              tunnelName: row.tunnelName,
            },
          });
          if (intent.status !== "Applied") throw new Error("Intent missing");
          expect(
            (yield* lifecycle.completeMutation({
              claim: owner.claim,
              stepId: intent.stepId,
              outcome: { action: "rejected_no_effect" },
            })).status,
          ).toBe("Applied");
          yield* lifecycle.finishIdle(owner.claim);
          const capture = yield* lifecycle.revokeAndRequestCleanup(key);
          expect(yield* runtime.provider.deprovision({ ...key, target: capture.target })).toBe(
            true,
          );
          expect(yield* lifecycle.get(key)).toBeNull();
          yield* runtime.provider.provision(request);
          const replacement = yield* lifecycle.get(key);
          if (!replacement) throw new Error("Reinsert missing");
          expect(replacement.allocationId).not.toBe(row.allocationId);
          runtime.calls.length = 0;
          expect(
            (yield* lifecycle.completeMutation({
              claim: owner.claim,
              stepId: intent.stepId,
              outcome: { action: "delete_tunnel", tunnelId: row.tunnelId! },
            })).status,
          ).toBe("Stale");
          expect(
            (yield* lifecycle.beginMutation({
              claim: owner.claim,
              mutation: {
                action: "delete_tunnel",
                tunnelId: row.tunnelId!,
                tunnelName: row.tunnelName,
              },
            })).status,
          ).toBe("Stale");
          expect((yield* lifecycle.finishIdle(owner.claim)).status).toBe("Stale");
          expect((yield* lifecycle.retainUncertain(owner.claim)).status).toBe("Stale");
          expect(
            (yield* lifecycle.removeClaimed({ ...owner.claim, kind: "deprovision" })).status,
          ).toBe("Stale");
          expect((yield* lifecycle.requestCleanup(targetFor(row))).status).toBe("Stale");
          expect(yield* runtime.provider.deprovision({ ...key, target: targetFor(row) })).toBe(
            false,
          );
          expect(
            yield* runtime.provider.release({
              ...key,
              expectedTarget: targetFor(row),
              expectedTunnelId: row.tunnelId!,
            }),
          ).toBe(false);
          expect(runtime.calls).toEqual([]);
          expect(yield* lifecycle.get(key)).toEqual(replacement);
        }),
      ),
  );

  it.effect.each(["release", "deprovision"] as const)(
    "public %s ABA rejects only the old UUID when the entire logical target and cleanup context match",
    (control) =>
      fixture(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime();
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const limits = yield* Limits.ManagedTunnelLimits;
          const links = yield* Links.EnvironmentLinks;
          const db = yield* RelayDb.RelayDb;
          const admission = {
            ...key,
            hostname: "fixture-aaaaaaaaaaaaaaaa.fixture.test",
            tunnelName: "t3coderelay-managedendpoint-fixture-aaaaaaaaaaaaaaaa",
          };
          const prepare = Effect.fnUntraced(function* () {
            const reserved = yield* limits.reserveAllocation(admission);
            const acquired = yield* lifecycle.acquireOperation({
              key,
              kind: "provision",
              purpose: { kind: "link" },
              expectedTarget: targetFor(reserved),
            });
            if (acquired.status !== "Acquired") throw new Error("Fresh owner missing");
            expect(
              (yield* runtime.tunnels.list({
                isDeleted: false,
                name: reserved.tunnelName,
                page: 1,
                perPage: 100,
              })).result,
            ).toEqual([]);
            expect(yield* runtime.dns.listExactRecords(reserved.hostname)).toEqual([]);
            for (const resource of ["tunnel", "dns"] as const)
              expect(
                (yield* lifecycle.recordObservation({
                  claim: acquired.claim,
                  observation: { resource, presence: "never_created" },
                })).status,
              ).toBe("Applied");
            expect((yield* lifecycle.finishIdle(acquired.claim)).status).toBe("Applied");
            const row = yield* lifecycle.get(key);
            if (!row) throw new Error("Settled fresh row missing");
            return row;
          });
          const old = yield* prepare();
          const oldCapture = yield* lifecycle.revokeAndRequestCleanup(key);
          if (!oldCapture.target) throw new Error("Old cleanup target missing");
          expect(oldCapture.target).toEqual(targetFor(old));
          expect(yield* runtime.provider.deprovision({ ...key, target: oldCapture.target })).toBe(
            true,
          );
          expect(yield* lifecycle.get(key)).toBeNull();
          expect(yield* db.select().from(table)).toHaveLength(0);

          const admitted = yield* prepare();
          const currentCapture = yield* lifecycle.revokeAndRequestCleanup(key);
          if (!currentCapture.target) throw new Error("Current cleanup target missing");
          const replacement = yield* lifecycle.get(key);
          if (!replacement) throw new Error("Replacement missing");
          expect(currentCapture.target).toEqual(targetFor(admitted));
          expect(oldCapture.target.key).toEqual(currentCapture.target.key);
          expect(oldCapture.target.generation).toBe(currentCapture.target.generation);
          expect(oldCapture.target.generation).toBe(2);
          expect(oldCapture.target.tunnelId).toBe(currentCapture.target.tunnelId);
          expect(currentCapture.target.tunnelId).toBeNull();
          expect(old.hostname).toBe(replacement.hostname);
          expect(old.tunnelName).toBe(replacement.tunnelName);
          expect(old.allocationId).not.toBe(replacement.allocationId);
          expect({ ...oldCapture.target, allocationId: replacement.allocationId }).toEqual(
            currentCapture.target,
          );
          expect(replacement).toMatchObject({
            lifecycleState: "idle",
            operationId: null,
            pendingMutation: null,
            cleanupRequested: true,
            tunnelId: null,
            tunnelPresence: "never_created",
            dnsRecordId: null,
            dnsPresence: "never_created",
          });
          expect(yield* links.getForUser(key)).toBeNull();
          expect(yield* db.select().from(table)).toHaveLength(1);

          runtime.calls.length = 0;
          // No explicit expectedTunnelId or active authority can mask UUID rejection.
          expect(
            yield* runtime.provider.release({
              ...key,
              expectedTarget: oldCapture.target,
              markReleased: true,
            }),
          ).toBe(false);
          expect(yield* runtime.provider.deprovision({ ...key, target: oldCapture.target })).toBe(
            false,
          );
          expect((yield* lifecycle.requestCleanup(oldCapture.target)).status).toBe("Stale");
          expect(runtime.calls).toEqual([]);
          expect(yield* lifecycle.get(key)).toEqual(replacement);
          expect(yield* db.select().from(table)).toHaveLength(1);

          // Otherwise identical current-UUID requests are valid: release settles
          // a new generation; deprovision really removes the counted replacement.
          if (control === "release") {
            expect(
              yield* runtime.provider.release({
                ...key,
                expectedTarget: currentCapture.target,
                markReleased: true,
              }),
            ).toBe(true);
            expect(yield* lifecycle.get(key)).toMatchObject({
              allocationId: replacement.allocationId,
              generation: replacement.generation + 2,
              lifecycleState: "idle",
              pendingMutation: null,
              tunnelReleasedAt: null,
            });
            expect(yield* db.select().from(table)).toHaveLength(1);
          } else {
            expect(
              yield* runtime.provider.deprovision({ ...key, target: currentCapture.target }),
            ).toBe(true);
            expect(yield* lifecycle.get(key)).toBeNull();
            expect(yield* db.select().from(table)).toHaveLength(0);
          }
          expect(runtime.calls).toEqual([]);
        }),
      ),
  );

  it.effect(
    "old real owner and step preserve a live replacement; a constructed UUID-only completion probe isolates identity",
    () =>
      fixture(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime();
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const limits = yield* Limits.ManagedTunnelLimits;
          const db = yield* RelayDb.RelayDb;
          const admission = {
            ...key,
            hostname: "fixture-aaaaaaaaaaaaaaaa.fixture.test",
            tunnelName: "t3coderelay-managedendpoint-fixture-aaaaaaaaaaaaaaaa",
          };
          const start = Effect.fnUntraced(function* () {
            const reserved = yield* limits.reserveAllocation(admission);
            const acquired = yield* lifecycle.acquireOperation({
              key,
              kind: "provision",
              purpose: { kind: "link" },
              expectedTarget: targetFor(reserved),
            });
            if (acquired.status !== "Acquired") throw new Error("Owner missing");
            expect(
              (yield* runtime.tunnels.list({
                isDeleted: false,
                name: reserved.tunnelName,
                page: 1,
                perPage: 100,
              })).result,
            ).toEqual([]);
            expect(
              (yield* lifecycle.recordObservation({
                claim: acquired.claim,
                observation: { resource: "tunnel", presence: "never_created" },
              })).status,
            ).toBe("Applied");
            const intent = yield* lifecycle.beginMutation({
              claim: acquired.claim,
              mutation: { action: "create_tunnel", tunnelName: reserved.tunnelName },
            });
            if (intent.status !== "Applied") throw new Error("Intent missing");
            const response = yield* runtime.tunnels.create({
              name: reserved.tunnelName,
              configSrc: "cloudflare",
            });
            if (!response.id || response.name !== reserved.tunnelName)
              throw new Error("Exact create response missing");
            return { acquired, intent, response: { id: response.id, name: response.name } };
          });
          const old = yield* start();
          expect(
            (yield* lifecycle.completeMutation({
              claim: old.acquired.claim,
              stepId: old.intent.stepId,
              outcome: {
                action: "create_tunnel",
                tunnelId: old.response.id,
                tunnelName: old.response.name,
              },
            })).status,
          ).toBe("Applied");
          expect((yield* lifecycle.finishIdle(old.acquired.claim)).status).toBe("Applied");
          const capture = yield* lifecycle.revokeAndRequestCleanup(key);
          expect(yield* runtime.provider.deprovision({ ...key, target: capture.target })).toBe(
            true,
          );
          expect(yield* lifecycle.get(key)).toBeNull();
          const current = yield* start();
          const live = yield* lifecycle.get(key);
          if (!live) throw new Error("Live replacement missing");
          expect(live).toMatchObject({
            lifecycleState: "owned",
            operationId: current.acquired.claim.operationId,
            operationKind: current.acquired.claim.kind,
            generation: current.acquired.claim.generation,
            pendingMutation: { action: "create_tunnel", stepId: current.intent.stepId },
          });
          expect(current.acquired.claim.generation).toBe(old.acquired.claim.generation);
          expect(current.acquired.allocation.tunnelId).toBe(old.acquired.allocation.tunnelId);
          expect(current.acquired.allocation.tunnelId).toBeNull();
          expect(current.acquired.allocation.tunnelName).toBe(old.acquired.allocation.tunnelName);
          expect(current.acquired.claim.allocationId).not.toBe(old.acquired.claim.allocationId);
          expect(current.acquired.claim.operationId).not.toBe(old.acquired.claim.operationId);
          expect(current.intent.stepId).not.toBe(old.intent.stepId);
          runtime.calls.length = 0;
          expect(
            (yield* lifecycle.completeMutation({
              claim: old.acquired.claim,
              stepId: old.intent.stepId,
              outcome: {
                action: "create_tunnel",
                tunnelId: old.response.id,
                tunnelName: old.response.name,
              },
            })).status,
          ).toBe("Stale");
          expect((yield* lifecycle.finishIdle(old.acquired.claim)).status).toBe("Stale");
          expect((yield* lifecycle.retainUncertain(old.acquired.claim)).status).toBe("Stale");
          expect(yield* lifecycle.get(key)).toEqual(live);

          // This is a constructed SQL guard-isolation probe, not an old public
          // continuation: copy the CURRENT owner and step, changing only its UUID.
          const uuidOnlyClaim = {
            ...current.acquired.claim,
            allocationId: old.acquired.claim.allocationId,
          };
          expect({ ...uuidOnlyClaim, allocationId: live.allocationId }).toEqual(
            current.acquired.claim,
          );
          expect(uuidOnlyClaim.generation).toBe(live.generation);
          expect(uuidOnlyClaim.operationId).toBe(live.operationId);
          expect(uuidOnlyClaim.kind).toBe(live.operationKind);
          expect(current.intent.stepId).toBe(live.pendingMutation?.stepId);
          const outcome = {
            action: "create_tunnel" as const,
            tunnelId: current.response.id,
            tunnelName: current.response.name,
          };
          expect(
            (yield* lifecycle.completeMutation({
              claim: uuidOnlyClaim,
              stepId: current.intent.stepId,
              outcome,
            })).status,
          ).toBe("Stale");
          expect(runtime.calls).toEqual([]);
          expect(yield* lifecycle.get(key)).toEqual(live);
          expect(yield* db.select().from(table)).toHaveLength(1);
          expect(
            (yield* lifecycle.completeMutation({
              claim: current.acquired.claim,
              stepId: current.intent.stepId,
              outcome,
            })).status,
          ).toBe("Applied");
          expect(yield* lifecycle.get(key)).toMatchObject({
            allocationId: live.allocationId,
            lifecycleState: "owned",
            operationId: current.acquired.claim.operationId,
            generation: live.generation,
            pendingMutation: null,
            tunnelId: current.response.id,
          });
          expect((yield* lifecycle.finishIdle(current.acquired.claim)).status).toBe("Applied");
        }),
      ),
  );

  it.effect.each([
    "owned",
    "uncertain",
    "legacy_unverified",
    "cleanup",
    "unresolved",
    "replaced",
    "unrecorded",
  ] as const)("real reaper cannot mutate %s durable candidates", (state) =>
    fixture(
      Effect.gen(function* () {
        const runtime = yield* makeRuntime();
        const { row, expectedLink } = yield* ready(runtime);
        yield* runtime.provider.reconcileOrigin({
          ...key,
          origin,
          tunnelId: row.tunnelId!,
          expectedLink,
        });
        const db = yield* RelayDb.RelayDb;
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        if (state === "owned" || state === "uncertain") {
          const current = yield* lifecycle.get(key);
          if (!current) throw new Error("Current row missing");
          const acquired = yield* lifecycle.acquireOperation({
            key,
            kind: "release",
            expectedTarget: targetFor(current),
          });
          if (acquired.status !== "Acquired") throw new Error("Missing owner");
          if (state === "uncertain") yield* lifecycle.retainUncertain(acquired.claim);
        } else if (state === "legacy_unverified")
          yield* db
            .update(table)
            .set({ lifecycleState: state })
            .where(eq(table.userId, key.userId));
        else if (state === "cleanup") yield* lifecycle.revokeAndRequestCleanup(key);
        else if (state === "unresolved")
          yield* db
            .update(table)
            .set({ tunnelPresence: "unresolved" })
            .where(eq(table.userId, key.userId));
        else if (state === "unrecorded")
          yield* db
            .update(table)
            .set({ tunnelId: null, tunnelPresence: "unresolved" })
            .where(eq(table.userId, key.userId));
        else
          yield* db
            .update(table)
            .set({ tunnelId: "newer-tunnel", dnsTargetTunnelId: "newer-tunnel" })
            .where(eq(table.userId, key.userId));
        const captured = yield* lifecycle.get(key);
        runtime.calls.length = 0;
        const sweep = yield* runtime.reaper.sweep;
        expect(sweep.attempted).toBe(0);
        expect(mutations(runtime.calls)).toEqual([]);
        expect(yield* lifecycle.get(key)).toEqual(captured);
        expect(runtime.tunnelRows.has("tunnel-1")).toBe(true);
      }),
    ),
  );

  it.effect(
    "a reaper snapshot cannot release a replacement admitted after guarded full removal",
    () =>
      fixture(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const runtime = yield* makeRuntime({
            afterAllocationSnapshot: Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(resume)),
            ),
          });
          const { row, expectedLink } = yield* ready(runtime);
          yield* runtime.provider.reconcileOrigin({
            ...key,
            origin,
            tunnelId: row.tunnelId!,
            expectedLink,
          });
          const fiber = yield* Effect.forkChild(runtime.reaper.sweep);
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(resume, undefined).pipe(
              Effect.andThen(Fiber.interrupt(fiber)),
              Effect.asVoid,
            ),
          );
          yield* awaitBarrier(entered, fiber);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const capture = yield* lifecycle.revokeAndRequestCleanup(key);
          expect(yield* runtime.provider.deprovision({ ...key, target: capture.target })).toBe(
            true,
          );
          yield* runtime.provider.provision(request);
          const replacement = yield* lifecycle.get(key);
          if (!replacement) throw new Error("Replacement missing");
          expect(replacement.allocationId).not.toBe(row.allocationId);
          const calls = [...runtime.calls];
          yield* Deferred.succeed(resume, undefined);
          expect(yield* Fiber.join(fiber)).toMatchObject({ attempted: 1, deleted: 0, failed: 0 });
          expect(runtime.calls).toEqual(calls);
          expect(yield* lifecycle.get(key)).toEqual(replacement);
          expect(runtime.tunnelRows.has(replacement.tunnelId!)).toBe(true);
        }),
      ),
  );

  it.effect(
    "idempotent revoked unlink preserves another user's active same-key managed authority and credentials",
    () =>
      fixture(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime();
          const initial = yield* ready(runtime);
          const otherKey = { ...key, userId: "surviving-user" };
          const other = yield* runtime.provider.provision({
            ...otherKey,
            origin,
            publication: publicationFor(key.environmentId),
          });
          if (other.kind !== "linked" || !other.runtime.tunnelId)
            throw new Error("Other link missing");
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const links = yield* Links.EnvironmentLinks;
          const credentials = yield* Credentials.EnvironmentCredentials;
          const survivor = yield* lifecycle.get(otherKey);
          const survivorLink = yield* links.getForUser(otherKey);
          expect(Option.isSome(yield* credentials.authenticate(other.environmentCredential))).toBe(
            true,
          );
          const capture = yield* lifecycle.revokeAndRequestCleanup(key);
          expect(capture.revoked).toBe(true);
          const retry = yield* lifecycle.revokeAndRequestCleanup(key);
          expect(retry.revoked).toBe(false);
          expect(retry.target).toEqual(capture.target);
          expect(yield* runtime.provider.deprovision({ ...key, target: retry.target })).toBe(true);
          expect(yield* runtime.provider.deprovision({ ...key, target: retry.target })).toBe(true);
          expect(yield* lifecycle.get(otherKey)).toEqual(survivor);
          expect(yield* links.getForUser(otherKey)).toEqual(survivorLink);
          // Publishing the second link rotated the key credential before unlink.
          expect(
            Option.isNone(yield* credentials.authenticate(initial.result.environmentCredential)),
          ).toBe(true);
          expect(Option.isSome(yield* credentials.authenticate(other.environmentCredential))).toBe(
            true,
          );
          expect(runtime.tunnelRows.has(other.runtime.tunnelId)).toBe(true);
        }),
      ),
  );
});
