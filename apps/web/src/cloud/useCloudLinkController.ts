import { hasCloudPublicConfig } from "./publicConfig";
import { useManagedAuth } from "../auth/managedAuthContext";
import { useAtomValue } from "@effect/atom-react";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  EnvironmentId,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type EnvironmentCloudLinkStateResult,
} from "@t3tools/contracts";
import type { RelayManagedEndpointProviderKind } from "@t3tools/contracts/relay";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { toastManager } from "../components/ui/toast";
import { relayEnvironmentDiscovery } from "../state/relay";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import {
  linkPrimaryEnvironment as linkPrimaryEnvironmentAtom,
  unlinkPrimaryEnvironment as unlinkPrimaryEnvironmentAtom,
  updatePrimaryEnvironmentPreferences as updatePrimaryEnvironmentPreferencesAtom,
} from "./linkEnvironmentAtoms";
import { readCachedPrimaryCloudLinkState, usePrimaryCloudLinkState } from "./primaryCloudLinkState";

export interface CloudLinkDesiredState {
  readonly managedTunnel: boolean;
  readonly publish: boolean;
  readonly holdWebhooksWhileOffline?: boolean;
}

/**
 * The local tunnel config can outlive a relay link that drifted to
 * publish-only, and clients then get `endpoint_provider_not_managed`. So when
 * relay discovery has this environment's record, it must also say managed.
 */
function isManagedTunnelActive(
  linkState: EnvironmentCloudLinkStateResult,
  relayProviderKind: RelayManagedEndpointProviderKind | undefined,
) {
  const localManagedTunnel = linkState.managedTunnelActive ?? linkState.linked;
  return (
    linkState.linkRevoked !== true &&
    localManagedTunnel &&
    (relayProviderKind === undefined || relayProviderKind === "cloudflare_tunnel")
  );
}

/**
 * Drives the primary environment's Arcwright Connect link. Arcwright Connect (managed
 * tunnel) and agent-activity publishing are independent capabilities backed by
 * a single relay link, so consumers express the full desired state and
 * `reconcileCloudState` applies it: unlink when neither is wanted, otherwise
 * (re)link with the mode the managed-tunnel bit implies and set the publish
 * preference. Re-linking only happens when the managed-tunnel mode actually
 * changes, so flipping publish alone is cheap.
 */
