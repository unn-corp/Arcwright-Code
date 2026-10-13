// @effect-diagnostics nodeBuiltinImport:off - Offline public-content compiler uses bounded local files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

export type PublicationStatus = "preparing" | "ready";

export function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Require a JSON object.");
  return value as Record<string, unknown>;
}
export function publicText(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 8000 ||
    [...value].some((char) => char.charCodeAt(0) < 32 && !"\t\n\r".includes(char))
  )
    throw new Error("Invalid public content text.");
  if (
    /placeholder|TODO|maintainer-notes|\/home\/|\.local\/state|\/userdata\/|[A-Z]:\\/i.test(value)
  )
    throw new Error("Private or placeholder content is not publishable.");
  const emails = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  if (emails.some((email) => email !== "theunnamed@theunnamed.dev"))
    throw new Error("Unreviewed public contact.");
  return value;
}
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

export function readBoundedJson(
  file: string,
  limit = 128 * 1024,
): { value: unknown; sha256: string } {
  const fd = NodeFS.openSync(
    file,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const stat = NodeFS.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Require a bounded regular JSON input.");
    const content = NodeFS.readFileSync(fd);
    if (content.length > limit) throw new Error("Oversized JSON input.");
    return {
      value: JSON.parse(content.toString("utf8")),
      sha256: NodeCrypto.createHash("sha256").update(content).digest("hex"),
    };
  } finally {
    NodeFS.closeSync(fd);
  }
}

function link(value: unknown, origin: string, external = false) {
  const href = publicText(value);
  if (href === "mailto:theunnamed@theunnamed.dev") return href;
  const url = new URL(href);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (!external &&
      (url.origin !== origin || !["/", "/about.html", "/privacy.html"].includes(url.pathname)))
  )
    throw new Error("Invalid public navigation link.");
  return href;
}

const stylesheet = `:root{color-scheme:dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#101113;color:#e7e7ec}*{box-sizing:border-box}body{margin:0}header,main,footer{max-width:860px;margin:auto;padding:24px}header{display:flex;flex-wrap:wrap;gap:20px;align-items:center;border-bottom:1px solid #34343a}header strong{margin-right:auto}nav{display:flex;flex-wrap:wrap;gap:20px}a{color:#b7c8ff;text-underline-offset:4px}a:focus-visible{outline:2px solid #b7c8ff;outline-offset:4px}h1{font-size:clamp(2rem,5vw,3rem);line-height:1.15;margin:24px 0}h2{font-size:1.3rem;margin-top:36px}p{line-height:1.75;color:#cdced6}main{padding-bottom:48px}.status{padding:16px;border:1px solid #454551;border-radius:10px;background:#1b1c21}footer{border-top:1px solid #34343a;font-size:.9rem}@media(max-width:540px){header,main,footer{padding:20px}nav{gap:14px}}`;

