import { p256 } from "@noble/curves/nist.js";
import type { DpopPublicJwk } from "@t3tools/shared/dpop";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Schema from "effect/Schema";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encode = (input: string) => Base64Url.encode(new TextEncoder().encode(input));
const pem = (label: string, data: ArrayBuffer) => {
  const encoded = btoa(String.fromCharCode(...new Uint8Array(data)));
  return `-----BEGIN ${label}-----\n${encoded.match(/.{1,64}/g)?.join("\n")}\n-----END ${label}-----\n`;
};
const rsaAlgorithm: RsaHashedKeyGenParams = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
};
const rsa = await globalThis.crypto.subtle.generateKey(rsaAlgorithm, true, ["sign", "verify"]);
const ed = await globalThis.crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
export const clerkKeys = {
  publicKey: pem("PUBLIC KEY", await globalThis.crypto.subtle.exportKey("spki", rsa.publicKey)),
  privateKey: pem("PRIVATE KEY", await globalThis.crypto.subtle.exportKey("pkcs8", rsa.privateKey)),
};
export const relayKeys = {
  publicKey: pem("PUBLIC KEY", await globalThis.crypto.subtle.exportKey("spki", ed.publicKey)),
  privateKey: pem("PRIVATE KEY", await globalThis.crypto.subtle.exportKey("pkcs8", ed.privateKey)),
};

/** Independent platform signing oracle; production verification and key parsing are exercised unchanged. */
export async function signFixtureJwt(
  payload: object,
  privateKey: string,
  alg = "EdDSA",
  typ = "JWT",
): Promise<string> {
  const header = encode(encodeJson({ alg, typ, kid: "fixture" }));
  const body = encode(encodeJson(payload));
  const key =
    privateKey === clerkKeys.privateKey
      ? rsa.privateKey
      : privateKey === relayKeys.privateKey
        ? ed.privateKey
        : undefined;
  if (!key) throw new Error("Unknown signing fixture key");
  const signature = await globalThis.crypto.subtle.sign(
    alg === "RS256" ? "RSASSA-PKCS1-v1_5" : "Ed25519",
    key,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${Base64Url.encode(new Uint8Array(signature))}`;
}
export function dpopKey() {
  const privateKey = p256.utils.randomPrivateKey();
  const publicKey = p256.getPublicKey(privateKey, false);
  return {
    privateKey,
    jwk: {
      kty: "EC",
      crv: "P-256",
      x: Base64Url.encode(publicKey.slice(1, 33)),
      y: Base64Url.encode(publicKey.slice(33, 65)),
    } satisfies DpopPublicJwk,
  };
}
export async function signDpop(key: ReturnType<typeof dpopKey>, claims: object): Promise<string> {
  const header = encode(encodeJson({ typ: "dpop+jwt", alg: "ES256", jwk: key.jwk }));
  const payload = encode(encodeJson(claims));
  const privateKey = await globalThis.crypto.subtle.importKey(
    "jwk",
    { ...key.jwk, d: Base64Url.encode(key.privateKey) },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${Base64Url.encode(new Uint8Array(signature))}`;
}
// This isolated test adapter reads the real verification clock used by Clerk,
// independently of the Effect TestClock used for relay tokens and proof controls.
export const systemEpochSeconds = () => Math.floor(Effect.runSync(Clock.currentTimeMillis) / 1000);
