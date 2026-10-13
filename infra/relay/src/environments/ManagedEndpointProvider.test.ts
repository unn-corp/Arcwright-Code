import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { DuplicateTunnelName, TunnelNotFound } from "@distilled.cloud/cloudflare/zero-trust";
import { DnsRecordAlreadyExists, RecordNotFound } from "@distilled.cloud/cloudflare/dns";
import { eq } from "drizzle-orm";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as RelayDb from "../db.ts";
import * as Config from "../Config.ts";
import {
  relayManagedEndpointAllocations as table,
  relayEnvironmentCredentials,
} from "../persistence/schema.ts";
import * as Provider from "./ManagedEndpointProvider.ts";
import * as Lifecycle from "./ManagedEndpointLifecycle.ts";
import * as Limits from "./ManagedTunnelLimits.ts";
import * as Links from "./EnvironmentLinks.ts";
import * as Credentials from "./EnvironmentCredentials.ts";
import { targetFor } from "./managedEndpointLifecycleContracts.ts";
import { config, publicationFor } from "./managedEndpointProviderTestFixture.ts";
import { connectDatabase, fixtureFile, layerDb } from "./managedEndpointPostgresFixture.ts";

const repositories = Layer.merge(Links.layer, Credentials.layer).pipe(
  Layer.provide(NodeServices.layer),
);
const services = Layer.merge(Lifecycle.layer, Limits.layer).pipe(Layer.provideMerge(repositories));
const fixture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.fresh(
        services.pipe(Layer.provideMerge(layerDb), Layer.provideMerge(NodeServices.layer)),
      ),
    ),
  );
const key = { userId: "runtime-user", environmentId: "runtime-env" };
const origin = { localHttpHost: "localhost", localHttpPort: 3000 };
const request = { ...key, origin, publication: publicationFor(key.environmentId) };
const notFoundTunnel = (id: string) =>
  new Provider.ManagedEndpointTunnelClientError({
    operation: "get",
    tunnelId: id,
    cause: new TunnelNotFound({ code: 1002, message: "Missing exact tunnel" }),
  });
const notFoundDns = (id: string) =>
  new Provider.ManagedEndpointDnsClientError({
    operation: "get-record",
    dnsRecordId: id,
    cause: new RecordNotFound({ code: 81044, message: "Missing exact DNS" }),
  });
