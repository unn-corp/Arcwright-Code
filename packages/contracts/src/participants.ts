import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

// Small raster thumbnails can travel with an author snapshot without a signed URL
// expiring or a remote client needing access to the sender's filesystem.
export const ParticipantPhoto = Schema.String.check(
  Schema.isMaxLength(16_384),
  Schema.makeFilter(
    (value) =>
      /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ||
      (value.length <= 2048 && value.startsWith("https://")),
  ),
);
export const HumanParticipant = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  photo: Schema.NullOr(ParticipantPhoto),
});
export type HumanParticipant = typeof HumanParticipant.Type;
export const ConnectedProfileAccount = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  photo: Schema.NullOr(ParticipantPhoto),
});
export type ConnectedProfileAccount = typeof ConnectedProfileAccount.Type;
export const ParticipantProfile = Schema.Struct({
  participant: HumanParticipant,
  initialized: Schema.Boolean,
  accounts: Schema.Array(ConnectedProfileAccount),
  photoSource: Schema.optionalKey(Schema.Literals(["account", "custom"])),
});
export type ParticipantProfile = typeof ParticipantProfile.Type;
export const ParticipantProfiles = Schema.Record(Schema.String, ParticipantProfile);
export const AgentColorOverrides = Schema.Record(
  Schema.String,
  Schema.String.check(Schema.makeFilter((value) => /^#[a-fA-F0-9]{6}$/.test(value))),
);

export const AgentMessageAuthor = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String.check(Schema.isMaxLength(256)),
});
export type AgentMessageAuthor = typeof AgentMessageAuthor.Type;
