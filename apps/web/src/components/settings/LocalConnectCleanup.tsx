import type { EnvironmentCloudLinkStateResult } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../ui/button";

/** Local cleanup uses the paired session; account sign-in and cloud setup are independent. */
export function LocalConnectCleanup({
  state,
  canManage,
  pending,
  unlink,
}: {
  readonly state: EnvironmentCloudLinkStateResult | null;
  readonly canManage: boolean;
  readonly pending: boolean;
  readonly unlink: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const present = state?.persistedLinkPresent ?? state?.linked ?? false;
  if (!present && !state?.remoteCleanupPending) return null;
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      {present ? (
        <>
          <p>{state?.authorityMessage ?? "This environment has saved Connect link state."}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={!canManage || pending || busy}
            onClick={async () => {
              if (!canManage || pending || busy) return;
              setBusy(true);
              return await (async () => {
                await unlink();
              })().finally(() => {
                setBusy(false);
              });
            }}
          >
            Unlink locally
          </Button>
        </>
      ) : null}
      {state?.remoteCleanupPending ? (
        <p>
          Remote cleanup pending. Select the original Connect profile and sign in deliberately to
          remove its record. If the old origin is unknown, review it manually.
        </p>
      ) : null}
    </div>
  );
}
