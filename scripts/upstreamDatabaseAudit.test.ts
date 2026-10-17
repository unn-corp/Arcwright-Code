// @effect-diagnostics nodeBuiltinImport:off - verify exact source SHA-256 in the Node-only merge checker.
import { describe, expect, it } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import { auditUpstreamDatabase, readMigrationManifest } from "./upstreamDatabaseAudit.ts";

const input = {
  upstream: [
    [1, "Base"],
    [2, "NewUpstream"],
  ] as const,
  registered: [
    { upstreamId: 1, forkId: 1, name: "Base" },
    { upstreamId: 2, forkId: 4, name: "NewUpstream" },
  ],
  deployed: [
    [1, "Base"],
    [3, "ForkFeature"],
    [4, "NewUpstream"],
  ] as const,
  historical: [
    [1, "Base"],
    [3, "ForkFeature"],
    [4, "NewUpstream"],
  ] as const,
  sources: [
    { upstreamPath: "base.ts", localPath: "base.ts", upstream: "original", local: "original" },
  ],
  patches: [],
};

describe("upstream database merge audit", () => {
  it("reads mapped IDs, comments, multiline tuples and imported aliases", () => {
    const manifest = `import Incoming from './incoming.ts';
      export const upstreamMigrationEntries = [
        // Ignore this fake terminator: ] as const;
        [
          36, 38, 'Incoming', Incoming,
        ], /* compatibility mapping */
      ] as const;`;
    expect(readMigrationManifest(manifest, "upstreamMigrationEntries", 2)).toEqual([
      [36, 38, "Incoming", "./incoming.ts"],
    ]);
  });
  it("rejects a newly wrapped migration instead of silently omitting it", () => {
    const manifest = `import Migration0001 from "./first.ts";
      import Migration0002 from "./second.ts";
      const migrationEntries = [
        [1, "First", Migration0001],
        [2, "Incoming", Migration0002.pipe(transform)],
      ] as const;`;
    expect(() => readMigrationManifest(manifest, "migrationEntries")).toThrow(/Unsupported/);
  });
  it("rejects migration bindings without a static default import", () => {
    expect(() =>
      readMigrationManifest(
        'const forkMigrationEntries = [[110, "Missing", Missing]] as const;',
        "forkMigrationEntries",
      ),
    ).toThrow(/no static default import/);
  });
  it("accepts preserved fork IDs even when their upstream numbers differ", () => {
    expect(auditUpstreamDatabase(input)).toEqual([]);
  });
  it("accepts Windows checkout line endings without hiding source changes", () => {
    expect(
      auditUpstreamDatabase({
        ...input,
        sources: [{ ...input.sources[0]!, upstream: "original\n", local: "original\r\n" }],
      }),
    ).toEqual([]);
  });
  it("detects an incoming upstream migration that would otherwise be skipped", () => {
    expect(
      auditUpstreamDatabase({ ...input, upstream: [...input.upstream, [3, "Incoming"]] }),
    ).toContain("Upstream migration 3_Incoming has no matching registry entry.");
  });
  it("detects renumbering and collisions in published fork identities", () => {
    const result = auditUpstreamDatabase({
      ...input,
      deployed: [
        [1, "Base"],
        [3, "Replaced"],
        [3, "NewUpstream"],
      ],
    });
    expect(result).toContain("Fork migration IDs and names must be unique.");
    expect(result).toContain("Published migration 3_ForkFeature was removed or renamed.");
    expect(result).toContain("Upstream 2_NewUpstream maps to the wrong fork identity 4.");
  });
  it("requires fresh review when either side of an allowed migration patch changes", () => {
    const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
    const patch = {
      upstreamPath: "base.ts",
      localPath: "base.ts",
      upstreamSha256: hash("original"),
      forkSha256: hash("fork"),
      reason: "Preserve fork data",
    };
    const reviewed = {
      ...input,
      sources: [{ ...input.sources[0]!, local: "fork" }],
      patches: [patch],
    };
    expect(auditUpstreamDatabase(reviewed)).toEqual([]);
    expect(
      auditUpstreamDatabase({
        ...reviewed,
        sources: [{ ...reviewed.sources[0]!, upstream: "new upstream" }],
      }),
    ).toContain("Unreviewed migration difference: base.ts -> base.ts.");
    expect(
      auditUpstreamDatabase({
        ...reviewed,
        sources: [{ ...reviewed.sources[0]!, local: "new fork" }],
      }),
    ).toContain("Unreviewed migration difference: base.ts -> base.ts.");
  });
});
