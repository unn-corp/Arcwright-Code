import * as Effect from "effect/Effect";

/** Old Git echoes an unrecognized rev-parse flag with exit 0. Reftable-aware
 * Git also records extensions.refStorage, so a missing extension is the files
 * default only when the old-command response is exactly the echoed flag. */
export const usesFilesRefStorage = <E, R>(
  git: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<{ readonly exitCode: number; readonly stdout: Uint8Array }, E, R>,
): Effect.Effect<boolean, E, R> =>
  Effect.gen(function* () {
    const result = yield* git(["rev-parse", "--show-ref-format"]);
    const format = Buffer.from(result.stdout).toString("ascii").trim();
    if (result.exitCode !== 0) return false;
    if (format !== "--show-ref-format") return format === "files";
    const configured = yield* git(["config", "--local", "--get", "extensions.refStorage"]);
    const value = Buffer.from(configured.stdout).toString("ascii").trim();
    return (
      (configured.exitCode === 1 && value === "") ||
      (configured.exitCode === 0 && value === "files")
    );
  });
