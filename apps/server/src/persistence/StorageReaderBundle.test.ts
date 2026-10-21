// @effect-diagnostics nodeBuiltinImport:off - builds and executes an isolated artifact fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import { build } from "vite-plus/pack";
import { expect, it } from "vite-plus/test";
import serverConfig from "../../vite.config.ts";

it("preserves compressed storage functions in the bundled server reader worker", async () => {
  const outDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "arcwright-reader-bundle-"));
  try {
    // Reuse the actual server pack configuration: serialized worker functions must
    // survive its dependency inlining and compiler transforms, not just TS tests.
    await build({
      ...serverConfig.pack,
      config: false,
      entry: [
        NodeURL.fileURLToPath(
          new URL("../../../../scripts/fixtures/storage-reader-smoke.ts", import.meta.url),
        ),
      ],
      outDir,
      sourcemap: false,
      banner: undefined,
    });
    const result = await NodeUtil.promisify(NodeChildProcess.execFile)(
      process.execPath,
      [NodePath.join(outDir, "storage-reader-smoke.mjs")],
      { timeout: 30000 },
    );
    expect(result.stdout).toContain("gzip, Brotli, byte counts and corruption checks passed");
  } finally {
    await NodeFSP.rm(outDir, { recursive: true, force: true });
  }
});
