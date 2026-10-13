import {
  CONNECT_PUBLIC_KEYS,
  CONNECT_PUBLIC_ALIASES,
  connectProfileEnv,
  hasConnectPublicFields,
  serializeConnectProfile,
  type ConnectEnvironment,
} from "../../packages/shared/src/connectProfile.ts";
import { loadRepoEnv, connectProfileReceipt } from "./public-config.ts";

export const OWNED_WEB_TRACING_KEYS = [
  "T3CODE_MOBILE_OTLP_TRACES",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES",
  "EXPO_PUBLIC_OTLP_TRACES",
  "VITE_RELAY_OTLP_TRACES",
].flatMap((prefix) => ["URL", "DATASET", "TOKEN"].map((suffix) => `${prefix}_${suffix}`));

/** Return only public compile inputs, with no ambient per-field merge or dotenv reads. */
export function ownedHostedBuildEnv(input: ConnectEnvironment): Record<string, string> {
  if (input.T3CODE_CONNECT_MODE !== "owned" || !input.T3CODE_CONNECT_PROFILE_FILE) {
    throw new Error(
      "Owned hosted builds require explicit owned mode and a complete public profile file.",
    );
  }
  const profileInput: Record<string, string | undefined> = {
    T3CODE_CONNECT_MODE: "owned",
    T3CODE_CONNECT_PROFILE_FILE: input.T3CODE_CONNECT_PROFILE_FILE,
  };
  if (hasConnectPublicFields(input)) {
    for (const name of CONNECT_PUBLIC_KEYS.flatMap((key) => [
      key,
      ...CONNECT_PUBLIC_ALIASES[key],
    ])) {
      profileInput[name] = input[name];
    }
  }
  const env = loadRepoEnv({ baseEnv: profileInput, readEnvFiles: false });
  const profile = connectProfileReceipt(env);
  const hosted = profile.T3CODE_HOSTED_APP_URL;
  for (const name of ["VITE_HOSTED_APP_URL", "VITE_CONNECT_HOSTED_APP_URL"]) {
    if (input[name] && input[name] !== hosted)
      throw new Error("Hosted surface conflicts with the selected public profile.");
  }
  for (const name of [
    "VITE_HTTP_URL",
    "VITE_WS_URL",
    "VITE_ANDROID_PWA",
    "VITE_HOSTED_APP_CHANNEL",
    "VERCEL_URL",
    "VERCEL_PROJECT_PRODUCTION_URL",
  ]) {
    if (input[name])
      throw new Error(
        "Owned hosted builds reject local, native, channel, or upstream surface inputs.",
      );
  }
  if (serializeConnectProfile(profile).includes("t3.codes"))
    throw new Error("Owned hosted profile cannot select upstream services.");
  return {
    ...connectProfileEnv(profile),
    T3CODE_CONNECT_PROFILE_FILE: input.T3CODE_CONNECT_PROFILE_FILE,
    T3CODE_OWNED_CONNECT_WEB: "1",
    VITE_HOSTED_APP_URL: hosted,
    VITE_HOSTED_APP_CHANNEL: "",
    VITE_HTTP_URL: "",
    VITE_WS_URL: "",
    VITE_ANDROID_PWA: "",
    T3CODE_WEB_SOURCEMAP: "0",
    ...Object.fromEntries(OWNED_WEB_TRACING_KEYS.map((name) => [name, ""])),
  };
}