interface Options {
  readonly before?: (operation: string) => Effect.Effect<void>;
  readonly createFailure?: "duplicate" | "ambiguous" | "defect" | "composite";
  readonly dnsCreateFailure?: "duplicate" | "ambiguous";
  readonly wrongDnsResponse?: boolean;
  readonly malformedConfiguration?: boolean;
  readonly malformedTunnelDeletion?: boolean;
  readonly malformedDnsDeletion?: boolean;
  readonly wrongDnsUpdateResponse?: boolean;
  readonly deleteFailure?: boolean;
  readonly token?: string;
  readonly incompleteInventory?: boolean;
}
const makeRuntime = Effect.fnUntraced(function* (options: Options = {}) {
  const db = yield* RelayDb.RelayDb;
  const calls: string[] = [];
  const tunnelRows = new Map<string, Provider.ManagedEndpointTunnel>();
  const dnsRows = new Map<string, Provider.ManagedEndpointDnsRecord>();
  let tunnelSequence = 0;
  const call = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      expect(Option.isNone(yield* Effect.serviceOption(db.$client.transactionService))).toBe(true);
      calls.push(operation);
      if (options.before) yield* options.before(operation);
      return yield* effect;
    });
  const tunnels = Provider.ManagedEndpointTunnelClient.of({
    get: (id) =>
      call(
        "tunnel-get",
        Effect.suspend(() =>
          tunnelRows.has(id)
            ? Effect.succeed(tunnelRows.get(id)!)
            : Effect.fail(notFoundTunnel(id)),
        ),
      ),
    list: (input) =>
      call(
        "tunnel-list",
        Effect.sync(() => {
          const result = [...tunnelRows.values()].filter((row) => row.name === input.name);
          return {
            result,
            resultInfo: options.incompleteInventory
              ? { page: 1, perPage: 100 }
              : {
                  page: input.page ?? 1,
                  perPage: 100,
                  count: result.length,
                  totalCount: result.length,
                  totalPages: 1,
                },
          };
        }),
      ),
    create: (input) =>
      call(
        "tunnel-create",
        Effect.suspend(() => {
          const row = {
            id: `tunnel-${++tunnelSequence}`,
            name: input.name,
            status: "inactive",
            createdAt: "2026-01-01T00:00:00.000Z",
          };
          if (options.createFailure === "composite") {
            const duplicate = new Provider.ManagedEndpointTunnelClientError({
              operation: "create",
              cause: new DuplicateTunnelName({ code: 1013, message: "Duplicate" }),
            });
            const unknown = new Provider.ManagedEndpointTunnelClientError({
              operation: "create",
              cause: "unknown concurrent failure",
            });
            return Effect.failCause(Cause.combine(Cause.fail(duplicate), Cause.fail(unknown)));
          }
          if (options.createFailure === "defect") return Effect.die("Dispatch defect");
          if (options.createFailure === "ambiguous")
            return Effect.fail(
              new Provider.ManagedEndpointTunnelClientError({
                operation: "create",
                tunnelName: input.name,
                cause: { _tag: "TimeoutError" },
              }),
            );
          tunnelRows.set(row.id, row);
          if (options.createFailure === "duplicate")
            return Effect.fail(
              new Provider.ManagedEndpointTunnelClientError({
                operation: "create",
                tunnelName: input.name,
                cause: new DuplicateTunnelName({ code: 1013, message: "Duplicate name" }),
              }),
            );
          return Effect.succeed(row);
        }),
      ),
    putConfiguration: (tunnelId, config) =>
      call(
        "tunnel-configure",
        Effect.succeed(options.malformedConfiguration ? {} : { tunnelId, config }),
      ),
    getToken: () => call("token", Effect.succeed(options.token ?? "fixture-connector-token")),
    delete: (id) =>
      call(
        "tunnel-delete",
        Effect.suspend(() => {
          if (options.deleteFailure)
            return Effect.fail(
              new Provider.ManagedEndpointTunnelClientError({
                operation: "delete",
                tunnelId: id,
                cause: { code: 1022, message: "Tunnel has active connections" },
              }),
            );
          const previous = tunnelRows.get(id);
          tunnelRows.delete(id);
          return Effect.succeed(
            options.malformedTunnelDeletion
              ? {}
              : { id, name: previous?.name, deletedAt: "2026-10-13T00:00:00.000Z" },
          );
        }),
      ),
  });
  const dns = Provider.ManagedEndpointDnsClient.of({
    getRecord: (id) =>
      call(
        "dns-get",
        Effect.suspend(() =>
          dnsRows.has(id) ? Effect.succeed(dnsRows.get(id)!) : Effect.fail(notFoundDns(id)),
        ),
      ),
    listRecords: () => Effect.die("Legacy DNS discovery forbidden"),
    listRecordsPage: () => Effect.die("Unused normalized page port"),
    listExactRecords: (hostname) =>
      call(
        "dns-list",
        Effect.sync(() => [...dnsRows.values()].filter((row) => row.name === hostname)),
      ),
    createRecord: (input) =>
      call(
        "dns-create",
        Effect.suspend(() => {
          const row = {
            ...input,
            id: "dns-1",
            ...(options.wrongDnsResponse ? { content: "foreign.cfargotunnel.com" } : {}),
          };
          if (options.dnsCreateFailure === "ambiguous")
            return Effect.fail(
              new Provider.ManagedEndpointDnsClientError({
                operation: "create-record",
                hostname: input.name,
                cause: { _tag: "TimeoutError" },
              }),
            );
          dnsRows.set(row.id, row);
          if (options.dnsCreateFailure === "duplicate")
            return Effect.fail(
              new Provider.ManagedEndpointDnsClientError({
                operation: "create-record",
                hostname: input.name,
                cause: new DnsRecordAlreadyExists({ code: 81057, message: "Duplicate record" }),
              }),
            );
          return Effect.succeed(row);
        }),
      ),
    updateRecord: (id, input) =>
      call(
        "dns-update",
        Effect.sync(() => {
          const row = { ...input, id };
          dnsRows.set(id, row);
          return options.wrongDnsUpdateResponse ? { ...row, id: "wrong-id" } : row;
        }),
      ),
    deleteRecord: (id) =>
      call(
        "dns-delete",
        Effect.sync(() => {
          dnsRows.delete(id);
          return options.malformedDnsDeletion ? {} : { id };
        }),
      ),
  });
  const provider = yield* Provider.make.pipe(
    Effect.provideService(Provider.ManagedEndpointTunnelClient, tunnels),
    Effect.provideService(Provider.ManagedEndpointDnsClient, dns),
    Effect.provideService(Config.RelayConfiguration, config),
  );
  return { provider, calls, tunnelRows, dnsRows };
});
const ready = Effect.fnUntraced(function* (
  runtime: Effect.Success<ReturnType<typeof makeRuntime>>,
) {
  const result = yield* runtime.provider.provision(request);
  const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
  const row = yield* lifecycle.get(key);
  const links = yield* Links.EnvironmentLinks;
  const link = yield* links.getForUser(key);
  if (!row || !link || result.kind !== "linked") throw new Error("Fixture publication missing");
  return {
    result,
    row,
    link,
    expectedLink: {
      environmentPublicKey: link.environmentPublicKey,
      expectedLinkIncarnationId: link.linkIncarnationId,
      endpoint: link.endpoint,
    },
  };
});

