import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect } from "@effect/vitest";
import { DuplicateTunnelName, TunnelNotFound } from "@distilled.cloud/cloudflare/zero-trust";
import { DnsRecordAlreadyExists, RecordNotFound } from "@distilled.cloud/cloudflare/dns";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import * as Config from "../Config.ts";
import * as Provider from "./ManagedEndpointProvider.ts";
import * as Lifecycle from "./ManagedEndpointLifecycle.ts";
import * as Limits from "./ManagedTunnelLimits.ts";
import * as Links from "./EnvironmentLinks.ts";
import * as Credentials from "./EnvironmentCredentials.ts";
import * as Allocations from "./ManagedEndpointAllocations.ts";
import * as Reaper from "./ManagedEndpointReaper.ts";
import { config, publicationFor } from "./managedEndpointProviderTestFixture.ts";
import { layerDb } from "./managedEndpointPostgresFixture.ts";

const repositories = Layer.merge(Links.layer, Credentials.layer).pipe(
  Layer.provide(NodeServices.layer),
);
const services = Layer.merge(Lifecycle.layer, Limits.layer).pipe(Layer.provideMerge(repositories));
export const fixture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.fresh(
        services.pipe(Layer.provideMerge(layerDb), Layer.provideMerge(NodeServices.layer)),
      ),
    ),
  );
export const key = { userId: "runtime-user", environmentId: "runtime-env" };
export const origin = { localHttpHost: "localhost", localHttpPort: 3000 };
export const request = { ...key, origin, publication: publicationFor(key.environmentId) };
export const awaitBarrier = <A, E>(entered: Deferred.Deferred<void>, fiber: Fiber.Fiber<A, E>) =>
  Effect.raceFirst(
    Deferred.await(entered),
    Fiber.await(fiber).pipe(
      Effect.andThen(Effect.die("Winner settled before the expected external barrier")),
    ),
  );
export const notFoundTunnel = (id: string) =>
  new Provider.ManagedEndpointTunnelClientError({
    operation: "get",
    tunnelId: id,
    cause: new TunnelNotFound({ code: 1002, message: "Missing exact tunnel" }),
  });
export const notFoundDns = (id: string) =>
  new Provider.ManagedEndpointDnsClientError({
    operation: "get-record",
    dnsRecordId: id,
    cause: new RecordNotFound({ code: 81044, message: "Missing exact DNS" }),
  });
