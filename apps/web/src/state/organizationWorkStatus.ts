import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId, type OrganizationId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { useVisiblePolling } from "../hooks/useVisiblePolling";
import { usePrimaryEnvironmentId } from "./environments";
import { organizationEnvironment } from "./organizations";
import { useEnvironmentQuery } from "./query";
import { environmentServerConfigsAtom } from "./server";

const subscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:organizations:work-status",
  tag: WS_METHODS.organizationsSubscribeWorkStatus,
  idleTtlMs: 0,
});
const pushSupported = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make(
    (get) =>
      environmentId !== null &&
      get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
        .organizationWorkStatusPush === true,
  ),
);
const drain = Atom.family((source: ReturnType<typeof subscription>) =>
  source.pipe(
    Atom.mapResult((snapshot) => snapshot.drain),
    Atom.setIdleTTL(0),
  ),
);
const emergency = Atom.family((source: ReturnType<typeof subscription>) =>
  source.pipe(
    Atom.mapResult((snapshot) => snapshot.emergencyStop),
    Atom.setIdleTTL(0),
  ),
);

export function useOrganizationDrainStatus(organizationId: OrganizationId, offline: boolean) {
  const environmentId = usePrimaryEnvironmentId();
  const supported = useAtomValue(pushSupported(environmentId));
  const target = environmentId === null ? null : { environmentId, input: { organizationId } };
  const query = useEnvironmentQuery(
    target === null
      ? null
      : supported
        ? drain(subscription(target))
        : organizationEnvironment.getWorkDrainStatus(target),
  );
  // Legacy servers need polling even in "none": another client can start a drain.
  useVisiblePolling(query.refresh, !offline && !supported && target !== null, 5_000);
  return query;
}

export function useOrganizationEmergencyStopStatus(
  organizationId: OrganizationId,
  offline: boolean,
) {
  const environmentId = usePrimaryEnvironmentId();
  const supported = useAtomValue(pushSupported(environmentId));
  const target = environmentId === null ? null : { environmentId, input: { organizationId } };
  const query = useEnvironmentQuery(
    target === null
      ? null
      : supported
        ? emergency(subscription(target))
        : organizationEnvironment.getEmergencyStopStatus(target),
  );
  useVisiblePolling(query.refresh, !offline && !supported && target !== null, 5_000);
  return query;
}
