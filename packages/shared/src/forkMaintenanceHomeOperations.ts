// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * One-shot operations on a single data home, run by the process that owns that filesystem. This is
 * the explicit control channel for a WSL distribution: the Windows desktop invokes
 * `t3 maintenance home <op>` inside the distribution (so it never reaches into \\wsl$ paths or guesses
 * an address), and each operation returns JSON. The same dispatcher backs the Windows side.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { HISTORY_SOURCES, readArchivedRow, type HistorySource } from "./forkStorageArchive.ts";
import { normalizeStorageHome } from "./forkStorageMaintenance.ts";
import { readStorageMigrationStatus } from "./forkStorageMigration.ts";
import {
  assertCapacity,
  createSnapshot,
  discardSnapshot,
  listRestorePoints,
  pruneRestorePoints,
  restoreSnapshot,
  snapshotRequirement,
  verifySnapshot,
} from "./forkMaintenanceSnapshot.ts";
import type { CoordinatorStore } from "./forkMaintenanceStore.ts";

export type HomeOperation =
  | { readonly op: "requirement" }
  /** The realpath of the home. Journal and restore-point identities must use this, never a configured spelling. */
  | { readonly op: "canonical" }
  | { readonly op: "capacity"; readonly rescue?: boolean; readonly artifactBytes?: number }
  | { readonly op: "snapshot"; readonly transactionId: string }
  | { readonly op: "rescue"; readonly transactionId: string }
  | { readonly op: "verify"; readonly snapshotId: string }
  | { readonly op: "restore"; readonly snapshotId: string; readonly transactionId: string }
  | { readonly op: "discard"; readonly snapshotId: string }
  | { readonly op: "list" }
  | { readonly op: "storage-status" }
  | {
      readonly op: "normalize-storage";
      readonly transactionId: string;
      readonly parentParticipantId?: string;
    }
  | {
      readonly op: "history";
      readonly source: HistorySource;
      readonly threadId: string;
      readonly after: string;
    }
  | { readonly op: "prune"; readonly keep: number; readonly pinned: ReadonlyArray<string> };

export type HomeOperationResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

/**
 * `store` lets the dispatcher refuse a restore while a live runtime owns the home: replacing files
 * under a running database corrupts it. Operations never take the fence themselves; the caller's
 * transaction (on whichever side owns the fence) already holds admission.
 */
