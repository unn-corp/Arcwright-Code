import { clerkFrontendApiUrlFromPublishableKey } from "./relayAuth.ts";

export type ConnectMode = "legacy" | "owned" | "cloudless";
export type ConnectEnvironment = Readonly<Record<string, string | undefined>>;

export const CONNECT_PUBLIC_KEYS = [
  "T3CODE_CLERK_PUBLISHABLE_KEY",
  "T3CODE_CLERK_JWT_TEMPLATE",
  "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
  "T3CODE_RELAY_URL",
  "T3CODE_HOSTED_APP_URL",
] as const;
export type ConnectPublicKey = (typeof CONNECT_PUBLIC_KEYS)[number];
export type ConnectPublicFields = Readonly<Record<ConnectPublicKey, string>>;
export type ConnectProfileReceipt = ConnectPublicFields & {
  readonly schemaVersion: 1;
  readonly mode: ConnectMode;
};

export const CONNECT_PUBLIC_ALIASES = {
  T3CODE_CLERK_PUBLISHABLE_KEY: [
    "VITE_CLERK_PUBLISHABLE_KEY",
    "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "T3_PWA_CLERK_PUBLISHABLE_KEY",
  ],
  T3CODE_CLERK_JWT_TEMPLATE: [
    "VITE_CLERK_JWT_TEMPLATE",
    "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
    "T3_PWA_CLERK_JWT_TEMPLATE",
  ],
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: [
    "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
    "EXPO_PUBLIC_CLERK_CLI_OAUTH_CLIENT_ID",
    "T3_PWA_CLERK_CLI_OAUTH_CLIENT_ID",
  ],
  T3CODE_RELAY_URL: ["VITE_T3CODE_RELAY_URL", "EXPO_PUBLIC_T3CODE_RELAY_URL", "T3_PWA_RELAY_URL"],
  // VITE_HOSTED_APP_URL classifies the local surface and is deliberately separate.
  T3CODE_HOSTED_APP_URL: [
    "VITE_CONNECT_HOSTED_APP_URL",
    "EXPO_PUBLIC_CONNECT_HOSTED_APP_URL",
    "T3_PWA_HOSTED_APP_URL",
  ],
} as const satisfies Record<ConnectPublicKey, readonly string[]>;

const CONNECT_GOOGLE_ALIASES = [
  "EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID",
  "EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID",
  "EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID",
  "EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME",
] as const;

export function resolveConnectMode(value: string | undefined): ConnectMode {
  const mode = value?.trim() || "legacy";
  if (mode !== "legacy" && mode !== "owned" && mode !== "cloudless") {
    throw new Error("Invalid T3CODE_CONNECT_MODE; use legacy, owned or cloudless.");
  }
  return mode;
}

export function hasConnectPublicFields(source: ConnectEnvironment): boolean {
  return CONNECT_PUBLIC_KEYS.some((key) =>
    [key, ...CONNECT_PUBLIC_ALIASES[key]].some((name) => source[name] !== undefined),
  );
}

function readFields(source: ConnectEnvironment, strict: boolean): ConnectPublicFields {
  const read = (key: ConnectPublicKey) => {
    const values = [key, ...CONNECT_PUBLIC_ALIASES[key]]
      .map((name) => source[name]?.trim())
      .filter((value) => value !== undefined);
    if (strict && new Set(values).size > 1) {
      throw new Error(`Conflicting Connect aliases for ${key}.`);
    }
    return values.find((value) => value !== "") ?? "";
  };
  return {
    T3CODE_CLERK_PUBLISHABLE_KEY: read("T3CODE_CLERK_PUBLISHABLE_KEY"),
    T3CODE_CLERK_JWT_TEMPLATE: read("T3CODE_CLERK_JWT_TEMPLATE"),
    T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: read("T3CODE_CLERK_CLI_OAUTH_CLIENT_ID"),
    T3CODE_RELAY_URL: read("T3CODE_RELAY_URL"),
    T3CODE_HOSTED_APP_URL: read("T3CODE_HOSTED_APP_URL"),
  };
}

