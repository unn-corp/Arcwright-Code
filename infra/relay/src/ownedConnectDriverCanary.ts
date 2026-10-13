import * as Worker from "alchemy/Cloudflare/Workers";
import { Request } from "alchemy/Cloudflare/Workers";
import * as Drizzle from "alchemy/Drizzle/Postgres";
import { sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type {
  EffectPgQueryEffectHKT,
  EffectPgQueryResultHKT,
} from "drizzle-orm/effect-postgres/session";
import type { PgEffectTransaction } from "drizzle-orm/pg-core/effect/session";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import type { SqlError } from "effect/sql/SqlError";
import * as Config from "effect/Config";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const APPROVED_ACCOUNT_ID = "e0fa69f64063aa2670ad354549a34dd6";
export const APPROVED_HYPERDRIVE_ID = "12d94be566e04becba00585b67444d28";
export const CANARY_STAGE = "devotek-driver-canary";
export const CANARY_STACK = "ArcwrightConnectDriverCanary";
export const CANARY_CONTRACT = "arcwright-driver-canary/v1";
export const CANARY_HEADER = "X-Arcwright-Canary-Key";
export const CANARY_UNICODE = "Arcwright — café — 雪 — 🛰";

export const canaryWorkerProps = {
  main: import.meta.url,
  name: "arcwright-connect-driver-canary",
  compatibility: { date: "2026-09-18", flags: [] },
  workersDev: { enabled: true, previewsEnabled: false },
} satisfies Worker.WorkerProps;

export class MalformedCanaryBinding extends Schema.TaggedError<MalformedCanaryBinding>()(
  "MalformedCanaryBinding",
  {},
) {}
class InvalidCanarySecret extends Schema.TaggedError<InvalidCanarySecret>()(
  "InvalidCanarySecret",
  {},
) {}
class CanaryAssertionFailed extends Schema.TaggedError<CanaryAssertionFailed>()(
  "CanaryAssertionFailed",
  {},
) {}
export class IntentionalCanaryRollback extends Schema.TaggedError<IntentionalCanaryRollback>()(
  "IntentionalCanaryRollback",
  {},
) {}
const isIntentionalCanaryRollback = Schema.is(IntentionalCanaryRollback);

export const recoverCanaryRollback = <A, E, R>(transaction: Effect.Effect<A, E, R>) =>
  transaction.pipe(
    Effect.andThen(Effect.fail(new CanaryAssertionFailed())),
    Effect.catchCause((cause: Cause.Cause<unknown>) => {
      const reason = cause.reasons[0];
      return cause.reasons.length === 1 &&
        reason !== undefined &&
        Cause.isFailReason(reason) &&
        isIntentionalCanaryRollback(reason.error)
        ? Effect.void
        : Effect.fail(new CanaryAssertionFailed());
    }),
  );

/** Close the probe scope before producing either response, including failed close. */
export const canaryProbeResponse = <A, E, R>(probe: Effect.Effect<A, E, R>) =>
  probe.pipe(
    Effect.scoped,
    Effect.timeout("15 seconds"),
    Effect.map((receipt) => HttpServerResponse.jsonUnsafe(receipt)),
    Effect.catchCause(() =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "probe_failed" }, { status: 503 })),
    ),
  );

/** Accept canonical unpadded base64url carrying 32–64 random bytes. */
export function validCanaryToken(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43,86}$/.test(value) || value.length % 4 === 1) return false;
  try {
    const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return (
      decoded.length >= 32 &&
      decoded.length <= 64 &&
      btoa(decoded).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") === value
    );
  } catch {
    return false;
  }
}

