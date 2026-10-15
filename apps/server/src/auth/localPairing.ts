// @effect-diagnostics nodeBuiltinImport:off — CLI transport to the existing local server.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { AuthEnvironmentScope, AuthStandardClientScopes } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type * as ServerConfig from "../config.ts";
import { isProcessAlive } from "../serverRuntimeState.ts";
import {
  OPERATOR_ROUTE_PREFIX,
  OPERATOR_TOKEN_HEADER,
  readOperatorToken,
} from "../maintenance/operatorAuth.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

export const LocalPairingInput = Schema.Struct({
  scopes: Schema.NonEmptyArray(AuthEnvironmentScope),
  label: Schema.optionalKey(Schema.String),
  ttlMs: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
});

const LocalPairingResult = Schema.Struct({
  id: Schema.String,
  credential: Schema.String,
  scopes: Schema.Array(AuthEnvironmentScope),
  subject: Schema.String,
  label: Schema.optionalKey(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});

export class LocalPairingError extends Schema.TaggedError<LocalPairingError>()(
  "LocalPairingError",
  {
    stage: Schema.Literals(["discovery", "credential", "request", "response", "server-upgrade"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.stage === "server-upgrade"
      ? "The running Arcwright Code server needs an update before SSH pairing can use its local pairing API."
      : "Could not request pairing from the running Arcwright Code server.";
  }
}

export const serializeLocalPairingLink = (issued: EnvironmentAuth.IssuedPairingLink) => ({
  ...issued,
  createdAt: DateTime.formatIso(issued.createdAt),
  expiresAt: DateTime.formatIso(issued.expiresAt),
});

/** Only an absent/dead server allows offline issuance. A live server's refusal must never open its database. */
const RuntimeState = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Int.check(Schema.isGreaterThan(0)), origin: Schema.String }),
);

const decodeRuntimeState = Schema.decodeEffect(RuntimeState);

export const createLivePairingLink = Effect.fn("auth.createLivePairingLink")(
  function* (
    config: Pick<ServerConfig.ServerConfig["Service"], "baseDir">,
    input: Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["createPairingLink"]>[0],
  ) {
    let target: string | null = null;
    for (const variant of ["userdata", "dev"]) {
      const file = NodePath.join(config.baseDir, variant, "server-runtime.json");
      const text = yield* Effect.tryPromise({
        try: () =>
          NodeFSP.readFile(file, "utf8").catch((cause: unknown) => {
            if (
              typeof cause === "object" &&
              cause !== null &&
              "code" in cause &&
              cause.code === "ENOENT"
            )
              return null;
            throw cause;
          }),
        catch: (cause) => new LocalPairingError({ stage: "discovery", cause }),
      });
      if (text === null) continue;
      const state = yield* decodeRuntimeState(text).pipe(
        Effect.mapError((cause) => new LocalPairingError({ stage: "discovery", cause })),
      );
      if (!isProcessAlive(state.pid)) continue;
      const origin = yield* Effect.try({
        try: () => new URL(state.origin),
        catch: (cause) => new LocalPairingError({ stage: "discovery", cause }),
      });
      if (
        origin.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
        origin.username ||
        origin.password
      )
        return yield* new LocalPairingError({
          stage: "discovery",
          cause: new Error("The local pairing target must be loopback HTTP."),
        });
      target = origin.origin;
      break;
    }
    if (target === null) return Option.none<EnvironmentAuth.IssuedPairingLink>();
    const token = yield* Effect.tryPromise({
      try: () => readOperatorToken(config.baseDir),
      catch: (cause) => new LocalPairingError({ stage: "credential", cause }),
    });
    if (token === null)
      return yield* new LocalPairingError({
        stage: "credential",
        cause: new Error("No local operator credential."),
      });
    const body = {
      scopes: input?.scopes ?? AuthStandardClientScopes,
      ...(input?.label === undefined ? {} : { label: input.label }),
      ...(input?.ttl === undefined ? {} : { ttlMs: Duration.toMillis(input.ttl) }),
    };
    const http = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(`${target}${OPERATOR_ROUTE_PREFIX}pairing`).pipe(
      HttpClientRequest.setHeader(OPERATOR_TOKEN_HEADER, token),
      HttpClientRequest.bodyJson(body),
      Effect.mapError((cause) => new LocalPairingError({ stage: "request", cause })),
    );
    const response = yield* http.execute(request).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError((cause) => new LocalPairingError({ stage: "request", cause })),
    );
    if (response.status < 200 || response.status >= 300)
      return yield* new LocalPairingError({
        stage: response.status === 404 ? "server-upgrade" : "response",
        cause: new Error(`Local pairing HTTP status ${response.status}.`),
      });
    const issued = yield* HttpClientResponse.schemaBodyJson(LocalPairingResult)(response).pipe(
      Effect.mapError((cause) => new LocalPairingError({ stage: "response", cause })),
    );
    return Option.some(issued);
  },
  Effect.scoped,
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
  Effect.provide(FetchHttpClient.layer),
);
