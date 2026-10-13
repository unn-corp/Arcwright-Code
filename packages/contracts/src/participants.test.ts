import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ParticipantPhoto, HumanParticipant } from "./participants.ts";
import { ClientSettingsSchema } from "./settings.ts";
import { OrchestrationMessageContext } from "./composerContext.ts";

const decodeSettings = Schema.decodeSync(ClientSettingsSchema);
const decodeContext = Schema.decodeSync(OrchestrationMessageContext);
const decodeUnknownContext = Schema.decodeUnknownSync(OrchestrationMessageContext);
const encodeContext = Schema.encodeSync(OrchestrationMessageContext);
const isPhoto = Schema.is(ParticipantPhoto);
const isHuman = Schema.is(HumanParticipant);

it("loads old settings and old messages with participant defaults", () => {
  const settings = decodeSettings({});
  expect(settings.participantProfiles).toEqual({});
  expect(settings.agentColorOverrides).toEqual({});
  expect(decodeContext({ version: 1, records: [] })).not.toHaveProperty("author");
});
it("round trips bounded thumbnail author snapshots for remote clients", () => {
  const context = {
    version: 1 as const,
    records: [],
    author: { id: "alice", name: "Alice", photo: "data:image/webp;base64,AA==" },
  };
  const encoded = encodeContext(context);
  expect(decodeUnknownContext(JSON.parse(JSON.stringify(encoded)))).toEqual(context);
});
it("rejects local paths, active image formats, oversized pictures and empty names", () => {
  for (const photo of [
    "file:///private/avatar.png",
    "http://host/photo.png",
    "data:image/svg+xml;base64,AA==",
    "data:image/png;base64," + "A".repeat(16_384),
  ])
    expect(isPhoto(photo)).toBe(false);
  expect(isHuman({ id: "alice", name: "", photo: null })).toBe(false);
});
