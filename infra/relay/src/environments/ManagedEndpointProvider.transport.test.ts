import { describe, expect, it } from "@effect/vitest";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as Alchemy from "alchemy";
import { dnsReadWriteClient } from "alchemy/Cloudflare/DNS";
import type { DnsAuth } from "alchemy/Cloudflare/DNS";
import { readWriteClient } from "alchemy/Cloudflare/Tunnel";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";

import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";

const hostname = "managed.example.test";
const runtimeContext: Alchemy.BaseRuntimeContext = {
  Type: "TransportTest",
  id: "transport-test",
  env: {},
  get: () => Effect.void.pipe(Effect.as(undefined)),
  set: (id) => Effect.succeed(id),
};
const cname = {
  type: "CNAME",
  name: hostname,
  content: "tunnel.cfargotunnel.com",
  ttl: 1,
  proxied: true,
} as const;

function clients(
  respond: (
    request: HttpClientRequest.HttpClientRequest,
    attempt: number,
  ) => Response | "transport-error",
) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const http = HttpClient.make((request) => {
    requests.push(request);
    const response = respond(request, requests.length);
    return response === "transport-error"
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: "intercepted" }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  const auth: DnsAuth = {
    authorize: (effect) =>
      effect.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(
          Credentials.Credentials,
          Effect.succeed(Credentials.apiTokenCredentials({ apiToken: "local-test-token" })),
        ),
      ),
  };
  return {
    requests,
    dns: ManagedEndpointProvider.makeCloudflareDnsClient(
      dnsReadWriteClient(auth, Effect.succeed("zone-id")),
      runtimeContext,
    ),
    tunnels: ManagedEndpointProvider.makeCloudflareTunnelClient(
      readWriteClient({ ...auth, accountId: Effect.succeed("account-id") }),
      runtimeContext,
    ),
  };
}

function json(result: unknown, resultInfo?: unknown): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
  });
}
function record(id: unknown = "dns-id", overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: hostname,
    type: "CNAME",
    content: "foreign.cfargotunnel.com",
    proxied: false,
    ttl: 1,
    created_on: "2026-01-01T00:00:00Z",
    modified_on: "2026-01-01T00:00:00Z",
    meta: {},
    proxiable: true,
    ...overrides,
  };
}
function info(total: number, page = 1) {
  return {
    page,
    per_page: 100,
    count: Math.min(100, Math.max(0, total - (page - 1) * 100)),
    total_count: total,
    total_pages: Math.ceil(total / 100),
  };
}
function url(request: HttpClientRequest.HttpClientRequest) {
  const value = new URL(request.url);
  for (const [key, param] of request.urlParams)
    value.searchParams.append(key, Redacted.isRedacted(param) ? Redacted.value(param) : param);
  return value;
}
const mutations = [
  "tunnel-create",
  "tunnel-configure",
  "tunnel-delete",
  "dns-create",
  "dns-update",
  "dns-delete",
] as const;
const mutationFailures = mutations.flatMap((operation) =>
  (["503", "transport-error"] as const).map((failure) => ({ operation, failure })),
);

function mutate(
  operation: (typeof mutations)[number],
  transport: ReturnType<typeof clients>,
): Effect.Effect<
  unknown,
  | ManagedEndpointProvider.ManagedEndpointTunnelClientError
  | ManagedEndpointProvider.ManagedEndpointDnsClientError
> {
  switch (operation) {
    case "tunnel-create":
      return transport.tunnels.create({ name: "managed-tunnel", configSrc: "cloudflare" });
    case "tunnel-configure":
      return transport.tunnels.putConfiguration("tunnel-id", {
        ingress: [{ service: "http_status:404" }],
      });
    case "tunnel-delete":
      return transport.tunnels.delete("tunnel-id");
    case "dns-create":
      return transport.dns.createRecord(cname);
    case "dns-update":
      return transport.dns.updateRecord("dns-id", cname);
    case "dns-delete":
      return transport.dns.deleteRecord("dns-id");
  }
}

