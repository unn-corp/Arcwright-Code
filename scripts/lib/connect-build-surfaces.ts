import {
  selectConnectProfile,
  resolveConnectMode,
  type ConnectEnvironment,
} from "../../packages/shared/src/connectProfile.ts";
import { clerkFrontendApiHostnameFromPublishableKey } from "../../packages/shared/src/relayAuth.ts";

/** Expo's issuer association follows the selected identity, without changing app identities. */
export function mobileConnectBuildConfig(env: ConnectEnvironment) {
  const profile = selectConnectProfile(resolveConnectMode(env.T3CODE_CONNECT_MODE), [env]);
  const relyingParty =
    profile.mode === "cloudless"
      ? null
      : profile.mode === "owned"
        ? clerkFrontendApiHostnameFromPublishableKey(profile.T3CODE_CLERK_PUBLISHABLE_KEY)
        : "clerk.t3.codes";
  return {
    profile,
    clerkPluginEnabled: profile.mode !== "cloudless",
    associatedDomains: relyingParty
      ? [`applinks:${relyingParty}`, `webcredentials:${relyingParty}`]
      : [],
  };
}

/** Local surface classification is independent of the remote Connect authorization origin. */
export function webSurfaceHostedAppUrl(
  env: ConnectEnvironment,
  isAndroidPwa: boolean,
): string | undefined {
  if (isAndroidPwa) return "https://appassets.androidplatform.net";
  const explicit = env.VITE_HOSTED_APP_URL?.trim();
  if (explicit) return explicit;
  if (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return undefined;
}

export function resolveMobileVersionPolicy(value: string | undefined, development: boolean) {
  const policy = value ?? (development ? "appVersion" : "fingerprint");
  switch (policy) {
    case "appVersion":
    case "fingerprint":
    case "nativeVersion":
    case "sdkVersion":
      return policy;
    default:
      throw new Error("Invalid MOBILE_VERSION_POLICY; require an Expo runtime version policy.");
  }
}
