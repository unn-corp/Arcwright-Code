import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

const METADATA_COMMANDS = new Set([
  "rev-parse",
  "symbolic-ref",
  "show-ref",
  "for-each-ref",
  "config",
  "remote",
  "check-attr",
  "check-ignore",
  "ls-files",
  "ls-tree",
  "version",
]);

function gitCommand(args: ReadonlyArray<string>): { name: string; index: number } | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (["-c", "-C", "--git-dir", "--work-tree"].includes(arg)) index++;
    else if (!arg.startsWith("-")) return { name: arg, index };
  }
  return null;
}

function isHeavy(args: ReadonlyArray<string>): boolean {
  const command = gitCommand(args);
  if (command === null) return false;
  // Unknown commands and aliases may scan assets or write objects.
  // Only listing worktrees is metadata; mutations retain the heavy write lock.
  return !(
    METADATA_COMMANDS.has(command.name) ||
    (command.name === "worktree" && args[command.index + 1] === "list")
  );
}

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const processes = yield* Semaphore.make(8);
  const heavyProcesses = yield* Semaphore.make(2);
  // A stalled network fetch must leave a heavy slot available for local reads.
  const fetchProcesses = yield* Semaphore.make(1);
  const repositories = yield* KeyedLock.make<string>();
  return {
    withPermit: <A, E, R>(
      cwd: string,
      args: ReadonlyArray<string>,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => {
      const bounded = processes.withPermit(effect);
      // Acquire the repository first: queued work for one busy checkout must
      // not consume the global permits needed by other repositories.
      if (!isHeavy(args)) return bounded;
      const heavy = heavyProcesses.withPermit(bounded);
      // Status and divergence reads must finish while a detached status fetch owns the
      // repository's writer lock. They still count toward the heavy process cap.
      const command = gitCommand(args)?.name;
      if (command === "rev-list" || command === "status" || command === "diff-index") return heavy;
      return repositories.withLock(
        path.resolve(cwd),
        command === "fetch" ? fetchProcesses.withPermit(heavy) : heavy,
      );
    },
  };
});

// Both Git execution paths use the same process-wide budget, including
// commands with extended or unlimited deadlines. Metadata reads retain room
// while asset scans, LFS filtering and checkout writes are running.
const shared = Effect.runSync(make.pipe(Effect.provide(NodePath.layer)));
export const withPermit = shared.withPermit;
