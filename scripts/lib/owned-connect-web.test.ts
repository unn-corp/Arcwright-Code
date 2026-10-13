// @effect-diagnostics nodeBuiltinImport:off - Isolated public input fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ownedHostedBuildEnv, OWNED_WEB_TRACING_KEYS } from "./owned-connect-web-env.ts";
import {
  renderOwnedPublicPages,
  ownedHostedHeaders,
  escapeHtml,
} from "./owned-connect-web-content.ts";
import { loadRepoEnv } from "./public-config.ts";
const dirs: string[] = [];
const owned = {
  T3CODE_CLERK_PUBLISHABLE_KEY: `pk_live_${btoa("clerk.arcwright.space$")}`,
  T3CODE_CLERK_JWT_TEMPLATE: "t3-relay",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "VS3HcN01wPJotPrs",
  T3CODE_RELAY_URL: "https://relay.arcwright.space",
  T3CODE_HOSTED_APP_URL: "https://connect.arcwright.space",
};
function profile(value: unknown = owned) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "owned-web-"));
  dirs.push(dir);
  const file = NodePath.join(dir, "profile.json");
  NodeFS.writeFileSync(file, JSON.stringify(value));
  return { T3CODE_CONNECT_MODE: "owned", T3CODE_CONNECT_PROFILE_FILE: file };
}
afterEach(() =>
  dirs.splice(0).forEach((dir) => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

describe("isolated hosted compile selection", () => {
  it("clears all tracing aliases and sets the hosted surface separately", () => {
    const env = ownedHostedBuildEnv({
      ...profile(),
      VITE_RELAY_OTLP_TRACES_TOKEN: "unused-fixture",
      T3CODE_MOBILE_OTLP_TRACES_URL: "https://unused.test",
    });
    expect(env.VITE_HOSTED_APP_URL).toBe(owned.T3CODE_HOSTED_APP_URL);
    expect(env.VITE_CONNECT_HOSTED_APP_URL).toBe(owned.T3CODE_HOSTED_APP_URL);
    expect(OWNED_WEB_TRACING_KEYS.every((key) => env[key] === "")).toBe(true);
    expect(env).toMatchObject({
      VITE_HTTP_URL: "",
      VITE_WS_URL: "",
      VITE_HOSTED_APP_CHANNEL: "",
      VITE_ANDROID_PWA: "",
      T3CODE_WEB_SOURCEMAP: "0",
    });
    expect(env).not.toHaveProperty("CLERK_SECRET_KEY");
  });
  it("rejects conflicting public aliases and partial ambient sources", () => {
    expect(() =>
      ownedHostedBuildEnv({
        ...profile(),
        VITE_CLERK_PUBLISHABLE_KEY: owned.T3CODE_CLERK_PUBLISHABLE_KEY,
      }),
    ).toThrow(/complete/i);
    expect(() =>
      ownedHostedBuildEnv({
        ...profile(),
        ...owned,
        VITE_T3CODE_RELAY_URL: "https://different.test",
      }),
    ).toThrow(/conflict/i);
  });
  it("rejects wrong surface, local backend pins, native and channel classification", () => {
    const input = profile();
    for (const [key, value] of Object.entries({
      VITE_HOSTED_APP_URL: "https://wrong.test",
      VITE_HTTP_URL: "http://localhost:5733",
      VITE_WS_URL: "ws://localhost:5733",
      VITE_ANDROID_PWA: "1",
      VITE_HOSTED_APP_CHANNEL: "latest",
      VERCEL_URL: "app.t3.codes",
    }))
      expect(() => ownedHostedBuildEnv({ ...input, [key]: value })).toThrow();
  });
  it("rejects incomplete and upstream profiles", () => {
    expect(() =>
      ownedHostedBuildEnv(profile({ T3CODE_RELAY_URL: owned.T3CODE_RELAY_URL })),
    ).toThrow();
    expect(() =>
      ownedHostedBuildEnv(profile({ ...owned, T3CODE_HOSTED_APP_URL: "https://app.t3.codes" })),
    ).toThrow();
  });
  it("explicit isolation ignores root env files without changing default loading", () => {
    const input = profile();
    const dir = NodePath.dirname(input.T3CODE_CONNECT_PROFILE_FILE);
    NodeFS.writeFileSync(
      NodePath.join(dir, ".env"),
      "VITE_HTTP_URL=http://localhost:1\nCLERK_SECRET_KEY=private-fixture\n",
    );
    expect(loadRepoEnv({ baseEnv: input, repoRoot: dir, readEnvFiles: false })).not.toHaveProperty(
      "CLERK_SECRET_KEY",
    );
    expect(loadRepoEnv({ baseEnv: {}, repoRoot: dir }).VITE_HTTP_URL).toBe("http://localhost:1");
  });
});

function content() {
  const origin = owned.T3CODE_HOSTED_APP_URL;
  const config = {
    supportEmail: "theunnamed@theunnamed.dev",
    publicSignup: true,
    effectiveDate: "2026-10-12",
    serviceName: "Arcwright Connect",
    homepageUrl: `${origin}/about.html`,
    privacyUrl: `${origin}/privacy.html`,
    status: "draft",
  };
  const section = (id: string) => ({
    id,
    heading: `Heading <${id}>`,
    paragraphs: ["Reviewed public text & information."],
  });
  const draft = {
    public_contact: config.supportEmail,
    effective_date: config.effectiveDate,
    operator_label: "the operator of Arcwright Connect",
    rendering: {
      javascript_required: false,
      authentication_required: false,
      navigation: [
        { label: "Open app", href: `${origin}/` },
        { label: "About", href: config.homepageUrl },
        { label: "Privacy", href: config.privacyUrl },
        { label: "Contact", href: `mailto:${config.supportEmail}` },
      ],
    },
    about: {
      title: "About Arcwright Connect",
      canonical_url: config.homepageUrl,
      description: "Live public signup",
      sections: [section("purpose"), section("accounts")],
      before_commissioning_replacements: {
        description: "Preparing public signup",
        purpose: "Designed for your environments",
        accounts: "Anyone can sign up when available",
      },
    },
    privacy: {
      title: "Arcwright Connect Privacy",
      canonical_url: config.privacyUrl,
      introduction: "Effective October 12, 2026",
      sections: [
        "purpose",
        "identity",
        "connections",
        "content",
        "local",
        "uses",
        "sharing",
        "retention",
        "deletion",
        "security",
        "international",
        "children",
        "changes",
      ].map(section),
      provider_links: [{ label: "Clerk Privacy", href: "https://clerk.com/legal/privacy" }],
    },
  };
  return { config, draft, origin };
}

describe("public hosted pages and headers", () => {
  it("requires all reviewed policy topics instead of an invented numeric section count", () => {
    const input = content();
    expect(input.draft.privacy.sections).toHaveLength(13);
    expect(renderOwnedPublicPages({ ...input, status: "preparing" }).privacy).toContain(
      'id="identity"',
    );
    input.draft.privacy.sections = input.draft.privacy.sections.filter(
      (section) => section.id !== "identity",
    );
    expect(() => renderOwnedPublicPages({ ...input, status: "preparing" })).toThrow(/complete/);
    input.draft.privacy.sections.push(input.draft.privacy.sections[0]!);
    expect(() => renderOwnedPublicPages({ ...input, status: "preparing" })).toThrow(/identifier/);
  });
  it("escapes all content and includes only the public contact and no scripts", () => {
    const pages = renderOwnedPublicPages({ ...content(), status: "preparing" });
    expect(pages.privacy).toContain("Heading &lt;identity&gt;");
    expect(pages.privacy).toContain("text &amp; information");
    expect(pages.about).toContain("mailto:theunnamed@theunnamed.dev");
    expect(pages.privacy).not.toMatch(/<script|clerk\.arcwright|maintainer|@gmail|\/home\//i);
    expect(escapeHtml("\"<>&'")).toBe("&quot;&lt;&gt;&amp;&#39;");
  });
  it("uses preparation copy without claiming an operational cleanup executor", () => {
    const input = content();
    input.draft.privacy.sections.find((section) => section.id === "deletion")!.paragraphs[0] =
      "Account deletion includes Clerk and relay records.";
    const pages = renderOwnedPublicPages({ ...input, status: "preparing" });
    expect(pages.about).toContain("Anyone can sign up when available");
    expect(pages.privacy).toContain("preparing the manual account and relay cleanup procedure");
    expect(pages.privacy).not.toContain("Account deletion includes Clerk and relay records.");
    expect(() => renderOwnedPublicPages({ ...input, status: "ready" })).toThrow(/reviewed ready/);
    input.config.status = "reviewed-ready";
    expect(renderOwnedPublicPages({ ...input, status: "ready" }).privacy).toContain(
      "Account deletion includes Clerk and relay records.",
    );
  });
  it("rejects private email, placeholders, missing contact and hostile links", () => {
    const input = content();
    input.draft.about.description = "Contact owner@gmail.com";
    expect(() => renderOwnedPublicPages({ ...input, status: "ready" })).toThrow();
    input.config.status = "reviewed-ready";
    expect(() => renderOwnedPublicPages({ ...input, status: "ready" })).toThrow(/contact/i);
    input.draft.about.description = "TODO";
    expect(() => renderOwnedPublicPages({ ...input, status: "ready" })).toThrow(/placeholder/i);
    input.draft.about.description = "Reviewed description";
    input.draft.rendering.navigation[0]!.href = "javascript:alert(1)";
    expect(() => renderOwnedPublicPages({ ...input, status: "preparing" })).toThrow();
    input.config.supportEmail = "";
    expect(() => renderOwnedPublicPages({ ...input, status: "preparing" })).toThrow();
  });
  it("sets hosted revalidation, immutable hashed assets and separate no-script static policies", () => {
    const headers = ownedHostedHeaders("https://clerk.arcwright.space");
    expect(headers).toContain("X-Content-Type-Options: nosniff");
    expect(headers).toContain("Cache-Control: no-cache, must-revalidate");
    expect(headers).toContain("max-age=31536000, immutable");
    expect(headers).toContain("script-src 'none'");
    expect(headers).toContain("worker-src 'self' blob:");
    expect(headers).toContain("https://challenges.cloudflare.com");
  });
});