function normalizeOwnedConnectOrigin(value: string, field: string): string {
  try {
    // URL parsing erases dot segments and repairs missing authority slashes.
    // Admit origin syntax first so those inputs cannot become valid origins.
    if (
      !/^https:\/\/[^/?#\\@]+\/?$/i.test(value) ||
      value.length > 2048 ||
      /[\s\\?#]/.test(value) ||
      Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      throw new Error("invalid origin syntax");
    const url = new URL(value);
    const hostname = url.hostname.replace(/\.+$/, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      hostname === "t3.codes" ||
      hostname.endsWith(".t3.codes")
    )
      throw new Error("invalid origin");
    return url.origin;
  } catch {
    throw new Error(`Invalid owned Connect HTTPS origin for ${field}.`);
  }
}

function validateOwnedConnectFields(fields: ConnectPublicFields): ConnectPublicFields {
  if (CONNECT_PUBLIC_KEYS.some((key) => !fields[key])) {
    throw new Error(
      "Owned Connect requires one complete source containing all five public fields.",
    );
  }
  const key = fields.T3CODE_CLERK_PUBLISHABLE_KEY;
  if (key.length > 1024 || !/^pk_(?:test|live)_[A-Za-z0-9+/=_-]+$/.test(key)) {
    throw new Error("Invalid owned Connect Clerk publishable key.");
  }
  try {
    normalizeOwnedConnectOrigin(clerkFrontendApiUrlFromPublishableKey(key), "Clerk issuer");
  } catch {
    throw new Error("Invalid owned Connect Clerk issuer or publishable key.");
  }
  for (const name of ["T3CODE_CLERK_JWT_TEMPLATE", "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID"] as const) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(fields[name])) {
      throw new Error(`Invalid owned Connect public identifier for ${name}.`);
    }
  }
  return {
    ...fields,
    T3CODE_RELAY_URL: normalizeOwnedConnectOrigin(fields.T3CODE_RELAY_URL, "relay"),
    T3CODE_HOSTED_APP_URL: normalizeOwnedConnectOrigin(fields.T3CODE_HOSTED_APP_URL, "hosted app"),
  };
}

/** Chooses a whole source. An empty higher source field still counts as an override. */
export function selectConnectProfile(
  mode: ConnectMode,
  sources: readonly ConnectEnvironment[],
): ConnectProfileReceipt {
  const empty = readFields({}, false);
  if (mode === "cloudless") return { schemaVersion: 1, mode, ...empty };
  if (mode === "owned") {
    const source = sources.find(hasConnectPublicFields) ?? {};
    return { schemaVersion: 1, mode, ...validateOwnedConnectFields(readFields(source, true)) };
  }
  const fields = { ...empty };
  for (const key of CONNECT_PUBLIC_KEYS) {
    fields[key] = sources.map((source) => readFields(source, false)[key]).find(Boolean) ?? "";
  }
  return { schemaVersion: 1, mode, ...fields };
}

/** Explicit public receipt order is the serialization contract for build provenance. */
export function serializeConnectProfile(receipt: ConnectProfileReceipt): string {
  return JSON.stringify({
    schemaVersion: 1,
    mode: receipt.mode,
    T3CODE_CLERK_PUBLISHABLE_KEY: receipt.T3CODE_CLERK_PUBLISHABLE_KEY,
    T3CODE_CLERK_JWT_TEMPLATE: receipt.T3CODE_CLERK_JWT_TEMPLATE,
    T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: receipt.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID,
    T3CODE_RELAY_URL: receipt.T3CODE_RELAY_URL,
    T3CODE_HOSTED_APP_URL: receipt.T3CODE_HOSTED_APP_URL,
  });
}

export function connectProfileEnv(receipt: ConnectProfileReceipt): Record<string, string> {
  const env: Record<string, string> = {
    T3CODE_CONNECT_MODE: receipt.mode,
    VITE_CONNECT_MODE: receipt.mode,
    EXPO_PUBLIC_CONNECT_MODE: receipt.mode,
    T3_PWA_CONNECT_MODE: receipt.mode,
  };
  for (const key of CONNECT_PUBLIC_KEYS) {
    for (const name of [key, ...CONNECT_PUBLIC_ALIASES[key]]) env[name] = receipt[key];
  }
  if (receipt.mode === "cloudless") {
    for (const name of CONNECT_GOOGLE_ALIASES) env[name] = "";
  }
  return env;
}

/** Build-selected modes stay authoritative; runtime owned alternatives must be complete. */
export function effectiveConnectProfile(
  build: ConnectProfileReceipt,
  runtime: ConnectEnvironment,
): ConnectProfileReceipt {
  const runtimeMode = runtime.T3CODE_CONNECT_MODE?.trim();
  if (build.mode !== "legacy" && runtimeMode && resolveConnectMode(runtimeMode) !== build.mode) {
    throw new Error("Runtime Connect mode conflicts with the selected build mode.");
  }
  const mode = build.mode === "legacy" ? resolveConnectMode(runtimeMode) : build.mode;
  return selectConnectProfile(
    mode,
    hasConnectPublicFields(runtime)
      ? [runtime]
      : build.mode === "owned" || mode === "legacy"
        ? [Object.fromEntries(CONNECT_PUBLIC_KEYS.map((key) => [key, build[key]]))]
        : [],
  );
}
