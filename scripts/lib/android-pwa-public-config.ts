import type { T3CodePublicConfig } from "./public-config";

/** Public build inputs only; the helper passes one resolved config to both native and Vite. */
export function androidManagedAuthBuildEnv(config: T3CodePublicConfig) {
  return {
    T3_PWA_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey ?? "",
    T3_PWA_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate ?? "",
    T3_PWA_RELAY_URL: config.relayUrl ?? "",
  };
}
