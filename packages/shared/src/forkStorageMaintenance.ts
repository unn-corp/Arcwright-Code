/* oxlint-disable t3code/no-global-process-runtime -- native maintenance configures the actual child process on this OS */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off processEnv:off preferSchemaOverJson:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import type { CoordinatorStore } from "./forkMaintenanceStore.ts";
import { verifySnapshot } from "./forkMaintenanceSnapshot.ts";
import { registerStorageFunctions } from "./forkStorageCodec.ts";
import {
  archiveLegacyHistory,
  compressEventHistory,
  compressTurnItemHistory,
  recordLegacyBaselines,
  type ArchiveProgress,
} from "./forkStorageArchive.ts";
import { deduplicateEvidence } from "./forkEvidenceDedup.ts";
import { STORAGE_MIGRATION_VERSION } from "./forkStorageMigration.ts";
import { compactHistoryBlocks } from "./forkStorageBlocks.ts";

export interface StorageOptimizationInput {
  readonly home: string;
  readonly transactionId: string;
  readonly store: CoordinatorStore;
  /** Only the registered trial backend may optimize before opening its application connection. */
  readonly participantId?: string;
  /** Native CLI child of the trial backend. The live parent identity, fence and snapshot still authorize it. */
  readonly parentParticipantId?: string;
  readonly progress?: (progress: ArchiveProgress) => void;
}

async function assertStorageAdmission(input: StorageOptimizationInput): Promise<string> {
  const home = await NodeFSP.realpath(input.home);
  const status = await input.store.status(Date.now());
  const journal = await input.store.readJournal(input.transactionId);
  const journalHome =
    journal?.homes.includes(home) === true
      ? home
      : process.env.WSL_DISTRO_NAME === undefined
        ? undefined
        : `wsl:${process.env.WSL_DISTRO_NAME}:${home}`;
  if (
    status.fence?.transactionId !== input.transactionId ||
    journal?.kind !== "update" ||
    journal.phase !== "trial" ||
    journal.storageOptimization !== true ||
    journalHome === undefined ||
    !journal.homes.includes(journalHome)
  )
    throw new Error("Storage optimization requires the exact authorized, fenced update trial.");
  const callerId = input.parentParticipantId ?? input.participantId;
  const caller =
    callerId === undefined ? undefined : status.participants.find((p) => p.id === callerId);
  if (
    callerId !== undefined &&
    (caller?.owner.pid !== (input.parentParticipantId === undefined ? process.pid : process.ppid) ||
      caller.trialFor !== journal.id ||
      !caller.homes.includes(home))
  )
    throw new Error("The storage optimizer does not own this trial home.");
  if (
    input.parentParticipantId !== undefined &&
    !caller?.descendants.some(
      (child) => child.pid === process.pid && child.label === "Arcwright storage maintenance",
    )
  )
    throw new Error("The trial backend has not recorded this storage worker's ownership.");
  const owners = status.participants.filter(
    (p) =>
      p.homes.includes(home) &&
      p.id !== caller?.id &&
      !(caller !== undefined && p.kind === "desktop" && p.trialFor === journal.id),
  );
  if (owners.length > 0 || caller?.descendants.some((child) => child.pid !== process.pid))
    throw new Error(
      "A runtime or its agents still owns this data home; storage optimization is blocked.",
    );
  const snapshot = journal.snapshots[journalHome];
  if (snapshot === undefined)
    throw new Error("Storage optimization has no recorded restore point.");
  return snapshot;
}