describe.skipIf(!fixtureFile)("Managed endpoint coordinated runtime PostgreSQL", () => {
  it.effect(
    "publishes authority, credential and readiness together after all exact checkpoints",
    () =>
      fixture(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime();
          const { result, row } = yield* ready(runtime);
          expect(result.runtime.connectorToken).toBe("fixture-connector-token");
          expect(row).toMatchObject({
            lifecycleState: "idle",
            operationId: null,
            pendingMutation: null,
            tunnelPresence: "recorded",
            dnsPresence: "recorded",
            dnsTargetTunnelId: "tunnel-1",
            origin,
            recoveryEnabledAt: null,
          });
          expect(row.readyAt).not.toBeNull();
          const db = yield* RelayDb.RelayDb;
          expect(yield* db.select().from(relayEnvironmentCredentials)).toHaveLength(1);
          expect(runtime.calls).toEqual([
            "tunnel-list",
            "tunnel-create",
            "tunnel-configure",
            "dns-list",
            "dns-create",
            "token",
          ]);
        }),
      ),
  );

  it.effect(
    "holds owner through token and permits a distinct backend's advisory and row lock while CF is held",
    () =>
      fixture(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const runtime = yield* makeRuntime({
            before: (operation) =>
              operation === "token"
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
          yield* Deferred.await(entered);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const row = yield* lifecycle.get(key);
          expect(row).toMatchObject({
            lifecycleState: "owned",
            pendingMutation: null,
            readyAt: null,
          });
          const db = yield* RelayDb.RelayDb;
          const ownPid = (yield* db.$client<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]
            ?.pid;
          const context = yield* Effect.context<RelayDb.RelayDb>();
          const otherPid = yield* Effect.gen(function* () {
            const otherDb = Context.get(yield* Effect.context<RelayDb.RelayDb>(), RelayDb.RelayDb);
            return yield* otherDb.$client.withTransaction(
              Effect.gen(function* () {
                yield* otherDb.$client`SELECT pg_advisory_xact_lock(hashtextextended(${`relay-managed-tunnel:${key.userId}`}, 0))`;
                yield* otherDb.$client`SELECT allocation_id FROM relay_managed_endpoint_allocations WHERE user_id = ${key.userId} FOR UPDATE NOWAIT`;
                return (yield* otherDb.$client<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]
                  ?.pid;
              }),
            );
          }).pipe(Effect.provide(Layer.fresh(connectDatabase("1s"))));
          expect(otherPid).not.toBe(ownPid);
          expect(Context.get(context, RelayDb.RelayDb)).toBe(db);
          expect(yield* runtime.provider.release(key)).toBe(false);
          yield* Deferred.succeed(resume, undefined);
          expect((yield* Fiber.join(fiber)).kind).toBe("linked");
        }),
      ),
  );

  it.effect.each(["create", "token"] as const)(
    "unlink during held $0 cannot free reservation or resurrect authority",
    (stage) =>
      fixture(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const runtime = yield* makeRuntime({
            before: (op) =>
              op === (stage === "create" ? "tunnel-create" : "token")
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
          });
          const fiber = yield* Effect.forkChild(Effect.exit(runtime.provider.provision(request)));
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(resume, undefined).pipe(
              Effect.andThen(Fiber.interrupt(fiber)),
              Effect.asVoid,
            ),
          );
          yield* Deferred.await(entered);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const captured = yield* lifecycle.revokeAndRequestCleanup(key);
          expect(captured.target?.tunnelId).toBe(stage === "create" ? null : "tunnel-1");
          expect(yield* runtime.provider.deprovision({ ...key, target: captured.target })).toBe(
            false,
          );
          yield* Deferred.succeed(resume, undefined);
          expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
          const links = yield* Links.EnvironmentLinks;
          expect(yield* links.getForUser(key)).toBeNull();
          expect(yield* lifecycle.get(key)).toMatchObject({
            cleanupRequested: true,
            lifecycleState: "idle",
          });
          const retryCapture = yield* lifecycle.revokeAndRequestCleanup(key);
          expect(yield* runtime.provider.deprovision({ ...key, target: retryCapture.target })).toBe(
            true,
          );
          expect(yield* lifecycle.get(key)).toBeNull();
          const db = yield* RelayDb.RelayDb;
          expect(yield* db.select().from(relayEnvironmentCredentials)).toHaveLength(0);
        }),
      ),
  );

  it.effect("interruption reaches a dispatched external call and retains exact pending owner", () =>
    fixture(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const runtime = yield* makeRuntime({
          before: (operation) =>
            operation === "tunnel-create"
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                )
              : Effect.void,
        });
        const fiber = yield* Effect.forkChild(runtime.provider.provision(request));
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        yield* Deferred.await(interrupted);
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        expect(yield* lifecycle.get(key)).toMatchObject({
          lifecycleState: "uncertain",
          pendingMutation: { action: "create_tunnel" },
          tunnelId: null,
        });
        expect(runtime.calls).toEqual(["tunnel-list", "tunnel-create"]);
      }),
    ),
  );

  it.effect.each(["duplicate", "ambiguous", "defect"] as const)(
    "handles create $0 without unowned adoption/retry",
    (failure) =>
      fixture(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime({ createFailure: failure });
          const exit = yield* Effect.exit(runtime.provider.provision(request));
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const row = yield* lifecycle.get(key);
          if (failure === "duplicate") {
            expect(Exit.isSuccess(exit)).toBe(true);
            expect(runtime.calls.filter((x) => x === "tunnel-list")).toHaveLength(2);
            expect(row?.lifecycleState).toBe("idle");
          } else {
            expect(Exit.isFailure(exit)).toBe(true);
            expect(row).toMatchObject({
              lifecycleState: "uncertain",
              pendingMutation: { action: "create_tunnel" },
            });
            expect(runtime.calls).toEqual(["tunnel-list", "tunnel-create"]);
          }
          expect(runtime.calls.filter((x) => x === "tunnel-create")).toHaveLength(1);
        }),
      ),
  );

  it.effect.each(["duplicate", "ambiguous"] as const)(
    "handles DNS create $0 with one attempt",
    (failure) =>
      fixture(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime({ dnsCreateFailure: failure });
          const exit = yield* Effect.exit(runtime.provider.provision(request));
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          expect(Exit.isSuccess(exit)).toBe(failure === "duplicate");
          expect(runtime.calls.filter((x) => x === "dns-create")).toHaveLength(1);
          if (failure === "ambiguous")
            expect(yield* lifecycle.get(key)).toMatchObject({
              lifecycleState: "uncertain",
              pendingMutation: { action: "create_dns" },
            });
        }),
      ),
  );

  it.effect.each(["wrong-dns", "empty-token", "incomplete-inventory"] as const)(
    "fails closed on $0",
    (failure) =>
      fixture(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime({
            wrongDnsResponse: failure === "wrong-dns",
            token: failure === "empty-token" ? "" : "token",
            incompleteInventory: failure === "incomplete-inventory",
          });
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(request)))).toBe(
            true,
          );
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const row = yield* lifecycle.get(key);
          expect(row?.readyAt).toBeNull();
          expect(row?.lifecycleState).toBe(failure === "wrong-dns" ? "uncertain" : "idle");
          const links = yield* Links.EnvironmentLinks;
          expect(yield* links.getForUser(key)).toBeNull();
        }),
      ),
  );

  it.effect(
    "exact release retains quota/DNS/identity and recovery repoints only its previous DNS target",
    () =>
      fixture(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime();
          const { row, expectedLink } = yield* ready(runtime);
          expect(
            yield* runtime.provider.release({
              ...key,
              expectedTarget: targetFor(row),
              expectedTunnelId: row.tunnelId!,
              markReleased: true,
            }),
          ).toBe(true);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const released = yield* lifecycle.get(key);
          expect(released).toMatchObject({
            lifecycleState: "idle",
            tunnelPresence: "absent",
            tunnelId: "tunnel-1",
            dnsRecordId: "dns-1",
          });
          expect(released?.tunnelReleasedAt).not.toBeNull();
          const recovered = yield* runtime.provider.provision({
            ...key,
            origin,
            publication: { kind: "recover", ...expectedLink },
          });
          expect(recovered.kind).toBe("recovered");
          expect(recovered.runtime.tunnelId).toBe("tunnel-2");
          expect(runtime.calls.filter((op) => op === "dns-update")).toHaveLength(1);
          expect(yield* lifecycle.get(key)).toMatchObject({
            recoveryEnvironmentPublicKey: "fixture-key",
            tunnelReleasedAt: null,
            dnsTargetTunnelId: "tunnel-2",
          });
        }),
      ),
  );

  it.effect("unsupported in-use delete retains pending and leaves release marker unchanged", () =>
    fixture(
      Effect.gen(function* () {
        const runtime = yield* makeRuntime({ deleteFailure: true });
        yield* ready(runtime);
        expect(
          Exit.isFailure(
            yield* Effect.exit(runtime.provider.release({ ...key, markReleased: true })),
          ),
        ).toBe(true);
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        expect(yield* lifecycle.get(key)).toMatchObject({
          lifecycleState: "uncertain",
          pendingMutation: { action: "delete_tunnel" },
          tunnelReleasedAt: null,
        });
        expect(runtime.calls.at(-1)).toBe("tunnel-delete");
      }),
    ),
  );

  it.effect(
    "never-created release cannot invent a marker and unresolved null ID cannot imply success",
    () =>
      fixture(
        Effect.gen(function* () {
          const limits = yield* Limits.ManagedTunnelLimits;
          const db = yield* RelayDb.RelayDb;
          yield* limits.reserveAllocation({
            ...key,
            hostname: "fresh.fixture.test",
            tunnelName: "fresh",
          });
          const runtime = yield* makeRuntime();
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.release(key)))).toBe(true);
          yield* db
            .update(table)
            .set({ tunnelPresence: "never_created" })
            .where(eq(table.userId, key.userId));
          expect(yield* runtime.provider.release({ ...key, markReleased: true })).toBe(true);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "idle",
            tunnelReleasedAt: null,
          });
          expect(runtime.calls).toEqual([]);
        }),
      ),
  );

  it.effect(
    "stale recovery incarnation fails before any Cloudflare call, including after unlink/new admission",
    () =>
      fixture(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime();
          const { expectedLink } = yield* ready(runtime);
          runtime.calls.length = 0;
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                runtime.provider.provision({
                  ...key,
                  origin,
                  publication: {
                    kind: "recover",
                    ...expectedLink,
                    expectedLinkIncarnationId: "stale",
                  },
                }),
              ),
            ),
          ).toBe(true);
          expect(runtime.calls).toEqual([]);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const captured = yield* lifecycle.revokeAndRequestCleanup(key);
          expect(yield* runtime.provider.deprovision({ ...key, target: captured.target })).toBe(
            true,
          );
          runtime.calls.length = 0;
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                runtime.provider.provision({
                  ...key,
                  origin,
                  publication: { kind: "recover", ...expectedLink },
                }),
              ),
            ),
          ).toBe(true);
          expect(runtime.calls).toEqual([]);
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "idle",
            tunnelId: null,
          });
        }),
      ),
  );

  it.effect("unchanged-origin reconcile owns until final commit and blocks release", () =>
    fixture(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let holding = false;
        const runtime = yield* makeRuntime({
          before: (operation) =>
            holding && operation === "dns-get"
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void,
        });
        const { row, expectedLink } = yield* ready(runtime);
        holding = true;
        const fiber = yield* Effect.forkChild(
          runtime.provider.reconcileOrigin({
            ...key,
            origin,
            tunnelId: row.tunnelId!,
            expectedLink,
          }),
        );
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(resume, undefined).pipe(
            Effect.andThen(Fiber.interrupt(fiber)),
            Effect.asVoid,
          ),
        );
        yield* Deferred.await(entered);
        expect(yield* runtime.provider.release(key)).toBe(false);
        yield* Deferred.succeed(resume, undefined);
        expect(yield* Fiber.join(fiber)).toBe("ready");
        expect(runtime.calls.filter((op) => op === "tunnel-configure")).toHaveLength(1);
      }),
    ),
  );

  it.effect(
    "deprovision commits revocation before exact cleanup and rejects a target from another key",
    () =>
      fixture(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime();
          yield* ready(runtime);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const captured = yield* lifecycle.revokeAndRequestCleanup(key);
          const target = captured.target;
          if (!target) throw new Error("Missing target");
          runtime.calls.length = 0;
          expect(
            yield* runtime.provider.deprovision({
              ...key,
              target: { ...target, key: { ...key, userId: "wrong" } },
            }),
          ).toBe(false);
          expect(runtime.calls).toEqual([]);
          expect(yield* runtime.provider.deprovision({ ...key, target })).toBe(true);
          expect(yield* lifecycle.get(key)).toBeNull();
          expect(runtime.calls).toEqual(["dns-get", "dns-delete", "tunnel-get", "tunnel-delete"]);
          expect(yield* runtime.provider.deprovision({ ...key, target })).toBe(true);
        }),
      ),
  );

  it.effect(
    "generic insert remains legacy quarantine while admission is explicitly fresh idle",
    () =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          yield* db.insert(table).values({
            ...key,
            hostname: "legacy.fixture.test",
            tunnelName: "legacy",
            createdAt: "now",
            updatedAt: "now",
          });
          const runtime = yield* makeRuntime();
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(request)))).toBe(
            true,
          );
          expect(runtime.calls).toEqual([]);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "legacy_unverified",
            tunnelPresence: "unresolved",
          });
        }),
      ),
  );

  it.effect("all provider entrypoints reject ambient SQL before external calls", () =>
    fixture(
      Effect.gen(function* () {
        const runtime = yield* makeRuntime();
        const db = yield* RelayDb.RelayDb;
        const provision = yield* db.$client.withTransaction(
          Effect.exit(runtime.provider.provision(request)),
        );
        const release = yield* db.$client.withTransaction(
          Effect.exit(runtime.provider.release(key)),
        );
        const cleanup = yield* db.$client.withTransaction(
          Effect.exit(runtime.provider.deprovision({ ...key, target: null })),
        );
        const reconcile = yield* db.$client.withTransaction(
          Effect.exit(
            runtime.provider.reconcileOrigin({
              ...key,
              origin,
              tunnelId: "id",
              expectedLink: {
                environmentPublicKey: "key",
                expectedLinkIncarnationId: "id",
                endpoint: {
                  providerKind: "cloudflare_tunnel",
                  httpBaseUrl: "https://fixture.test/",
                  wsBaseUrl: "wss://fixture.test/ws",
                },
              },
            }),
          ),
        );
        expect(Exit.isFailure(provision)).toBe(true);
        expect(Exit.isFailure(release)).toBe(true);
        expect(Exit.isFailure(cleanup)).toBe(true);
        expect(Exit.isFailure(reconcile)).toBe(true);
        expect(runtime.calls).toEqual([]);
      }),
    ),
  );
  it.effect(
    "publish-only during held null-ID create commits replacement authority and preserves reservation",
    () =>
      fixture(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const runtime = yield* makeRuntime({
            before: (operation) =>
              operation === "tunnel-create"
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
          });
          const fiber = yield* Effect.forkChild(Effect.exit(runtime.provider.provision(request)));
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(resume, undefined).pipe(
              Effect.andThen(Fiber.interrupt(fiber)),
              Effect.asVoid,
            ),
          );
          yield* Deferred.await(entered);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const publication = publicationFor(key.environmentId);
          if (publication.kind !== "link") throw new Error("Fixture proof missing");
          const captured = yield* lifecycle.publishWithoutTunnel({
            userId: key.userId,
            request: { ...publication.request, managedTunnelsEnabled: false },
            verifiedProof: publication.proof,
            endpoint: publication.proof.endpoint,
          });
          expect(captured.target?.tunnelId).toBeNull();
          expect(yield* runtime.provider.deprovision({ ...key, target: captured.target })).toBe(
            false,
          );
          yield* Deferred.succeed(resume, undefined);
          expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
          const links = yield* Links.EnvironmentLinks;
          expect((yield* links.getForUser(key))?.endpoint.providerKind).toBe("manual");
          expect(yield* lifecycle.get(key)).toMatchObject({
            cleanupRequested: true,
            tunnelId: "tunnel-1",
            readyAt: null,
          });
          const db = yield* RelayDb.RelayDb;
          expect(yield* db.select().from(relayEnvironmentCredentials)).toHaveLength(1);
        }),
      ),
  );

  it.effect.each(["foreign", "multiple", "wrong-stored-id"] as const)(
    "leaves $0 DNS identities untouched",
    (kind) =>
      fixture(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime();
          const { row } = yield* ready(runtime);
          const first = runtime.dnsRows.get("dns-1");
          if (!first) throw new Error("Fixture DNS missing");
          runtime.dnsRows.set("dns-1", {
            ...first,
            ...(kind === "foreign" ? { content: "foreign.cfargotunnel.com" } : {}),
            ...(kind === "wrong-stored-id" ? { id: "wrong" } : {}),
          });
          const db = yield* RelayDb.RelayDb;
          if (kind === "multiple") {
            runtime.dnsRows.set("dns-2", { ...first, id: "dns-2" });
            yield* db
              .update(table)
              .set({ dnsRecordId: null, dnsPresence: "unresolved" })
              .where(eq(table.userId, key.userId));
          }
          runtime.calls.length = 0;
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(request)))).toBe(
            true,
          );
          expect(
            runtime.calls.some((operation) =>
              ["dns-create", "dns-update", "dns-delete"].includes(operation),
            ),
          ).toBe(false);
          expect(runtime.dnsRows.size).toBe(kind === "multiple" ? 2 : 1);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          expect((yield* lifecycle.get(key))?.allocationId).toBe(row.allocationId);
        }),
      ),
  );

  it.effect("a live recorded tunnel name mismatch never replaces or deletes it", () =>
    fixture(
      Effect.gen(function* () {
        const runtime = yield* makeRuntime();
        yield* ready(runtime);
        runtime.tunnelRows.set("tunnel-1", { id: "tunnel-1", name: "foreign-name" });
        runtime.calls.length = 0;
        expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(request)))).toBe(true);
        expect(runtime.calls).toEqual(["tunnel-get"]);
        expect(runtime.tunnelRows.get("tunnel-1")?.name).toBe("foreign-name");
      }),
    ),
  );

  it.effect(
    "an exact mutation checkpoint suppressed by PostgreSQL stops all further dispatch",
    () =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          const runtime = yield* makeRuntime({
            before: (operation) =>
              operation === "tunnel-create"
                ? Effect.gen(function* () {
                    yield* db.$client`CREATE FUNCTION task4c_managed_endpoints.suppress_runtime_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`;
                    yield* db.$client`CREATE TRIGGER suppress_runtime_checkpoint BEFORE UPDATE ON relay_managed_endpoint_allocations FOR EACH ROW EXECUTE FUNCTION task4c_managed_endpoints.suppress_runtime_checkpoint()`;
                  }).pipe(Effect.orDie)
                : Effect.void,
          });
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(request)))).toBe(
            true,
          );
          expect(runtime.calls).toEqual(["tunnel-list", "tunnel-create"]);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "owned",
            pendingMutation: { action: "create_tunnel" },
            tunnelId: null,
            readyAt: null,
          });
        }),
      ),
  );

  it.effect("composite known duplicate plus unknown failure remains uncertain", () =>
    fixture(
      Effect.gen(function* () {
        const runtime = yield* makeRuntime({ createFailure: "composite" });
        expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(request)))).toBe(true);
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        expect(yield* lifecycle.get(key)).toMatchObject({
          lifecycleState: "uncertain",
          pendingMutation: { action: "create_tunnel" },
        });
        expect(runtime.calls).toEqual(["tunnel-list", "tunnel-create"]);
      }),
    ),
  );

  it.effect.each(["configuration", "tunnel-deletion", "dns-deletion", "dns-update"] as const)(
    "malformed $0 success retains the exact pending step",
    (operation) =>
      fixture(
        Effect.gen(function* () {
          const options = {
            malformedConfiguration: false,
            malformedTunnelDeletion: false,
            malformedDnsDeletion: false,
            wrongDnsUpdateResponse: false,
          };
          const runtime = yield* makeRuntime(options);
          const { expectedLink } = yield* ready(runtime);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const exit = yield* Effect.exit(
            Effect.gen(function* () {
              if (operation === "configuration") {
                options.malformedConfiguration = true;
                yield* runtime.provider.provision(request);
              } else if (operation === "tunnel-deletion") {
                options.malformedTunnelDeletion = true;
                yield* runtime.provider.release(key);
              } else if (operation === "dns-deletion") {
                options.malformedDnsDeletion = true;
                const captured = yield* lifecycle.revokeAndRequestCleanup(key);
                yield* runtime.provider.deprovision({ ...key, target: captured.target });
              } else {
                yield* runtime.provider.release(key);
                options.wrongDnsUpdateResponse = true;
                yield* runtime.provider.provision({
                  ...key,
                  origin,
                  publication: { kind: "recover", ...expectedLink },
                });
              }
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "uncertain",
            pendingMutation: {
              action:
                operation === "configuration"
                  ? "configure_tunnel"
                  : operation === "tunnel-deletion"
                    ? "delete_tunnel"
                    : operation === "dns-deletion"
                      ? "delete_dns"
                      : "update_dns",
            },
          });
        }),
      ),
  );
  it.effect.each(["acquisition", "intent"] as const)(
    "a suppressed $0 write invokes no mutation builder or dispatch",
    (boundary) =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          yield* db.$client`CREATE FUNCTION task4c_managed_endpoints.suppress_runtime_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`;
          if (boundary === "acquisition")
            yield* db.$client`CREATE TRIGGER suppress_runtime_intent BEFORE UPDATE ON relay_managed_endpoint_allocations FOR EACH ROW WHEN (NEW.lifecycle_state = 'owned' AND OLD.lifecycle_state = 'idle') EXECUTE FUNCTION task4c_managed_endpoints.suppress_runtime_intent()`;
          else
            yield* db.$client`CREATE TRIGGER suppress_runtime_intent BEFORE UPDATE ON relay_managed_endpoint_allocations FOR EACH ROW WHEN (NEW.pending_mutation IS NOT NULL) EXECUTE FUNCTION task4c_managed_endpoints.suppress_runtime_intent()`;
          const runtime = yield* makeRuntime();
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(request)))).toBe(
            true,
          );
          expect(runtime.calls).toEqual(boundary === "acquisition" ? [] : ["tunnel-list"]);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "idle",
            pendingMutation: null,
            tunnelId: null,
            readyAt: null,
          });
        }),
      ),
  );

  it.effect(
    "release rechecks reconnect eligibility under ownership and leaves the marker unchanged",
    () =>
      fixture(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime();
          const { row } = yield* ready(runtime);
          const tunnel = runtime.tunnelRows.get("tunnel-1");
          if (!tunnel) throw new Error("Fixture tunnel missing");
          runtime.tunnelRows.set("tunnel-1", { ...tunnel, status: "healthy" });
          runtime.calls.length = 0;
          expect(
            yield* runtime.provider.release({
              ...key,
              expectedTarget: targetFor(row),
              expectedTunnelId: "tunnel-1",
              expectedStatus: "inactive",
              expectedInactiveBefore: "2026-10-01T00:00:00.000Z",
              markReleased: true,
            }),
          ).toBe(false);
          expect(runtime.calls).toEqual(["tunnel-get"]);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "idle",
            pendingMutation: null,
            tunnelPresence: "recorded",
            tunnelReleasedAt: null,
          });
        }),
      ),
  );
  it.effect(
    "downgrade with the same nominal Cloudflare endpoint permits cleanup while preserving publish-only authority",
    () =>
      fixture(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime();
          const { result } = yield* ready(runtime);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const publication = publicationFor(key.environmentId);
          if (publication.kind !== "link") throw new Error("Fixture proof missing");
          const captured = yield* lifecycle.publishWithoutTunnel({
            userId: key.userId,
            request: { ...publication.request, managedTunnelsEnabled: false },
            verifiedProof: { ...publication.proof, endpoint: result.endpoint },
            endpoint: result.endpoint,
          });
          expect(yield* runtime.provider.deprovision({ ...key, target: captured.target })).toBe(
            true,
          );
          expect(yield* lifecycle.get(key)).toBeNull();
          const links = yield* Links.EnvironmentLinks;
          const link = yield* links.getForUser(key);
          expect(link?.endpoint).toEqual(result.endpoint);
          expect(link?.environmentPublicKey).toBe("fixture-key");
          const credentials = yield* Credentials.EnvironmentCredentials;
          expect(
            Option.isSome(yield* credentials.authenticate(captured.environmentCredential)),
          ).toBe(true);
        }),
      ),
  );
});
