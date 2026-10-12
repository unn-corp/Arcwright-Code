/* oxlint-disable t3code/no-global-process-runtime -- this native filesystem maintenance module checks actual file ownership */
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/** Copy-on-write deduplication preserves names, permissions, bytes and independent future edits. */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import type * as NodeSqlite from "node:sqlite";

async function* files(root: string): AsyncGenerator<string> {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    if ((await NodeFSP.realpath(directory)) !== directory)
      throw new Error("Evidence deduplication refuses symbolic links.");
    const entries = await NodeFSP.opendir(directory);
    for await (const entry of entries) {
      const file = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && !entry.name.startsWith(".maintenance-storage-")) yield file;
      // Special files and symlinks stay untouched, including their targets.
    }
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const bytes of NodeFS.createReadStream(file, { highWaterMark: 64 * 1024 }))
    hash.update(bytes);
  return hash.digest("hex");
}

const unchanged = (
  a: Awaited<ReturnType<typeof NodeFSP.lstat>>,
  b: Awaited<ReturnType<typeof NodeFSP.lstat>>,
) =>
  a.isFile() &&
  b.isFile() &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.gid === b.gid;

export async function deduplicateEvidence(
  root: string,
  db: NodeSqlite.DatabaseSync,
  checkAdmission: () => Promise<void>,
): Promise<{
  readonly scanned: number;
  readonly shared: number;
  readonly logicalSharedBytes: number;
  readonly unsupported: number;
}> {
  if (!(await NodeFSP.stat(root).catch(() => null))?.isDirectory())
    return { scanned: 0, shared: 0, logicalSharedBytes: 0, unsupported: 0 };
  const sizes = new Map<number, number>();
  for await (const file of files(root)) {
    const stat = await NodeFSP.lstat(file);
    if (stat.size >= 4096) sizes.set(stat.size, (sizes.get(stat.size) ?? 0) + 1);
  }
  // A disk-backed index bounds memory even for source trees with hundreds of thousands of files.
  db.exec(
    "CREATE TEMP TABLE evidence_dedup_candidates(digest TEXT,dev INTEGER,size INTEGER,file TEXT,PRIMARY KEY(digest,dev,size)) WITHOUT ROWID",
  );
  let scanned = 0,
    shared = 0,
    logicalSharedBytes = 0,
    unsupported = 0;
  try {
    for await (const file of files(root)) {
      const before = await NodeFSP.lstat(file);
      if (
        before.size < 4096 ||
        (sizes.get(before.size) ?? 0) < 2 ||
        (process.platform !== "win32" && before.uid !== process.getuid?.())
      )
        continue;
      if (++scanned % 64 === 0) await checkAdmission();
      const digest = await hashFile(file);
      if (!unchanged(before, await NodeFSP.lstat(file))) continue;
      const candidate = db
        .prepare("SELECT file FROM evidence_dedup_candidates WHERE digest=? AND dev=? AND size=?")
        .get(digest, before.dev, before.size) as { file: string } | undefined;
      if (candidate === undefined) {
        db.prepare("INSERT INTO evidence_dedup_candidates VALUES(?,?,?,?)").run(
          digest,
          before.dev,
          before.size,
          file,
        );
        continue;
      }
      const source = await NodeFSP.lstat(candidate.file);
      if (
        !source.isFile() ||
        source.ino === before.ino ||
        source.size !== before.size ||
        (await hashFile(candidate.file)) !== digest
      )
        continue;
      const temporary = NodePath.join(
        NodePath.dirname(file),
        `.maintenance-storage-${NodeCrypto.randomUUID()}`,
      );
      try {
        await checkAdmission();
        // FORCE never falls back to a full copy and cannot turn a deduplication pass into extra storage.
        await NodeFSP.copyFile(
          candidate.file,
          temporary,
          NodeFS.constants.COPYFILE_EXCL | NodeFS.constants.COPYFILE_FICLONE_FORCE,
        );
        if ((await hashFile(temporary)) !== digest || !unchanged(before, await NodeFSP.lstat(file)))
          continue;
        await NodeFSP.chown(temporary, before.uid, before.gid);
        await NodeFSP.chmod(temporary, before.mode & 0o7777);
        await NodeFSP.utimes(temporary, before.atime, before.mtime);
        const handle = await NodeFSP.open(temporary, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        await NodeFSP.rename(temporary, file);
        shared += 1;
        logicalSharedBytes += before.size;
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          ["ENOTSUP", "EOPNOTSUPP", "EXDEV", "EINVAL", "ENOSYS", "EPERM", "EACCES"].includes(
            String(cause.code),
          )
        )
          unsupported += 1;
        else throw cause;
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
    }
  } finally {
    db.exec("DROP TABLE evidence_dedup_candidates");
  }
  return { scanned, shared, logicalSharedBytes, unsupported };
}
