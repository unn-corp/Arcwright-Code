import * as NodeCrypto from "node:crypto";

// Independent historical Node HMAC oracle, imported by tests only.
export function nodeHmacSha256Base64Url(secret, canonicalPayload) {
  return NodeCrypto.createHmac("sha256", secret)
    .update(canonicalPayload, "utf8")
    .digest("base64url");
}