export function renderOwnedPublicPages({
  config,
  draft,
  origin,
  status,
}: {
  config: unknown;
  draft: unknown;
  origin: string;
  status: PublicationStatus;
}) {
  const cfg = jsonObject(config);
  const data = jsonObject(draft);
  if (
    cfg.supportEmail !== "theunnamed@theunnamed.dev" ||
    data.public_contact !== cfg.supportEmail ||
    cfg.publicSignup !== true ||
    cfg.effectiveDate !== "2026-10-12" ||
    data.effective_date !== cfg.effectiveDate ||
    cfg.serviceName !== "Arcwright Connect"
  )
    throw new Error("Require reviewed Arcwright contact, public signup, and effective date.");
  if (status === "ready" && cfg.status !== "reviewed-ready")
    throw new Error("Ready copy requires an explicitly reviewed ready content configuration.");
  const operator = publicText(data.operator_label);
  if (!operator.includes("Arcwright Connect")) throw new Error("Invalid Arcwright operator label.");
  const navigation = jsonObject(data.rendering);
  if (
    navigation.javascript_required !== false ||
    navigation.authentication_required !== false ||
    !Array.isArray(navigation.navigation) ||
    navigation.navigation.length !== 4
  )
    throw new Error("Public pages must be independently readable.");
  const nav = navigation.navigation
    .map((item) => {
      const row = jsonObject(item);
      return `<a href="${escapeHtml(link(row.href, origin))}">${escapeHtml(publicText(row.label))}</a>`;
    })
    .join("");
  if (cfg.homepageUrl !== `${origin}/about.html` || cfg.privacyUrl !== `${origin}/privacy.html`)
    throw new Error("Public content origin conflicts with selected profile.");
  const about = jsonObject(data.about);
  const privacy = jsonObject(data.privacy);
  const preparing = jsonObject(about.before_commissioning_replacements);
  function sections(page: Record<string, unknown>, isPrivacy: boolean) {
    if (!Array.isArray(page.sections))
      throw new Error("Require complete reviewed policy sections.");
    const ids = new Set<string>();
    const rendered = page.sections
      .map((section) => {
        const row = jsonObject(section);
        const id = publicText(row.id);
        if (!/^[a-z][a-z0-9-]*$/.test(id) || ids.has(id))
          throw new Error("Invalid public section identifier.");
        ids.add(id);
        if (!Array.isArray(row.paragraphs) || row.paragraphs.length === 0)
          throw new Error("Empty public section.");
        let paragraphs = row.paragraphs.map(publicText);
        if (status === "preparing") {
          if (!isPrivacy && ["purpose", "accounts"].includes(id))
            paragraphs = [publicText(preparing[id])];
          if (isPrivacy && id === "purpose")
            paragraphs = [
              "Arcwright Connect is being prepared for public signup and account-scoped environment connections. The following sections describe the intended handling of information when the corresponding service or optional feature becomes available. Public availability and managed environment access have not yet been commissioned.",
            ];
          if (isPrivacy && id === "deletion")
            paragraphs[0] =
              "Email theunnamed@theunnamed.dev to request account deletion or ask about your information. We may ask you to verify control of the account. The operator is preparing the manual account and relay cleanup procedure; this notice does not claim that this process is already operational. Signing out or removing Google access is not an account deletion request.";
        }
        return `<section id="${id}"><h2>${escapeHtml(publicText(row.heading))}</h2>${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("")}</section>`;
      })
      .join("");
    if (
      isPrivacy &&
      [
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
      ].some((id) => !ids.has(id))
    ) {
      throw new Error("Require complete reviewed policy sections.");
    }
    return rendered;
  }
  function page(title: unknown, canonical: unknown, introduction: string, body: string) {
    return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(publicText(title))}</title><link rel="canonical" href="${escapeHtml(link(canonical, origin))}"><link rel="icon" href="/favicon.ico"><style>${stylesheet}</style></head><body><header><strong>Arcwright Connect</strong><nav aria-label="Public pages">${nav}</nav></header><main><h1>${escapeHtml(publicText(title))}</h1>${status === "preparing" ? '<p class="status">Being prepared for public signup. Managed environment access is not yet commissioned.</p>' : ""}<p>${escapeHtml(introduction)}</p>${body}</main><footer>${escapeHtml(operator)} · Effective ${escapeHtml(publicText(cfg.effectiveDate))} · <a href="mailto:theunnamed@theunnamed.dev">Contact</a></footer></body></html>\n`;
  }
  if (!Array.isArray(privacy.provider_links)) throw new Error("Missing provider privacy links.");
  const providers = `<section><h2>Provider privacy notices</h2>${privacy.provider_links
    .map((item) => {
      const row = jsonObject(item);
      return `<p><a href="${escapeHtml(link(row.href, origin, true))}" rel="noreferrer">${escapeHtml(publicText(row.label))}</a>${row.note ? ` — ${escapeHtml(publicText(row.note))}` : ""}</p>`;
    })
    .join("")}</section>`;
  return {
    about: page(
      about.title,
      about.canonical_url,
      publicText(status === "preparing" ? preparing.description : about.description),
      sections(about, false),
    ),
    privacy: page(
      privacy.title,
      privacy.canonical_url,
      `${status === "preparing" ? "This preparation notice describes intended information handling; optional service features described below are not yet offered by the owned service. " : ""}${publicText(privacy.introduction)}`,
      sections(privacy, true) + providers,
    ),
  };
}

export function ownedHostedHeaders(clerkOrigin: string) {
  const issuer = new URL(clerkOrigin);
  if (issuer.protocol !== "https:" || issuer.origin !== clerkOrigin)
    throw new Error("Invalid Clerk header origin.");
  // Existing inline bootstraps and Clerk UI require inline script/styles. Direct environment
  // HTTPS/WSS, challenge frames, blob workers and WASM remain available on this hosted surface.
  const shell = `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${clerkOrigin} https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; img-src 'self' data: blob: https:; font-src 'self' data:; worker-src 'self' blob:; frame-src ${clerkOrigin} https://challenges.cloudflare.com; media-src 'self' blob: https:; form-action 'self' ${clerkOrigin}`;
  const strict =
    "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'none'";
  return `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Cache-Control: no-cache, must-revalidate\n  Content-Security-Policy: ${shell}\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/about.html\n  ! Content-Security-Policy\n  Content-Security-Policy: ${strict}\n\n/privacy.html\n  ! Content-Security-Policy\n  Content-Security-Policy: ${strict}\n`;
}
