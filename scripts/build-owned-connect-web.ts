#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Offline CLI bootstrap and final public summary.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { applyWebBrandAssets } from "./apply-web-brand-assets.ts";
import { ownedHostedBuildEnv } from "./lib/owned-connect-web-env.ts";
import { loadRepoEnv, connectProfileReceipt, connectProfileDigest } from "./lib/public-config.ts";
import { clerkFrontendApiUrlFromPublishableKey } from "../packages/shared/src/relayAuth.ts";
import {
  CONNECT_PUBLIC_KEYS,
  CONNECT_PUBLIC_ALIASES,
  type ConnectEnvironment,
} from "../packages/shared/src/connectProfile.ts";
import {
  readBoundedJson,
  renderOwnedPublicPages,
  ownedHostedHeaders,
  type PublicationStatus,
} from "./lib/owned-connect-web-content.ts";
import {
  REPO_ROOT,
  cleanSourceGit,
  assertExternalPath,
  artifactInventory,
  compiledProfileProof,
  readFinalAssets,
  cloudflareAssetSnapshot,
  freezeArtifact,
  verifyOwnedWebArtifact,
} from "../infra/relay/scripts/owned-connect-web-artifact.ts";

export async function buildOwnedConnectWeb(
  options: {
    profileFile: string;
    contentConfig: string;
    content: string;
    reviewedContentSha256: string;
    outputRoot: string;
    status: PublicationStatus;
  },
  ambient: ConnectEnvironment = process.env,
) {
  process.umask(0o077);
  const sourceGit = cleanSourceGit();
  assertExternalPath(options.outputRoot, "Hosted artifact root");
  // Inspect only public profile/surface inputs. Credentials are never copied into the compiler.
  const selected: Record<string, string | undefined> = {};
  for (const key of [
    ...CONNECT_PUBLIC_KEYS.flatMap((key) => [key, ...CONNECT_PUBLIC_ALIASES[key]]),
    "T3CODE_CONNECT_MODE",
    "T3CODE_CONNECT_PROFILE_FILE",
    "VITE_HOSTED_APP_URL",
    "VITE_ANDROID_PWA",
    "VITE_HOSTED_APP_CHANNEL",
    "VITE_HTTP_URL",
    "VITE_WS_URL",
    "VERCEL_URL",
    "VERCEL_PROJECT_PRODUCTION_URL",
  ])
    selected[key] = ambient[key];
  if (selected.T3CODE_CONNECT_MODE && selected.T3CODE_CONNECT_MODE !== "owned")
    throw new Error("Ambient Connect mode conflicts with owned hosted build.");
  if (
    selected.T3CODE_CONNECT_PROFILE_FILE &&
    selected.T3CODE_CONNECT_PROFILE_FILE !== options.profileFile
  )
    throw new Error("Ambient public profile file conflicts with selected input.");
  selected.T3CODE_CONNECT_MODE = "owned";
  selected.T3CODE_CONNECT_PROFILE_FILE = options.profileFile;
  const compileEnv = ownedHostedBuildEnv(selected);
  const profile = connectProfileReceipt(loadRepoEnv({ baseEnv: compileEnv, readEnvFiles: false }));
  const config = readBoundedJson(options.contentConfig);
  const draft = readBoundedJson(options.content);
  if (
    !/^[0-9a-f]{64}$/.test(options.reviewedContentSha256) ||
    draft.sha256 !== options.reviewedContentSha256
  )
    throw new Error("Reviewed public content digest does not match selected content.");
  const pages = renderOwnedPublicPages({
    config: config.value,
    draft: draft.value,
    origin: profile.T3CODE_HOSTED_APP_URL,
    status: options.status,
  });
  // Clear tracing aliases in this process too; the child receives an allowlist only.
  for (const key of Object.keys(process.env)) if (/OTLP|^OTEL_/.test(key)) delete process.env[key];
  NodeFS.mkdirSync(options.outputRoot, { mode: 0o700 });
  const directory = NodePath.join(options.outputRoot, "assets");
  const childEnv: Record<string, string> = {
    ...compileEnv,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
    CI: "true",
  };
  NodeChildProcess.execFileSync(
    NodePath.join(REPO_ROOT, "node_modules/.bin/vp"),
    ["build", "--outDir", directory],
    { cwd: NodePath.join(REPO_ROOT, "apps/web"), env: childEnv, stdio: "inherit" },
  );
  await Effect.runPromise(
    applyWebBrandAssets("production", directory).pipe(Effect.provide(NodeServices.layer)),
  );
  NodeFS.writeFileSync(NodePath.join(directory, "about.html"), pages.about);
  NodeFS.writeFileSync(NodePath.join(directory, "privacy.html"), pages.privacy);
  NodeFS.writeFileSync(
    NodePath.join(directory, "_headers"),
    ownedHostedHeaders(clerkFrontendApiUrlFromPublishableKey(profile.T3CODE_CLERK_PUBLISHABLE_KEY)),
  );
  NodeFS.writeFileSync(
    NodePath.join(directory, "connect-profile.json"),
    `${JSON.stringify({ ...profile, digest: connectProfileDigest(profile) }, null, 2)}\n`,
  );
  const compiledProof = await compiledProfileProof(directory, profile);
  const inventory = artifactInventory(directory);
  const cloudflare = await Effect.runPromise(readFinalAssets(directory));
  if (cleanSourceGit() !== sourceGit) throw new Error("Source changed during owned hosted build.");
  const receipt = {
    schemaVersion: 1,
    sourceGit,
    directory,
    profile,
    profileDigest: connectProfileDigest(profile),
    publicationStatus: options.status,
    contentSha256: draft.sha256,
    contentConfigSha256: config.sha256,
    compiledProof,
    inventory,
    cloudflare: cloudflareAssetSnapshot(cloudflare),
    deploymentStatus: "offline-artifact-only",
  };
  const receiptFile = NodePath.join(options.outputRoot, "build-receipt.json");
  NodeFS.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  freezeArtifact(directory);
  await Effect.runPromise(verifyOwnedWebArtifact(receiptFile, profile));
  return {
    sourceGit,
    directory,
    receiptFile,
    profileDigest: receipt.profileDigest,
    cloudflareHash: cloudflare.hash,
    assets: Object.keys(cloudflare.manifest).length,
    publicationStatus: options.status,
  };
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      profile: { type: "string" },
      "content-config": { type: "string" },
      content: { type: "string" },
      "reviewed-content-sha256": { type: "string" },
      "output-root": { type: "string" },
      status: { type: "string" },
    },
  });
  if (
    !values.profile ||
    !values["content-config"] ||
    !values.content ||
    !values["reviewed-content-sha256"] ||
    !values["output-root"] ||
    (values.status !== "preparing" && values.status !== "ready")
  )
    throw new Error(
      "Require --profile --content-config --content --reviewed-content-sha256 --output-root --status preparing|ready.",
    );
  console.log(
    JSON.stringify(
      await buildOwnedConnectWeb({
        profileFile: values.profile,
        contentConfig: values["content-config"],
        content: values.content,
        reviewedContentSha256: values["reviewed-content-sha256"],
        outputRoot: values["output-root"],
        status: values.status,
      }),
      null,
      2,
    ),
  );
}
