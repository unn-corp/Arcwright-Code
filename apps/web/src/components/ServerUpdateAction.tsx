import { useAtomValue } from "@effect/atom-react";
import {
  AuthEnvironmentMaintainScope,
  type AuthSessionState,
  managedUpdatesDenial,
  sessionGrantsScope,
  supportsForkMaintenanceAdmission,
} from "@t3tools/contracts";
import type { AsyncResult } from "effect/reactivity";
import { environmentSession } from "~/state/session";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { hostForkUpdateController, requestHostUpdates } from "../state/hostForkUpdates";
import { forkStatusDescription } from "./forkUpdatePresentation";
import type {
  DesktopUpdateChannel,
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
  ServerInstallation,
  ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import type { ServerUpdateStage, ServerUpdateState } from "@t3tools/client-runtime/state/server";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CircleArrowUpIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useRef, useState } from "react";
import { requestConfirmDialog } from "~/confirmDialog";
import { updateOutdatedServer } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useServerConfigs } from "~/state/entities";
import { useManagedPolicy } from "~/state/managedPolicy";
import { environmentPresentations } from "~/state/presentation";
import { ManagedControl } from "./ManagedPolicy";
import { crossesReleaseTrack } from "@t3tools/shared/cliRelease";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Preserve distinct download, replacement, and restart stages in notices.
const UPDATE_STAGE_LABELS: Record<ServerUpdateStage, string> = {
  downloading: "Downloading…",
  installing: "Installing…",
  resuming: "Restarting…",
};
const pendingUpdateEnvironmentIds = new Set<EnvironmentId>();
export function serverUpdateStageLabel(stage: ServerUpdateStage): string {
  return UPDATE_STAGE_LABELS[stage];
}

/** Why the environment's policy refuses server updates, read outside render. */
function readUpdatesDenial(environmentId: EnvironmentId): string | undefined {
  return managedUpdatesDenial(
    appAtomRegistry.get(environmentPresentations.serverConfigsAtom).get(environmentId)
      ?.managedPolicy,
  );
}
const CROSS_TRACK_NOTE = "Switch tracks in About → Update track";

/** Hosts refuse a Stable/Nightly crossing outside a track switch, which checks the database first. */
function refusedCrossing(
  target: {
    readonly selfUpdate: ServerSelfUpdateCapability | null;
    readonly targetVersion: string;
    readonly channel?: DesktopUpdateChannel | undefined;
  },
  serverVersion: string | undefined,
): boolean {
  return (
    target.channel === undefined &&
    target.selfUpdate !== null &&
    serverVersion !== undefined &&
    crossesReleaseTrack(serverVersion, target.targetVersion)
  );
}
function CrossTrackNote() {
  return <span className="text-muted-foreground text-xs">{CROSS_TRACK_NOTE}</span>;
}
function updateFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Server update failed.";
}
export interface ServerUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  readonly installation?: ServerInstallation | undefined;
  readonly desktopAppUpdate?: boolean;
  readonly forkMaintenance?: ExecutionEnvironmentCapabilities["forkMaintenance"] | undefined;
  readonly threadContinuation?: boolean;
  readonly targetVersion: string;
  /** Set only by a track switch; the host's desktop app moves to this track. */
  readonly channel?: DesktopUpdateChannel;
  /** A track switch's checked release migration; the host re-checks its own database. */
  readonly targetDatabaseMigration?: number;
  /** The host already runs its track's newest build and only saves the track. */
  readonly trackOnly?: boolean;
}
export type PendingServerUpdate = Omit<ServerUpdateTarget, "continueThreadsAfterServerUpdate"> & {
  readonly serverVersion: string;
};
export interface ServerUpdateControl {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}
type UpdateButtonProps = Pick<ComponentProps<typeof Button>, "variant" | "size" | "className"> & {
  readonly label?: string;
  readonly appearance?: "button" | "icon";
};
export type ServerUpdateOutcome =
  | {
      readonly status: "updated" | "skipped" | "waiting";
    }
  | {
      readonly status: "failed";
      readonly message: string;
    };
