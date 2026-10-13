// @effect-diagnostics nodeBuiltinImport:off - Offline fixtures use independent file and Git evidence.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { afterEach, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Alchemy from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  artifactInventory,
  readFinalAssets,
  cloudflareAssetSnapshot,
  cleanSourceGit,
  verifyOwnedWebArtifact,
} from "./owned-connect-web-artifact.ts";
import {
  ownedPrivateAlchemyState,
  withOwnedPrivateAlchemyContext,
} from "./owned-connect-web-state.ts";
import { readOwnedWebDeployConfig } from "./owned-connect-web-config.ts";
import { selectConnectProfile } from "../../../packages/shared/src/connectProfile.ts";
import { connectProfileDigest } from "../../../scripts/lib/public-config.ts";

const dirs: string[] = [];
function fixture() {
  const path = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "owned-web-artifact-"));
  dirs.push(path);
  return path;
}
const publicFields = {
  T3CODE_CLERK_PUBLISHABLE_KEY: `pk_live_${btoa("clerk.arcwright.space$")}`,
  T3CODE_CLERK_JWT_TEMPLATE: "t3-relay",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "VS3HcN01wPJotPrs",
  T3CODE_RELAY_URL: "https://relay.arcwright.space",
  T3CODE_HOSTED_APP_URL: "https://connect.arcwright.space",
};
afterEach(() =>
  dirs.splice(0).forEach((dir) => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

describe("owned assets identity and private state", () => {
  it.effect(
    "captures the actual reader's extension-aware upload manifest and separate SHA inventory",
    () =>
      Effect.gen(function* () {
        const directory = fixture();
        NodeFS.writeFileSync(NodePath.join(directory, "index.html"), "same-body");
        NodeFS.writeFileSync(NodePath.join(directory, "shell.js"), "same-body");
        NodeFS.writeFileSync(
          NodePath.join(directory, "_headers"),
          "/*\n  Cache-Control: no-cache\n",
        );
        const result = yield* readFinalAssets(directory);
        expect(result.manifest["/index.html"]?.hash).toBe(
          NodeCrypto.createHash("sha256").update("same-bodyhtml").digest("hex").slice(0, 32),
        );
        expect(result.manifest["/shell.js"]?.hash).not.toBe(result.manifest["/index.html"]?.hash);
        expect(result.manifest).not.toHaveProperty("/_headers");
        expect(result.config?.htmlHandling).toBe("none");
        expect(result.config?.notFoundHandling).toBe("single-page-application");
        expect(result.config?.headers).toContain("no-cache");
        expect(artifactInventory(directory)["/index.html"]?.sha256).toBe(
          NodeCrypto.createHash("sha256").update("same-body").digest("hex"),
        );
      }),
  );
  it.effect("rejects byte/header additions or modifications after receipt capture", () =>
    Effect.gen(function* () {
      const repoRoot = fixture();
      const directory = fixture();
      const privateReceipts = fixture();
      NodeChildProcess.execFileSync("git", ["init", "--quiet", repoRoot]);
      NodeChildProcess.execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "--allow-empty",
          "--quiet",
          "-m",
          "fixture",
        ],
        { cwd: repoRoot },
      );
      NodeFS.writeFileSync(NodePath.join(directory, "index.html"), "<html>Arcwright</html>");
      const profile = selectConnectProfile("owned", [publicFields]);
      const receiptFile = NodePath.join(privateReceipts, "receipt.json");
      const receipt = {
        schemaVersion: 1,
        sourceGit: cleanSourceGit(repoRoot),
        directory,
        profile,
        profileDigest: connectProfileDigest(profile),
        inventory: artifactInventory(directory),
        cloudflare: cloudflareAssetSnapshot(yield* readFinalAssets(directory)),
      };
      NodeFS.writeFileSync(receiptFile, JSON.stringify(receipt));
      expect((yield* verifyOwnedWebArtifact(receiptFile, profile, repoRoot)).directory).toBe(
        directory,
      );
      NodeFS.writeFileSync(NodePath.join(directory, "_headers"), "/*\n  X-Test: modified\n");
      const exit = yield* Effect.exit(verifyOwnedWebArtifact(receiptFile, profile, repoRoot));
      expect(exit._tag).toBe("Failure");
      NodeFS.rmSync(NodePath.join(directory, "_headers"));
      NodeFS.writeFileSync(NodePath.join(directory, "index.html"), "different bytes");
      expect(
        (yield* Effect.exit(verifyOwnedWebArtifact(receiptFile, profile, repoRoot)))._tag,
      ).toBe("Failure");
    }),
  );
  it.effect("enforces the actual reader 25 MiB limit before hashing", () =>
    Effect.gen(function* () {
      const directory = fixture();
      const file = NodePath.join(directory, "large.wasm");
      NodeFS.writeFileSync(file, "");
      NodeFS.truncateSync(file, 25 * 1024 * 1024 + 1);
      const error = yield* readFinalAssets(directory).pipe(Effect.flip);
      expect(error._tag).toBe("AssetTooLargeError");
    }),
  );
  it("rejects source maps, secrets and upload symlinks", () => {
    const directory = fixture();
    NodeFS.writeFileSync(NodePath.join(directory, "bundle.js.map"), "{}");
    expect(() => artifactInventory(directory)).toThrow(/Nonpublic/);
    NodeFS.rmSync(NodePath.join(directory, "bundle.js.map"));
    NodeFS.writeFileSync(NodePath.join(directory, "private.js"), "sk_live_privatefixture");
    expect(() => artifactInventory(directory)).toThrow(/Private/);
    NodeFS.rmSync(NodePath.join(directory, "private.js"));
    NodeFS.symlinkSync("/etc/hosts", NodePath.join(directory, "hosts"));
    expect(() => artifactInventory(directory)).toThrow(/Symlink/);
  });
  it.effect(
    "executes the metadata-preserving Stack wrapper and private LocalState writes offline",
    () =>
      Effect.gen(function* () {
        const root = fixture();
        const directory = NodePath.join(root, "private-alchemy");
        const { context, state } = ownedPrivateAlchemyState(directory);
        const stack = Alchemy.Stack(
          "ArcwrightConnectWeb",
          { providers: Layer.empty, state },
          Effect.gen(function* () {
            return { privateDirectory: (yield* AlchemyContext).dotAlchemy };
          }),
        );
        const wrapped = withOwnedPrivateAlchemyContext(stack, context);
        expect(wrapped.stackName).toBe("ArcwrightConnectWeb");
        expect(wrapped.state).toBe(state);
        const compiled = yield* wrapped.pipe(
          Effect.provideService(Alchemy.Stage, "devotek-pilot"),
          Effect.provide(NodeServices.layer),
          Effect.scoped,
        );
        expect(compiled.output.privateDirectory).toBe(directory);
        expect(Context.get(compiled.services, AlchemyContext).dotAlchemy).toBe(directory);
        const storeEffect = Context.get(compiled.services, State);
        const store = yield* storeEffect;
        const identity = { stack: "ArcwrightConnectWeb", stage: "devotek-pilot" };
        yield* store.setOutput({ ...identity, value: { offlineProbe: true } });
        expect(yield* store.getOutput(identity)).toEqual({ offlineProbe: true });
        expect(
          NodeFS.existsSync(
            NodePath.join(
              directory,
              "state/ArcwrightConnectWeb/devotek-pilot/__stack_output__.json",
            ),
          ),
        ).toBe(true);
        expect(NodeFS.statSync(directory).mode & 0o777).toBe(0o700);
        expect(
          NodeFS.statSync(
            NodePath.join(
              directory,
              "state/ArcwrightConnectWeb/devotek-pilot/__stack_output__.json",
            ),
          ).mode & 0o777,
        ).toBe(0o600);
      }),
  );
  it("requires explicit authorized deployment scope and a matching public origin", () => {
    const root = fixture();
    const profileFile = NodePath.join(root, "profile.json");
    NodeFS.writeFileSync(profileFile, JSON.stringify(publicFields));
    const config = {
      accountId: "e0fa69f64063aa2670ad354549a34dd6",
      zoneId: "71edc69babf1a57c2abca300c28c8c27",
      hostname: "connect.arcwright.space",
      stage: "devotek-pilot",
      privateStateRoot: NodePath.join(root, "state"),
      artifactReceipt: NodePath.join(root, "receipt.json"),
      profileFile,
    };
    const file = NodePath.join(root, "config.json");
    NodeFS.writeFileSync(file, JSON.stringify(config));
    expect(readOwnedWebDeployConfig(file).hostname).toBe("connect.arcwright.space");
    NodeFS.writeFileSync(
      file,
      JSON.stringify({ ...config, zoneId: "00000000000000000000000000000000" }),
    );
    expect(() => readOwnedWebDeployConfig(file)).toThrow(/authorized/);
    NodeFS.writeFileSync(file, JSON.stringify(config));
    NodeFS.writeFileSync(
      profileFile,
      JSON.stringify({ ...publicFields, T3CODE_HOSTED_APP_URL: "https://different.test" }),
    );
    expect(() => readOwnedWebDeployConfig(file)).toThrow(/conflict/);
  });
});
