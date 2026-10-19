import { useState, useSyncExternalStore } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { usePreparedConnection } from "../state/session";
import { useClientSettings } from "../hooks/useSettings";
import { Button } from "../components/ui/button";
import { androidNotificationRequest, supportsAndroidNotifications } from "./notifications";
import { notificationConfiguration, notificationRegistration } from "./notificationRegistration";

/** A user choice for phone alerts; foreground connection selection remains independent. */
export function AndroidDirectNotificationChoice({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const prepared = usePreparedConnection(environmentId);
  const enabled = useClientSettings((settings) => settings.agentNotifications.enabled);
  const configuration = useSyncExternalStore(
    notificationConfiguration.subscribe,
    notificationConfiguration.getSnapshot,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (
    !supportsAndroidNotifications() ||
    prepared._tag !== "Some" ||
    prepared.value.httpAuthorization?._tag !== "Bearer"
  )
    return null;
  const connection = prepared.value;
  const token = prepared.value.httpAuthorization.token;
  const select = async () => {
    const current = notificationConfiguration.getSnapshot();
    if (current === null) return;
    setBusy(true);
    setMessage(null);
    return await (async () => {
      await androidNotificationRequest("selectDirect", {
        environmentId,
        ...notificationRegistration(current),
        httpBaseUrl: connection.httpBaseUrl,
        token,
      });
      setMessage("Phone alerts use this paired route.");
    })()
      .catch(() => {
        setMessage(
          "Could not select this route for phone alerts. Check that the environment and alerts are enabled.",
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <div>
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={busy || !enabled || configuration === null}
        onClick={() => void select()}
      >
        Use current paired route for phone alerts
      </Button>
      {message ? (
        <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  );
}