/** Always compares the validated operator token's fixed length. */
export function canaryTokenMatches(expected: string, supplied: string | null): boolean {
  const candidate = supplied !== null && supplied.length === expected.length ? supplied : "";
  let difference = candidate.length ^ expected.length;
  for (let index = 0; index < expected.length; index++) {
    difference |= expected.charCodeAt(index) ^ (candidate.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export const runtimeConnectionString = Effect.gen(function* () {
  const environment = yield* Worker.WorkerEnvironment;
  return yield* Effect.try({
    try: () => {
      const binding: unknown = environment.ARCWRIGHT_CONNECT_HYPERDRIVE;
      if (typeof binding !== "object" || binding === null || !("connectionString" in binding))
        throw new MalformedCanaryBinding();
      const value: unknown = binding.connectionString;
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 4096 ||
        [...value].some((char) => char.charCodeAt(0) < 32 || /\s/.test(char))
      )
        throw new MalformedCanaryBinding();
      const url = new URL(value);
      if (
        !(url.protocol === "postgres:" || url.protocol === "postgresql:") ||
        !url.hostname ||
        url.pathname.length < 2 ||
        url.hash
      )
        throw new MalformedCanaryBinding();
      return Redacted.make(value);
    },
    catch: () => new MalformedCanaryBinding(),
  });
});

export const makeCanaryHandler = Effect.fnUntraced(function* (secret: Redacted.Redacted<string>) {
  const token = Redacted.value(secret);
  if (!validCanaryToken(token)) return yield* new InvalidCanarySecret();
  const db = yield* Drizzle.Postgres(runtimeConnectionString, undefined, {
    prepare: false,
    maxConnections: 1,
    minConnections: 0,
    connectTimeout: "5 seconds",
  });
  const assert = (condition: boolean) =>
    condition ? Effect.void : Effect.fail(new CanaryAssertionFailed());
  // Installed Drizzle's declaration still imports the pre-rename SqlError path.
  // Restate its original generic contract with the current public type; execution
  // remains the actual lazy proxy's transaction, including its scope and receiver.
  const transaction: <A, E, R>(
    body: (
      tx: PgEffectTransaction<EffectPgQueryEffectHKT, EffectPgQueryResultHKT, EmptyRelations>,
    ) => Effect.Effect<A, E, R>,
    config?: PgTransactionConfig,
  ) => Effect.Effect<A, E | SqlError, R> = db.transaction;
  const rows = <E>(query: Effect.Effect<Record<string, unknown>[], E>) =>
    query.pipe(Effect.catchCause(() => Effect.fail(new CanaryAssertionFailed())));
  const probe = Effect.gen(function* () {
    const identity = (yield* rows(
      db.execute(
        sql`SELECT current_database() AS database, current_user AS role, current_setting('server_version_num') AS server_version_num`,
        "objects",
      ),
    ))[0];
    yield* assert(
      identity?.database === "arcwright_connect" &&
        identity.role === "arcwright_connect_runtime" &&
        typeof identity.server_version_num === "string" &&
        /^[0-9]{5,8}$/.test(identity.server_version_num),
    );
    const unicode = (yield* rows(
      db.execute(sql`SELECT ${CANARY_UNICODE}::text AS value`, "objects"),
    ))[0];
    yield* assert(unicode?.value === CANARY_UNICODE);
    yield* transaction(
      (tx) =>
        Effect.gen(function* () {
          const read = (yield* rows(
            tx.execute(sql`SELECT ${CANARY_UNICODE}::text AS value`, "objects"),
          ))[0];
          const mode = (yield* rows(tx.execute(sql`SHOW transaction_read_only`, "objects")))[0];
          yield* assert(read?.value === CANARY_UNICODE && mode?.transaction_read_only === "on");
        }),
      { accessMode: "read only" },
    ).pipe(Effect.catchCause(() => Effect.fail(new CanaryAssertionFailed())));
    yield* recoverCanaryRollback(
      transaction(
        (tx) =>
          Effect.gen(function* () {
            const read = (yield* rows(
              tx.execute(sql`SELECT ${CANARY_UNICODE}::text AS value`, "objects"),
            ))[0];
            yield* assert(read?.value === CANARY_UNICODE);
            return yield* new IntentionalCanaryRollback();
          }),
        { accessMode: "read only" },
      ),
    );
    const afterRollback = (yield* rows(
      db.execute(sql`SELECT ${CANARY_UNICODE}::text AS value`, "objects"),
    ))[0];
    yield* assert(afterRollback?.value === CANARY_UNICODE);
    return {
      contract: CANARY_CONTRACT,
      database: "arcwright_connect",
      role: "arcwright_connect_runtime",
      serverVersionNum: identity?.server_version_num,
      unicodeRoundTrip: true,
      readCommit: true,
      readRollbackControl: true,
      prepare: false,
    };
  });
  return Effect.gen(function* () {
    const request = yield* Request;
    if (!canaryTokenMatches(token, request.headers.get(CANARY_HEADER)))
      return HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 });
    const path = new URL(request.url).pathname;
    if (path !== "/metadata" && path !== "/probe")
      return HttpServerResponse.jsonUnsafe({ error: "not_found" }, { status: 404 });
    if (path === "/metadata" && request.method === "GET")
      return HttpServerResponse.jsonUnsafe({
        contract: CANARY_CONTRACT,
        build: {
          compatibilityDate: canaryWorkerProps.compatibility.date,
          driver: "alchemy/Drizzle/Postgres",
        },
        prepare: false,
      });
    if (path !== "/probe" || request.method !== "POST")
      return HttpServerResponse.jsonUnsafe({ error: "method_not_allowed" }, { status: 405 });
    return yield* canaryProbeResponse(probe);
  });
});

export class OwnedConnectDriverCanary extends Worker.Worker<
  OwnedConnectDriverCanary,
  {
    fetch: Effect.Effect<HttpServerResponse.HttpServerResponse, never, Request>;
  }
>()("OwnedConnectDriverCanary") {}

export default OwnedConnectDriverCanary.make(
  canaryWorkerProps,
  Effect.gen(function* () {
    const host = yield* Worker.Worker;
    if (!globalThis.__ALCHEMY_RUNTIME__)
      yield* host.bind("OwnedConnectExistingHyperdrive", {
        bindings: [
          { type: "hyperdrive", name: "ARCWRIGHT_CONNECT_HYPERDRIVE", id: APPROVED_HYPERDRIVE_ID },
        ],
      });
    const secret = yield* Config.Redacted("ARCWRIGHT_CONNECT_DRIVER_CANARY_SECRET");
    return { fetch: yield* makeCanaryHandler(secret).pipe(Effect.orDie) };
  }),
);