export function useCloudLinkController() {
  const { getRelayToken, isSignedIn } = useManagedAuth();
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const linkPrimaryEnvironment = useAtomCommand(linkPrimaryEnvironmentAtom, {
    reportFailure: false,
  });
  const unlinkPrimaryEnvironment = useAtomCommand(unlinkPrimaryEnvironmentAtom, {
    reportFailure: false,
  });
  const updatePrimaryEnvironmentPreferences = useAtomCommand(
    updatePrimaryEnvironmentPreferencesAtom,
    { reportFailure: false },
  );
  const primaryCloudLinkState = usePrimaryCloudLinkState();
  const relayEnvironments = useAtomValue(relayEnvironmentDiscovery.stateValueAtom).environments;
  const primaryEnvironmentId = primaryCloudLinkState.target?.environmentId;
  const relayProviderKind = primaryEnvironmentId
    ? relayEnvironments.get(primaryEnvironmentId)?.environment.endpoint.providerKind
    : undefined;
  const [operationError, setOperationError] = useState<string | null>(null);

  const reportUpdateFailure = (cause: unknown) => {
    const message =
      cause instanceof Error ? cause.message : "Could not update Arcwright Connect access.";
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not update Arcwright Connect", { message, traceId, cause });
    setOperationError(traceId ? `${message} Trace ID: ${traceId}` : message);
    toastManager.add({
      type: "error",
      title: "Could not update Arcwright Connect",
      description: message,
      data: traceId
        ? {
            secondaryActionProps: {
              children: "Copy trace ID",
              onClick: () => void navigator.clipboard?.writeText(traceId),
            },
          }
        : undefined,
    });
  };

  const linkData = primaryCloudLinkState.data;
  const linkRevoked = linkData?.linkRevoked ?? false;
  const managedTunnelActive = linkData ? isManagedTunnelActive(linkData, relayProviderKind) : false;
  const managedTunnelOutOfSync =
    linkData !== null && !managedTunnelActive && isManagedTunnelActive(linkData, undefined);
  const publishAgentActivity = primaryCloudLinkState.data?.publishAgentActivity ?? false;
  const holdWebhooksWhileOffline = primaryCloudLinkState.data?.holdWebhooksWhileOffline ?? false;
  const linked = !linkRevoked && (primaryCloudLinkState.data?.linked ?? false);

  const reconcileCloudState = async (desired: CloudLinkDesiredState): Promise<boolean> => {
    setOperationError(null);
    const target = primaryCloudLinkState.target;
    if (!target) {
      reportUpdateFailure(new Error("Local environment is not ready yet."));
      return false;
    }
    const environmentId = EnvironmentId.make(target.environmentId);
    const canManageLink = () => {
      if (
        !readEnvironmentScope(environmentId, AuthRelayReadScope) ||
        !readEnvironmentScope(environmentId, AuthRelayWriteScope)
      ) {
        reportUpdateFailure(
          new Error(
            "This connection needs permission to view and manage Arcwright Connect settings.",
          ),
        );
        return false;
      }
      return true;
    };
    const readLinkState = () => {
      const state = readCachedPrimaryCloudLinkState(target);
      if (state === null) {
        reportUpdateFailure(
          new Error("Wait until the current Arcwright Connect settings can be read."),
        );
      }
      return state;
    };
    if (!canManageLink()) return false;
    const wantsLink = desired.managedTunnel || desired.publish;
    const currentState = wantsLink ? readLinkState() : readCachedPrimaryCloudLinkState(target);
    if (wantsLink && currentState === null) return false;
    const managedAvailable =
      hasCloudPublicConfig() &&
      (!currentState?.authorityStatus || currentState.authorityStatus === "active") &&
      !(currentState?.persistedLinkPresent === true && !currentState.linked);
    if (wantsLink && !managedAvailable) {
      reportUpdateFailure(
        new Error(
          currentState?.authorityMessage ??
            "Managed Connect is unavailable. Unlink the saved local state before reconnecting.",
        ),
      );
      return false;
    }
    const tokenResult = await settlePromise(() =>
      managedAvailable ? getRelayToken() : Promise.resolve(null),
    );
    if (!canManageLink()) return false;

    // A failure after this point may follow a partially applied mutation (e.g.
    // the link succeeded but the preference update did not), so every exit —
    // success or failure — refreshes the rendered state to whatever the server
    // actually holds now.
    if (!wantsLink) {
      // Unlink works without a relay token — a failed token read must not
      // leave the user unable to turn Arcwright Connect off.
      const unlinkResult = await unlinkPrimaryEnvironment({
        target,
        clerkToken: tokenResult._tag === "Success" ? (tokenResult.value ?? null) : null,
      });
      if (unlinkResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(unlinkResult)) {
          reportUpdateFailure(squashAtomCommandFailure(unlinkResult));
        }
        primaryCloudLinkState.refresh();
        return false;
      }
    } else {
      const currentLinkState = readLinkState();
      if (currentLinkState === null) return false;
      if (tokenResult._tag === "Failure") {
        reportUpdateFailure(squashAtomCommandFailure(tokenResult));
        return false;
      }
      const clerkToken = tokenResult.value;
      if (!clerkToken) {
        reportUpdateFailure(new Error("Sign in to Arcwright Connect before enabling this."));
        return false;
      }
      if (
        (currentLinkState.persistedLinkPresent === true && !currentLinkState.linked) ||
        (currentLinkState.authorityStatus && currentLinkState.authorityStatus !== "active")
      ) {
        reportUpdateFailure(
          new Error(
            currentLinkState.authorityMessage ??
              "Unlink and reconnect to the selected account service.",
          ),
        );
        return false;
      }
      const currentManagedTunnel = isManagedTunnelActive(currentLinkState, relayProviderKind);
      if (
        !currentLinkState.linked ||
        currentLinkState.linkRevoked === true ||
        currentManagedTunnel !== desired.managedTunnel
      ) {
        const linkResult = await linkPrimaryEnvironment({
          target,
          clerkToken,
          mode: desired.managedTunnel ? "managed" : "publish_only",
        });
        if (linkResult._tag === "Failure") {
          if (!isAtomCommandInterrupted(linkResult)) {
            reportUpdateFailure(squashAtomCommandFailure(linkResult));
          }
          primaryCloudLinkState.refresh();
          return false;
        }
      }
      if (!canManageLink() || readLinkState() === null) {
        primaryCloudLinkState.refresh();
        return false;
      }
      const prefResult = await updatePrimaryEnvironmentPreferences({
        target,
        publishAgentActivity: desired.publish,
        ...(desired.holdWebhooksWhileOffline === undefined
          ? {}
          : { holdWebhooksWhileOffline: desired.holdWebhooksWhileOffline }),
      });
      if (prefResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(prefResult)) {
          reportUpdateFailure(squashAtomCommandFailure(prefResult));
        }
        primaryCloudLinkState.refresh();
        return false;
      }
    }

    primaryCloudLinkState.refresh();
    if (!hasCloudPublicConfig() || !isSignedIn || !managedAvailable) return true;
    const refreshResult = await refreshRelayEnvironments();
    if (refreshResult._tag === "Failure" && !isAtomCommandInterrupted(refreshResult)) {
      reportUpdateFailure(squashAtomCommandFailure(refreshResult));
      return false;
    }
    return true;
  };

  return {
    isSignedIn,
    linkState: primaryCloudLinkState,
    linked,
    linkRevoked,
    managedTunnelActive,
    managedTunnelOutOfSync,
    publishAgentActivity,
    holdWebhooksWhileOffline,
    operationError,
    reconcileCloudState,
  };
}
