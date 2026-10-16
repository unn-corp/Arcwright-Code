import { OrganizationWorkError, type OrganizationId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { readOrganizationWorkDrain } from "./OrganizationLiveWorkDrain.ts";
import { readOrganizationEmergencyStop } from "./OrganizationLiveWorkEmergencyStop.ts";

const isWorkError = Schema.is(OrganizationWorkError);

/** Run in a fresh fiber context, outside the producer's transaction. Acquiring
 * the SQL writer lock waits for the outer commit or rollback, and both halves
 * of the snapshot are read from the same committed transaction.
 */
export const read = (organizationId: OrganizationId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const drain = yield* readOrganizationWorkDrain(organizationId);
        const emergencyStop = yield* readOrganizationEmergencyStop(organizationId);
        return { organizationId, drain, emergencyStop };
      }),
    );
  }).pipe(
    Effect.mapError((error) =>
      isWorkError(error)
        ? error
        : new OrganizationWorkError({
            code: "unavailable",
            message: "Organization work status is unavailable.",
          }),
    ),
  );
