import { build } from "vite-plus";
import { expect, it } from "vite-plus/test";
import { ownedConnectProfileProofPlugin } from "../../vite/ownedConnectProfileProof.ts";

it("retains actual compiler profile exports in application mode without an importing consumer", async () => {
  const expected = {
    schemaVersion: 1,
    mode: "owned",
    T3CODE_CLERK_PUBLISHABLE_KEY: "pk_fixture",
    T3CODE_CLERK_JWT_TEMPLATE: "jwt_fixture",
    T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "client_fixture",
    T3CODE_RELAY_URL: "https://relay.example.test",
    T3CODE_HOSTED_APP_URL: "https://connect.example.test",
  };
  const values = {
    VITE_CONNECT_MODE: expected.mode,
    VITE_CLERK_PUBLISHABLE_KEY: expected.T3CODE_CLERK_PUBLISHABLE_KEY,
    VITE_CLERK_JWT_TEMPLATE: expected.T3CODE_CLERK_JWT_TEMPLATE,
    VITE_CLERK_CLI_OAUTH_CLIENT_ID: expected.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID,
    VITE_T3CODE_RELAY_URL: expected.T3CODE_RELAY_URL,
    VITE_CONNECT_HOSTED_APP_URL: expected.T3CODE_HOSTED_APP_URL,
    VITE_CONNECT_PROFILE_DIGEST: "digest_fixture",
    VITE_HOSTED_APP_URL: expected.T3CODE_HOSTED_APP_URL,
    VITE_HOSTED_APP_CHANNEL: "",
    VITE_HTTP_URL: "",
    VITE_WS_URL: "",
    VITE_ANDROID_PWA: "",
    VITE_RELAY_OTLP_TRACES_URL: "",
    VITE_RELAY_OTLP_TRACES_DATASET: "",
    VITE_RELAY_OTLP_TRACES_TOKEN: "",
  };
  const result = await build({
    configFile: false,
    envDir: false,
    envPrefix: [],
    logLevel: "silent",
    publicDir: false,
    plugins: [
      ownedConnectProfileProofPlugin(),
      {
        name: "fixture-application-entry",
        resolveId: (id) => (id === "virtual:application" ? `\0${id}` : undefined),
        load: (id) =>
          id === "\0virtual:application"
            ? 'globalThis.fixtureApplication = "application";'
            : undefined,
      },
    ],
    define: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        `import.meta.env.${key}`,
        JSON.stringify(value),
      ]),
    ),
    build: { write: false, rolldownOptions: { input: "virtual:application" } },
  });
  if (Array.isArray(result) || !("output" in result))
    throw new Error("Expected one fixture build output.");
  const chunk = result.output.find(
    (output) => output.type === "chunk" && output.name === "connect-profile-compiled",
  );
  if (!chunk || chunk.type !== "chunk") throw new Error("Missing actual compiler chunk.");
  expect(chunk.code).not.toBe("");
  const compiled: unknown = await import(`data:text/javascript,${encodeURIComponent(chunk.code)}`);
  expect(compiled).toMatchObject({
    compiled: expected,
    digest: "digest_fixture",
    surface: {
      hosted: expected.T3CODE_HOSTED_APP_URL,
      http: "",
      ws: "",
      android: "",
      tracingToken: "",
    },
  });
});
