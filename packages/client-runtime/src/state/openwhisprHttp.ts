import { OPENWHISPR_TIMEOUT_MS, type OpenWhisprStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { type RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

export const fetchEnvironmentDictationStatus = (
  input: Omit<Parameters<typeof fetchEnvironmentTranscription>[0], "audio">,
) =>
  executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "voice",
    method: "GET",
    url: (urls) => urls.status(),
    timeoutMs: 10_000,
    request: ({ client, headers }) => client.status({ headers }),
  }).pipe(
    Effect.catchTags({
      RemoteEnvironmentAuthUndeclaredStatusError: (error) =>
        // Paired hosts predating discovery still support the existing transcription route.
        error.status === 404 ? Effect.succeed(null) : Effect.fail(error),
    }),
  );

export const fetchEnvironmentTranscription = Effect.fn("clientRuntime.voice.transcribe")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly audio: Uint8Array;
    readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
    readonly remoteAuthorization?: Option.Option<
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
    >;
  }) {
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "voice",
      method: "POST",
      url: (urls) => urls.transcribe(),
      timeoutMs: OPENWHISPR_TIMEOUT_MS + 5_000,
      request: ({ client, headers }) => client.transcribe({ payload: input.audio, headers }),
    });
  },
);

export class OpenWhisprLoader extends Context.Service<
  OpenWhisprLoader,
  {
    readonly status: (
      prepared: PreparedConnection,
    ) => Effect.Effect<OpenWhisprStatus | null, RemoteEnvironmentRequestError>;
    readonly transcribe: (
      prepared: PreparedConnection,
      audio: Uint8Array,
    ) => Effect.Effect<{ readonly text: string }, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/openwhisprHttp/OpenWhisprLoader") {}

export const layer = Layer.effect(
  OpenWhisprLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    return OpenWhisprLoader.of({
      status: Effect.fn("OpenWhisprLoader.status")((prepared: PreparedConnection) =>
        fetchEnvironmentDictationStatus({ prepared, signer, remoteAuthorization }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
      ),
      transcribe: Effect.fn("OpenWhisprLoader.transcribe")(
        (prepared: PreparedConnection, audio: Uint8Array) =>
          fetchEnvironmentTranscription({ prepared, audio, signer, remoteAuthorization }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
          ),
      ),
    });
  }),
);
