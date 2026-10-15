import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { usesFilesRefStorage } from "./gitRefFormat.ts";

it.effect.each([
  ["files", 0, undefined, undefined, true],
  ["reftable", 0, undefined, undefined, false],
  ["garbage", 0, undefined, undefined, false],
  ["files", 128, undefined, undefined, false],
  ["--show-ref-format", 0, "", 1, true],
  ["--show-ref-format", 0, "files", 0, true],
  ["--show-ref-format", 0, "reftable", 0, false],
  ["--show-ref-format", 0, "", 128, false],
  ["--show-ref-format", 0, "", 0, false],
] as const)(
  "checks native and legacy Git ref storage %s/%s/%s/%s",
  ([shown, shownExit, configured, configExit, expected]) =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const actual = yield* usesFilesRefStorage((args) => {
        calls.push(args);
        const first = args[0] === "rev-parse";
        return Effect.succeed({
          exitCode: first ? shownExit : configExit!,
          stdout: Buffer.from(first ? shown : configured!),
        });
      });
      assert.equal(actual, expected);
      assert.equal(calls.length, shown === "--show-ref-format" && shownExit === 0 ? 2 : 1);
    }),
);
