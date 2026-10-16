import type { OrganizationId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as OrganizationWorkStatusChanges from "./OrganizationWorkStatusChanges.ts";

export const stream = (organizationId: OrganizationId) =>
  Stream.unwrap(
    Effect.map(OrganizationWorkStatusChanges.OrganizationWorkStatusChanges, (service) =>
      service.watch(organizationId),
    ),
  );
