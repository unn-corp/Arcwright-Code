// @effect-diagnostics nodeBuiltinImport:off -- Independent process and native filesystem probes verify cross-process exclusion.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeUtil from "node:util";
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import { afterEach, vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import {
  readPendingRemoteCleanup,
  rememberPendingRemoteCleanup,
  clearMatchingPendingRemoteCleanup,
} from "./pendingRemoteCleanup.ts";

const observation = vi.hoisted(() => ({
  contended: (_path: string) => {},
  releaseFailurePath: "",
}));
// All filesystem calls and lock decisions remain real; observe the exclusive mkdir milestone.
vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("proper-lockfile")>();
  const fs = await import("node:fs");
  return {
    ...actual,
    lock: (file: string, options?: import("proper-lockfile").LockOptions) =>
      actual.lock(file, {
        ...options,
        fs: {
          ...fs,
          mkdir: ((
            name: NodeFS.PathLike,
            callback: (error: NodeJS.ErrnoException | null) => void,
          ) =>
            fs.mkdir(name, (error) => {
              if (error?.code === "EEXIST") observation.contended(String(name));
              callback(error);
            })) as typeof fs.mkdir,
          rmdir: ((
            name: NodeFS.PathLike,
            callback: (error: NodeJS.ErrnoException | null) => void,
          ) => {
            if (String(name) === observation.releaseFailurePath) {
              callback(Object.assign(new Error("fixture-denied-release"), { code: "EACCES" }));
            } else fs.rmdir(name, callback);
          }) as typeof fs.rmdir,
        },
      }),
  };
});
afterEach(() => {
  observation.contended = () => {};
  observation.releaseFailurePath = "";
});
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const lockModule = NodeModule.createRequire(import.meta.url).resolve("proper-lockfile");
const first = { relayUrl: "https://selected.example.test", environmentId: "env-one" };
const second = { relayUrl: "https://foreign.example.test", environmentId: "env-one" };
const publicFile = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(
    path.dirname(config.serverRuntimeStatePath),
    "connect-pending-remote-cleanup.json",
  );
});
const probe = (file: string) =>
  Effect.promise(async () => {
    const { stdout } = await execFile(process.execPath, [
      "-e",
      `
    const { lock } = require(process.argv[1]);
    lock(process.argv[2], {realpath: false, stale: Infinity, update: 1000, retries: 0}).then(async release => {
      await release(); process.stdout.write('acquired');
    }, error => {
      if (error.code === 'ELOCKED') process.stdout.write('blocked');
      else { process.stderr.write('probe failed'); process.exitCode = 1; }
    });
  `,
      lockModule,
      file,
    ]);
    return stdout;
  });

it.live.each(["clear", "append"] as const)(
  "serializes a paused %s and an unrelated append across the complete real-file transaction",
  (operation) =>
    Effect.gen(function* () {
      if (operation === "clear") yield* rememberPendingRemoteCleanup(first);
      const fs = yield* FileSystem.FileSystem;
      const file = yield* publicFile;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const contended = Promise.withResolvers<void>();
      observation.contended = (name) => {
        if (name === `${file}.lock`) contended.resolve();
      };
      const heldFs = {
        ...fs,
        rename: (from: string, to: string) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            yield* fs.rename(from, to);
          }),
      };
      const clearing = yield* (
        operation === "clear"
          ? clearMatchingPendingRemoteCleanup(first).pipe(Effect.asVoid)
          : rememberPendingRemoteCleanup(first)
      ).pipe(Effect.provideService(FileSystem.FileSystem, heldFs), Effect.forkScoped);
      yield* Deferred.await(entered);
      const adding = yield* rememberPendingRemoteCleanup(second).pipe(Effect.forkScoped);
      // Without transaction locking B completes before A's stale rename and its reference is lost.
      yield* Effect.raceFirst(
        Effect.promise(() => contended.promise),
        Fiber.join(adding),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(clearing);
      yield* Fiber.join(adding);
      const references = yield* readPendingRemoteCleanup;
      assert.deepEqual(
        references.map((reference) => reference.relayOrigin).sort(),
        operation === "clear" ? [second.relayUrl] : [second.relayUrl, first.relayUrl].sort(),
      );
      assert.isFalse(yield* fs.exists(`${file}.lock`));
    }).pipe(Effect.scoped, Effect.provide(fixture)),
);