describe("Cloudflare managed endpoint transport", () => {
  it.effect.each(mutationFailures)(
    "makes one HTTP attempt for $operation with $failure through the installed SDK",
    ({ operation, failure }) =>
      Effect.gen(function* () {
        const transport = clients(() =>
          failure === "transport-error"
            ? failure
            : Response.json(
                { success: false, errors: [{ code: 1000, message: "retryable" }] },
                { status: 503 },
              ),
        );
        const result = yield* mutate(operation, transport).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(transport.requests).toHaveLength(1);
        const error = yield* mutateErrorTag(result);
        expect(error).toBe(
          operation.startsWith("tunnel")
            ? "ManagedEndpointTunnelClientError"
            : "ManagedEndpointDnsClientError",
        );
      }),
  );

  it.effect(
    "gets the exact DNS ID and preserves normalized foreign content, type and false proxy state",
    () =>
      Effect.gen(function* () {
        const transport = clients(() =>
          json(record("dns-id", { name: "MANAGED.Example.Test.", type: "TXT", content: null })),
        );
        expect(yield* transport.dns.getRecord("dns-id")).toEqual({
          id: "dns-id",
          name: hostname,
          type: "TXT",
          content: null,
          proxied: false,
        });
        expect(url(transport.requests[0]!).pathname).toBe(
          "/client/v4/zones/zone-id/dns_records/dns-id",
        );
      }),
  );

  it.effect("forwards exact hostname, page and perPage with actual pagination metadata", () =>
    Effect.gen(function* () {
      const transport = clients(() =>
        json([record()], { page: 2, per_page: 5, count: 1, total_count: 6, total_pages: 2 }),
      );
      const response = yield* transport.dns.listRecordsPage({
        hostname: " MANAGED.Example.Test. ",
        page: 2,
        perPage: 5,
      });
      expect(response.records).toEqual([
        {
          id: "dns-id",
          name: hostname,
          type: "CNAME",
          content: "foreign.cfargotunnel.com",
          proxied: false,
        },
      ]);
      expect(response.resultInfo).toEqual({
        page: 2,
        perPage: 5,
        count: 1,
        totalCount: 6,
        totalPages: 2,
      });
      const query = url(transport.requests[0]!).searchParams;
      expect(Object.fromEntries(query)).toEqual({
        "name.exact": hostname,
        page: "2",
        per_page: "5",
      });
      expect(query.has("search")).toBe(false);
    }),
  );

  it.effect.each([
    { name: "missing", metadata: undefined },
    { name: "null", metadata: null },
  ])(
    "preserves $name metadata in page reads and rejects it as a complete inventory",
    ({ metadata }) =>
      Effect.gen(function* () {
        const transport = clients(() => json([], metadata));
        const page = yield* transport.dns.listRecordsPage({ hostname, page: 1, perPage: 100 });
        expect(page.resultInfo).toBe(metadata);
        expect(Object.hasOwn(page, "resultInfo")).toBe(metadata !== undefined);
        const failure = yield* transport.dns.listExactRecords(hostname).pipe(Effect.flip);
        expect(failure.operation).toBe("list-exact-records");
        expect(transport.requests).toHaveLength(2);
      }),
  );

  it.effect.each([0, 1])(
    "returns complete empty inventory with totalPages=%s in one read",
    (totalPages) =>
      Effect.gen(function* () {
        const transport = clients(() => json([], { ...info(0), total_pages: totalPages }));
        expect(yield* transport.dns.listExactRecords(hostname)).toEqual([]);
        expect(transport.requests).toHaveLength(1);
      }),
  );

  it.effect("collects every indicated page before returning a complete inventory", () =>
    Effect.gen(function* () {
      const transport = clients((_request, page) =>
        json(
          Array.from({ length: page === 1 ? 100 : 1 }, (_, index) =>
            record(`dns-${(page - 1) * 100 + index}`),
          ),
          info(101, page),
        ),
      );
      const records = yield* transport.dns.listExactRecords(hostname);
      expect(records).toHaveLength(101);
      expect(records[100]?.id).toBe("dns-100");
      expect(transport.requests.map((request) => url(request).searchParams.get("page"))).toEqual([
        "1",
        "2",
      ]);
    }),
  );

  it.effect.each([
    { name: "missing totalPages", totalPages: undefined, total: 0 },
    { name: "null totalPages", totalPages: null, total: 0 },
    { name: "missing totalPages", totalPages: undefined, total: 101 },
    { name: "null totalPages", totalPages: null, total: 101 },
  ])(
    "derives complete $total-record inventory with $name from totalCount",
    ({ total, totalPages }) =>
      Effect.gen(function* () {
        const transport = clients((_request, page) =>
          json(
            Array.from(
              { length: Math.min(100, Math.max(0, total - (page - 1) * 100)) },
              (_, index) => record(`dns-${(page - 1) * 100 + index}`),
            ),
            { ...info(total, page), total_pages: totalPages },
          ),
        );
        expect(yield* transport.dns.listExactRecords(hostname)).toHaveLength(total);
        expect(transport.requests).toHaveLength(total === 0 ? 1 : 2);
      }),
  );

  it.effect.each([
    { name: "empty id", response: record("") },
    { name: "missing id", response: record("dns-id", { id: undefined }) },
    { name: "numeric id", response: record(123) },
    { name: "whitespace id", response: record("dns id") },
    { name: "overlong id", response: record("x".repeat(257)) },
    { name: "invalid name", response: record("dns-id", { name: "bad/name" }) },
    { name: "missing name", response: record("dns-id", { name: undefined }) },
    { name: "invalid type", response: record("dns-id", { type: "" }) },
    { name: "missing type", response: record("dns-id", { type: undefined }) },
  ])("rejects malformed required DNS identity: $name", ({ response }) =>
    Effect.gen(function* () {
      const transport = clients(() => json([response], info(1)));
      const failure = yield* transport.dns
        .listRecordsPage({ hostname, page: 1, perPage: 100 })
        .pipe(Effect.flip);
      expect(failure._tag).toBe("ManagedEndpointDnsClientError");
      expect(failure.operation).toBe("list-records-page");
    }),
  );

  it.effect("rejects a wrong name in an exact result instead of hiding it as absence", () =>
    Effect.gen(function* () {
      const transport = clients(() =>
        json([record("foreign-id", { name: "other.example.test" })], info(1)),
      );
      const failure = yield* transport.dns.listExactRecords(hostname).pipe(Effect.flip);
      expect(failure.operation).toBe("list-exact-records");
      expect(transport.requests).toHaveLength(1);
    }),
  );

  it.effect.each([
    { name: "missing count", metadata: { ...info(1), count: undefined } },
    { name: "null total", metadata: { ...info(1), total_count: null } },
    { name: "missing perPage", metadata: { ...info(1), per_page: undefined } },
    { name: "wrong page", metadata: { ...info(1), page: 2 } },
    { name: "nonfinite count", metadata: { ...info(1), count: Infinity } },
    { name: "fractional count", metadata: { ...info(1), count: 1.5 } },
    { name: "negative count", metadata: { ...info(1), count: -1 } },
    { name: "wrong perPage", metadata: { ...info(1), per_page: 99 } },
    { name: "wrong count", metadata: { ...info(1), count: 0 } },
    { name: "inconsistent derived pages", metadata: { ...info(1), total_pages: 2 } },
    { name: "cursor pagination", metadata: { ...info(1), cursor: "next" } },
  ])("fails closed for $name metadata", ({ metadata }) =>
    Effect.gen(function* () {
      const transport = clients(() => json([record()], metadata));
      const failure = yield* transport.dns.listExactRecords(hostname).pipe(Effect.flip);
      expect(failure.operation).toBe("list-exact-records");
      expect(transport.requests).toHaveLength(1);
    }),
  );

  it.effect(
    "rejects an otherwise coherent inventory beyond the record and page budgets in one read",
    () =>
      Effect.gen(function* () {
        const transport = clients(() =>
          json(
            Array.from({ length: 100 }, (_, index) => record(`dns-${index}`)),
            info(1001),
          ),
        );
        const failure = yield* transport.dns.listExactRecords(hostname).pipe(Effect.flip);
        expect(failure.operation).toBe("list-exact-records");
        expect(transport.requests).toHaveLength(1);
      }),
  );

  it.effect("allows the exact 1000-record budget in ten complete pages", () =>
    Effect.gen(function* () {
      const transport = clients((_request, page) =>
        json(
          Array.from({ length: 100 }, (_, index) => record(`dns-${(page - 1) * 100 + index}`)),
          info(1000, page),
        ),
      );
      const records = yield* transport.dns.listExactRecords(hostname);
      expect(records).toHaveLength(1000);
      expect(records[0]?.id).toBe("dns-0");
      expect(records[999]?.id).toBe("dns-999");
      expect(transport.requests).toHaveLength(10);
    }),
  );

  it.effect.each(["duplicate-id", "changed-totals", "overlong-page"] as const)(
    "rejects %s inventories",
    (scenario) =>
      Effect.gen(function* () {
        const transport = clients((_request, page) => {
          const size =
            scenario === "overlong-page"
              ? 101
              : page === 1
                ? 100
                : scenario === "changed-totals"
                  ? 2
                  : 1;
          return json(
            Array.from({ length: size }, (_, index) =>
              record(`dns-${scenario === "duplicate-id" ? index : (page - 1) * 100 + index}`),
            ),
            info(scenario === "changed-totals" && page === 2 ? 102 : 101, page),
          );
        });
        const failure = yield* transport.dns.listExactRecords(hostname).pipe(Effect.flip);
        expect(failure.operation).toBe("list-exact-records");
        expect(transport.requests).toHaveLength(scenario === "overlong-page" ? 1 : 2);
      }),
  );

  it.effect.each(["", "http://managed.example.test", "a..example.test", "-bad.example.test"])(
    "rejects invalid query hostname %s before any HTTP request",
    (invalid) =>
      Effect.gen(function* () {
        const transport = clients(() => json([], info(0)));
        const failure = yield* transport.dns.listExactRecords(invalid).pipe(Effect.flip);
        expect(failure.operation).toBe("list-exact-records");
        expect(transport.requests).toHaveLength(0);
      }),
  );

  it.effect("keeps the legacy search/filter lookup to one page without mutations", () =>
    Effect.gen(function* () {
      const transport = clients(() =>
        json([record(), record("other", { name: "other.example.test" })], info(200)),
      );
      const records = yield* transport.dns.listRecords(hostname);
      expect(records.map((item) => item.id)).toEqual(["dns-id"]);
      expect(transport.requests).toHaveLength(1);
      expect(transport.requests[0]?.method).toBe("GET");
      expect(Object.fromEntries(url(transport.requests[0]!).searchParams)).toEqual({
        search: hostname,
      });
    }),
  );
  it.effect.each(["create", "update"] as const)(
    "retains the full decoded DNS $0 success identity",
    (operation) =>
      Effect.gen(function* () {
        const transport = clients(() =>
          json(record("dns-id", { content: cname.content, proxied: true })),
        );
        const response = yield* operation === "create"
          ? transport.dns.createRecord(cname)
          : transport.dns.updateRecord("dns-id", cname);
        expect(response).toEqual({
          id: "dns-id",
          name: hostname,
          type: "CNAME",
          content: cname.content,
          proxied: true,
        });
        expect(transport.requests).toHaveLength(1);
      }),
  );
  it.effect.each(["create", "update"] as const)(
    "rejects incomplete DNS $0 success through the installed SDK",
    (operation) =>
      Effect.gen(function* () {
        const transport = clients(() => json({ id: "dns-id" }));
        const failure = yield* (
          operation === "create"
            ? transport.dns.createRecord(cname)
            : transport.dns.updateRecord("dns-id", cname)
        ).pipe(Effect.flip);
        expect(failure.operation).toBe(operation === "create" ? "create-record" : "update-record");
        expect(transport.requests).toHaveLength(1);
      }),
  );
  it.effect(
    "normalizes tunnel inventory metadata and configure/delete acknowledgement identities through public Alchemy bindings",
    () =>
      Effect.gen(function* () {
        const transport = clients((request) =>
          request.method === "GET"
            ? json([{ id: "tunnel-id", name: "managed-tunnel" }], info(1))
            : request.method === "PUT"
              ? json({
                  tunnel_id: "tunnel-id",
                  config: { ingress: [{ service: "http_status:404" }] },
                })
              : json({
                  id: "tunnel-id",
                  name: "managed-tunnel",
                  deleted_at: "2026-10-13T00:00:00.000Z",
                }),
        );
        const inventory = yield* transport.tunnels.list({
          isDeleted: false,
          name: "managed-tunnel",
          page: 1,
          perPage: 100,
        });
        expect(inventory.resultInfo).toEqual({
          page: 1,
          perPage: 100,
          count: 1,
          totalCount: 1,
          totalPages: 1,
        });
        expect(
          yield* transport.tunnels.putConfiguration("tunnel-id", {
            ingress: [{ service: "http_status:404" }],
          }),
        ).toMatchObject({
          tunnelId: "tunnel-id",
          config: { ingress: [{ service: "http_status:404" }] },
        });
        expect(yield* transport.tunnels.delete("tunnel-id")).toMatchObject({
          id: "tunnel-id",
          name: "managed-tunnel",
          deletedAt: "2026-10-13T00:00:00.000Z",
        });
        expect(transport.requests).toHaveLength(3);
      }),
  );
});

function mutateErrorTag<A>(
  result: Exit.Exit<
    A,
    | ManagedEndpointProvider.ManagedEndpointTunnelClientError
    | ManagedEndpointProvider.ManagedEndpointDnsClientError
  >,
) {
  return Exit.isFailure(result)
    ? Effect.failCause(result.cause).pipe(
        Effect.flip,
        Effect.map((error) => error._tag),
      )
    : Effect.die("Expected terminal failure");
}