const isTunnelClientError = Schema.is(Provider.ManagedEndpointTunnelClientError);
const malformedResponse = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
  null,
).pipe(
  Effect.match({
    onFailure: (cause) => cause,
    onSuccess: () => new Error("Unexpected fixture parse success"),
  }),
);
export interface Options {
  readonly before?: (operation: string) => Effect.Effect<void>;
  readonly createFailure?: "duplicate" | "ambiguous" | "defect" | "composite";
  readonly dnsCreateFailure?: "duplicate" | "ambiguous";
  readonly wrongDnsResponse?: boolean;
  readonly malformedConfiguration?: boolean;
  readonly configurationNotFound?: boolean;
  readonly malformedTunnelDeletion?: boolean;
  readonly malformedDnsDeletion?: boolean;
  readonly wrongDnsUpdateResponse?: boolean;
  readonly deleteFailure?: boolean;
  readonly token?: string;
  readonly incompleteInventory?: boolean;
  readonly failAttempt?:
    | {
        readonly operation: string;
        readonly kind: "timeout" | "abort" | "reset" | "unknown" | "parse" | "defect";
        readonly cause?: unknown;
      }
    | undefined;
  readonly malformedCreate?: boolean;
  readonly uninterruptibleOperation?: string;
  readonly inventory?: (
    input: Provider.ManagedEndpointTunnelListRequest,
  ) => Effect.Success<ReturnType<Provider.ManagedEndpointTunnelClient["Service"]["list"]>>;
  readonly exactDnsInventory?: (
    hostname: string,
  ) => ReadonlyArray<Provider.ManagedEndpointDnsRecord>;
  readonly afterAllocationSnapshot?: Effect.Effect<void>;
  readonly lifecycle?: (
    service: Lifecycle.ManagedEndpointLifecycle["Service"],
  ) => Lifecycle.ManagedEndpointLifecycle["Service"];
}
export const makeRuntime = Effect.fnUntraced(function* (options: Options = {}) {
  const db = yield* RelayDb.RelayDb;
  const calls: string[] = [];
  const tunnelGetIds: string[] = [];
  const configurationCalls: Array<{
    readonly tunnelId: string;
    readonly config: {
      readonly ingress: ReadonlyArray<{ readonly hostname?: string; readonly service: string }>;
    };
  }> = [];
  const tunnelRows = new Map<string, Provider.ManagedEndpointTunnel>();
  const dnsRows = new Map<string, Provider.ManagedEndpointDnsRecord>();
  let tunnelSequence = 0;
  const call = Effect.fn("managedEndpointRuntimeTestFixture.call")(
    function* <A, E>(operation: string, effect: Effect.Effect<A, E>) {
      expect(Option.isNone(yield* Effect.serviceOption(db.$client.transactionService))).toBe(true);
      calls.push(operation);
      if (options.before) yield* options.before(operation);
      if (options.failAttempt?.operation === operation) {
        const kind = options.failAttempt.kind;
        if (kind === "defect") return yield* Effect.die("Fixture dispatch defect");
        const cause =
          options.failAttempt.cause ??
          (kind === "parse"
            ? yield* malformedResponse
            : kind === "timeout"
              ? { _tag: "TimeoutError" }
              : kind === "abort"
                ? { name: "AbortError" }
                : kind === "reset"
                  ? { code: "ECONNRESET" }
                  : { status: 503 });
        return yield* new Provider.ManagedEndpointTunnelClientError({
          operation:
            operation === "tunnel-delete"
              ? "delete"
              : operation === "tunnel-configure"
                ? "put-configuration"
                : operation === "tunnel-get"
                  ? "get"
                  : operation === "token"
                    ? "get-token"
                    : "create",
          cause,
        });
      }
      return yield* effect;
    },
    (_program, operation) =>
      _program.pipe(
        options.uninterruptibleOperation === operation
          ? Effect.uninterruptible
          : (effect) => effect,
      ),
  );
  const tunnels = Provider.ManagedEndpointTunnelClient.of({
    get: (id) =>
      call(
        "tunnel-get",
        Effect.suspend(() => {
          tunnelGetIds.push(id);
          return tunnelRows.has(id)
            ? Effect.succeed(tunnelRows.get(id)!)
            : Effect.fail(notFoundTunnel(id));
        }),
      ),
    list: (input) =>
      call(
        "tunnel-list",
        Effect.sync(() => {
          if (options.inventory) return options.inventory(input);
          const result = [...tunnelRows.values()].filter(
            (row) =>
              (input.name === undefined || row.name === input.name) &&
              (input.status === undefined || row.status === input.status),
          );
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
            createdAt: "1900-01-01T00:00:00.000Z",
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
          return Effect.succeed(options.malformedCreate ? { ...row, id: "" } : row);
        }),
      ),
    putConfiguration: (tunnelId, config) =>
      call(
        "tunnel-configure",
        Effect.suspend(() => {
          configurationCalls.push({ tunnelId, config });
          return options.configurationNotFound
            ? Effect.fail(
                new Provider.ManagedEndpointTunnelClientError({
                  operation: "put-configuration",
                  tunnelId,
                  cause: new TunnelNotFound({
                    code: 1002,
                    message: "Missing exact configured tunnel",
                  }),
                }),
              )
            : Effect.succeed(options.malformedConfiguration ? {} : { tunnelId, config });
        }),
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
  const dnsCall = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    call(operation, effect).pipe(
      Effect.mapError((cause) =>
        isTunnelClientError(cause)
          ? new Provider.ManagedEndpointDnsClientError({
              operation:
                operation === "dns-get"
                  ? "get-record"
                  : operation === "dns-create"
                    ? "create-record"
                    : operation === "dns-update"
                      ? "update-record"
                      : operation === "dns-delete"
                        ? "delete-record"
                        : "list-records",
              cause: cause.cause,
            })
          : cause,
      ),
    );
  const dns = Provider.ManagedEndpointDnsClient.of({
    getRecord: (id) =>
      dnsCall(
        "dns-get",
        Effect.suspend(() =>
          dnsRows.has(id) ? Effect.succeed(dnsRows.get(id)!) : Effect.fail(notFoundDns(id)),
        ),
      ),
    listRecords: () => Effect.die("Legacy DNS discovery forbidden"),
    listRecordsPage: () => Effect.die("Unused normalized page port"),
    listExactRecords: (hostname) =>
      dnsCall(
        "dns-list",
        Effect.sync(
          () =>
            options.exactDnsInventory?.(hostname) ??
            [...dnsRows.values()].filter((row) => row.name === hostname),
        ),
      ),
    createRecord: (input) =>
      dnsCall(
        "dns-create",
        Effect.suspend(() => {
          const row = {
            ...input,
            id: `dns-${tunnelSequence}`,
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
      dnsCall(
        "dns-update",
        Effect.sync(() => {
          const row = { ...input, id };
          dnsRows.set(id, row);
          return options.wrongDnsUpdateResponse ? { ...row, id: "wrong-id" } : row;
        }),
      ),
    deleteRecord: (id) =>
      dnsCall(
        "dns-delete",
        Effect.sync(() => {
          dnsRows.delete(id);
          return options.malformedDnsDeletion ? {} : { id };
        }),
      ),
  });
  const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
  const provider = yield* Provider.make.pipe(
    Effect.provideService(Provider.ManagedEndpointTunnelClient, tunnels),
    Effect.provideService(Provider.ManagedEndpointDnsClient, dns),
    Effect.provideService(Config.RelayConfiguration, config),
    Effect.provideService(
      Lifecycle.ManagedEndpointLifecycle,
      options.lifecycle?.(lifecycle) ?? lifecycle,
    ),
  );
  const actualAllocations = yield* Allocations.make;
  const allocations = {
    ...actualAllocations,
    listByTunnelNames: (names: readonly string[]) =>
      actualAllocations
        .listByTunnelNames(names)
        .pipe(Effect.tap(() => options.afterAllocationSnapshot ?? Effect.void)),
  };
  const reaper = yield* Reaper.make.pipe(
    Effect.provideService(Provider.ManagedEndpointTunnelClient, tunnels),
    Effect.provideService(Provider.ManagedEndpointProvider, provider),
    Effect.provideService(Allocations.ManagedEndpointAllocations, allocations),
    Effect.provideService(Config.RelayConfiguration, {
      ...config,
      managedEndpointCleanupMode: "enabled",
    }),
  );
  return {
    provider,
    reaper,
    calls,
    tunnelGetIds,
    configurationCalls,
    tunnelRows,
    dnsRows,
    tunnels,
    dns,
  };
});
export const ready = Effect.fnUntraced(function* (
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
