// @effect-diagnostics nodeBuiltinImport:off -- private filesystem fixtures
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { readStorageMigrationStatus, STORAGE_MIGRATION_VERSION } from "./forkStorageMigration.ts";

it("distinguishes pending older work, a completed older format and a completed current format", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "arcwright-storage-marker-"));
  try {
    await NodeFSP.mkdir(NodePath.join(home, "userdata"));
    const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"));
    try {
      expect(readStorageMigrationStatus(home).state).toBe("legacy");
      db.exec(
        "CREATE TABLE arcwright_storage_migrations(version INTEGER PRIMARY KEY,state TEXT,before_bytes INTEGER,after_bytes INTEGER); INSERT INTO arcwright_storage_migrations VALUES(1,'pending',NULL,NULL)",
      );
      expect(readStorageMigrationStatus(home)).toMatchObject({
        version: STORAGE_MIGRATION_VERSION,
        state: "pending",
      });
      db.exec("UPDATE arcwright_storage_migrations SET state='complete'");
      expect(readStorageMigrationStatus(home).state).toBe("legacy");
      db.prepare("INSERT INTO arcwright_storage_migrations VALUES(?,'pending',NULL,NULL)").run(
        STORAGE_MIGRATION_VERSION,
      );
      expect(readStorageMigrationStatus(home).state).toBe("pending");
      db.prepare(
        "UPDATE arcwright_storage_migrations SET state='complete',before_bytes=10000,after_bytes=2000 WHERE version=?",
      ).run(STORAGE_MIGRATION_VERSION);
      expect(readStorageMigrationStatus(home)).toMatchObject({
        state: "complete",
        beforeBytes: 10000,
        afterBytes: 2000,
      });
      db.exec("UPDATE arcwright_storage_migrations SET state='pending' WHERE version=1");
      expect(readStorageMigrationStatus(home).state).toBe("pending");
    } finally {
      db.close();
    }
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});