export async function runHomeOperation(
  home: string,
  operation: HomeOperation,
  options: { readonly store?: CoordinatorStore } = {},
): Promise<HomeOperationResult> {
  try {
    switch (operation.op) {
      case "storage-status":
        return { ok: true, value: readStorageMigrationStatus(home) };
      case "normalize-storage":
        if (options.store === undefined)
          throw new Error("Storage normalization requires the native coordinator.");
        if (operation.parentParticipantId !== undefined) {
          let handshake = "";
          for await (const chunk of process.stdin) {
            handshake += String(chunk);
            if (handshake.length > 64) throw new Error("Invalid maintenance worker handshake.");
          }
          if (handshake !== "storage-child-recorded\n")
            throw new Error("The maintenance worker was not registered by its parent.");
        }
        return {
          ok: true,
          value: await normalizeStorageHome({
            home,
            transactionId: operation.transactionId,
            store: options.store,
            ...(operation.parentParticipantId === undefined
              ? {}
              : { parentParticipantId: operation.parentParticipantId }),
          }),
        };
      case "history": {
        const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"), {
          readOnly: true,
        });
        try {
          const keys = db
            .prepare(
              "SELECT row_key FROM arcwright_history_rows WHERE source=? AND thread_id=? AND row_key>? ORDER BY row_key LIMIT 100",
            )
            .all(operation.source, operation.threadId, operation.after) as { row_key: string }[];
          const selected: typeof keys = [];
          let bytes = 0;
          for (const key of keys) {
            const size = db
              .prepare("SELECT raw_bytes FROM arcwright_history_rows WHERE source=? AND row_key=?")
              .get(operation.source, key.row_key) as { raw_bytes: number };
            if (selected.length > 0 && bytes + size.raw_bytes > 4 * 1024 * 1024) break;
            selected.push(key);
            bytes += size.raw_bytes;
          }
          return {
            ok: true,
            value: {
              rows: selected.map(({ row_key }) => readArchivedRow(db, operation.source, row_key)),
              next: selected.at(-1)?.row_key ?? null,
            },
          };
        } finally {
          db.close();
        }
      }
      case "requirement":
        return { ok: true, value: await snapshotRequirement(home) };
      case "canonical":
        return { ok: true, value: await NodeFSP.realpath(home) };
      case "capacity":
        await assertCapacity([home], {
          ...(operation.rescue === undefined ? {} : { rescue: operation.rescue }),
          ...(operation.artifactBytes === undefined
            ? {}
            : { artifactBytesByHome: { [home]: operation.artifactBytes } }),
        });
        return { ok: true, value: true };
      case "snapshot":
        return { ok: true, value: await createSnapshot(home, operation.transactionId) };
      case "rescue":
        return {
          ok: true,
          value: await createSnapshot(home, operation.transactionId, { kind: "rescue" }),
        };
      case "verify": {
        const manifest = await verifySnapshot(home, operation.snapshotId);
        return {
          ok: true,
          value: { id: manifest.id, createdAt: manifest.createdAt, files: manifest.files.length },
        };
      }
      case "restore": {
        if (options.store !== undefined) {
          const status = await options.store.status(Date.now());
          const owners = status.participants.filter(
            (participant) =>
              participant.homes.includes(home) &&
              (participant.trialFor === null ||
                participant.descendants.some(
                  (child) => child.label === "Arcwright storage maintenance",
                )),
          );
          if (owners.length > 0)
            return {
              ok: false,
              reason: "A runtime still owns this data home. Stop it before restoring.",
            };
        }
        await restoreSnapshot(home, operation.snapshotId, operation.transactionId);
        return { ok: true, value: true };
      }
      case "discard":
        await discardSnapshot(home, operation.snapshotId);
        return { ok: true, value: true };
      case "list":
        return { ok: true, value: await listRestorePoints(home) };
      case "prune":
        return {
          ok: true,
          value: await pruneRestorePoints(home, {
            keep: operation.keep,
            pinned: new Set(operation.pinned),
          }),
        };
    }
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Parses the CLI argument vector of `t3 maintenance home <op> ...` (everything after `home`). */
export function parseHomeOperation(
  args: ReadonlyArray<string>,
): { readonly home: string; readonly operation: HomeOperation } | { readonly error: string } {
  const [op, ...rest] = args;
  const flags = new Map<string, string>();
  const multi = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined)
      return { error: `Malformed arguments near ${key ?? "end"}.` };
    flags.set(key.slice(2), value);
    multi.set(key.slice(2), [...(multi.get(key.slice(2)) ?? []), value]);
  }
  const home = flags.get("home");
  if (home === undefined) return { error: "--home is required." };
  const need = (name: string) => flags.get(name);
  switch (op) {
    case "normalize-storage": {
      const transactionId = need("transaction");
      return transactionId === undefined
        ? { error: "--transaction is required." }
        : {
            home,
            operation: {
              op,
              transactionId,
              ...(need("parent-participant") === undefined
                ? {}
                : { parentParticipantId: need("parent-participant")! }),
            },
          };
    }
    case "history": {
      const source = need("source");
      const threadId = need("thread");
      if (!HISTORY_SOURCES.includes(source as HistorySource) || threadId === undefined)
        return {
          error: "--source must name a supported history archive and --thread is required.",
        };
      return {
        home,
        operation: { op, source: source as HistorySource, threadId, after: need("after") ?? "" },
      };
    }
    case "requirement":
    case "list":
    case "storage-status":
    case "canonical":
      return { home, operation: { op } };
    case "capacity": {
      const artifactBytes =
        need("artifact-bytes") === undefined ? undefined : Number(need("artifact-bytes"));
      if (artifactBytes !== undefined && !Number.isFinite(artifactBytes))
        return { error: "--artifact-bytes must be a number." };
      return {
        home,
        operation: {
          op,
          rescue: need("rescue") === "true",
          ...(artifactBytes === undefined ? {} : { artifactBytes }),
        },
      };
    }
    case "snapshot":
    case "rescue": {
      const transactionId = need("transaction");
      return transactionId === undefined
        ? { error: "--transaction is required." }
        : { home, operation: { op, transactionId } };
    }
    case "verify":
    case "discard": {
      const snapshotId = need("snapshot");
      return snapshotId === undefined
        ? { error: "--snapshot is required." }
        : { home, operation: { op, snapshotId } };
    }
    case "restore": {
      const snapshotId = need("snapshot");
      const transactionId = need("transaction");
      return snapshotId === undefined || transactionId === undefined
        ? { error: "--snapshot and --transaction are required." }
        : { home, operation: { op, snapshotId, transactionId } };
    }
    case "prune": {
      const keep = Number(need("keep") ?? "2");
      return Number.isInteger(keep) && keep >= 0
        ? { home, operation: { op, keep, pinned: multi.get("pin") ?? [] } }
        : { error: "--keep must be a non-negative integer." };
    }
    default:
      return { error: `Unknown home operation ${op ?? "(none)"}.` };
  }
}
