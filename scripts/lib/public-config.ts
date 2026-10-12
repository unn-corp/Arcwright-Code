// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap reads optional root env files before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import * as NodeBuffer from "node:buffer";
import {
  CONNECT_PUBLIC_KEYS,
  connectProfileEnv,
  hasConnectPublicFields,
  resolveConnectMode,
  selectConnectProfile,
  serializeConnectProfile,
  type ConnectMode,
  type ConnectProfileReceipt,
} from "../../packages/shared/src/connectProfile.ts";

export interface T3CodePublicConfig {
  readonly connectMode?: ConnectMode;
  readonly hostedAppUrl?: string;
  readonly clerkPublishableKey: string | undefined;
  readonly clerkJwtTemplate: string | undefined;
  readonly clerkCliOAuthClientId: string | undefined;
  readonly relayUrl: string | undefined;
  readonly mobileOtlpTracesUrl: string | undefined;
  readonly mobileOtlpTracesDataset: string | undefined;
  readonly mobileOtlpTracesToken: string | undefined;
  readonly relayClientOtlpTracesUrl: string | undefined;
  readonly relayClientOtlpTracesDataset: string | undefined;
  readonly relayClientOtlpTracesToken: string | undefined;
}

type Environment = Readonly<Record<string, string | undefined>>;

const REPO_ROOT = NodePath.dirname(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
);