it.live("excludes a different Node process during the write and releases after success", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* publicFile;
    let checked = false;
    const checkingFs = {
      ...fs,
      rename: (from: string, to: string) =>
        Effect.gen(function* () {
          assert.equal(yield* probe(file), "blocked");
          checked = true;
          yield* fs.rename(from, to);
        }),
    };
    yield* rememberPendingRemoteCleanup(first).pipe(
      Effect.provideService(FileSystem.FileSystem, checkingFs),
    );
    assert.isTrue(checked);
    assert.equal(yield* probe(file), "acquired");
    assert.equal((yield* readPendingRemoteCleanup).length, 1);
  }).pipe(Effect.provide(fixture)),
);

it.live("releases an interrupted writer without overwriting the existing reminder", () =>
  Effect.gen(function* () {
    yield* rememberPendingRemoteCleanup(first);
    const fs = yield* FileSystem.FileSystem;
    const file = yield* publicFile;
    const entered = yield* Deferred.make<void>();
    const blockedFs = {
      ...fs,
      rename: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    };
    const writer = yield* rememberPendingRemoteCleanup(second).pipe(
      Effect.provideService(FileSystem.FileSystem, blockedFs),
      Effect.forkScoped,
    );
    yield* Deferred.await(entered);
    assert.equal(yield* probe(file), "blocked");
    yield* Fiber.interrupt(writer);
    assert.equal(yield* probe(file), "acquired");
    assert.deepEqual(
      (yield* readPendingRemoteCleanup).map((reference) => reference.relayOrigin),
      [first.relayUrl],
    );
    yield* rememberPendingRemoteCleanup(second);
    assert.equal((yield* readPendingRemoteCleanup).length, 2);
  }).pipe(Effect.scoped, Effect.provide(fixture)),
);

it.live("releases after a failed rename and preserves the previous file", () =>
  Effect.gen(function* () {
    yield* rememberPendingRemoteCleanup(first);
    const fs = yield* FileSystem.FileSystem;
    const file = yield* publicFile;
    const before = yield* fs.readFileString(file);
    const failingFs = {
      ...fs,
      rename: () =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: "fixture-file",
          }),
        ),
    };
    assert.equal(
      (yield* Effect.flip(
        rememberPendingRemoteCleanup(second).pipe(
          Effect.provideService(FileSystem.FileSystem, failingFs),
        ),
      ))._tag,
      "PendingRemoteCleanupError",
    );
    assert.equal(yield* fs.readFileString(file), before);
    assert.equal(yield* probe(file), "acquired");
  }).pipe(Effect.provide(fixture)),
);

it.live("bounds interrupted acquisition and never leaves a late acquired lock behind", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* publicFile;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const contended = Promise.withResolvers<void>();
    observation.contended = (name) => {
      if (name === `${file}.lock`) contended.resolve();
    };
    const blockedFs = {
      ...fs,
      rename: (from: string, to: string) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(fs.rename(from, to)),
        ),
    };
    const owner = yield* rememberPendingRemoteCleanup(first).pipe(
      Effect.provideService(FileSystem.FileSystem, blockedFs),
      Effect.forkScoped,
    );
    yield* Deferred.await(entered);
    const waiter = yield* rememberPendingRemoteCleanup(second).pipe(Effect.forkScoped);
    yield* Effect.promise(() => contended.promise);
    const started = yield* Clock.currentTimeMillis;
    yield* Fiber.interrupt(waiter);
    assert.isBelow((yield* Clock.currentTimeMillis) - started, 5000);
    assert.equal(yield* probe(file), "blocked");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(owner);
    assert.equal(yield* probe(file), "acquired");
    assert.deepEqual(
      (yield* readPendingRemoteCleanup).map((reference) => reference.relayOrigin),
      [first.relayUrl],
    );
  }).pipe(Effect.scoped, Effect.provide(fixture)),
);

it.live(
  "never reaps an existing stale unknown lock and fails bounded acquisition without a write",
  () =>
    Effect.gen(function* () {
      yield* rememberPendingRemoteCleanup(first);
      const fs = yield* FileSystem.FileSystem;
      const file = yield* publicFile;
      const before = yield* fs.readFileString(file);
      yield* fs.makeDirectory(`${file}.lock`);
      yield* Effect.sync(() => NodeFS.utimesSync(`${file}.lock`, 0, 0));
      const started = yield* Clock.currentTimeMillis;
      assert.equal(
        (yield* Effect.flip(rememberPendingRemoteCleanup(second)))._tag,
        "PendingRemoteCleanupError",
      );
      assert.isBelow((yield* Clock.currentTimeMillis) - started, 5000);
      assert.isTrue(yield* fs.exists(`${file}.lock`));
      assert.equal(yield* fs.readFileString(file), before);
    }).pipe(Effect.provide(fixture)),
);

