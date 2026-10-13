import { afterEach, expect, it, vi } from "vite-plus/test";

import { resolvePrivacyPolicy } from "./legalLinks";

afterEach(() => vi.unstubAllEnvs());

function ownedProfile() {
  vi.stubEnv("VITE_CONNECT_MODE", "owned");
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_test_${btoa("sample.accounts.dev$")}`);
  vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "arcwright-relay");
  vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "client_sample");
  vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
  vi.stubEnv("VITE_CONNECT_HOSTED_APP_URL", "https://selected.example.test/");
}

it.each(["", "legacy", "cloudless"])("keeps the compatible policy in %s mode", (mode) => {
  vi.stubEnv("VITE_CONNECT_MODE", mode);
  vi.stubEnv("VITE_CONNECT_HOSTED_APP_URL", "https://ignored.example.test");
  expect(resolvePrivacyPolicy()).toEqual({
    url: "https://t3.codes/privacy-policy",
    ownedConnect: false,
  });
});

it("uses the selected owned profile rather than the local desktop/APK/browser origin", () => {
  ownedProfile();
  vi.stubEnv("VITE_HOSTED_APP_URL", "https://appassets.androidplatform.net");
  expect(resolvePrivacyPolicy()).toEqual({
    url: "https://selected.example.test/privacy.html",
    ownedConnect: true,
  });
});

it.each([
  "",
  "http://selected.example.test",
  "https://untrusted.example.test/path",
  "https://user:password@selected.example.test",
  "https://app.t3.codes",
])("rejects an invalid owned policy origin %s without upstream fallback", (origin) => {
  ownedProfile();
  vi.stubEnv("VITE_CONNECT_HOSTED_APP_URL", origin);
  expect(() => resolvePrivacyPolicy()).toThrow();
});

it("requires the rest of the owned profile even when the policy origin is present", () => {
  ownedProfile();
  vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "");
  expect(() => resolvePrivacyPolicy()).toThrow(/complete/);
});
