import { expect, it } from "@effect/vitest";
import * as NodeURL from "node:url";
import * as Alchemy from "alchemy";
import * as Workers from "@alchemy.run/cloudflare/Workers";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Artifacts from "alchemy/Artifacts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Provider from "alchemy/Provider";
import * as Output from "alchemy/Output";
import * as Context from "effect/Context";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { makeWithTransaction } from "effect/sql/SqlClient";
import { State } from "alchemy/State";
import { inMemoryState } from "alchemy/State";
import { ProfileStore } from "alchemy/Auth/Profile";
import { CredentialsStore } from "alchemy/Auth/Credentials";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Request } from "@alchemy.run/cloudflare/Workers";
import { driverCanaryStackBody } from "./owned-connect-driver-canary-stack.ts";
import { readDriverCanaryConfig } from "./owned-connect-driver-canary-config.ts";
import {
  APPROVED_ACCOUNT_ID,
  APPROVED_HYPERDRIVE_ID,
  CANARY_CONTRACT,
  CANARY_HEADER,
  CANARY_STACK,
  CANARY_STAGE,
  canaryWorkerProps,
  canaryTokenMatches,
  makeCanaryHandler,
  runtimeConnectionString,
  validCanaryToken,
  IntentionalCanaryRollback,
  recoverCanaryRollback,
  canaryProbeResponse,
} from "../src/ownedConnectDriverCanary.ts";

const TOKEN = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
class CanaryFixtureFailure extends Schema.TaggedError<CanaryFixtureFailure>()(
  "CanaryFixtureFailure",
  {},
) {}

function executionOwner() {
  const pending: Promise<unknown>[] = [];
  let rejected = 0;
  // Workers v5 adds context fields absent in v4; both accept this fixture structurally.
  const context = {
    props: {},
    exports: {},
    get tracing(): never {
      throw new CanaryFixtureFailure();
    },
    abort: () => {
      throw new CanaryFixtureFailure();
    },
    passThroughOnException: () => {},
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
      void promise.catch(() => {
        rejected++;
      });
    },
  };
  const execution = Workers.fromExecutionContext(context);
  const runtime = RuntimeContext.of({
    Type: "CanaryTest",
    id: "CanaryTest",
    env: {},
    get: () => Effect.void.pipe(Effect.as(undefined)),
    set: () => Effect.die(new CanaryFixtureFailure()),
  });
  return { pending, execution, runtime, rejected: () => rejected };
}
const provideOwner =
  (owner: ReturnType<typeof executionOwner>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Workers.WorkerExecutionContext, owner.execution),
      Effect.provideService(RuntimeContext, owner.runtime),
    );

it.effect(
  "hands masked BEGIN/COMMIT/ROLLBACK and stalled finalizers to the registered event owner",
  () =>
    Effect.gen(function* () {
      for (const phase of ["begin", "commit", "rollback", "scope-finalizer"]) {
        const owner = executionOwner();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let completed = false;
        const stall = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(
            Effect.sync(() => {
              completed = true;
            }),
          ),
        );
        const transaction = makeWithTransaction({
          transactionService: Context.Service<readonly [{ readonly fixture: true }, number]>(
            `canary-control-${phase}`,
          ),
          spanAttributes: [],
          acquireConnection: Effect.succeed([undefined, { fixture: true }]),
          begin: () => (phase === "begin" ? stall : Effect.void),
          commit: () => (phase === "commit" ? stall : Effect.void),
          rollback: () => (phase === "rollback" ? stall : Effect.void),
          savepoint: () => Effect.void,
          rollbackSavepoint: () => Effect.void,
        });
        const probe =
          phase === "scope-finalizer"
            ? Effect.acquireRelease(Effect.succeed({ fixture: true }), () => stall)
            : transaction(
                phase === "rollback"
                  ? Effect.fail(new CanaryFixtureFailure())
                  : Effect.succeed({ fixture: true }),
              );
        const response = yield* canaryProbeResponse(probe).pipe(
          Effect.provideService(Workers.WorkerExecutionContext, owner.execution),
          Effect.provideService(RuntimeContext, owner.runtime),
          Effect.forkScoped,
        );
        yield* Deferred.await(entered);
        expect(owner.pending).toHaveLength(1);
        yield* TestClock.adjust("15 seconds");
        expect((yield* Fiber.join(response)).status).toBe(503);
        expect(completed).toBe(false);
        expect(owner.pending).toHaveLength(2);
        yield* Deferred.succeed(release, undefined);
        const endings = yield* Effect.promise(() => Promise.allSettled(owner.pending));
        expect(endings.every((ending) => ending.status === "fulfilled")).toBe(true);
        expect(completed).toBe(true);
        expect(owner.rejected()).toBe(0);
      }
    }),
);

