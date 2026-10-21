import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildConnectCliClerkAuthorizeUrl,
  connectCliSignInRedirectUrl,
  connectCliAuthRoutesEnabled,
} from "./connectCliAuth";

const TEST_PUBLISHABLE_KEY = `pk_test_${btoa("witty-mole-42.clerk.accounts.dev$")}`;

const surface = vi.hoisted(() => ({ android: false, electron: false }));
vi.mock("../env", () => ({
  get isAndroidPwa() {
    return surface.android;
  },
  get isElectron() {
    return surface.electron;
  },
}));
vi.mock("../hostedPairing", () => ({ isHostedStaticApp: () => true }));

describe("connectCliAuth", () => {
  it("allows terminal authorization only in the hosted browser even with full native public config", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.com");
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_fixture");
    surface.android = false;
    surface.electron = false;
    expect(connectCliAuthRoutesEnabled()).toBe(true);
    surface.android = true;
    expect(connectCliAuthRoutesEnabled()).toBe(false);
    surface.android = false;
    surface.electron = true;
    expect(connectCliAuthRoutesEnabled()).toBe(false);
    surface.electron = false;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires both the publishable key and the CLI OAuth client id", () => {
    surface.android = false;
    surface.electron = false;
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.com");
    // Stubbed empty rather than left alone: a repo-root .env with real Connect
    // values is injected into import.meta.env, so "absent" has to be asserted
    // explicitly or this passes only on machines with no Connect config.
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "");
    expect(connectCliAuthRoutesEnabled()).toBe(false);

    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");
    expect(connectCliAuthRoutesEnabled()).toBe(true);
  });

  it("builds a PKCE authorize URL that redirects to the CLI's loopback listener", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");

    const authorizeUrl = buildConnectCliClerkAuthorizeUrl({
      state: "state-1",
      challenge: "challenge-1",
      loopbackPort: 34338,
    });
    expect(authorizeUrl).not.toBeNull();

    const url = new URL(authorizeUrl!);
    expect(url.hostname).toBe("witty-mole-42.clerk.accounts.dev");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:34338/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("returns null when the CLI OAuth client id is not configured", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "");
    expect(
      buildConnectCliClerkAuthorizeUrl({
        state: "state-1",
        challenge: "challenge-1",
        loopbackPort: 34338,
      }),
    ).toBeNull();
  });

  it("sends the sign-in redirect to the authorize endpoint, not back to /connect", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");

    const connectUrl =
      "https://app.t3.codes/connect#state=state-1&challenge=challenge-1&port=34338";
    const redirectUrl = connectCliSignInRedirectUrl(
      { state: "state-1", challenge: "challenge-1", loopbackPort: 34338 },
      connectUrl,
    );

    expect(redirectUrl).not.toBe(connectUrl);
    expect(new URL(redirectUrl).pathname).toBe("/oauth/authorize");
  });

  it("falls back to the current URL when the authorize URL cannot be built", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "");

    const connectUrl =
      "https://app.t3.codes/connect#state=state-1&challenge=challenge-1&port=34338";
    expect(
      connectCliSignInRedirectUrl(
        { state: "state-1", challenge: "challenge-1", loopbackPort: 34338 },
        connectUrl,
      ),
    ).toBe(connectUrl);
  });
});
