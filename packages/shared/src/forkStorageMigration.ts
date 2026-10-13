// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

export const STORAGE_MIGRATION_VERSION = 2;
export interface StorageMigrationStatus {
  readonly version: number;
  readonly state: "pending" | "complete" | "legacy";
  readonly beforeBytes: number | null;
  readonly afterBytes: number | null;
}

/** Polling UI and controller ticks share one lookup. In particular, do not spawn a WSL CLI every five seconds. */
export function createStorageMigrationCheck(read: () => Promise<boolean>, now: () => number) {
  let cached: Promise<boolean> | undefined;
  let checkedAt = 0;
  return () => {
    if (cached !== undefined && now() - checkedAt < 60_000) return cached;
    checkedAt = now();
    cached = read().catch((cause: unknown) => {
      cached = undefined;
      throw cause;
    });
    return cached;
  };
}

/** A tiny read-only lookup. Neither startup nor status scans old history to decide whether cleanup is due. */
export function readStorageMigrationStatus(home: string): StorageMigrationStatus {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"), {
    readOnly: true,
  });
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA cache_size=-1024");
    const table = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='arcwright_storage_migrations'",
      )
      .get();
    const row =
      table === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT state,before_bytes,after_bytes FROM arcwright_storage_migrations
               WHERE version=? OR (version<? AND state='pending')
               ORDER BY CASE WHEN state='pending' THEN 0 ELSE 1 END,version DESC LIMIT 1`,
            )
            .get(STORAGE_MIGRATION_VERSION, STORAGE_MIGRATION_VERSION) as
            | {
                state: "pending" | "complete";
                before_bytes: number | null;
                after_bytes: number | null;
              }
            | undefined);
    return {
      version: STORAGE_MIGRATION_VERSION,
      state: row?.state ?? "legacy",
      beforeBytes: row?.before_bytes ?? null,
      afterBytes: row?.after_bytes ?? null,
    };
  } finally {
    db.close();
  }
}
