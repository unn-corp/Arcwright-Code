import { expect, it } from "@effect/vitest";
import {
  compressText,
  expandBlob,
  parsePayloadReference,
  payloadReference,
} from "./forkStorageCodec.ts";

it("verifies bytes, Unicode length and bounded expansion rather than trusting an archive reference", () => {
  const text = "original 🧰 tool output\n".repeat(1000);
  const blob = compressText(text);
  expect(expandBlob(blob)).toBe(text);
  expect(parsePayloadReference(payloadReference(blob))).toMatchObject({
    rawBytes: Buffer.byteLength(text),
    digest: blob.digest,
  });
  expect(() => expandBlob({ ...blob, digest: "0".repeat(64) })).toThrow("integrity");
  expect(() => expandBlob({ ...blob, rawBytes: 1 })).toThrow();
  expect(() => parsePayloadReference("arcwright:payload:v1:bad:999999999999")).toThrow("Invalid");
});
