import team0 from "./Migrations/055_TeamSpaces.ts";
import team1 from "./Migrations/056_ThreadCollaboration.ts";
import team2 from "./Migrations/057_TeamPublication.ts";
import team3 from "./Migrations/058_TeamPublicationMessageOrder.ts";
import team4 from "./Migrations/059_TeamFiles.ts";
import team5 from "./Migrations/060_TeamPublicationIntents.ts";
import team6 from "./Migrations/061_TeamCreationIntentReceipts.ts";
import team7 from "./Migrations/062_RepairForkMigrationCollisions.ts";
import team8 from "./Migrations/063_TeamRoster.ts";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import repairDesktop from "./Migrations/062_RepairForkMigrationCollisions.ts";
import type * as Schema from "effect/Schema";

type Migration = Effect.Effect<void, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient>;
type Entry = readonly [number, string, Migration];
const TEAM_ID_START = 199;
const teamNames = [
  "TeamSpaces",
  "ThreadCollaboration",
  "TeamPublication",
  "TeamPublicationMessageOrder",
  "TeamFiles",
  "TeamPublicationIntents",
  "TeamCreationIntentReceipts",
  "RepairForkMigrationCollisions",
  "TeamRoster",
];

export const skipRecordedTeamMigration = (name: string, migration: Migration): Migration =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const applied =
      yield* sql`SELECT 1 FROM effect_sql_migrations WHERE name=${name} AND migration_id < ${TEAM_ID_START}`;
    if (applied.length === 0) yield* migration;
  });

/** Keep published Teams ledger identities while applying the fork migrations they displaced. */
export const reconcileTeamMigrationHistory = Effect.fn("reconcileTeamMigrationHistory")(function* (
  entries: ReadonlyArray<Entry>,
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`SELECT 1 FROM sqlite_master WHERE name='effect_sql_migrations'`;
  if (!tables.length) return entries;
  const history = yield* sql<{
    migration_id: number;
    name: string;
  }>`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`;
  const legacy = history.some((row) => row.migration_id === 55 && row.name === "TeamSpaces");
  const integrated = history.some((row) => row.migration_id === 95 && row.name === "TeamSpaces");
  // Upstream and early v2 previews have their own identity-aware reconciler.
  const upstream =
    !legacy &&
    !integrated &&
    history.some((row) => row.migration_id === 36 && row.name === "ProjectionThreadsPinned") &&
    !history.some(
      (row) =>
        (row.migration_id === 53 && row.name === "ProjectionThreadsActiveOrderKey") ||
        (row.migration_id === 54 && row.name === "ProjectionThreadPullRequests"),
    );
  if (upstream || history.some((row) => row.name === "OrchestrationV2" && row.migration_id <= 55))
    return entries;
  const desktopNames = new Map<number, string>([
    [36, "ProjectionThreadsPinned"],
    [37, "ProjectionTurnsKeysetIndex"],
    [38, "ProjectionThreadsPinOrderKey"],
    [39, "ProjectionProjectsDefaultThreadEnvMode"],
    [40, "ProjectionProjectFaviconPath"],
    [41, "AuthSessionClientConnection"],
    [42, "ProjectionThreadLinkedPullRequest"],
    [43, "ProjectionThreadsUnsettledAt"],
    [44, "ClearAutomaticProjectModelDefaults"],
    [45, "ProjectionProjectsAutoPull"],
    [46, "RepairAutomaticSettlementTimestamps"],
    [47, "ProjectionProjectIcon"],
    [48, "ProjectionThreadBranchPullRequest"],
    [49, "ProjectionThreadsActiveOrderKey"],
    [50, "ProjectionThreadPullRequests"],
    [51, "ProjectionThreadMessageContext"],
    [52, "ProjectionThreadTitleState"],
  ]);
  const desktop = history.some(
    (row) => row.migration_id === 38 && row.name === desktopNames.get(38),
  );
  const names = new Map(entries.map(([id, name]) => [id, name]));
  const recognized = new Map<number, string>();
  if (legacy) teamNames.forEach((name, i) => recognized.set(55 + i, name));
  if (integrated) teamNames.forEach((name, i) => recognized.set(95 + i, name));
  if (desktop)
    for (const row of history) {
      if (desktopNames.get(row.migration_id) === row.name)
        recognized.set(row.migration_id, row.name);
    }
  for (const row of history) {
    const expected = recognized.get(row.migration_id) ?? names.get(row.migration_id);
    if (expected === undefined)
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message: `Migration ${row.migration_id}_${row.name} belongs to a newer build.`,
      });
    if (expected !== row.name)
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message: `Unrecognized Teams migration history ${row.migration_id}_${row.name}; expected ${expected}.`,
      });
  }
  const latest = history.at(-1)?.migration_id ?? 0;
  const recorded = new Set(history.map((row) => row.migration_id));
  // Fork migrations added after Teams ids were recorded sit below the latest
  // ledger row, where Effect's Migrator skips them. Apply those directly.
  const latestFork = Math.max(
    0,
    ...history.filter((row) => row.migration_id < TEAM_ID_START).map((row) => row.migration_id),
  );
  const appendedFork = entries.filter(
    ([id]) =>
      id > latestFork &&
      id < TEAM_ID_START &&
      id < latest &&
      !recorded.has(id) &&
      (throughId === undefined || id <= throughId),
  );
  const appendedIds = new Set(appendedFork.map(([id]) => id));
  for (const [id, name] of entries) {
    if (id <= latest && !recorded.has(id) && !appendedIds.has(id))
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message: `Database history is missing migration ${id}_${name}.`,
      });
  }
  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        if (desktop) yield* repairDesktop;
        yield* sql`CREATE TABLE IF NOT EXISTS fork_migration_compatibility (name TEXT PRIMARY KEY)`;
        for (const [start, end, enabled] of [
          [55, 63, legacy],
          [95, 98, integrated],
        ] as const) {
          if (!enabled || (throughId !== undefined && throughId <= end)) continue;
          const receipt = `unn-${start}-${end}`;
          if ((yield* sql`SELECT 1 FROM fork_migration_compatibility WHERE name=${receipt}`).length)
            continue;
          for (const [id, , migration] of entries) if (id >= start && id <= end) yield* migration;
          yield* sql`INSERT INTO fork_migration_compatibility(name) VALUES (${receipt})`;
        }
        for (const [id, name, migration] of appendedFork) {
          yield* migration;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
        }
      }),
    )
    .pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new Migrator.MigrationError({
              kind: "Failed",
              message: "Teams compatibility migration failed.",
              cause,
            }),
          ),
      }),
    );
  const teamMigrations = [team0, team1, team2, team3, team4, team5, team6, team7, team8];
  const historicalMigration = (id: number): Migration | undefined => {
    const index =
      legacy && id >= 55 && id <= 63 ? id - 55 : integrated && id >= 95 && id <= 103 ? id - 95 : -1;
    return index < 0 ? undefined : teamMigrations[index];
  };
  const effective: Entry[] = entries.map(([id, name, migration]) => [
    id,
    recognized.get(id) ?? name,
    historicalMigration(id) ?? migration,
  ]);
  for (const [id, name] of recognized)
    if (!names.has(id)) effective.push([id, name, historicalMigration(id) ?? Effect.void]);
  return effective;
});