it.effect("keeps cleanup registered when the waiting HTTP fiber is interrupted", () =>
  Effect.gen(function* () {
    const owner = executionOwner();
    const entered = yield* Deferred.make<void>();
    const closing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let finalized = false;
    const probe = Effect.acquireRelease(Effect.void, () =>
      Deferred.succeed(closing, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(
          Effect.sync(() => {
            finalized = true;
          }),
        ),
      ),
    ).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Effect.never));
    const response = yield* canaryProbeResponse(probe).pipe(provideOwner(owner), Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(response);
    yield* Deferred.await(closing);
    expect(owner.pending).toHaveLength(2);
    expect(finalized).toBe(false);
    yield* Deferred.succeed(release, undefined);
    const endings = yield* Effect.promise(() => Promise.allSettled(owner.pending));
    expect(endings.every((ending) => ending.status === "fulfilled")).toBe(true);
    expect(finalized).toBe(true);
    expect(owner.rejected()).toBe(0);
  }),
);

it.effect(
  "recovers only completed intentional rollback and rejects unexpected or mixed failures",
  () =>
    Effect.gen(function* () {
      let finalized = false;
      yield* recoverCanaryRollback(
        Effect.fail(new IntentionalCanaryRollback()).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
      );
      expect(finalized).toBe(true);
      const unexpected: Array<
        Effect.Effect<void, CanaryFixtureFailure | IntentionalCanaryRollback>
      > = [
        Effect.void,
        Effect.fail(new CanaryFixtureFailure()),
        Effect.fail(new IntentionalCanaryRollback()).pipe(
          Effect.ensuring(Effect.die(new CanaryFixtureFailure())),
        ),
      ];
      for (const transaction of unexpected)
        expect((yield* recoverCanaryRollback(transaction).pipe(Effect.exit))._tag).toBe("Failure");
    }),
);

it.effect(
  "finishes scope finalizers before a receipt and converts failed finalizers to fixed 503",
  () =>
    Effect.gen(function* () {
      const owner = executionOwner();
      let finalized = false;
      const successful = yield* canaryProbeResponse(
        Effect.acquireRelease(Effect.succeed({ contract: CANARY_CONTRACT }), () =>
          Effect.sync(() => {
            finalized = true;
          }),
        ),
      ).pipe(provideOwner(owner));
      expect(successful.status).toBe(200);
      expect(finalized).toBe(true);
      const failed = yield* canaryProbeResponse(
        Effect.acquireRelease(Effect.succeed({ contract: CANARY_CONTRACT }), () =>
          Effect.die(new CanaryFixtureFailure()),
        ),
      ).pipe(provideOwner(owner));
      expect(failed.status).toBe(503);
    }),
);

it("bounds canonical token format and compares the fixed expected length", () => {
  expect(validCanaryToken(TOKEN)).toBe(true);
  for (const bad of ["", "a".repeat(42), "a".repeat(87), "=".repeat(43), TOKEN.slice(0, -1) + "_"])
    expect(validCanaryToken(bad)).toBe(false);
  expect(canaryTokenMatches(TOKEN, TOKEN)).toBe(true);
  for (const bad of [null, "", "wrong", "a".repeat(10000), "B" + TOKEN.slice(1)])
    expect(canaryTokenMatches(TOKEN, bad)).toBe(false);
});

it.effect("actual Drizzle construction, auth and metadata do not read the runtime binding", () =>
  Effect.gen(function* () {
    const owner = executionOwner();
    let bindingReads = 0;
    let connectionReads = 0;
    const environment = {
      get ARCWRIGHT_CONNECT_HYPERDRIVE() {
        bindingReads++;
        return {
          get connectionString() {
            connectionReads++;
            return "invalid-fixture";
          },
        };
      },
    };
    const handler = yield* makeCanaryHandler(Redacted.make(TOKEN));
    expect(bindingReads).toBe(0);
    for (const [method, path, token, expected] of [
      ["POST", "/probe", undefined, 401],
      ["POST", "/probe", "wrong", 401],
      ["GET", "/metadata", TOKEN, 200],
      ["GET", "/other", TOKEN, 404],
      ["GET", "/probe", TOKEN, 405],
    ] satisfies Array<[string, string, string | undefined, number]>) {
      const headers = token === undefined ? {} : { [CANARY_HEADER]: token };
      const response = yield* handler.pipe(
        Effect.provideService(
          Request,
          new globalThis.Request(`https://fixture.invalid${path}`, { method, headers }),
        ),
        Effect.provideService(Workers.WorkerEnvironment, environment),
        provideOwner(owner),
        Effect.scoped,
      );
      expect(response.status).toBe(expected);
    }
    expect(bindingReads).toBe(0);
    expect(connectionReads).toBe(0);
    const failed = yield* handler.pipe(
      Effect.provideService(
        Request,
        new globalThis.Request("https://fixture.invalid/probe", {
          method: "POST",
          headers: { [CANARY_HEADER]: TOKEN },
        }),
      ),
      Effect.provideService(Workers.WorkerEnvironment, environment),
      provideOwner(owner),
      Effect.scoped,
    );
    expect(failed.status).toBe(503);
    expect(bindingReads).toBe(1);
    expect(connectionReads).toBe(1);
  }),
);

