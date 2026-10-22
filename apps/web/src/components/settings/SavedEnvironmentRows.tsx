import { Link } from "@tanstack/react-router";
import { formatBuildVersion } from "@t3tools/shared/buildVersion";
import { supportsForkMaintenanceAdmission } from "@t3tools/contracts";
import { RenameEnvironmentDialog } from "./RenameEnvironmentDialog";
import { HostMaintenanceStatus } from "./HostMaintenanceStatus";
import { HostUpdateSettings } from "./HostUpdateSettings";
import { LocalConnectCleanup } from "./LocalConnectCleanup";
import { SessionPermissions } from "./SessionPermissions";
import {
  ChevronRightIcon,
  ChevronsLeftRightEllipsisIcon,
  EllipsisIcon,
  RouteIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useState } from "react";
import {
  AuthRelayWriteScope,
  type EnvironmentId,
  connectReachabilityHelpUrl,
  formatConnectReachable,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  connectionRoutes,
  connectionStatusText,
  environmentMcpUrl,
} from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import { EnvironmentRoutesList } from "./EnvironmentRoutesList";
import {
  ConnectionDiagnosisPanel,
  ConnectionDiagnosisSummary,
  useConnectionDiagnosis,
} from "./ConnectionDiagnosisDetails";
import { usePreparedConnection } from "~/state/session";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { resolveServerConfigVersionMismatch } from "~/versionSkew";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { environmentCatalog } from "~/connection/catalog";
import { readEnvironmentScope } from "~/state/session";
import {
  type EnvironmentPresentation,
  useRelayEnvironmentDiscovery,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { APP_VERSION } from "~/branding";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "~/state/server";
import { OutdatedServerUpdateAction, ServerUpdateProgress } from "../ServerUpdateAction";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";

type SavedBackendListRowProps = {
  environment: EnvironmentPresentation;
  removingEnvironmentId: EnvironmentId | null;
  onSetEnabled: (environmentId: EnvironmentId, enabled: boolean) => void;
  onRemove: (environment: EnvironmentPresentation) => void;
  onAddRoute: (environment: EnvironmentPresentation) => void;
  detail?: boolean;
  onSelect?: () => void;
};

function savedBackendStatus(environment: EnvironmentPresentation): {
  readonly text: string;
  readonly tone: "muted" | "error";
} {
  if (!environment.entry.enabled && environment.connection.phase !== "unsupported")
    return { text: "Off", tone: "muted" };
  const { connection } = environment;
  switch (connection.phase) {
    case "connected":
      return { text: "Connected", tone: "muted" };
    case "connecting":
      return { text: "Connecting", tone: "muted" };
    case "reconnecting":
      return {
        text: connection.error ? `Reconnecting: ${connection.error}` : "Reconnecting",
        tone: "error",
      };
    case "unsupported":
      return { text: "Client not supported", tone: "muted" };
    case "error":
      return {
        text: connection.error ? `Connection failed: ${connection.error}` : "Connection failed",
        tone: "error",
      };
    case "offline":
      return { text: "Offline", tone: "muted" };
    case "available":
      return { text: "Not connected", tone: "muted" };
  }
}

export function SavedBackendListRow({
  environment,
  removingEnvironmentId,
  onSetEnabled,
  onRemove,
  onAddRoute,
  detail = false,
  onSelect,
}: SavedBackendListRowProps) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
  const environmentId = environment.environmentId;
  const unsupported = environment.connection.phase === "unsupported";
  const enabled = environment.entry.enabled && !unsupported;
  const isConnected = environment.connection.phase === "connected";
  const isRemoving = removingEnvironmentId === environmentId;
  const errorTraceId = environment.connection.traceId;
  const { copyToClipboard: copyTraceIdToClipboard } = useCopyToClipboard<{ traceId: string }>({
    target: "trace ID",
    onCopy: ({ traceId }) => {
      toastManager.add({
        type: "success",
        title: "Trace ID copied",
        description: traceId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy trace ID",
          description: error.message,
        }),
      );
    },
  });
  const copyTraceId = (traceId: string) => {
    copyTraceIdToClipboard(traceId, { traceId });
  };
  const { copyToClipboard: copyMcpUrl } = useCopyToClipboard<{ url: string }>({
    target: "MCP URL",
    onCopy: ({ url }) => {
      toastManager.add({
        type: "success",
        title: "MCP URL copied",
        description: `Add it to an agent, e.g. claude mcp add --transport http t3 ${url}`,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy MCP URL",
          description: error.message,
        }),
      );
    },
  });
  const versionMismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
  const serverUpdateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const resumingServerUpdate =
    serverUpdateState.status === "running" && serverUpdateState.stage === "resuming";
  const status = savedBackendStatus(environment);
  const serverVersion = environment.serverConfig?.environment.serverVersion ?? null;
  // A saved Arcwright Connect machine this device has never reached (unsupported,
  // or not yet connected) still has a descriptor from relay discovery, so
  // it can wear its detected glyph instead of the generic server. Discovery
  // empties its map on every refresh, so hold the last descriptor seen or
  // the glyph would blink back to the generic one each time.
  const relayDiscovery = useRelayEnvironmentDiscovery();
  const discoveredDescriptor = Option.getOrNull(
    relayDiscovery.environments.get(environmentId)?.status ?? Option.none(),
  )?.descriptor;
  const [lastDescriptor, setLastDescriptor] = useState(discoveredDescriptor);
  if (discoveredDescriptor !== undefined && discoveredDescriptor !== lastDescriptor) {
    setLastDescriptor(discoveredDescriptor);
  }
  const discoveredRelayHttpBaseUrl =
    relayDiscovery.environments.get(environmentId)?.environment.endpoint.httpBaseUrl;
  const [lastRelayHttpBaseUrl, setLastRelayHttpBaseUrl] = useState(discoveredRelayHttpBaseUrl);
  if (
    discoveredRelayHttpBaseUrl !== undefined &&
    discoveredRelayHttpBaseUrl !== lastRelayHttpBaseUrl
  ) {
    setLastRelayHttpBaseUrl(discoveredRelayHttpBaseUrl);
  }
  const retryNow = useAtomCommand(environmentCatalog.retryNow);
  const {
    diagnosis: currentDiagnosis,
    state: connectionState,
    relayOnly,
  } = useConnectionDiagnosis(environment);
  const diagnosis = resumingServerUpdate ? null : currentDiagnosis;
  const prepared = usePreparedConnection(environmentId);
  const connectedTarget = isConnected && prepared._tag === "Some" ? prepared.value.target : null;
  const mcpUrl = environmentMcpUrl({
    entry: environment.entry,
    relayHttpBaseUrl: discoveredRelayHttpBaseUrl ?? lastRelayHttpBaseUrl,
    connectedTarget,
  });
  const machineKind = resolveEnvironmentMachineKind(
    environment.serverConfig ??
      (lastDescriptor === undefined ? null : { environment: lastDescriptor }),
  );
  const routeCount = connectionRoutes(environment.entry).length;
  const subtitleText = [
    environmentTransportLabel(environment, connectedTarget),
    diagnosis ? null : resumingServerUpdate ? "Restarting" : status.text,
    enabled && serverVersion
      ? formatBuildVersion(environment.serverConfig?.buildIdentity ?? { version: serverVersion })
      : null,
    environment.serverConfig?.buildIdentity?.commit?.slice(0, 12) ?? null,
    environment.serverConfig?.buildIdentity?.dirty ? "Local changes" : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" · ");

  // Only a connected, enabled machine can take a remote update; a switched-off
  // one keeps the version note so the icon is not a surprise later.

  const statusTooltip = `${
    unsupported
      ? (environment.connection.error ?? connectionStatusText(environment.connection))
      : enabled
        ? connectionStatusText(environment.connection)
        : "Switched off"
  }${
    versionMismatch
      ? `\nHost version differs from this client: ${formatBuildVersion(environment.serverConfig?.buildIdentity ?? { version: versionMismatch.serverVersion })}`
      : ""
  }${environment.serverConfig?.buildIdentity?.commit ? `\nCommit: ${environment.serverConfig.buildIdentity.commit}` : ""}${environment.serverConfig?.buildIdentity?.builtAt ? `\nBuilt: ${environment.serverConfig.buildIdentity.builtAt}` : ""}`;

  return (
    <>
      {renameOpen ? (
        <RenameEnvironmentDialog environment={environment} onClose={() => setRenameOpen(false)} />
      ) : null}
      <EnvironmentRow
        kind={machineKind}
        label={environment.label}
        dimmed={!enabled}
        subtitle={
          <span className="flex min-w-0 items-center gap-1">
            <Tooltip>
              {/* The status can change while the tooltip is open, and base-ui only
                re-measures the popup when the trigger's payload changes. */}
              <TooltipTrigger
                payload={statusTooltip}
                render={
                  <span
                    className={cn(
                      "min-w-0 truncate",
                      enabled &&
                        status.tone === "error" &&
                        !resumingServerUpdate &&
                        "text-destructive",
                    )}
                  />
                }
              >
                {subtitleText}
              </TooltipTrigger>
              <TooltipPopup side="top" className="whitespace-pre-wrap">
                {statusTooltip}
              </TooltipPopup>
            </Tooltip>
            <span aria-hidden className="shrink-0">
              ·
            </span>
            <button
              type="button"
              aria-expanded={detail}
              onClick={onSelect}
              className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {routeCount === 1 ? "Routes" : `${routeCount} routes`}
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                  detail && "rotate-90",
                )}
              />
            </button>
          </span>
        }
        below={
          <>
            {!detail ? (
              <HostMaintenanceStatus
                environmentId={environmentId}
                label={environment.label}
                supported={supportsForkMaintenanceAdmission(
                  environment.serverConfig?.environment.capabilities.forkMaintenance,
                )}
              />
            ) : null}
            {diagnosis ? (
              <ConnectionDiagnosisSummary
                diagnosis={diagnosis}
                retryAt={connectionState.phase === "backoff" ? connectionState.retryAt : null}
                attempt={connectionState.attempt}
                expanded={diagnosisOpen}
                onToggle={() => setDiagnosisOpen((open) => !open)}
              />
            ) : null}
            {diagnosis && diagnosisOpen ? (
              <ConnectionDiagnosisPanel
                hostLabel={environment.label}
                diagnosis={diagnosis}
                onRetry={() => void retryNow(environmentId)}
                onAddRoute={relayOnly ? () => onAddRoute(environment) : null}
              />
            ) : null}
            {serverUpdateState.status !== "idle" ? (
              <div className="mt-1 max-w-md">
                <ServerUpdateProgress state={serverUpdateState} />
              </div>
            ) : null}
          </>
        }
        detail={
          detail ? (
            <div className="mt-4 space-y-6">
              <SettingsSection
                id={`computer-${environmentId}-addresses`}
                title="Addresses & routes"
              >
                <EnvironmentRoutesList
                  environment={environment}
                  onAddRoute={() => onAddRoute(environment)}
                />
              </SettingsSection>
              <SettingsSection id={`computer-${environmentId}-permissions`} title="Permissions">
                <SessionPermissions
                  environmentId={environmentId}
                  connected={isConnected}
                  routeContext
                />
              </SettingsSection>
              <SettingsSection
                id={`computer-${environmentId}-maintenance`}
                title="Version & maintenance"
              >
                <SettingsRow
                  title="Installed version"
                  description={serverVersion ?? "Connect to inspect this computer's version."}
                />
                {isConnected ? (
                  <HostUpdateSettings
                    mode="contextual"
                    environmentId={environmentId}
                    label={environment.label}
                    supported={supportsForkMaintenanceAdmission(
                      environment.serverConfig?.environment.capabilities.forkMaintenance,
                    )}
                  />
                ) : null}
                <SettingsRow
                  title="Update preferences & history"
                  description="Manage update policy and previous builds in About & updates."
                  control={
                    <Button
                      variant="outline"
                      size="sm"
                      render={
                        <Link
                          to="/settings/about"
                          search={{ machine: environmentId }}
                          hash={`host-updates-${environmentId}`}
                        />
                      }
                    >
                      About & updates
                    </Button>
                  }
                />
              </SettingsSection>
            </div>
          ) : null
        }
      >
        {!detail ? (
          <Button size="xs" variant="outline" onClick={onSelect}>
            Details
          </Button>
        ) : null}
        {unsupported &&
        environment.entry.serverUpdateRequired === true &&
        serverUpdateState.status !== "running" ? (
          <OutdatedServerUpdateAction
            environmentId={environmentId}
            serverLabel={`${environment.label} server`}
            fromVersion={lastDescriptor?.serverVersion}
            targetVersion={APP_VERSION}
            label={serverUpdateState.status === "failed" ? "Retry update" : "Update"}
          />
        ) : null}

        <Tooltip>
          <TooltipTrigger
            render={
              <Switch
                size="sm"
                checked={enabled}
                disabled={isRemoving || unsupported}
                aria-label={`${enabled ? "Switch off" : "Switch on"} ${environment.label}`}
                onCheckedChange={(checked) => onSetEnabled(environmentId, checked)}
              />
            }
          />
          <TooltipPopup side="top">
            {unsupported ? "Client not supported" : enabled ? "Switch off" : "Switch on"}
          </TooltipPopup>
        </Tooltip>
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                disabled={isRemoving}
                aria-label={`More actions for ${environment.label}`}
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => setRenameOpen(true)}>Rename environment…</MenuItem>
            <EnvironmentIconMenu
              environmentId={environmentId}
              serverConfig={environment.serverConfig}
            />
            <MenuItem onClick={onSelect}>
              <RouteIcon />
              Addresses & routes
            </MenuItem>
            {mcpUrl ? (
              <MenuItem onClick={() => copyMcpUrl(mcpUrl, { url: mcpUrl })}>Copy MCP URL</MenuItem>
            ) : null}
            {errorTraceId ? (
              <MenuItem onClick={() => copyTraceId(errorTraceId)}>Copy trace ID</MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => onRemove(environment)}>
              {isRemoving ? "Removing…" : "Remove from this device…"}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </EnvironmentRow>
    </>
  );
}

