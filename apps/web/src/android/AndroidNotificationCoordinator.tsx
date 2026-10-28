import { useEffect, useState, useSyncExternalStore } from "react";
import * as Option from "effect/Option";
import type { EnvironmentId } from "@t3tools/contracts";
import { androidAuthStore } from "./connectAuth";
import { useClientSettings } from "../hooks/useSettings";
import { useEnvironments } from "../state/environments";
import { usePreparedConnection } from "../state/session";
import { androidNotificationRequest, supportsAndroidNotifications } from "./notifications";
import {
  clearNotificationConfiguration,
  confirmNotificationConfiguration,
  notificationRegistration,
} from "./notificationRegistration";

let registrationSequence = 0;
function nextRegistrationId(): string {
  return `${Date.now()}:${++registrationSequence}`;
}

export function AndroidNotificationCoordinator() {
  const { isReady, environments } = useEnvironments();
  const preferences = useClientSettings((settings) => settings.agentNotifications);
  const ids = environments
    .filter((environment) => environment.entry.enabled)
    .map((environment) => environment.environmentId);
  const configuration = JSON.stringify({ preferences, environmentIds: ids });
  const [configured, setConfigured] = useState<{
    readonly configuration: string;
    readonly id: string;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- configures the native notification allowlist before credential registration and releases stale configuration on unmount
  useEffect(() => {
    if (!isReady || !supportsAndroidNotifications()) return;
    let current = true;
    const id = nextRegistrationId();
    void androidNotificationRequest("configure", {
      ...JSON.parse(configuration),
      configurationId: id,
    })
      .then(() => {
        if (current) {
          confirmNotificationConfiguration(id);
          setConfigured({ configuration, id });
        }
      })
      .catch(() => {});
    return () => {
      current = false;
      clearNotificationConfiguration(id);
    };
  }, [isReady, configuration]);
  // Configure the native allowlist before copying credentials; stale registrations
  // cannot resurrect an environment after it has been disabled or removed.
  if (
    !isReady ||
    !preferences.enabled ||
    configured?.configuration !== configuration ||
    !supportsAndroidNotifications()
  )
    return null;
  return ids.map((environmentId) => (
    <RegisterEnvironment
      key={environmentId}
      environmentId={environmentId}
      configurationId={configured.id}
    />
  ));
}

function RegisterEnvironment({
  environmentId,
  configurationId,
}: {
  readonly environmentId: EnvironmentId;
  readonly configurationId: string;
}) {
  const prepared = usePreparedConnection(environmentId);
  const account = useSyncExternalStore(androidAuthStore.subscribe, androidAuthStore.getSnapshot);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the prepared environment with the native notification service using the current account generation
  useEffect(() => {
    if (Option.isNone(prepared)) return;
    const connection = prepared.value;
    const authorization = connection.httpAuthorization;
    const registration = notificationRegistration(configurationId);
    if (authorization?._tag === "Dpop") {
      if (account.phase !== "signedIn") return;
      void androidNotificationRequest("registerManaged", {
        environmentId,
        ...registration,
        userId: account.userId,
        sessionId: account.sessionId,
        generation: account.generation,
      }).catch(() => {});
      return;
    }
    // Direct pairing credentials can reconnect without a signed-in cloud account.
    if (authorization?._tag !== "Bearer") return;
    void androidNotificationRequest("register", {
      environmentId,
      ...registration,
      httpBaseUrl: connection.httpBaseUrl,
      token: authorization.token,
    }).catch(() => {});
  }, [environmentId, configurationId, prepared, account]);
  return null;
}