it.live("surfaces release refusal without deleting current or unrelated cleanup references", () =>
  Effect.gen(function* () {
    yield* rememberPendingRemoteCleanup(first);
    const fs = yield* FileSystem.FileSystem;
    const file = yield* publicFile;
    observation.releaseFailurePath = `${file}.lock`;
    assert.equal(
      (yield* Effect.flip(rememberPendingRemoteCleanup(second)))._tag,
      "PendingRemoteCleanupError",
    );
    assert.equal((yield* readPendingRemoteCleanup).length, 2);
    assert.isTrue(yield* fs.exists(`${file}.lock`));
  }).pipe(Effect.provide(fixture)),
);

it.live("fails safely when lock ownership changes while a transaction is suspended", () =>
  Effect.gen(function* () {
    yield* rememberPendingRemoteCleanup(first);
    const fs = yield* FileSystem.FileSystem;
    const file = yield* publicFile;
    const before = yield* fs.readFileString(file);
    const entered = yield* Deferred.make<void>();
    const blockedFs = {
      ...fs,
      rename: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    };
    const writer = yield* rememberPendingRemoteCleanup(second).pipe(
      Effect.provideService(FileSystem.FileSystem, blockedFs),
      Effect.forkScoped,
    );
    yield* Deferred.await(entered);
    yield* Effect.sync(() => NodeFS.utimesSync(`${file}.lock`, 0, 0));
    assert.equal((yield* Effect.flip(Fiber.join(writer)))._tag, "PendingRemoteCleanupError");
    assert.equal(yield* fs.readFileString(file), before);
    assert.isTrue(yield* fs.exists(`${file}.lock`));
  }).pipe(Effect.scoped, Effect.provide(fixture)),
);
const fixture = ServerConfig.layerTest("/", { prefix: "t3-connect-pending-cleanup-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "durably deduplicates public reminders and clears only the matching service/environment",
  () =>
    Effect.gen(function* () {
      const first = { relayUrl: "https://old.example.test/", environmentId: "env-one" };
      yield* rememberPendingRemoteCleanup(first);
      yield* rememberPendingRemoteCleanup({ ...first, environmentId: "env-two" });
      yield* rememberPendingRemoteCleanup({
        relayUrl: "https://other.example.test",
        environmentId: "env-one",
      });
      yield* rememberPendingRemoteCleanup(first);
      const read = yield* readPendingRemoteCleanup;
      assert.equal(read.length, 3);
      assert.deepEqual(Object.keys(read[0]!).sort(), [
        "environmentId",
        "relayOrigin",
        "status",
        "unlinkedAt",
      ]);
      yield* clearMatchingPendingRemoteCleanup(first);
      const remaining = yield* readPendingRemoteCleanup;
      assert.equal(remaining.length, 2);
      assert.isTrue(remaining.some((value) => value.environmentId === "env-two"));
      assert.isTrue(remaining.some((value) => value.relayOrigin === "https://other.example.test"));
    }).pipe(Effect.provide(fixture)),
);

it.effect("refuses a seventeenth reminder without discarding any existing cleanup reference", () =>
  Effect.gen(function* () {
    for (let index = 0; index < 16; index++)
      yield* rememberPendingRemoteCleanup({
        relayUrl: `https://old${index}.example.test`,
        environmentId: "env-one",
      });
    const error = yield* Effect.flip(
      rememberPendingRemoteCleanup({
        relayUrl: "https://seventeenth.example.test",
        environmentId: "env-one",
      }),
    );
    assert.equal(error._tag, "PendingRemoteCleanupError");
    assert.equal((yield* readPendingRemoteCleanup).length, 16);
  }).pipe(Effect.provide(fixture)),
);

it.effect("refuses oversized public state before another cleanup reference is written", () =>
  Effect.gen(function* () {
    yield* rememberPendingRemoteCleanup({
      relayUrl: "https://old.example.test",
      environmentId: "env-one",
    });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const filePath = path.join(
      path.dirname(config.serverRuntimeStatePath),
      "connect-pending-remote-cleanup.json",
    );
    const oversized = " ".repeat(8193);
    yield* fs.writeFileString(filePath, oversized);
    const error = yield* Effect.flip(
      rememberPendingRemoteCleanup({
        relayUrl: "https://next.example.test",
        environmentId: "env-one",
      }),
    );
    assert.equal(error._tag, "PendingRemoteCleanupError");
    assert.equal(yield* fs.readFileString(filePath), oversized);
  }).pipe(Effect.provide(fixture)),
);
