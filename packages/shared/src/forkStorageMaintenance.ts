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
import { normalizeStorageJson } from "./upstreamStorageCopy.ts";

export interface StorageNormalizationInput {
  readonly home: string;
  readonly transactionId: string;
  readonly store: CoordinatorStore;
  /** Only the registered trial backend may normalize before opening its application connection. */
  readonly participantId?: string;
  /** Native CLI child of the trial backend. The live parent identity, fence and snapshot still authorize it. */
  readonly parentParticipantId?: string;
  readonly progress?: (progress: {
    readonly stage: string;
    readonly rows: number;
  }) => void | Promise<void>;
}

async function assertStorageAdmission(input: StorageNormalizationInput) {
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
    journal.storageNormalization !== true ||
    journal.storageOptimization === true ||
    journalHome === undefined ||
    !journal.homes.includes(journalHome)
  )
    throw new Error("Storage normalization requires the exact authorized, fenced update trial.");
  const callerId = input.parentParticipantId ?? input.participantId;
  const caller =
    callerId === undefined ? undefined : status.participants.find((p) => p.id === callerId);
  if (
    callerId === undefined ||
    caller?.orphaned === true ||
    caller?.owner.pid !== (input.parentParticipantId === undefined ? process.pid : process.ppid) ||
    caller.trialFor !== journal.id ||
    !caller?.homes.includes(home)
  )
    throw new Error("The storage normalizer does not own this trial home.");
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
      "A runtime or its agents still owns this data home; storage normalization is blocked.",
    );
  const snapshot = journal.snapshots[journalHome];
  if (snapshot === undefined)
    throw new Error("Storage normalization has no recorded restore point.");
  return {
    snapshotId: snapshot,
    binding: JSON.stringify([
      journal.target,
      journal.previous,
      journal.homes,
      journal.snapshots,
      caller.owner,
    ]),
  };
}

/** This never creates a fence, stops work, skips recovery verification, or releases admission. */
export async function normalizeStorageHome(
  input: StorageNormalizationInput,
): Promise<Record<string, unknown>> {
  const admission = await assertStorageAdmission(input);
  const { snapshotId } = admission;
  const assertSameAdmission = async () => {
    if ((await assertStorageAdmission(input)).binding !== admission.binding)
      throw new Error("Storage normalization authorization changed during conversion.");
  };
  if (input.parentParticipantId !== undefined) {
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
    throw new Error("Storage normalization refuses relocated userdata.");
  const database = NodePath.join(state, "statev2.sqlite");
  if ((await NodeFSP.realpath(database)) !== database || !(await NodeFSP.lstat(database)).isFile())
    throw new Error("Storage normalization requires a regular application database.");
  await verifySnapshot(home, snapshotId);
  await assertSameAdmission();
  const reserve = async (additionalBytes = 0) => {
    const space = await NodeFSP.statfs(state);
    if (Number(space.bavail) * Number(space.bsize) < additionalBytes + 8 * 1024 ** 3)
      throw new Error("Insufficient free space for plain JSON and rollback headroom.");
  };
  await reserve();
  const beforeBytes = (await NodeFSP.stat(database)).size;
  const db = new NodeSqlite.DatabaseSync(database);
  try {
    db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE",
    );
    // A single SQLite commit binds every expanded row to the receipt. Interruption rolls both back.
    db.exec("BEGIN IMMEDIATE");
    const prior = db
      .prepare(
        "SELECT report_json FROM arcwright_storage_runs WHERE transaction_id=? AND completed_at IS NOT NULL",
      )
      .get(input.transactionId) as { report_json: string } | undefined;
    if (prior !== undefined) {
      const report = JSON.parse(prior.report_json) as Record<string, unknown>;
      if (report.storageNormalizationVersion !== 1 || report.snapshotId !== snapshotId)
        throw new Error(
          "Storage normalization requires a fresh admitted transaction and restore point.",
        );
      db.exec("ROLLBACK");
      return report;
    }
    const progress = async (stage: string, rows: number) => {
      await input.progress?.({ stage, rows });
      await reserve();
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      await assertSameAdmission();
    };
    const normalized = await normalizeStorageJson(db, progress, reserve);
    const report = { ...normalized, storageNormalizationVersion: 1, beforeBytes, snapshotId };
    await reserve();
    await assertSameAdmission();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO arcwright_storage_runs(transaction_id,started_at,completed_at,report_json) VALUES(?,?,?,?)",
    ).run(input.transactionId, now, now, JSON.stringify(report));
    db.exec("COMMIT");
    return report;
  } catch (cause) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw cause;
  } finally {
    db.close();
  }
}
