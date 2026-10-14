import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as RelayDb from "../db.ts";
import { relayManagedEndpointAllocations as table } from "../persistence/schema.ts";
import * as Lifecycle from "./ManagedEndpointLifecycle.ts";
import { fixtureFile } from "./managedEndpointPostgresFixture.ts";
import { publicationFor } from "./managedEndpointProviderTestFixture.ts";
import {
  fixture,
  key,
  origin,
  request,
  makeRuntime,
  ready,
  type Options,
} from "./managedEndpointRuntimeTestFixture.ts";

const actions = {
  "tunnel-create": "create_tunnel",
  "tunnel-configure": "configure_tunnel",
  "dns-create": "create_dns",
  "dns-update": "update_dns",
  "dns-delete": "delete_dns",
  "tunnel-delete": "delete_tunnel",
} as const;
const mutationNames = Object.keys(actions);
const failures = ["timeout", "abort", "reset", "unknown", "parse", "malformed", "defect"] as const;
const matrix = (Object.keys(actions) as Array<keyof typeof actions>).flatMap((operation) =>
  failures.map((failure) => ({ operation, failure })),
);

describe.skipIf(!fixtureFile)("Managed endpoint mutation failures PostgreSQL", () => {
  it.effect.each([
    { failure: "generic message", cause: { message: "Tunnel not found" } },
    { failure: "raw 404", cause: { status: 404 } },
  ])(
    "unsupported tunnel DELETE $failure remains uncertain without heuristic absence",
    ({ cause }) =>
      fixture(
        Effect.gen(function* () {
          const options: { failAttempt: Options["failAttempt"] } = { failAttempt: undefined };
          const runtime = yield* makeRuntime(options);
          yield* ready(runtime);
          options.failAttempt = { operation: "tunnel-delete", kind: "unknown", cause };
          runtime.calls.length = 0;
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
            tunnelPresence: "recorded",
          });
          expect(runtime.calls).toEqual(["tunnel-get", "tunnel-delete"]);
          expect(yield* runtime.provider.release(key)).toBe(false);
          expect(runtime.calls).toEqual(["tunnel-get", "tunnel-delete"]);
        }),
      ),
  );

  it.effect.each(matrix)(
    "$operation $failure retains one exact uncertain step and blocks all public cleanup",
    ({ operation, failure }) =>
      fixture(
        Effect.gen(function* () {
          const options: {
            failAttempt: Options["failAttempt"];
            malformedCreate: boolean;
            malformedConfiguration: boolean;
            wrongDnsResponse: boolean;
            wrongDnsUpdateResponse: boolean;
            malformedDnsDeletion: boolean;
            malformedTunnelDeletion: boolean;
          } = {
            failAttempt: undefined,
            malformedCreate: false,
            malformedConfiguration: false,
            wrongDnsResponse: false,
            wrongDnsUpdateResponse: false,
            malformedDnsDeletion: false,
            malformedTunnelDeletion: false,
          };
          const runtime = yield* makeRuntime(options);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          let provision = request;
          let teardown: ReturnType<typeof lifecycle.revokeAndRequestCleanup> | undefined;
          if (["dns-update", "dns-delete", "tunnel-delete"].includes(operation)) {
            const initial = yield* ready(runtime);
            if (operation === "dns-update") {
              expect(yield* runtime.provider.release({ ...key, markReleased: true })).toBe(true);
              provision = { ...request, publication: { kind: "recover", ...initial.expectedLink } };
            } else if (operation === "dns-delete")
              teardown = lifecycle.revokeAndRequestCleanup(key);
          }
          const capture = teardown ? yield* teardown : null;
          runtime.calls.length = 0;
          if (failure === "malformed") {
            options.malformedCreate = operation === "tunnel-create";
            options.malformedConfiguration = operation === "tunnel-configure";
            options.wrongDnsResponse = operation === "dns-create";
            options.wrongDnsUpdateResponse = operation === "dns-update";
            options.malformedDnsDeletion = operation === "dns-delete";
            options.malformedTunnelDeletion = operation === "tunnel-delete";
          } else options.failAttempt = { operation, kind: failure };
          const result = Effect.gen(function* () {
            if (operation === "dns-delete")
              yield* runtime.provider.deprovision({ ...key, target: capture!.target });
            else if (operation === "tunnel-delete")
              yield* runtime.provider.release({ ...key, markReleased: true });
            else yield* runtime.provider.provision(provision);
          });
          expect(Exit.isFailure(yield* Effect.exit(result))).toBe(true);
          const failed = yield* lifecycle.get(key);
          expect(failed).toMatchObject({
            lifecycleState: "uncertain",
            pendingMutation: { action: actions[operation] },
          });
          expect(failed?.operationId).toBeTypeOf("string");
          expect(failed?.pendingMutation?.stepId).toBeTypeOf("string");
          expect(runtime.calls.filter((call) => call === operation)).toHaveLength(1);
          expect(
            runtime.calls
              .slice(runtime.calls.indexOf(operation))
              .filter((call) => mutationNames.includes(call)),
          ).toEqual([operation]);
          const beforeContenders = runtime.calls.length;
          // Immediate absence cannot prove the uncertain request is quiescent.
          runtime.tunnelRows.clear();
          runtime.dnsRows.clear();
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(provision)))).toBe(
            true,
          );
          expect(yield* runtime.provider.release(key)).toBe(false);
          expect((yield* runtime.reaper.sweep).attempted).toBe(0);
          const unlink = yield* lifecycle.revokeAndRequestCleanup(key);
          expect(yield* runtime.provider.deprovision({ ...key, target: unlink.target })).toBe(
            false,
          );
          // A late fake resource is still not an authority to adopt, retry or delete.
          if (!failed) throw new Error("Failed allocation missing");
          runtime.tunnelRows.set(failed.tunnelId ?? "late-tunnel", {
            id: failed.tunnelId ?? "late-tunnel",
            name: failed.tunnelName,
            status: "inactive",
            createdAt: "1900-01-01T00:00:00.000Z",
          });
          runtime.dnsRows.set(failed.dnsRecordId ?? "late-dns", {
            id: failed.dnsRecordId ?? "late-dns",
            name: failed.hostname,
            type: "CNAME",
            proxied: true,
            content: `${failed.tunnelId ?? "late-tunnel"}.cfargotunnel.com`,
          });
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(provision)))).toBe(
            true,
          );
          expect((yield* runtime.reaper.sweep).attempted).toBe(0);
          expect(yield* runtime.provider.deprovision({ ...key, target: unlink.target })).toBe(
            false,
          );
          expect(
            runtime.calls.slice(beforeContenders).filter((call) => mutationNames.includes(call)),
          ).toEqual([]);
          expect(yield* lifecycle.get(key)).toMatchObject({
            allocationId: failed.allocationId,
            generation: failed.generation,
            operationId: failed.operationId,
            pendingMutation: failed.pendingMutation,
            lifecycleState: "uncertain",
            cleanupRequested: true,
          });
          const db = yield* RelayDb.RelayDb;
          expect(yield* db.select().from(table)).toHaveLength(1);
        }),
      ),
  );

  it.effect.each([
    "wrong-name",
    "empty-id",
    "duplicate-id",
    "multiple",
    "truncated",
    "changed-total",
    "count-budget",
    "cursor",
  ] as const)(
    "coherent %s tunnel inventory fails before any mutation and preserves foreign resources",
    (kind) =>
      fixture(
        Effect.gen(function* () {
          let reads = 0;
          const runtime = yield* makeRuntime({
            inventory: (input) => {
              reads++;
              const page = input.page ?? 1;
              const total =
                kind === "changed-total"
                  ? page === 1
                    ? 101
                    : 102
                  : kind === "count-budget"
                    ? 1001
                    : kind === "duplicate-id" || kind === "multiple"
                      ? 2
                      : 1;
              const count = Math.min(100, Math.max(0, total - (page - 1) * 100));
              const result = Array.from(
                { length: kind === "truncated" ? 0 : count },
                (_, index) => ({
                  id:
                    kind === "empty-id"
                      ? ""
                      : kind === "duplicate-id"
                        ? "same-id"
                        : `foreign-${page}-${index}`,
                  name:
                    kind === "wrong-name" ? "foreign-name" : (input.name ?? "fixture-inventory"),
                  status: "inactive",
                }),
              );
              return {
                result,
                resultInfo: {
                  page,
                  perPage: 100,
                  count,
                  totalCount: total,
                  totalPages: Math.ceil(total / 100),
                  ...(kind === "cursor" ? { cursor: "more" } : {}),
                },
              };
            },
          });
          runtime.tunnelRows.set("untouched", { id: "untouched", name: "foreign" });
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(request)))).toBe(
            true,
          );
          expect(reads).toBe(kind === "changed-total" ? 2 : 1);
          expect(runtime.calls.every((call) => call === "tunnel-list")).toBe(true);
          expect(runtime.tunnelRows.get("untouched")).toEqual({ id: "untouched", name: "foreign" });
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "idle",
            tunnelId: null,
            pendingMutation: null,
          });
        }),
      ),
  );

  it.effect.each(["wrong-name", "multiple", "malformed", "truncated"] as const)(
    "typed tunnel duplicate gets exactly one %s rediscovery and cannot adopt or delete",
    (kind) =>
      fixture(
        Effect.gen(function* () {
          let reads = 0;
          const runtime = yield* makeRuntime({
            createFailure: "duplicate",
            inventory: (input) => {
              reads++;
              const records =
                reads === 1
                  ? []
                  : Array.from({ length: kind === "multiple" ? 2 : 1 }, (_, index) => ({
                      id: kind === "malformed" ? "" : `candidate-${index}`,
                      name: kind === "wrong-name" ? "foreign" : (input.name ?? "fixture"),
                    }));
              return {
                result: kind === "truncated" && reads === 2 ? [] : records,
                resultInfo: {
                  page: 1,
                  perPage: 100,
                  count: records.length,
                  totalCount: records.length,
                  totalPages: 1,
                },
              };
            },
          });
          runtime.tunnelRows.set("foreign", { id: "foreign", name: "foreign" });
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(request)))).toBe(
            true,
          );
          expect(reads).toBe(2);
          expect(runtime.calls).toEqual(["tunnel-list", "tunnel-create", "tunnel-list"]);
          expect(runtime.tunnelRows.get("foreign")).toEqual({ id: "foreign", name: "foreign" });
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "idle",
            pendingMutation: null,
            tunnelId: null,
          });
        }),
      ),
  );

  it.effect.each(["foreign-target", "multiple", "empty-id", "wrong-name"] as const)(
    "typed DNS duplicate gets one %s rediscovery and leaves foreign records intact",
    (kind) =>
      fixture(
        Effect.gen(function* () {
          let reads = 0;
          const runtime = yield* makeRuntime({
            dnsCreateFailure: "duplicate",
            exactDnsInventory: (hostname) => {
              reads++;
              return reads === 1
                ? []
                : Array.from({ length: kind === "multiple" ? 2 : 1 }, (_, index) => ({
                    id: kind === "empty-id" ? "" : `candidate-${index}`,
                    name: kind === "wrong-name" ? "foreign.test" : hostname,
                    type: "CNAME",
                    content:
                      kind === "foreign-target"
                        ? "foreign.cfargotunnel.com"
                        : "tunnel-1.cfargotunnel.com",
                    proxied: true,
                  }));
            },
          });
          runtime.dnsRows.set("foreign", {
            id: "foreign",
            name: "foreign.test",
            type: "TXT",
            content: "foreign",
            proxied: false,
          });
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(request)))).toBe(
            true,
          );
          expect(reads).toBe(2);
          expect(runtime.calls.filter((op) => op.startsWith("dns"))).toEqual([
            "dns-list",
            "dns-create",
            "dns-list",
          ]);
          expect(runtime.dnsRows.get("foreign")).toEqual({
            id: "foreign",
            name: "foreign.test",
            type: "TXT",
            content: "foreign",
            proxied: false,
          });
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "idle",
            pendingMutation: null,
            dnsRecordId: null,
          });
        }),
      ),
  );

  it.effect(
    "partial teardown checkpoints DNS absence then a joined read failure permits a new explicit retry",
    () =>
      fixture(
        Effect.gen(function* () {
          const options: { failAttempt: Options["failAttempt"] } = { failAttempt: undefined };
          const runtime = yield* makeRuntime(options);
          yield* ready(runtime);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const capture = yield* lifecycle.revokeAndRequestCleanup(key);
          options.failAttempt = { operation: "tunnel-get", kind: "unknown" };
          runtime.calls.length = 0;
          expect(
            Exit.isFailure(
              yield* Effect.exit(runtime.provider.deprovision({ ...key, target: capture.target })),
            ),
          ).toBe(true);
          const partial = yield* lifecycle.get(key);
          expect(partial).toMatchObject({
            lifecycleState: "idle",
            operationId: null,
            pendingMutation: null,
            dnsPresence: "absent",
            tunnelPresence: "recorded",
            cleanupRequested: true,
          });
          expect(runtime.calls).toEqual(["dns-get", "dns-delete", "tunnel-get"]);
          options.failAttempt = undefined;
          const retry = yield* lifecycle.revokeAndRequestCleanup(key);
          runtime.calls.length = 0;
          expect(yield* runtime.provider.deprovision({ ...key, target: retry.target })).toBe(true);
          expect(runtime.calls).toEqual(["tunnel-get", "tunnel-delete"]);
          expect(yield* lifecycle.get(key)).toBeNull();
        }),
      ),
  );

  it.effect(
    "unknown second deletion blocks cleanup and quota until both absences and exact removal",
    () =>
      fixture(
        Effect.gen(function* () {
          const options: { failAttempt: Options["failAttempt"] } = { failAttempt: undefined };
          const runtime = yield* makeRuntime(options);
          yield* ready(runtime);
          for (const environmentId of ["quota-two", "quota-three"])
            yield* runtime.provider.provision({
              userId: key.userId,
              environmentId,
              origin,
              publication: publicationFor(environmentId),
            });
          const fourth = {
            userId: key.userId,
            environmentId: "quota-four",
            origin,
            publication: publicationFor("quota-four"),
          };
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(fourth)))).toBe(true);
          expect(
            yield* runtime.provider.release({
              ...key,
              environmentId: "quota-two",
              markReleased: true,
            }),
          ).toBe(true);
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(fourth)))).toBe(true);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          const capture = yield* lifecycle.revokeAndRequestCleanup(key);
          options.failAttempt = { operation: "tunnel-delete", kind: "unknown" };
          runtime.calls.length = 0;
          expect(
            Exit.isFailure(
              yield* Effect.exit(runtime.provider.deprovision({ ...key, target: capture.target })),
            ),
          ).toBe(true);
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "uncertain",
            dnsPresence: "absent",
            pendingMutation: { action: "delete_tunnel" },
          });
          expect(runtime.calls).toEqual(["dns-get", "dns-delete", "tunnel-get", "tunnel-delete"]);
          options.failAttempt = undefined;
          const retry = yield* lifecycle.revokeAndRequestCleanup(key);
          expect(yield* runtime.provider.deprovision({ ...key, target: retry.target })).toBe(false);
          expect(Exit.isFailure(yield* Effect.exit(runtime.provider.provision(fourth)))).toBe(true);
          // The independent released row can be fully removed by its exact cleanup owner.
          const otherKey = { ...key, environmentId: "quota-two" };
          const removed = yield* lifecycle.revokeAndRequestCleanup(otherKey);
          expect(yield* runtime.provider.deprovision({ ...otherKey, target: removed.target })).toBe(
            true,
          );
          expect((yield* runtime.provider.provision(fourth)).kind).toBe("linked");
          const db = yield* RelayDb.RelayDb;
          expect(yield* db.select().from(table)).toHaveLength(3);
        }),
      ),
  );
});
