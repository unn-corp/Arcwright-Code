/** Relay-local prechecks run before JSON, JOSE, Clerk, or public-key import. */
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export class PublicRelayInputInvalid extends Error {
  constructor() {
    super("Invalid relay input");
  }
}
function invalid(): never {
  throw new PublicRelayInputInvalid();
}

export function assertJsonDepth(text: string): void {
  let depth = 0;
  let string = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (string) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') string = false;
    } else if (char === '"') string = true;
    else if (char === "{" || char === "[") {
      if (++depth > 32) invalid();
    } else if (char === "}" || char === "]") {
      if (--depth < 0) invalid();
    }
  }
}

export function assertJsonShape(value: unknown): void {
  const pending: unknown[] = [value];
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (++nodes > 4096) invalid();
    if (Array.isArray(item)) {
      if (item.length > 128) invalid();
      pending.push(...item);
    } else if (typeof item === "object" && item !== null) {
      const keys = Object.keys(item);
      if (keys.length > 128) invalid();
      for (const key of keys) pending.push((item as Record<string, unknown>)[key]);
    }
  }
}

export function parseBoundedJson(text: string, maxBytes: number): unknown {
  if (encoder.encode(text).byteLength > maxBytes) invalid();
  assertJsonDepth(text);
  const value: unknown = JSON.parse(text);
  assertJsonShape(value);
  return value;
}

function decodedJson(segment: string, maxBytes: number): unknown {
  // Check the encoded length before allocating the decoded byte/string buffers.
  if (
    !/^[A-Za-z0-9_-]+$/.test(segment) ||
    segment.length > Math.ceil((maxBytes * 4) / 3) ||
    segment.length % 4 === 1
  )
    invalid();
  const raw = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
  if (raw.length > maxBytes) invalid();
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  return parseBoundedJson(decoder.decode(bytes), maxBytes);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function optionalString(object: Record<string, unknown>, key: string, max: number) {
  const value = object[key];
  if (value !== undefined && (typeof value !== "string" || value.length > max)) invalid();
}

export function assertPublicP256Jwk(value: unknown): void {
  if (
    !record(value) ||
    Object.keys(value).length > 16 ||
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    "d" in value
  )
    invalid();
  for (const name of ["x", "y"] as const) {
    const part = value[name];
    if (
      typeof part !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(part) ||
      atob(part.replace(/-/g, "+").replace(/_/g, "/")).length !== 32
    )
      invalid();
  }
}
export function assertPublicSpki(value: string): void {
  if (value.length > 2048) invalid();
}

export function inspectBoundedJwt(
  token: string,
  maxBytes = 49_152,
): { readonly header: Record<string, unknown>; readonly payload: Record<string, unknown> } {
  if (token.length > maxBytes || encoder.encode(token).byteLength > maxBytes) invalid();
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    !parts[0] ||
    !parts[1] ||
    !parts[2] ||
    !/^[A-Za-z0-9_-]+$/.test(parts[2])
  )
    invalid();
  const header = decodedJson(parts[0], 2048);
  const payload = decodedJson(parts[1], 32_768);
  if (!record(header) || !record(payload)) invalid();
  if (header.crit !== undefined && (!Array.isArray(header.crit) || header.crit.length > 8))
    invalid();
  if (payload.aud !== undefined) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (aud.length > 16 || aud.some((v) => typeof v !== "string" || v.length > 4096)) invalid();
  }
  for (const [key, max] of Object.entries({
    jti: 255,
    htm: 16,
    htu: 8192,
    ath: 128,
    iss: 4096,
    sub: 191,
    environmentId: 191,
    cloudUserId: 191,
    tunnelId: 191,
    linkCreatedByDeviceId: 191,
  }))
    optionalString(payload, key, max);
  if (record(payload.cnf)) optionalString(payload.cnf, "jkt", 128);
  if (payload.environmentPublicKey !== undefined) {
    optionalString(payload, "environmentPublicKey", 2048);
  }
  // RelayTokens prechecks a nested challenge before its own JOSE call. Do not
  // parse unknown challenge claims here or change ordinary challenge-invalid errors.
  if (typeof payload.challenge === "string" && payload.challenge.length > 16_384) invalid();
  return { header, payload };
}
export function isBoundedJwt(token: string, maxBytes = 49_152): boolean {
  try {
    inspectBoundedJwt(token, maxBytes);
    return true;
  } catch {
    return false;
  }
}

/** Only DPoP imports a request-supplied P-256 JWK; other JWT verifiers retain their own key policy. */
export function isBoundedDpopProof(token: string): boolean {
  try {
    const { header } = inspectBoundedJwt(token, 8192);
    if (header.jwk !== undefined) assertPublicP256Jwk(header.jwk);
    return true;
  } catch {
    return false;
  }
}

export function assertRelayForm(text: string): void {
  const form = new URLSearchParams(text);
  const required = new Set([
    "grant_type",
    "subject_token",
    "subject_token_type",
    "requested_token_type",
    "resource",
    "scope",
    "client_id",
  ]);
  const seen = new Set<string>();
  let count = 0;
  for (const [key, value] of form) {
    if (++count > 32 || key.length > 256) invalid();
    if (required.has(key) && seen.has(key)) invalid();
    seen.add(key);
    const max = key === "subject_token" ? 16_384 : key === "resource" ? 4096 : 512;
    if (value.length > max) invalid();
  }
}
