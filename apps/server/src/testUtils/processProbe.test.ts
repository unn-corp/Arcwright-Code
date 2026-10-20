// @effect-diagnostics nodeBuiltinImport:off - regression fixture uses a real child and TCP reset.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeProcessProbe } from "./processProbe.ts";

it.effect("observes a fixture exit when its socket is reset", () =>
  Effect.gen(function* () {
    const probe = yield* makeProcessProbe;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [
        "--input-type=module",
        "--eval",
        `import { createConnection } from "node:net";
         const socket = createConnection(${probe.port}, "127.0.0.1", () => {
           socket.write(process.pid + "\\n", () => socket.resetAndDestroy());
         });`,
      ]),
    );
    assert.equal(yield* probe.started, child.pid);
    yield* probe.exited;
    assert.equal(yield* child.exitCode, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
