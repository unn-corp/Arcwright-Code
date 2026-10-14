import { describe, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import * as RelayDb from "../db.ts";
import {
  relayManagedEndpointAllocations as table,
  relayEnvironmentCredentials,
  relayEnvironmentLinks,
} from "../persistence/schema.ts";
import * as Lifecycle from "./ManagedEndpointLifecycle.ts";
import * as Links from "./EnvironmentLinks.ts";
import * as Limits from "./ManagedTunnelLimits.ts";
import { targetFor } from "./managedEndpointLifecycleContracts.ts";
import { fixtureFile } from "./managedEndpointPostgresFixture.ts";
import { installCommitBarrier } from "./managedEndpointCommitTestFixture.ts";
import { publicationFor } from "./managedEndpointProviderTestFixture.ts";
import {
  awaitBarrier,
  fixture,
  key,
  origin,
  request,
  makeRuntime,
  ready,
} from "./managedEndpointRuntimeTestFixture.ts";

const commitBoundaries = ["claim", "intent", "checkpoint", "publication"] as const;
const sqlFaults = commitBoundaries.flatMap((boundary) =>
  (["rollback", "lost-ack"] as const).map((failure) => ({ boundary, failure })),
);
const mutationCalls = (calls: readonly string[]) =>
  calls.filter((op) =>
    [
      "tunnel-create",
      "tunnel-configure",
      "dns-create",
      "dns-update",
      "dns-delete",
      "tunnel-delete",
    ].includes(op),
  );

describe.skipIf(!fixtureFile)("Managed endpoint durable runtime boundaries PostgreSQL", () => {
  it.effect.each(["send", "acknowledgement"] as const)(
    "interruption during actual publication COMMIT %s waits for joined durable truth",
    (boundary) =>
      fixture(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const requested = yield* Deferred.make<void>();
          const completed = yield* Deferred.make<void>();
          let publishing = false;
          const barrier = Effect.suspend(() =>
            publishing
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void,
          );
          const original = yield* RelayDb.RelayDb;
          const spy = installCommitBarrier(
            original,
            boundary === "send" ? barrier : Effect.void,
            boundary === "acknowledgement" ? barrier : Effect.void,
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const runtime = yield* makeRuntime({
            lifecycle: () => ({
              ...lifecycle,
              publishProvision: (input) =>
                Effect.sync(() => {
                  publishing = true;
                }).pipe(Effect.andThen(lifecycle.publishProvision(input))),
            }),
          });
          const fiber = yield* Effect.forkChild(
            runtime.provider
              .provision(request)
              .pipe(Effect.onExit(() => Deferred.succeed(completed, undefined))),
          );
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(resume, undefined).pipe(
              Effect.andThen(Fiber.interrupt(fiber)),
              Effect.asVoid,
            ),
          );
          yield* awaitBarrier(entered, fiber);
          const interrupt = yield* Effect.forkChild(
            Deferred.succeed(requested, undefined).pipe(Effect.andThen(Fiber.interrupt(fiber))),
          );
          yield* Deferred.await(requested);
          expect(yield* Deferred.isDone(completed)).toBe(false);
          // A different pooled session sees publication only after the real COMMIT.
          expect(yield* original.select().from(relayEnvironmentLinks)).toHaveLength(
            boundary === "send" ? 0 : 1,
          );
          expect(yield* original.select().from(relayEnvironmentCredentials)).toHaveLength(
            boundary === "send" ? 0 : 1,
          );
          const visible = yield* original.select().from(table);
          expect(visible).toHaveLength(1);
          expect(visible[0]?.lifecycleState).toBe(boundary === "send" ? "owned" : "idle");
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(interrupt);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "idle",
            operationId: null,
            pendingMutation: null,
          });
          expect(yield* original.select().from(relayEnvironmentLinks)).toHaveLength(1);
          expect(yield* original.select().from(relayEnvironmentCredentials)).toHaveLength(1);
          expect(mutationCalls(runtime.calls)).toEqual([
            "tunnel-create",
            "tunnel-configure",
            "dns-create",
          ]);
          expect(yield* Deferred.isDone(completed)).toBe(true);
        }),
      ),
  );

  it.effect.each(sqlFaults)(
    "$boundary $failure uses real transactions and preserves committed truth",
    ({ boundary, failure }) =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          if (failure === "rollback") {
            yield* db.$client`CREATE FUNCTION task4c_managed_endpoints.reject_boundary_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture commit rejected'; END $$`;
            if (boundary === "publication")
              yield* db.$client`CREATE CONSTRAINT TRIGGER reject_boundary_commit AFTER INSERT ON relay_environment_credentials DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION task4c_managed_endpoints.reject_boundary_commit()`;
            else if (boundary === "claim")
              yield* db.$client`CREATE CONSTRAINT TRIGGER reject_boundary_commit AFTER UPDATE ON relay_managed_endpoint_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.lifecycle_state = 'owned' AND OLD.lifecycle_state = 'idle') EXECUTE FUNCTION task4c_managed_endpoints.reject_boundary_commit()`;
            else if (boundary === "intent")
              yield* db.$client`CREATE CONSTRAINT TRIGGER reject_boundary_commit AFTER UPDATE ON relay_managed_endpoint_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.pending_mutation IS NOT NULL AND OLD.pending_mutation IS NULL) EXECUTE FUNCTION task4c_managed_endpoints.reject_boundary_commit()`;
            else
              yield* db.$client`CREATE CONSTRAINT TRIGGER reject_boundary_commit AFTER UPDATE ON relay_managed_endpoint_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.pending_mutation IS NULL AND OLD.pending_mutation IS NOT NULL) EXECUTE FUNCTION task4c_managed_endpoints.reject_boundary_commit()`;
          }
          let injected = false;
          const runtime = yield* makeRuntime({
            lifecycle: (actual) => {
              const afterCommit = <A>(
                operation: Lifecycle.LifecyclePersistenceError["operation"],
                effect: Effect.Effect<A, Lifecycle.LifecyclePersistenceError>,
              ) =>
                effect.pipe(
                  Effect.flatMap((value) => {
                    if (failure !== "lost-ack" || injected) return Effect.succeed(value);
                    injected = true;
                    return Effect.fail(
                      new Lifecycle.LifecyclePersistenceError({
                        operation,
                        ...key,
                        cause: "Fixture lost COMMIT acknowledgement",
                      }),
                    );
                  }),
                );
              return {
                ...actual,
                ...(boundary === "claim"
                  ? {
                      acquireOperation: (input: Parameters<typeof actual.acquireOperation>[0]) =>
                        afterCommit("acquire", actual.acquireOperation(input)),
                    }
                  : {}),
                ...(boundary === "intent"
                  ? {
                      beginMutation: (input: Parameters<typeof actual.beginMutation>[0]) =>
                        afterCommit("begin", actual.beginMutation(input)),
                    }
                  : {}),
                ...(boundary === "checkpoint"
                  ? {
                      completeMutation: (input: Parameters<typeof actual.completeMutation>[0]) =>
                        afterCommit("complete", actual.completeMutation(input)),
                    }
                  : {}),
                ...(boundary === "publication"
                  ? {
                      publishProvision: (input: Parameters<typeof actual.publishProvision>[0]) =>
                        afterCommit("publish-provision", actual.publishProvision(input)),
                    }
                  : {}),
              };
            },
          });
          const exit = yield* Effect.exit(runtime.provider.provision(request));
          expect(Exit.isFailure(exit)).toBe(true); // No connector token or environment credential is returned.
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const row = yield* lifecycle.get(key);
          expect(yield* db.select().from(table)).toHaveLength(1);
          expect(runtime.calls.some((call) => call.endsWith("delete"))).toBe(false);
          if (boundary === "publication" && failure === "lost-ack") {
            expect(row).toMatchObject({
              lifecycleState: "idle",
              operationId: null,
              pendingMutation: null,
              tunnelId: "tunnel-1",
              dnsRecordId: "dns-1",
            });
            expect(row?.readyAt).not.toBeNull();
            expect(yield* db.select().from(relayEnvironmentLinks)).toHaveLength(1);
            expect(yield* db.select().from(relayEnvironmentCredentials)).toHaveLength(1);
            expect(runtime.tunnelRows.size).toBe(1);
            expect(runtime.dnsRows.size).toBe(1);
          } else {
            expect(row?.readyAt).toBeNull();
            expect(yield* db.select().from(relayEnvironmentLinks)).toHaveLength(0);
            expect(yield* db.select().from(relayEnvironmentCredentials)).toHaveLength(0);
            if (boundary === "claim")
              expect(row).toMatchObject({
                lifecycleState: failure === "lost-ack" ? "owned" : "idle",
                pendingMutation: null,
              });
            else expect(row?.lifecycleState).toBe("uncertain");
            if (boundary === "intent")
              expect(row?.pendingMutation === null).toBe(failure === "rollback");
            if (boundary === "checkpoint") {
              expect(row?.pendingMutation === null).toBe(failure === "lost-ack");
              expect(row?.tunnelId).toBe(failure === "lost-ack" ? "tunnel-1" : null);
            }
            if (boundary !== "claim" || failure === "lost-ack") {
              const before = mutationCalls(runtime.calls);
              expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(request)))).toBe(
                true,
              );
              expect(yield* runtime.provider.release(key)).toBe(false);
              const capture = yield* lifecycle.revokeAndRequestCleanup(key);
              expect(yield* runtime.provider.deprovision({ ...key, target: capture.target })).toBe(
                false,
              );
              expect(mutationCalls(runtime.calls)).toEqual(before);
            }
          }
          expect(injected).toBe(failure === "lost-ack");
          expect(mutationCalls(runtime.calls)).toEqual(
            boundary === "claim" || boundary === "intent"
              ? []
              : boundary === "checkpoint"
                ? ["tunnel-create"]
                : ["tunnel-create", "tunnel-configure", "dns-create"],
          );
        }),
      ),
  );

  it.effect("interruptible pre-entry cancellation runs no admission SQL or external dispatch", () =>
    fixture(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const runtime = yield* makeRuntime();
        let enteredProvider = false;
        const fiber = yield* Effect.forkChild(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.andThen(
              Effect.sync(() => {
                enteredProvider = true;
              }),
            ),
            Effect.andThen(runtime.provider.provision(request)),
          ),
        );
        yield* awaitBarrier(entered, fiber);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(enteredProvider).toBe(false);
        const db = yield* RelayDb.RelayDb;
        expect(yield* db.select().from(table)).toHaveLength(0);
        expect(runtime.calls).toEqual([]);
      }),
    ),
  );

  it.effect.each([
    "during-claim-mask",
    "after-claim",
    "before-intent",
    "after-intent",
    "before-checkpoint",
    "after-checkpoint",
    "before-publication",
    "after-publication",
  ] as const)(
    "real interruption at %s joins and retains the appropriate durable boundary",
    (boundary) =>
      fixture(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const requested = yield* Deferred.make<void>();
          const completed = yield* Deferred.make<void>();
          const barrier = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
          );
          let intercepted = false;
          const runtime = yield* makeRuntime({
            lifecycle: (actual) => {
              const around = <A>(
                before: boolean,
                effect: Effect.Effect<A, Lifecycle.LifecyclePersistenceError>,
              ) =>
                Effect.gen(function* () {
                  if (intercepted) return yield* effect;
                  intercepted = true;
                  if (before) yield* barrier;
                  const value = yield* effect;
                  if (!before) yield* barrier;
                  return value;
                });
              return {
                ...actual,
                ...(boundary === "during-claim-mask" || boundary === "after-claim"
                  ? {
                      acquireOperation: (input: Parameters<typeof actual.acquireOperation>[0]) =>
                        around(boundary === "during-claim-mask", actual.acquireOperation(input)),
                    }
                  : {}),
                ...(boundary.endsWith("intent")
                  ? {
                      beginMutation: (input: Parameters<typeof actual.beginMutation>[0]) =>
                        around(boundary === "before-intent", actual.beginMutation(input)),
                    }
                  : {}),
                ...(boundary.endsWith("checkpoint")
                  ? {
                      completeMutation: (input: Parameters<typeof actual.completeMutation>[0]) =>
                        around(boundary === "before-checkpoint", actual.completeMutation(input)),
                    }
                  : {}),
                ...(boundary.endsWith("publication")
                  ? {
                      publishProvision: (input: Parameters<typeof actual.publishProvision>[0]) =>
                        around(boundary === "before-publication", actual.publishProvision(input)),
                    }
                  : {}),
              };
            },
          });
          const fiber = yield* Effect.forkChild(
            runtime.provider
              .provision(request)
              .pipe(Effect.onExit(() => Deferred.succeed(completed, undefined))),
          );
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(resume, undefined).pipe(
              Effect.andThen(Fiber.interrupt(fiber)),
              Effect.asVoid,
            ),
          );
          yield* awaitBarrier(entered, fiber);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const held = yield* lifecycle.get(key);
          const interrupt = yield* Effect.forkChild(
            Deferred.succeed(requested, undefined).pipe(Effect.andThen(Fiber.interrupt(fiber))),
          );
          yield* Deferred.await(requested);
          expect(yield* Deferred.isDone(completed)).toBe(false);
          if (boundary !== "during-claim-mask" && boundary !== "after-publication")
            expect(yield* runtime.provider.release(key)).toBe(false);
          expect(mutationCalls(runtime.calls)).not.toContain("tunnel-delete");
          expect(yield* lifecycle.get(key)).toEqual(held);
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(interrupt);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          expect(yield* Deferred.isDone(completed)).toBe(true);
          const row = yield* lifecycle.get(key);
          // Durable writes are masked: the request waits, then is observed at the
          // next restored external boundary (or after finite final publication).
          if (boundary.includes("intent") || boundary.includes("checkpoint"))
            expect(row?.lifecycleState).toBe("uncertain");
          else
            expect(row).toMatchObject({
              lifecycleState: "idle",
              operationId: null,
              pendingMutation: null,
            });
          if (boundary === "during-claim-mask") {
            expect(row?.generation).toBe(2);
            expect(runtime.calls).toEqual([]);
          }
          expect(mutationCalls(runtime.calls)).not.toContain("tunnel-delete");
        }),
      ),
  );

  it.effect(
    "late uninterruptible external create stays owned until its joined response is durably handled",
    () =>
      fixture(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const requested = yield* Deferred.make<void>();
          const completed = yield* Deferred.make<void>();
          const runtime = yield* makeRuntime({
            uninterruptibleOperation: "tunnel-create",
            before: (op) =>
              op === "tunnel-create"
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(resume)),
                    Effect.uninterruptible,
                  )
                : Effect.void,
          });
          const fiber = yield* Effect.forkChild(
            runtime.provider
              .provision(request)
              .pipe(Effect.onExit(() => Deferred.succeed(completed, undefined))),
          );
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(resume, undefined).pipe(
              Effect.andThen(Fiber.interrupt(fiber)),
              Effect.asVoid,
            ),
          );
          yield* awaitBarrier(entered, fiber);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const held = yield* lifecycle.get(key);
          const interrupt = yield* Effect.forkChild(
            Deferred.succeed(requested, undefined).pipe(Effect.andThen(Fiber.interrupt(fiber))),
          );
          yield* Deferred.await(requested);
          expect(yield* Deferred.isDone(completed)).toBe(false);
          const capture = yield* lifecycle.revokeAndRequestCleanup(key);
          expect(yield* runtime.provider.deprovision({ ...key, target: capture.target })).toBe(
            false,
          );
          expect(yield* runtime.provider.release(key)).toBe(false);
          expect(yield* lifecycle.get(key)).toMatchObject({
            allocationId: held?.allocationId,
            operationId: held?.operationId,
            pendingMutation: held?.pendingMutation,
            cleanupRequested: true,
          });
          expect(mutationCalls(runtime.calls)).toEqual(["tunnel-create"]);
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(interrupt);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          const settled = yield* lifecycle.get(key);
          expect(settled?.lifecycleState).toBe("uncertain");
          expect(settled?.pendingMutation?.action).toBe("create_tunnel");
          expect(runtime.tunnelRows.has("tunnel-1")).toBe(true);
          expect(yield* Deferred.isDone(completed)).toBe(true);
          expect(yield* runtime.provider.deprovision({ ...key, target: capture.target })).toBe(
            false,
          );
        }),
      ),
  );

  it.effect.each([
    "claimed",
    "intent",
    "checkpoint",
    "before-publication",
    "uncertain",
    "legacy",
  ] as const)(
    "process death at %s has no clearing finalizer or diagnostic timestamp expiry",
    (boundary) =>
      fixture(
        Effect.gen(function* () {
          // These are committed lifecycle boundaries with no live provider fiber,
          // hence no finalizer can clear the dead process's owner.
          const runtime = yield* makeRuntime();
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const db = yield* RelayDb.RelayDb;
          const limits = yield* Limits.ManagedTunnelLimits;
          const reserved = yield* limits.reserveAllocation({
            ...key,
            hostname: "fixture-aaaaaaaaaaaaaaaa.fixture.test",
            tunnelName: "t3coderelay-managedendpoint-fixture-aaaaaaaaaaaaaaaa",
          });
          if (boundary === "legacy")
            yield* db
              .update(table)
              .set({ lifecycleState: "legacy_unverified", updatedAt: "1900-01-01T00:00:00.000Z" })
              .where(eq(table.userId, key.userId));
          else {
            const acquired = yield* lifecycle.acquireOperation({
              key,
              kind: "provision",
              expectedTarget: targetFor(reserved),
              purpose: { kind: "link" },
            });
            if (acquired.status !== "Acquired") throw new Error("Owner not acquired");
            if (boundary !== "claimed") {
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
              const begun = yield* lifecycle.beginMutation({
                claim: acquired.claim,
                mutation: { action: "create_tunnel", tunnelName: reserved.tunnelName },
              });
              if (begun.status !== "Applied") throw new Error("Intent missing");
              if (boundary === "checkpoint" || boundary === "before-publication") {
                yield* lifecycle.completeMutation({
                  claim: acquired.claim,
                  stepId: begun.stepId,
                  outcome: {
                    action: "create_tunnel",
                    tunnelId: "dead-tunnel",
                    tunnelName: reserved.tunnelName,
                  },
                });
                runtime.tunnelRows.set("dead-tunnel", {
                  id: "dead-tunnel",
                  name: reserved.tunnelName,
                  status: "inactive",
                  createdAt: "1900-01-01T00:00:00.000Z",
                });
              }
              if (boundary === "before-publication") {
                const configuration = yield* lifecycle.beginMutation({
                  claim: acquired.claim,
                  mutation: {
                    action: "configure_tunnel",
                    tunnelId: "dead-tunnel",
                    tunnelName: reserved.tunnelName,
                    origin: { localHttpHost: "localhost", localHttpPort: 3000 },
                  },
                });
                if (configuration.status !== "Applied")
                  throw new Error("Configuration intent missing");
                yield* lifecycle.completeMutation({
                  claim: acquired.claim,
                  stepId: configuration.stepId,
                  outcome: { action: "configure_tunnel", tunnelId: "dead-tunnel" },
                });
                expect(yield* runtime.dns.listExactRecords(reserved.hostname)).toEqual([]);
                yield* lifecycle.recordObservation({
                  claim: acquired.claim,
                  observation: { resource: "dns", presence: "never_created" },
                });
                const dns = yield* lifecycle.beginMutation({
                  claim: acquired.claim,
                  mutation: {
                    action: "create_dns",
                    hostname: reserved.hostname,
                    tunnelId: "dead-tunnel",
                  },
                });
                if (dns.status !== "Applied") throw new Error("DNS intent missing");
                yield* lifecycle.completeMutation({
                  claim: acquired.claim,
                  stepId: dns.stepId,
                  outcome: {
                    action: "create_dns",
                    hostname: reserved.hostname,
                    tunnelId: "dead-tunnel",
                    dnsRecordId: "dead-dns",
                  },
                });
              }
              if (boundary === "uncertain") yield* lifecycle.retainUncertain(acquired.claim);
            }
            yield* db
              .update(table)
              .set({
                operationStartedAt: "1900-01-01T00:00:00.000Z",
                updatedAt: "1900-01-01T00:00:00.000Z",
              })
              .where(eq(table.userId, key.userId));
          }
          const dead = yield* lifecycle.get(key);
          runtime.calls.length = 0;
          runtime.tunnelRows.clear();
          runtime.dnsRows.clear();
          if (boundary === "claimed")
            expect(dead).toMatchObject({
              lifecycleState: "owned",
              pendingMutation: null,
              tunnelId: null,
              tunnelPresence: "unresolved",
            });
          if (boundary === "intent" || boundary === "uncertain")
            expect(dead).toMatchObject({
              lifecycleState: boundary === "intent" ? "owned" : "uncertain",
              pendingMutation: { action: "create_tunnel" },
              tunnelId: null,
            });
          if (boundary === "checkpoint")
            expect(dead).toMatchObject({
              lifecycleState: "owned",
              pendingMutation: null,
              tunnelId: "dead-tunnel",
              dnsRecordId: null,
            });
          if (boundary === "before-publication")
            expect(dead).toMatchObject({
              lifecycleState: "owned",
              pendingMutation: null,
              tunnelId: "dead-tunnel",
              dnsRecordId: "dead-dns",
              readyAt: null,
            });
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(request)))).toBe(
            true,
          );
          expect(yield* runtime.provider.release(key)).toBe(false);
          expect((yield* runtime.reaper.sweep).attempted).toBe(0);
          const capture = yield* lifecycle.revokeAndRequestCleanup(key);
          expect(yield* runtime.provider.deprovision({ ...key, target: capture.target })).toBe(
            false,
          );
          expect(mutationCalls(runtime.calls)).toEqual([]);
          expect(yield* lifecycle.get(key)).toMatchObject({
            allocationId: dead?.allocationId,
            lifecycleState: dead?.lifecycleState,
            operationId: dead?.operationId,
            pendingMutation: dead?.pendingMutation,
            generation: dead?.generation,
          });
          expect(yield* db.select().from(table)).toHaveLength(1);
        }),
      ),
  );

  it.effect.each(["token", "tunnel-configure"] as const)(
    "current managed incarnation and key replacement during held %s blocks obsolete publication",
    (stage) =>
      fixture(
        Effect.gen(function* () {
          let holding = false;
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const runtime = yield* makeRuntime({
            before: (op) =>
              holding && op === stage
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
          });
          const { row, expectedLink } = yield* ready(runtime);
          holding = true;
          runtime.calls.length = 0;
          const fiber = yield* Effect.forkChild(
            Effect.exit(
              runtime.provider.provision({
                ...key,
                origin,
                publication: { kind: "recover", ...expectedLink },
              }),
            ),
          );
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(resume, undefined).pipe(
              Effect.andThen(Fiber.interrupt(fiber)),
              Effect.asVoid,
            ),
          );
          yield* awaitBarrier(entered, fiber);
          const links = yield* Links.EnvironmentLinks;
          const replacement = publicationFor(key.environmentId);
          if (replacement.kind !== "link") throw new Error("Missing proof");
          const db = yield* RelayDb.RelayDb;
          yield* db.$client.withTransaction(
            links.upsert({
              userId: key.userId,
              request: replacement.request,
              proof: { ...replacement.proof, environmentPublicKey: "replacement-key" },
              endpoint: expectedLink.endpoint,
            }),
          );
          yield* Deferred.succeed(resume, undefined);
          expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          expect(yield* lifecycle.get(key)).toMatchObject({
            allocationId: row.allocationId,
            tunnelId: row.tunnelId,
            lifecycleState: "idle",
            operationId: null,
          });
          const current = yield* links.getForUser(key);
          expect(current?.environmentPublicKey).toBe("replacement-key");
          expect(current?.linkIncarnationId).not.toBe(expectedLink.expectedLinkIncarnationId);
          expect(mutationCalls(runtime.calls)).not.toContain("tunnel-delete");
        }),
      ),
  );

  it.effect("revocation COMMIT rejection never authorizes public cleanup", () =>
    fixture(
      Effect.gen(function* () {
        const runtime = yield* makeRuntime();
        const { row } = yield* ready(runtime);
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        const db = yield* RelayDb.RelayDb;
        yield* db.$client`CREATE FUNCTION task4c_managed_endpoints.reject_revoke_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture revocation commit rejected'; END $$`;
        yield* db.$client`CREATE CONSTRAINT TRIGGER reject_revoke_commit AFTER UPDATE ON relay_environment_links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.revoked_at IS NOT NULL) EXECUTE FUNCTION task4c_managed_endpoints.reject_revoke_commit()`;
        runtime.calls.length = 0;
        const revoke = yield* Effect.exit(lifecycle.revokeAndRequestCleanup(key));
        expect(Exit.isFailure(revoke)).toBe(true);
        expect(yield* runtime.provider.deprovision({ ...key, target: targetFor(row) })).toBe(false);
        expect(runtime.calls).toEqual([]);
        expect(yield* lifecycle.get(key)).toEqual(row);
        expect((yield* db.select().from(relayEnvironmentLinks))[0]?.revokedAt).toBeNull();
      }),
    ),
  );
});