export function loadRepoEnv({
  baseEnv = process.env,
  repoRoot = REPO_ROOT,
}: {
  readonly baseEnv?: Environment;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  const rootEnv = readEnvFile(NodePath.join(repoRoot, ".env"));
  const localEnv = readEnvFile(NodePath.join(repoRoot, ".env.local"));
  const sources = [baseEnv, localEnv, rootEnv];
  const mode = resolveConnectMode(firstNonEmpty(sources, "T3CODE_CONNECT_MODE"));
  const profileFile = firstNonEmpty(sources, "T3CODE_CONNECT_PROFILE_FILE");
  if (profileFile && mode !== "owned") {
    throw new Error("A Connect public profile file requires owned mode.");
  }
  const profile = profileFile
    ? selectConnectProfile("owned", [readPublicProfileFile(repoRoot, profileFile)])
    : selectConnectProfile(mode, sources);
  if (profileFile && hasConnectPublicFields(baseEnv)) {
    const processProfile = selectConnectProfile("owned", [baseEnv]);
    if (serializeConnectProfile(profile) !== serializeConnectProfile(processProfile)) {
      throw new Error(
        "Process Connect public profile conflicts with the selected public profile file.",
      );
    }
  }
  const config = resolveLegacyPublicConfig(...sources);

  return {
    ...rootEnv,
    ...localEnv,
    ...baseEnv,
    ...(config.clerkPublishableKey
      ? {
          T3CODE_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
          VITE_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
          EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
        }
      : {}),
    ...(config.clerkJwtTemplate
      ? {
          T3CODE_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
          VITE_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
          EXPO_PUBLIC_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
        }
      : {}),
    ...(config.clerkCliOAuthClientId
      ? {
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: config.clerkCliOAuthClientId,
          VITE_CLERK_CLI_OAUTH_CLIENT_ID: config.clerkCliOAuthClientId,
        }
      : {}),
    ...(config.relayUrl
      ? {
          T3CODE_RELAY_URL: config.relayUrl,
          VITE_T3CODE_RELAY_URL: config.relayUrl,
        }
      : {}),
    ...(profile.T3CODE_HOSTED_APP_URL && mode === "legacy"
      ? {
          T3CODE_HOSTED_APP_URL: profile.T3CODE_HOSTED_APP_URL,
          VITE_CONNECT_HOSTED_APP_URL: profile.T3CODE_HOSTED_APP_URL,
          EXPO_PUBLIC_CONNECT_HOSTED_APP_URL: profile.T3CODE_HOSTED_APP_URL,
        }
      : {}),
    ...(mode !== "legacy" ? connectProfileEnv(profile) : {}),
    ...(config.mobileOtlpTracesUrl
      ? {
          T3CODE_MOBILE_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
          EXPO_PUBLIC_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
        }
      : {}),
    ...(config.mobileOtlpTracesDataset
      ? {
          T3CODE_MOBILE_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
          EXPO_PUBLIC_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
        }
      : {}),
    ...(config.mobileOtlpTracesToken
      ? {
          T3CODE_MOBILE_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
          EXPO_PUBLIC_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
        }
      : {}),
    ...(config.relayClientOtlpTracesUrl
      ? {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
          VITE_RELAY_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
        }
      : {}),
    ...(config.relayClientOtlpTracesDataset
      ? {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: config.relayClientOtlpTracesDataset,
          VITE_RELAY_OTLP_TRACES_DATASET: config.relayClientOtlpTracesDataset,
        }
      : {}),
    ...(config.relayClientOtlpTracesToken
      ? {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: config.relayClientOtlpTracesToken,
          VITE_RELAY_OTLP_TRACES_TOKEN: config.relayClientOtlpTracesToken,
        }
      : {}),
  };
}

function resolveLegacyPublicConfig(...sources: readonly Environment[]): T3CodePublicConfig {
  return {
    clerkPublishableKey: firstNonEmpty(
      sources,
      "T3CODE_CLERK_PUBLISHABLE_KEY",
      "VITE_CLERK_PUBLISHABLE_KEY",
      "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    ),
    clerkJwtTemplate: firstNonEmpty(
      sources,
      "T3CODE_CLERK_JWT_TEMPLATE",
      "VITE_CLERK_JWT_TEMPLATE",
      "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
    ),
    clerkCliOAuthClientId: firstNonEmpty(
      sources,
      "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
      "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
    ),
    relayUrl: firstNonEmpty(sources, "T3CODE_RELAY_URL", "VITE_T3CODE_RELAY_URL"),
    mobileOtlpTracesUrl: firstNonEmpty(
      sources,
      "T3CODE_MOBILE_OTLP_TRACES_URL",
      "EXPO_PUBLIC_OTLP_TRACES_URL",
    ),
    mobileOtlpTracesDataset: firstNonEmpty(
      sources,
      "T3CODE_MOBILE_OTLP_TRACES_DATASET",
      "EXPO_PUBLIC_OTLP_TRACES_DATASET",
    ),
    mobileOtlpTracesToken: firstNonEmpty(
      sources,
      "T3CODE_MOBILE_OTLP_TRACES_TOKEN",
      "EXPO_PUBLIC_OTLP_TRACES_TOKEN",
    ),
    relayClientOtlpTracesUrl: firstNonEmpty(
      sources,
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
      "VITE_RELAY_OTLP_TRACES_URL",
    ),
    relayClientOtlpTracesDataset: firstNonEmpty(
      sources,
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
      "VITE_RELAY_OTLP_TRACES_DATASET",
    ),
    relayClientOtlpTracesToken: firstNonEmpty(
      sources,
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
      "VITE_RELAY_OTLP_TRACES_TOKEN",
    ),
  };
}

function firstNonEmpty(sources: readonly Environment[], ...names: readonly string[]) {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readEnvFile(path: string): Record<string, string | undefined> {
  return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
}

export function resolvePublicConfig(...sources: readonly Environment[]): T3CodePublicConfig {
  const mode = resolveConnectMode(firstNonEmpty(sources, "T3CODE_CONNECT_MODE"));
  const legacy = resolveLegacyPublicConfig(...sources);
  if (mode === "legacy") {
    const hostedAppUrl = firstNonEmpty(
      sources,
      "T3CODE_HOSTED_APP_URL",
      "VITE_CONNECT_HOSTED_APP_URL",
    );
    return { ...legacy, ...(hostedAppUrl ? { hostedAppUrl } : {}) };
  }
  const profile = selectConnectProfile(mode, sources);
  return {
    ...legacy,
    connectMode: mode,
    clerkPublishableKey: profile.T3CODE_CLERK_PUBLISHABLE_KEY,
    clerkJwtTemplate: profile.T3CODE_CLERK_JWT_TEMPLATE,
    clerkCliOAuthClientId: profile.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID,
    relayUrl: profile.T3CODE_RELAY_URL,
    hostedAppUrl: profile.T3CODE_HOSTED_APP_URL,
  };
}

export function connectProfileReceipt(env: Environment): ConnectProfileReceipt {
  return selectConnectProfile(resolveConnectMode(env.T3CODE_CONNECT_MODE), [env]);
}

export function connectProfileDigest(receipt: ConnectProfileReceipt): string {
  const normalized = selectConnectProfile(receipt.mode, [
    Object.fromEntries(CONNECT_PUBLIC_KEYS.map((key) => [key, receipt[key]])),
  ]);
  return NodeCrypto.createHash("sha256").update(serializeConnectProfile(normalized)).digest("hex");
}

function readPublicProfileFile(repoRoot: string, profileFile: string): Environment {
  try {
    const path = NodePath.resolve(repoRoot, profileFile);
    // Regular files only: never block build bootstrap on a pipe or device.
    const fd = NodeFS.openSync(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK);
    let content: string;
    try {
      const stat = NodeFS.fstatSync(fd);
      if (!stat.isFile() || stat.size > 16 * 1024) throw new Error("invalid file");
      const bytes = NodeBuffer.Buffer.alloc(16 * 1024 + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = NodeFS.readSync(fd, bytes, length, bytes.length - length, length);
        if (count === 0) break;
        length += count;
      }
      if (length > 16 * 1024) throw new Error("oversized file");
      content = bytes.subarray(0, length).toString("utf8");
    } finally {
      NodeFS.closeSync(fd);
    }
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid object");
    const entries = Object.entries(parsed);
    if (
      entries.length !== CONNECT_PUBLIC_KEYS.length ||
      entries.some(
        ([key, value]) =>
          !CONNECT_PUBLIC_KEYS.some((allowed) => allowed === key) || typeof value !== "string",
      )
    ) {
      throw new Error("invalid public keys");
    }
    return Object.fromEntries(entries);
  } catch {
    throw new Error(
      "Cannot read Connect public profile file; require a regular JSON file of at most 16 KiB with exactly the five public keys.",
    );
  }
}

/** Recovery needs the original artifact's profile, never the current build's ambient profile. */
export function assertLegacyRecoveryConnectSelection(env: Environment): void {
  if (
    resolveConnectMode(env.T3CODE_CONNECT_MODE) !== "legacy" ||
    env.T3CODE_CONNECT_PROFILE_FILE?.trim()
  ) {
    throw new Error(
      "Recovery builds require the original artifact Connect profile; owned and cloudless recovery are unavailable until artifact profile provenance is supplied.",
    );
  }
}