export function createServerUpdate() {
  return async (
    target: ServerUpdateTarget,
    options:
      | string
      | {
          readonly quiet?: boolean;
        } = "Server update failed",
  ): Promise<ServerUpdateOutcome> => {
    const quiet = typeof options === "object" && options.quiet === true;
    const failureTitle = typeof options === "string" ? options : "Server update failed";
    const { environmentId, serverLabel } = target;
    const denial = readUpdatesDenial(environmentId);
    if (denial !== undefined) {
      if (!quiet) {
        toastManager.add({
          type: "error",
          title: `${serverLabel} not updated`,
          description: denial,
        });
      }
      return {
        status: "failed",
        message: denial,
      };
    }
    if (
      !canUpdateServer(appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId))) ||
      pendingUpdateEnvironmentIds.has(environmentId)
    )
      return {
        status: "skipped",
      };
    pendingUpdateEnvironmentIds.add(environmentId);
    try {
      const controller = hostForkUpdateController(environmentId);
      const checked = await controller.action({
        action: "check",
      });
      const result =
        checked.targetBuild && ["staged", "waiting"].includes(checked.phase)
          ? await controller.action({
              action: "install",
              targetArtifactSha256: checked.targetBuild.artifactSha256,
            })
          : checked;
      if (!quiet)
        toastManager.add({
          type: result.phase === "failed" ? "error" : "info",
          title: `${serverLabel}: ${result.phase}`,
          description: forkStatusDescription(result),
        });
      if (result.phase === "failed")
        return {
          status: "failed",
          message: forkStatusDescription(result),
        };
      if (checked.targetBuild === null)
        return {
          status: "skipped",
        };
      return {
        status:
          result.currentBuild.artifactSha256 === checked.targetBuild.artifactSha256
            ? "updated"
            : "waiting",
      };
    } catch (error) {
      const message = updateFailureMessage(error);
      toastManager.add({
        type: "error",
        title: `${serverLabel}: ${failureTitle}`,
        description: message,
      });
      return {
        status: "failed",
        message,
      };
    } finally {
      pendingUpdateEnvironmentIds.delete(environmentId);
    }
  };
}
export function ServerUpdatesAction({
  targets,
  label = "Update all",
  variant = "outline",
  size = "xs",
  className,
}: UpdateButtonProps & {
  readonly targets: ReadonlyArray<ServerUpdateTarget>;
}) {
  const serverConfigs = useServerConfigs();
  const pending = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const eligible = targets.filter(
    (target) =>
      supportsForkMaintenanceAdmission(target.forkMaintenance) &&
      target.selfUpdate !== null &&
      (target.selfUpdate !== "desktop-managed" || target.desktopAppUpdate) &&
      canUpdateServer(
        appAtomRegistry.get(environmentSession.sessionStateAtom(target.environmentId)),
      ) &&
      managedUpdatesDenial(serverConfigs.get(target.environmentId)?.managedPolicy) === undefined &&
      !refusedCrossing(target, serverConfigs.get(target.environmentId)?.environment.serverVersion),
  );
  const handleUpdate = async () => {
    if (pending.current) return;
    pending.current = true;
    setIsPending(true);
    await settlePromise(async () => {
      const available = eligible.filter(
        (target) => !pendingUpdateEnvironmentIds.has(target.environmentId),
      );
      const results = await requestHostUpdates(available);
      for (const result of results)
        toastManager.add({
          type: result.failed ? "error" : "info",
          title: result.label,
          description: result.message,
        });
    });
    pending.current = false;
    setIsPending(false);
  };
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      disabled={isPending || eligible.length === 0}
      onClick={() => void handleUpdate()}
    >
      {label}
    </Button>
  );
}
export function canUpdateServer(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
): boolean {
  if (result._tag !== "Success" || !result.value.authenticated) return false;
  return sessionGrantsScope(result.value, AuthEnvironmentMaintainScope);
}
export function ServerUpdateProgress({
  state,
}: {
  readonly state: Exclude<
    ServerUpdateState,
    {
      status: "idle";
    }
  >;
}) {
  if (state.status === "failed") {
    return (
      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-destructive" role="alert">
        <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 truncate">{state.message}</span>} />
          <TooltipPopup side="top">{state.message}</TooltipPopup>
        </Tooltip>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-2 text-xs font-medium text-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-foreground" aria-hidden="true" />
      <span>{serverUpdateStageLabel(state.stage)}</span>
    </div>
  );
}

/**
 * Offers the update path advertised by a version-skewed server. Self-updates
 * delegate their full lifecycle to the host update controller so this component can
 * unmount during reconnect without losing operation state.
 */
export function ServerUpdateAction({
  environmentId,
  serverLabel,
  selfUpdate,
  desktopAppUpdate = false,
  forkMaintenance,
  targetVersion,
  channel,
  label = "Update",
  variant = "outline",
  size = "xs",
  className,
  appearance = "button",
  render,
}: ServerUpdateTarget &
  UpdateButtonProps & {
    readonly render?: (control: ServerUpdateControl) => ReactNode;
  }) {
  const isDesktopAppUpdate = selfUpdate === "desktop-managed";
  const serverVersion = useServerConfigs().get(environmentId)?.environment.serverVersion;
  const updatesDenial = managedUpdatesDenial(useManagedPolicy(environmentId));
  const unsupportedDesktopUpdate = isDesktopAppUpdate && !desktopAppUpdate;
  const sessionStateAtom = environmentSession.sessionStateAtom(environmentId);
  const canUpdate = canUpdateServer(useAtomValue(sessionStateAtom));
  const update = createServerUpdate();
  if (
    !supportsForkMaintenanceAdmission(forkMaintenance) ||
    selfUpdate === null ||
    (selfUpdate === "desktop-managed" && !desktopAppUpdate)
  ) {
    if (render) {
      return render({
        label: "Bootstrap updater on",
        disabled: true,
        onClick: () => {},
      });
    }
    return (
      <a
        className="text-xs underline"
        href="https://github.com/unn-corp/Arcwright-Code/blob/main/docs/user/updating.md"
        target="_blank"
        rel="noreferrer"
      >
        Bootstrap updater on {serverLabel}
      </a>
    );
  }
  const handleUpdate = async () => {
    if (
      updatesDenial !== undefined ||
      refusedCrossing(
        {
          selfUpdate,
          targetVersion,
          channel,
        },
        serverVersion,
      ) ||
      unsupportedDesktopUpdate ||
      !canUpdateServer(appAtomRegistry.get(sessionStateAtom)) ||
      pendingUpdateEnvironmentIds.has(environmentId)
    ) {
      return;
    }
    if (isDesktopAppUpdate) {
      const confirmed =
        (await requestConfirmDialog(
          `Request an update on ${serverLabel}? Installation waits for all registered work to stop, then the desktop app closes and relaunches.`,
        )) ?? true;
      if (!confirmed) return;
    }
    if (!canUpdateServer(appAtomRegistry.get(sessionStateAtom))) return;
    await update({
      environmentId,
      serverLabel,
      selfUpdate,
      desktopAppUpdate,
      forkMaintenance,
      targetVersion,
    });
  };
  if (updatesDenial !== undefined) {
    return appearance === "icon" ? (
      <ManagedControl reason={updatesDenial}>
        <Button size="icon-xs" variant="ghost-muted" aria-label={updatesDenial} disabled>
          <CircleArrowUpIcon className="size-3.5" />
        </Button>
      </ManagedControl>
    ) : (
      <span className="text-muted-foreground text-xs">{updatesDenial}</span>
    );
  }
  if (selfUpdate === "desktop-managed" && !desktopAppUpdate) {
    return (
      <span className="text-muted-foreground text-xs">
        Update the desktop app on that machine to update this server.
      </span>
    );
  }
  if (
    refusedCrossing(
      {
        selfUpdate,
        targetVersion,
        channel,
      },
      serverVersion,
    )
  ) {
    return <CrossTrackNote />;
  }
  if (render) {
    return render({
      label,
      disabled: !canUpdate || pendingUpdateEnvironmentIds.has(environmentId),
      onClick: () => void handleUpdate(),
    });
  }
  if (appearance === "icon")
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              className={className}
              aria-label={`${label} for ${serverLabel}`}
              disabled={!canUpdate || pendingUpdateEnvironmentIds.has(environmentId)}
              onClick={() => void handleUpdate()}
            />
          }
        >
          <CircleArrowUpIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    );
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      disabled={!canUpdate || pendingUpdateEnvironmentIds.has(environmentId)}
      onClick={() => void handleUpdate()}
    >
      {label}
    </Button>
  );
}

