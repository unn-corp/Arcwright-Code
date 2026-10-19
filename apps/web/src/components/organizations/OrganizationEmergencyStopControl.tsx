import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { Organization } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useOrganizationEmergencyStopStatus } from "../../state/organizationWorkStatus";
import { randomUUID } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { organizationEnvironment } from "../../state/organizations";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Card, CardPanel } from "../ui/card";

export function OrganizationEmergencyStopControl({
  organization,
  offline,
  onRefresh,
}: {
  readonly organization: Organization;
  readonly offline: boolean;
  readonly onRefresh: () => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const status = useOrganizationEmergencyStopStatus(organization.id, offline);
  const request = useAtomCommand(organizationEnvironment.requestEmergencyStop, {
    reportFailure: false,
  });
  const requestId = useRef(randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    if (offline || busy || environmentId === null || status.data?.state !== "none") return;
    setBusy(true);
    setError(null);
    const operation = await settlePromise(async () => {
      const result = await request({
        environmentId,
        input: { organizationId: organization.id, requestId: requestId.current },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : String(cause));
      } else {
        status.refresh();
        onRefresh();
      }
    });
    setBusy(false);
    if (operation._tag === "Failure") throw squashAtomCommandFailure(operation);
  }

  return (
    <Card>
      <CardPanel size="md" spacing={3}>
        <h2 className="text-lg font-semibold">Emergency stop</h2>
        <p className="text-sm text-muted-foreground">
          A stop request blocks new Project work and interrupts admitted work. It does not undo
          completed Git updates or guarantee that a process has exited before verification.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error}
          </p>
        ) : null}
        {status.error ? (
          <p role="status" className="text-sm">
            Stop status unavailable: {status.error}
          </p>
        ) : null}
        {status.data?.state === "requested" ? (
          <div className="space-y-2 text-sm" role="status">
            <p className="font-medium">
              Emergency stop requested at {new Date(status.data.requestedAt ?? "").toLocaleString()}
              .
            </p>
            <p>New Project work is blocked. {status.data.admittedPhases} phase claims remain.</p>
            <p>
              {status.data.unverifiedProviderLaunches} provider launches still need exit
              verification.
            </p>
            {status.data.unverifiedProviderLaunches > 0 ? (
              <p className="text-muted-foreground">
                If verification remains blocked after refresh, a host restart may be needed to prove
                an uncertain provider launch is gone.
              </p>
            ) : null}
            <p>
              {status.data.verifiedProviderExits} provider exits and {status.data.verifiedScopes}{" "}
              scoped operations have verified receipts.
            </p>
            <Button variant="outline" disabled={offline} onClick={status.refresh}>
              Refresh verification
            </Button>
          </div>
        ) : status.data?.state === "none" ? (
          <Button
            variant="destructive"
            disabled={offline || busy || !["active", "paused"].includes(organization.lifecycle)}
            onClick={() => void stop()}
          >
            {busy ? "Requesting…" : "Request emergency stop"}
          </Button>
        ) : null}
      </CardPanel>
    </Card>
  );
}