function CloudLinkSwitch({
  checked,
  disabled,
  disabledReason,
  onCheckedChange,
  ariaLabel = "Enable Arcwright Connect",
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly onCheckedChange?: (enabled: boolean) => void;
  readonly ariaLabel?: string;
}) {
  const control = (
    <Switch
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      {...(onCheckedChange ? { onCheckedChange } : {})}
    />
  );
  return disabledReason ? (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{control}</span>} />
      <TooltipPopup side="top">{disabledReason}</TooltipPopup>
    </Tooltip>
  ) : (
    control
  );
}

function ConfiguredCloudLinkRow({ canManageRelay }: { readonly canManageRelay: boolean }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const {
    isSignedIn,
    linkState: primaryCloudLinkState,
    linkRevoked,
    managedTunnelActive,
    managedTunnelOutOfSync,
    publishAgentActivity,
    holdWebhooksWhileOffline,
    operationError,
    reconcileCloudState,
  } = useCloudLinkController();
  const [isUpdating, setIsUpdating] = useState(false);
  const [isUpdatingPreference, setIsUpdatingPreference] = useState(false);

  const disabledReason = !isSignedIn
    ? "Sign in to Arcwright Connect to manage this environment."
    : !canManageRelay
      ? "Your session does not have permission to manage Arcwright Connect access."
      : null;
  const isBusy = isUpdating || isUpdatingPreference;
  const managedAvailable =
    hasCloudPublicConfig() &&
    (!primaryCloudLinkState.data?.authorityStatus ||
      primaryCloudLinkState.data.authorityStatus === "active") &&
    !(
      primaryCloudLinkState.data?.persistedLinkPresent === true &&
      !primaryCloudLinkState.data.linked
    );
  const refreshLinkState = useEffectEvent(primaryCloudLinkState.refresh);
  // The server rechecks reachability when the tunnel's 30 s readiness poll changes.
  // Poll while mounted, so a failed read does not stop later ones.
  useEffect(() => {
    const interval = window.setInterval(() => refreshLinkState(), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  const reachability = managedTunnelActive ? primaryCloudLinkState.data?.reachability : undefined;
  const reachabilityStatus =
    reachability?.status === "reachable" ? (
      formatConnectReachable(reachability)
    ) : reachability?.status === "unreachable" ? (
      <span className="block text-destructive">
        {[reachability.reason, reachability.hint, `Fix: ${reachability.fix}`]
          .filter(Boolean)
          .join(" ")}{" "}
        <a
          href={connectReachabilityHelpUrl(reachability.cause)}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          More info
        </a>
      </span>
    ) : null;

  const updateManagedTunnel = async (enabled: boolean) => {
    if (
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
    )
      return;
    setIsUpdating(true);
    const ok = await reconcileCloudState({ managedTunnel: enabled, publish: publishAgentActivity });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled
          ? "Arcwright Connect linked"
          : publishAgentActivity
            ? "Arcwright Connect tunnel disabled"
            : "Arcwright Connect unlinked",
        description: enabled
          ? "This environment is available through Arcwright Connect."
          : publishAgentActivity
            ? "The managed tunnel was removed. Agent activity publishing stays on."
            : "This environment is no longer available through Arcwright Connect.",
      });
    }
    setIsUpdating(false);
  };

  const updatePublishAgentActivity = async (enabled: boolean) => {
    if (
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
    )
      return;
    setIsUpdatingPreference(true);
    const ok = await reconcileCloudState({ managedTunnel: managedTunnelActive, publish: enabled });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled ? "Agent activity enabled" : "Agent activity disabled",
        description: enabled
          ? "This environment publishes agent activity to your mobile clients."
          : "This environment will stop publishing agent activity.",
      });
    }
    setIsUpdatingPreference(false);
  };

  const updateHoldWebhooks = async (enabled: boolean) => {
    setIsUpdatingPreference(true);
    const ok = await reconcileCloudState({
      managedTunnel: managedTunnelActive,
      publish: publishAgentActivity,
      holdWebhooksWhileOffline: enabled,
    });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled ? "Webhooks held while offline" : "Webhooks no longer held",
        description: enabled
          ? "Arcwright Connect keeps webhook requests for up to 24 hours while this environment is offline."
          : "Requests to an offline environment now fail. Anything already held is still delivered.",
      });
    }
    setIsUpdatingPreference(false);
  };

  return (
    <>
      <LocalConnectCleanup
        state={primaryCloudLinkState.data}
        canManage={canManageRelay}
        pending={primaryCloudLinkState.isPending || isBusy}
        unlink={() => reconcileCloudState({ managedTunnel: false, publish: false })}
      />
      {managedAvailable ? (
        <>
          {window.desktopBridge ? (
            <SettingsRow
              title={searchableSetting("t3-connect").title}
              description={
                linkRevoked
                  ? "This environment was removed from Arcwright Connect. Turn it on to link it again."
                  : managedTunnelOutOfSync
                    ? "Arcwright Connect is out of sync. Turn it on to repair remote access."
                    : managedTunnelActive
                      ? "This environment is available to your other devices through Arcwright Connect."
                      : "Make this environment available to your other devices through Arcwright Connect."
              }
              status={
                operationError ??
                primaryCloudLinkState.error ??
                primaryCloudLinkState.data?.authorityMessage ??
                reachabilityStatus
              }
              control={
                <CloudLinkSwitch
                  checked={managedTunnelActive}
                  disabled={
                    !canManageRelay ||
                    !isSignedIn ||
                    primaryCloudLinkState.data === null ||
                    primaryCloudLinkState.isPending ||
                    isBusy
                  }
                  disabledReason={disabledReason}
                  onCheckedChange={(enabled) => void updateManagedTunnel(enabled)}
                />
              }
            />
          ) : null}
          <SettingsRow
            title={searchableSetting("publish-agent-activity").title}
            description="Send activity to mobile notifications and Live Activities without Arcwright Connect."
            control={
              <CloudLinkSwitch
                ariaLabel="Publish agent activity to mobile clients"
                checked={publishAgentActivity}
                disabled={
                  !canManageRelay ||
                  !isSignedIn ||
                  primaryCloudLinkState.data === null ||
                  primaryCloudLinkState.isPending ||
                  isBusy
                }
                disabledReason={disabledReason}
                onCheckedChange={(enabled) => void updatePublishAgentActivity(enabled)}
              />
            }
          />
          {managedTunnelActive ? (
            <SettingsRow
              title={searchableSetting("hold-webhooks-while-offline").title}
              description="Keep webhook requests for up to 24 hours while this environment is offline, then deliver them. Off: Arcwright Connect only forwards requests and stores nothing."
              control={
                <CloudLinkSwitch
                  ariaLabel="Hold webhook requests while this environment is offline"
                  checked={holdWebhooksWhileOffline}
                  disabled={
                    !canManageRelay || !isSignedIn || primaryCloudLinkState.isPending || isBusy
                  }
                  disabledReason={disabledReason}
                  onCheckedChange={(enabled) => void updateHoldWebhooks(enabled)}
                />
              }
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

export function CloudLinkRow({
  canReadRelay,
  canManageRelay,
}: {
  readonly canReadRelay: boolean;
  readonly canManageRelay: boolean;
}) {
  if (!canReadRelay) {
    return (
      <SettingsRow
        title="Arcwright Connect"
        description="To edit these settings, pair this connection with both View relay and Manage relay permissions."
      />
    );
  }
  return <ConfiguredCloudLinkRow canManageRelay={canManageRelay} />;
}

function EmptyRemoteEnvironments({ cloudEnabled = true }: { readonly cloudEnabled?: boolean }) {
  return (
    <Empty className="min-h-52">
      <EmptyMedia variant="icon">
        <ChevronsLeftRightEllipsisIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No saved remote environments</EmptyTitle>
        <EmptyDescription>
          {cloudEnabled
            ? "Click “Add environment” to pair another environment, or connect one from Arcwright Connect."
            : "Click “Add environment” to pair another environment."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function CloudRemoteEnvironmentRows({
  primaryEnvironmentId,
  savedEnvironments,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
}) {
  return hasCloudPublicConfig() ? (
    <CloudEnvironmentConnectRows
      primaryEnvironmentId={primaryEnvironmentId}
      savedEnvironments={savedEnvironments}
      empty={<EmptyRemoteEnvironments />}
    />
  ) : savedEnvironments.length === 0 ? (
    <EmptyRemoteEnvironments cloudEnabled={false} />
  ) : null;
}
