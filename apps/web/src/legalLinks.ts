import { resolveCloudPublicConfig } from "./cloud/publicConfig";

export function resolvePrivacyPolicy() {
  const { connectMode, hostedAppUrl } = resolveCloudPublicConfig();
  if (connectMode === "owned") {
    // Owned public config validates the complete profile before returning its origin.
    if (!hostedAppUrl) throw new Error("Owned Connect privacy policy requires its hosted origin.");
    return { url: new URL("/privacy.html", hostedAppUrl).href, ownedConnect: true };
  }
  return { url: "https://t3.codes/privacy-policy", ownedConnect: false };
}
