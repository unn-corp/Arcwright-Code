import type { Plugin } from "vite-plus";

/** A compiler-transformed public provenance chunk; application tree shaking must retain exports. */
export function ownedConnectProfileProofPlugin(): Plugin {
  return {
    name: "arcwright:owned-connect-profile-proof",
    buildStart() {
      this.emitFile({
        type: "chunk",
        id: "virtual:owned-connect-profile-proof",
        name: "connect-profile-compiled",
        preserveSignature: "strict",
      });
    },
    resolveId(id) {
      return id === "virtual:owned-connect-profile-proof" ? `\0${id}` : undefined;
    },
    load(id) {
      if (id !== "\0virtual:owned-connect-profile-proof") return;
      return `export const compiled = {schemaVersion:1,mode:import.meta.env.VITE_CONNECT_MODE,T3CODE_CLERK_PUBLISHABLE_KEY:import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,T3CODE_CLERK_JWT_TEMPLATE:import.meta.env.VITE_CLERK_JWT_TEMPLATE,T3CODE_CLERK_CLI_OAUTH_CLIENT_ID:import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID,T3CODE_RELAY_URL:import.meta.env.VITE_T3CODE_RELAY_URL,T3CODE_HOSTED_APP_URL:import.meta.env.VITE_CONNECT_HOSTED_APP_URL}; export const digest = import.meta.env.VITE_CONNECT_PROFILE_DIGEST; export const surface = {hosted:import.meta.env.VITE_HOSTED_APP_URL,channel:import.meta.env.VITE_HOSTED_APP_CHANNEL,http:import.meta.env.VITE_HTTP_URL,ws:import.meta.env.VITE_WS_URL,android:import.meta.env.VITE_ANDROID_PWA,tracingUrl:import.meta.env.VITE_RELAY_OTLP_TRACES_URL,tracingDataset:import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET,tracingToken:import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN};`;
    },
  };
}