it.effect(
  "validates unknown connection bindings with fixed typed failures and preserves proxy URLs",
  () =>
    Effect.gen(function* () {
      for (const binding of [
        undefined,
        null,
        {},
        { connectionString: 7 },
        { connectionString: "" },
        { connectionString: "https://credential-bearing-fixture.invalid/db" },
        { connectionString: "postgres://fixture@host/" },
        { connectionString: "postgres://fixture@host/db#fragment" },
      ]) {
        const error = yield* runtimeConnectionString.pipe(
          Effect.provideService(Workers.WorkerEnvironment, {
            ARCWRIGHT_CONNECT_HYPERDRIVE: binding,
          }),
          Effect.flip,
        );
        expect(error._tag).toBe("MalformedCanaryBinding");
        expect(Object.keys(error)).not.toContain("cause");
      }
      const proxyUrl = "postgres://fixture:fixture@192.0.2.1:5432/fixture?sslmode=require";
      const result = yield* runtimeConnectionString.pipe(
        Effect.provideService(Workers.WorkerEnvironment, {
          ARCWRIGHT_CONNECT_HYPERDRIVE: { connectionString: proxyUrl },
        }),
      );
      expect(Redacted.value(result)).toBe(proxyUrl);
    }),
);

it.effect(
  "requires five explicit pinned public fields and a separate private nonsymlink state root",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        directory: "/tmp",
        prefix: "arcwright-config-",
      });
      const state = path.join(root, "driver-canary/alchemy");
      yield* fs.makeDirectory(state, { recursive: true, mode: 0o700 });
      const file = path.join(root, "operator-config.json");
      const approved = {
        accountId: APPROVED_ACCOUNT_ID,
        hyperdriveId: APPROVED_HYPERDRIVE_ID,
        workerName: canaryWorkerProps.name,
        stage: CANARY_STAGE,
        privateStateRoot: state,
      };
      for (const value of [
        approved,
        { ...approved, token: TOKEN },
        Object.fromEntries(Object.entries(approved).filter(([key]) => key !== "hyperdriveId")),
        { ...approved, accountId: "0".repeat(32) },
        { ...approved, hyperdriveId: "0".repeat(32) },
        { ...approved, workerName: "foreign" },
        { ...approved, stage: "prod" },
        { ...approved, privateStateRoot: "relative" },
      ]) {
        yield* fs.writeFileString(file, JSON.stringify(value), { mode: 0o600 });
        const exit = yield* readDriverCanaryConfig(file).pipe(Effect.exit);
        expect(exit._tag).toBe(value === approved ? "Success" : "Failure");
      }
      yield* fs.writeFileString(file, JSON.stringify(approved), { mode: 0o600 });
      yield* fs.chmod(state, 0o755);
      expect((yield* readDriverCanaryConfig(file).pipe(Effect.exit))._tag).toBe("Failure");
      yield* fs.chmod(state, 0o700);
      const linkedParent = path.join(root, "linked-parent");
      yield* fs.symlink(path.join(root, "driver-canary"), linkedParent);
      yield* fs.writeFileString(
        file,
        JSON.stringify({
          ...approved,
          privateStateRoot: path.join(linkedParent, "driver-canary/alchemy"),
        }),
        { mode: 0o600 },
      );
      expect((yield* readDriverCanaryConfig(file).pipe(Effect.exit))._tag).toBe("Failure");
      yield* fs.writeFileString(file, JSON.stringify(approved), { mode: 0o600 });
      const link = path.join(root, "symlink-config.json");
      yield* fs.symlink(file, link);
      expect((yield* readDriverCanaryConfig(link).pipe(Effect.exit))._tag).toBe("Failure");
      expect((yield* readDriverCanaryConfig("relative").pipe(Effect.exit))._tag).toBe("Failure");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "compiles one genuine Worker with only the approved native binding and redacted config",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        directory: "/tmp",
        prefix: "arcwright-graph-",
      });
      let authIo = 0;
      const forbiddenAuthIo = Effect.sync(() => {
        authIo++;
      }).pipe(Effect.andThen(Effect.die(new CanaryFixtureFailure())));
      const providers = Layer.effect(
        Cloudflare.Providers,
        Provider.collection([Workers.Worker]),
      ).pipe(
        Layer.provide(Workers.LiveWorkerProvider()),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              Cloudflare.CloudflareEnvironment,
              Effect.succeed({
                type: "apiToken",
                apiToken: Redacted.make("synthetic-offline-not-a-credential"),
                accountId: "0".repeat(32),
                source: { type: "env" },
              }),
            ),
            Layer.succeed(Cloudflare.Credentials, forbiddenAuthIo),
          ),
        ),
        Layer.orDie,
      );
      const stack = Alchemy.Stack(
        CANARY_STACK,
        { providers, state: inMemoryState() },
        driverCanaryStackBody,
      );
      const blockedCredentials: CredentialsStore["Service"] = {
        read: () => forbiddenAuthIo,
        write: () => forbiddenAuthIo,
        delete: () => forbiddenAuthIo,
        deleteProfile: () => forbiddenAuthIo,
        scoped: () => blockedCredentials,
      };
      const compiled = yield* stack.pipe(
        Effect.provideService(Alchemy.Stage, CANARY_STAGE),
        Effect.provideService(AlchemyContext, {
          dotAlchemy: root,
          dev: false,
          adopt: false,
          updateStateStore: false,
        }),
        Effect.provideService(Artifacts.ArtifactStore, Artifacts.createArtifactStore()),
        Effect.provideService(AuthProviders, {}),
        Effect.provideService(CredentialsStore, blockedCredentials),
        Effect.provideService(ProfileStore, {
          readManifest: forbiddenAuthIo,
          current: forbiddenAuthIo,
          getProfile: () => forbiddenAuthIo,
          ensureProfile: () => forbiddenAuthIo,
          createProfile: () => forbiddenAuthIo,
          renameProfile: () => forbiddenAuthIo,
          setProviderConfig: () => forbiddenAuthIo,
          deleteProviderConfig: () => forbiddenAuthIo,
          deleteProfile: () => forbiddenAuthIo,
          loadProviderConfig: () => forbiddenAuthIo,
        }),
        Effect.provideService(
          Cloudflare.CloudflareEnvironment,
          Effect.succeed({
            type: "apiToken",
            apiToken: Redacted.make("synthetic-offline-not-a-credential"),
            accountId: "0".repeat(32),
            source: { type: "env" },
          }),
        ),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ ARCWRIGHT_CONNECT_DRIVER_CANARY_SECRET: TOKEN }),
          ),
        ),
      );
      expect(Object.keys(compiled.resources)).toEqual(["OwnedConnectDriverCanary"]);
      expect(Object.keys(compiled.actions)).toEqual([]);
      const worker = compiled.resources.OwnedConnectDriverCanary;
      expect(worker?.Type).toBe("Cloudflare.Worker");
      expect(compiled.bindings).toEqual({
        OwnedConnectDriverCanary: [
          {
            sid: "OwnedConnectExistingHyperdrive",
            data: {
              bindings: [
                {
                  type: "hyperdrive",
                  name: "ARCWRIGHT_CONNECT_HYPERDRIVE",
                  id: APPROVED_HYPERDRIVE_ID,
                },
              ],
            },
          },
        ],
      });
      expect(compiled.output.contract).toBe(CANARY_CONTRACT);
      expect(worker?.Props).toMatchObject({
        ...canaryWorkerProps,
        main: path.relative(process.cwd(), NodeURL.fileURLToPath(canaryWorkerProps.main)),
      });
      expect(Object.keys(worker?.Props ?? {}).sort()).toEqual([
        "compatibility",
        "env",
        "exports",
        "main",
        "name",
        "workersDev",
      ]);
      // Auto-bound runtime config is an Output carrying Redacted, never a props token literal.
      expect(JSON.stringify(worker?.Props)).not.toContain(TOKEN);
      const props: unknown = yield* Output.evaluate(worker?.Props, {}).pipe(
        Effect.provideService(State, Context.get(compiled.services, State)),
      );
      if (
        typeof props !== "object" ||
        props === null ||
        !("env" in props) ||
        typeof props.env !== "object" ||
        props.env === null
      )
        return yield* new CanaryFixtureFailure();
      expect(Object.keys(props.env)).toEqual(["ARCWRIGHT_CONNECT_DRIVER_CANARY_SECRET"]);
      const exports: unknown = "exports" in props ? props.exports : undefined;
      if (typeof exports !== "object" || exports === null) return yield* new CanaryFixtureFailure();
      expect(Object.keys(exports)).toEqual(["default"]);
      expect(
        "ARCWRIGHT_CONNECT_DRIVER_CANARY_SECRET" in props.env &&
          Redacted.isRedacted(props.env.ARCWRIGHT_CONNECT_DRIVER_CANARY_SECRET),
      ).toBe(true);
      expect(authIo).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
