import { OrganizationEmergencyStopStatus } from "./organizationEmergencyStop.ts";
import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrganizationId } from "./organizations.ts";

export const OrganizationWorkDrainInput = Schema.Struct({
  organizationId: OrganizationId,
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
});
export type OrganizationWorkDrainInput = typeof OrganizationWorkDrainInput.Type;

export const OrganizationWorkDrainStatusInput = Schema.Struct({ organizationId: OrganizationId });
export type OrganizationWorkDrainStatusInput = typeof OrganizationWorkDrainStatusInput.Type;

export const OrganizationWorkDrainStatus = Schema.Struct({
  organizationId: OrganizationId,
  state: Schema.Literals(["none", "draining", "paused"]),
  requestedAt: Schema.NullOr(IsoDateTime),
});
export type OrganizationWorkDrainStatus = typeof OrganizationWorkDrainStatus.Type;

export const OrganizationWorkStatusSnapshot = Schema.Struct({
  organizationId: OrganizationId,
  drain: OrganizationWorkDrainStatus,
  emergencyStop: OrganizationEmergencyStopStatus,
});
export type OrganizationWorkStatusSnapshot = typeof OrganizationWorkStatusSnapshot.Type;