/** This never creates a fence, stops work, skips recovery verification, or releases admission. */
export async function optimizeStorageHome(
  input: StorageOptimizationInput,
): Promise<Record<string, unknown>> {
  const snapshotId = await assertStorageAdmission(input);
  if (input.parentParticipantId !== undefined) {
    // This process exits after maintenance. Foreground app priorities never inherit the bulk rewrite's settings.
    process.title = "arcwright-storage-maintenance";
    NodeOS.setPriority(0, NodeOS.constants.priority.PRIORITY_LOW);
    if (process.platform === "linux")
      await NodeUtil.promisify(NodeChildProcess.execFile)("/usr/bin/ionice", [
        "-c",
        "3",
        "-p",
        String(process.pid),
      ]);
  }
  const home = await NodeFSP.realpath(input.home);
  const state = NodePath.join(home, "userdata");
  if ((await NodeFSP.realpath(state)) !== state)
    throw new Error("Storage optimization refuses relocated userdata.");
  const database = NodePath.join(state, "statev2.sqlite");
  if ((await NodeFSP.realpath(database)) !== database || !(await NodeFSP.lstat(database)).isFile())
    throw new Error("Storage optimization requires a regular application database.");
  await verifySnapshot(home, snapshotId);
  await assertStorageAdmission(input);
  const beforeBytes = (await NodeFSP.stat(database)).size;
  // VACUUM may require twice the original database size. Never rely on post-compaction estimates.
  const space = await NodeFSP.statfs(state);
  if (Number(space.bavail) * Number(space.bsize) < 2 * beforeBytes + 1024 ** 3)
    throw new Error("Not enough free space to repack the database safely.");
  // VACUUM and temporary sorts can spill gigabytes. Use this data disk, never an inherited RAM-backed /tmp.
  // The admitted optimizer is a dedicated process; its environment is restored for in-process fixtures.
  const temp = await NodeFSP.mkdtemp(NodePath.join(state, ".arcwright-storage-temp-"));
  const tempKeys = ["SQLITE_TMPDIR", "TMPDIR", "TEMP", "TMP"] as const;
  const previousTemp = tempKeys.map((key) => [key, process.env[key]] as const);
  for (const key of tempKeys) process.env[key] = temp;
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(database);
    registerStorageFunctions(db);
    db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE",
    );
    const prior = db
      .prepare("SELECT completed_at,report_json FROM arcwright_storage_runs WHERE transaction_id=?")
      .get(input.transactionId) as
      | { completed_at: string | null; report_json: string | null }
      | undefined;
    if (prior?.completed_at !== null && prior?.completed_at !== undefined) {
      const report = JSON.parse(prior.report_json!);
      if (report.storageMigrationVersion !== STORAGE_MIGRATION_VERSION)
        throw new Error(
          "A newer storage migration requires a fresh admitted transaction and restore point.",
        );
      return report;
    }
    const startedAt = new Date().toISOString();
    db.prepare(
      "INSERT INTO arcwright_storage_runs(transaction_id,started_at) VALUES(?,?) ON CONFLICT(transaction_id) DO NOTHING",
    ).run(input.transactionId, startedAt);
    // Dropping large B-trees can take seconds on older homes. Keep it out of the startup schema migration.
    db.exec(
      "DROP INDEX IF EXISTS idx_orch_events_correlation_id; DROP INDEX IF EXISTS idx_orch_command_receipts_aggregate; DROP INDEX IF EXISTS idx_orch_command_receipts_sequence",
    );
    const pause = async (progress: ArchiveProgress) => {
      input.progress?.(progress);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      await assertStorageAdmission(input);
    };
    recordLegacyBaselines(db, startedAt);
    // Ninety days bounds the hot legacy-receipt store. Archived IDs and exact responses remain indefinitely.
    const cutoff = new Date(Date.now() - 90 * 86400_000).toISOString();
    const archived = await archiveLegacyHistory(db, cutoff, pause);
    const historyBlocks = await compactHistoryBlocks(db, pause);
    const compressedEvents = await compressEventHistory(db, pause);
    const compressedTurnItems = await compressTurnItemHistory(db, pause);
    const evidence = await deduplicateEvidence(
      NodePath.join(state, "conversation-evidence"),
      db,
      () => pause({ stage: "evidence", rows: 0 }),
    );
    await assertStorageAdmission(input);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)");
    await assertStorageAdmission(input);
    const check = db.prepare("PRAGMA quick_check").all() as Record<string, unknown>[];
    if (
      check.length !== 1 ||
      Object.values(check[0]!)[0] !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length !== 0
    )
      throw new Error(
        "Repacked database failed verification; admission stays fenced for recovery.",
      );
    const report = {
      storageMigrationVersion: STORAGE_MIGRATION_VERSION,
      beforeBytes,
      afterBytes: (await NodeFSP.stat(database)).size,
      archived,
      historyBlocks,
      compressedEvents,
      compressedTurnItems,
      evidence,
      snapshotId,
    };
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      "UPDATE arcwright_storage_runs SET completed_at=?,report_json=? WHERE transaction_id=?",
    ).run(new Date().toISOString(), JSON.stringify(report), input.transactionId);
    db.prepare(
      "UPDATE arcwright_storage_migrations SET state='complete',completed_at=?,before_bytes=?,after_bytes=? WHERE version<=? AND state='pending'",
    ).run(new Date().toISOString(), beforeBytes, report.afterBytes, STORAGE_MIGRATION_VERSION);
    db.exec("COMMIT");
    return report;
  } finally {
    db?.close();
    for (const [key, value] of previousTemp) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await NodeFSP.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