/** Read the host descriptor's version because the host never delivers server config. */
export function OutdatedServerUpdateAction({
  environmentId,
  serverLabel,
  fromVersion,
  targetVersion,
  label = "Update",
}: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly fromVersion: string | undefined;
  readonly targetVersion: string;
  readonly label?: string;
}) {
  const update = useAtomCommand(updateOutdatedServer, {
    reportFailure: false,
  });
  const sessionStateAtom = environmentSession.sessionStateAtom(environmentId);
  const canUpdate = canUpdateServer(useAtomValue(sessionStateAtom));
  const handleUpdate = async () => {
    if (
      !canUpdateServer(appAtomRegistry.get(sessionStateAtom)) ||
      pendingUpdateEnvironmentIds.has(environmentId)
    )
      return;
    pendingUpdateEnvironmentIds.add(environmentId);
    const result = await update({
      environmentId,
      input: {
        targetVersion,
      },
      ...(fromVersion === undefined
        ? {}
        : {
            fromVersion,
          }),
    });
    pendingUpdateEnvironmentIds.delete(environmentId);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      toastManager.add({
        type: "error",
        title: `${serverLabel}: updater bootstrap required`,
        description: updateFailureMessage(squashAtomCommandFailure(result)),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: `${serverLabel} updated`,
      description: `Reconnected on t3@${result.value.targetVersion}.`,
    });
  };
  if (fromVersion !== undefined && crossesReleaseTrack(fromVersion, targetVersion)) {
    return <CrossTrackNote />;
  }
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={!canUpdate || pendingUpdateEnvironmentIds.has(environmentId)}
      onClick={() => void handleUpdate()}
    >
      {label}
    </Button>
  );
}
