// @effect-diagnostics nodeBuiltinImport:off - Offline artifact identity uses independent Node file hashes and Git provenance.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CONNECT_PUBLIC_KEYS,
  serializeConnectProfile,
  type ConnectProfileReceipt,
} from "../../../packages/shared/src/connectProfile.ts";
import { connectProfileDigest } from "../../../scripts/lib/public-config.ts";
import { jsonObject, readBoundedJson } from "../../../scripts/lib/owned-connect-web-content.ts";

export const REPO_ROOT = NodePath.resolve(
  NodeURL.fileURLToPath(new URL("../../..", import.meta.url)),
);
export const OWNED_WEB_ASSETS_OPTIONS = {
  htmlHandling: "none",
  notFoundHandling: "single-page-application",
} as const;

export function cleanSourceGit(repoRoot = REPO_ROOT) {
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--untracked-files=all"))
    throw new Error("Owned hosted artifacts require a clean source checkout.");
  return git("rev-parse", "HEAD");
}

export function assertExternalPath(path: string, label: string, repoRoot = REPO_ROOT) {
  if (
    !NodePath.isAbsolute(path) ||
    NodePath.resolve(path) !== path ||
    path === "/" ||
    path === repoRoot ||
    path.startsWith(`${repoRoot}/`)
  )
    throw new Error(
      `${label} must be an explicit canonical directory outside the source checkout.`,
    );
  // Existing ancestors must never redirect into an unrelated home or upload tree.
  let ancestor = path;
  while (!NodeFS.existsSync(ancestor)) ancestor = NodePath.dirname(ancestor);
  if (NodeFS.realpathSync(ancestor) !== ancestor)
    throw new Error(`${label} cannot use symbolic-link ancestors.`);
}

export function artifactInventory(directory: string) {
  const result: Record<string, { sha256: string; size: number }> = {};
  function walk(relative: string) {
    for (const name of NodeFS.readdirSync(NodePath.join(directory, relative)).sort()) {
      const path = NodePath.join(relative, name);
      const absolute = NodePath.join(directory, path);
      const stat = NodeFS.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error("Symlinks cannot enter a hosted upload tree.");
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (
        !stat.isFile() ||
        /(?:^|\/)(?:\.env[^/]*|\.alchemy|.*\.map|.*\.log|.*(?:receipt|draft|analysis).*\.(?:json|md|txt|html))$/.test(
          path,
        )
      )
        throw new Error("Nonpublic file in hosted upload tree.");
      if (stat.size > 25 * 1024 * 1024) throw new Error("Hosted asset exceeds 25 MiB.");
      const bytes = NodeFS.readFileSync(absolute);
      // Credential-shaped values and operator homes are forbidden even in otherwise public JS.
      if (
        /\.(?:html|js|css|json|txt)$/.test(path) &&
        /(?:sk_(?:live|test)_[A-Za-z0-9]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\/home\/devotek\/|\.local\/state\/arcwright|CLOUDFLARE_API_TOKEN\s*[=:]\s*["']?[A-Za-z0-9_-]{20})/.test(
          bytes.toString("utf8"),
        )
      )
        throw new Error("Private material in hosted upload tree.");
      result[`/${path.split(NodePath.sep).join("/")}`] = {
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      };
    }
  }
  walk("");
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

export const readFinalAssets = (directory: string) =>
  Cloudflare.readAssets({ directory, ...OWNED_WEB_ASSETS_OPTIONS }).pipe(
    Effect.provide(NodeServices.layer),
  );
/** Preserve absent rule files across the receipt's JSON round trip. */
export function cloudflareAssetSnapshot(value: Effect.Success<ReturnType<typeof readFinalAssets>>) {
  return { ...value, _headers: value._headers ?? null, _redirects: value._redirects ?? null };
}

export async function compiledProfileProof(directory: string, profile: ConnectProfileReceipt) {
  const files = NodeFS.readdirSync(NodePath.join(directory, "assets")).filter((name) =>
    /^connect-profile-compiled-[\w-]+\.js$/.test(name),
  );
  if (files.length !== 1) throw new Error("Missing actual compiler profile proof chunk.");
  const file = `assets/${files[0]!}`;
  const value: unknown = await import(NodeURL.pathToFileURL(NodePath.join(directory, file)).href);
  const module = jsonObject(value);
  const compiled = jsonObject(module.compiled);
  const expected = JSON.parse(serializeConnectProfile(profile)) as unknown;
  const normalized = {
    schemaVersion: compiled.schemaVersion,
    mode: compiled.mode,
    ...Object.fromEntries(CONNECT_PUBLIC_KEYS.map((key) => [key, compiled[key]])),
  };
  if (
    Object.keys(compiled).length !== 7 ||
    JSON.stringify(normalized) !== JSON.stringify(expected) ||
    module.digest !== connectProfileDigest(profile)
  )
    throw new Error("Actual compiled Connect profile differs from selected profile.");
  const surface = jsonObject(module.surface);
  if (
    surface.hosted !== profile.T3CODE_HOSTED_APP_URL ||
    ["channel", "http", "ws", "android", "tracingUrl", "tracingDataset", "tracingToken"].some(
      (key) => surface[key] !== "",
    )
  )
    throw new Error("Actual compiled hosted surface or tracing inputs differ.");
  return { file, compiled: normalized, digest: module.digest, surface };
}

export function freezeArtifact(directory: string) {
  function freeze(path: string) {
    const stat = NodeFS.lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of NodeFS.readdirSync(path)) freeze(NodePath.join(path, name));
      NodeFS.chmodSync(path, 0o500);
    } else NodeFS.chmodSync(path, 0o400);
  }
  freeze(directory);
}

export const verifyOwnedWebArtifact = Effect.fn(function* (
  receiptFile: string,
  profile: ConnectProfileReceipt,
  repoRoot = REPO_ROOT,
) {
  const receipt = jsonObject(readBoundedJson(receiptFile, 16 * 1024 * 1024).value);
  const directory = receipt.directory;
  if (typeof directory !== "string") throw new Error("Invalid hosted artifact receipt directory.");
  assertExternalPath(directory, "Hosted output");
  if (
    receipt.schemaVersion !== 1 ||
    receipt.sourceGit !== cleanSourceGit(repoRoot) ||
    receipt.profileDigest !== connectProfileDigest(profile) ||
    !NodeUtil.isDeepStrictEqual(receipt.profile, profile)
  )
    throw new Error("Hosted artifact receipt source/profile provenance mismatch.");
  const inventory = artifactInventory(directory);
  if (!NodeUtil.isDeepStrictEqual(inventory, receipt.inventory))
    throw new Error("Hosted artifact changed after its final manifest was captured.");
  const cloudflare = yield* readFinalAssets(directory);
  if (!NodeUtil.isDeepStrictEqual(cloudflareAssetSnapshot(cloudflare), receipt.cloudflare))
    throw new Error("Actual Cloudflare upload manifest/config changed after capture.");
  if (Object.keys(cloudflare.manifest).length > 20_000)
    throw new Error("Hosted upload exceeds 20,000 assets.");
  return { directory, receipt, cloudflare };
});
