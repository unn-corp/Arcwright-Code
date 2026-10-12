// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import { deduplicateEvidence } from "./forkEvidenceDedup.ts";

it("preserves independent source-tree edits and references when evidence supports copy-on-write sharing", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "evidence-dedup-"));
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    const first = NodePath.join(root, "first.ts"),
      second = NodePath.join(root, "second.ts");
    const bytes = "source evidence\n".repeat(1000);
    await NodeFSP.writeFile(first, bytes, { mode: 0o600 });
    await NodeFSP.writeFile(second, bytes, { mode: 0o640 });
    await NodeFSP.symlink(first, NodePath.join(root, "external-link"));
    const report = await deduplicateEvidence(root, db, async () => {});
    expect(report.shared + report.unsupported).toBe(1);
    expect(await NodeFSP.readFile(second, "utf8")).toBe(bytes);
    expect((await NodeFSP.lstat(second)).mode & 0o777).toBe(0o640);
    expect((await NodeFSP.lstat(first)).ino).not.toBe((await NodeFSP.lstat(second)).ino);
    await NodeFSP.writeFile(first, "changed independently");
    expect(await NodeFSP.readFile(second, "utf8")).toBe(bytes);
    expect((await NodeFSP.lstat(NodePath.join(root, "external-link"))).isSymbolicLink()).toBe(true);
  } finally {
    db.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
