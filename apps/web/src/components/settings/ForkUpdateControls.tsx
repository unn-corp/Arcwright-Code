import { Link } from "@tanstack/react-router";
import { formatBuildVersion } from "@t3tools/shared/buildVersion";
import type {
  EnvironmentId,
  ForkBuildIdentity,
  ForkMaintenanceActionInput,
  ForkRecoveryOption,
  ForkUpdateStatus,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { ForkUpdateController, useForkUpdates } from "../../state/forkUpdates";
import {
  forkPhaseLabels,
  forkPinnedBuildLabel,
  forkStatusDetail,
  forkStatusDisplayBuild,
  forkWaitingLabels,
} from "../forkUpdatePresentation";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { isAndroidPwa } from "../../env";
import { UpdateSafetyReviewDialog } from "./UpdateSafetyReviewDialog";
import { UpdateRecoveryDialog } from "./UpdateRecoveryDialog";
import { UpdateInstallDialog } from "./UpdateInstallDialog";

export function ForkUpdateControls({
  controller,
  device,
  environmentId,
  mode = "full",
}: {
  controller: ForkUpdateController;
  device: string;
  environmentId?: EnvironmentId;
  mode?: "full" | "contextual";
}) {
  const { status, busy, error } = useForkUpdates(controller);
  const [installReview, setInstallReview] = useState<ForkBuildIdentity | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<ForkRecoveryOption | null>(null);
  const [review, setReview] = useState<"bootstrap" | "automation" | null>(null);
  const [now, setNow] = useState(Date.now);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{
    phase: ForkUpdateStatus["phase"];
    message: string;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the one-second timer for the mounted native-update countdown
  useEffect(() => {
    if (!status?.countdown) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status?.countdown]);
  const request = (promise: Promise<unknown>) => {
    void promise.catch(() => {});
  };
  const requestUpdate = async (input: ForkMaintenanceActionInput) => {
    setPendingAction(input.action);
    setActionFeedback(null);
    return await (async () => {
      const result = await controller.action(input);
      if (result.lastError) return;
      const target = result.targetBuild ? ` · ${formatBuildVersion(result.targetBuild)}` : "";
      setActionFeedback({
        phase: result.phase,
        message:
          input.action === "check"
            ? `Check completed. ${forkPhaseLabels[result.phase]}${target}.`
            : result.phase === "waiting"
              ? "Installation has not started. Waiting for this device’s activity and safety checks."
              : `Install request checked. ${forkPhaseLabels[result.phase]}.`,
      });
    })()
      .catch(() => {
        // The controller retains the error across status polling and native status events.
      })
      .finally(() => {
        setPendingAction(null);
      });
  };
  const updateNow = async () => {
    const reviewed = status?.targetBuild;
    if (!reviewed) return;
    setInstallError(null);
    return await (async () => {
      const fresh = await controller.refresh();
      if (fresh.targetBuild?.artifactSha256 !== reviewed.artifactSha256)
        throw new Error("The update changed. Review the current build before updating.");
      if (
        fresh.blockers.some((blocker) =>
          ["active-agents", "commands", "background-work"].includes(blocker.reason),
        )
      ) {
        setInstallReview(reviewed);
        return;
      }
      await requestUpdate({ action: "install", targetArtifactSha256: reviewed.artifactSha256 });
    })().catch((failure: unknown) => {
      setInstallError(
        failure instanceof Error ? failure.message : "Could not check update status.",
      );
    });
  };
  if (!status)
    return (
      <SettingsRow
        title={device}
        description={error ?? "Loading update status…"}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => request(controller.refresh())}
          >
            Retry
          </Button>
        }
      />
    );
  const working = ["checking", "downloading", "installing", "verifying", "recovery"].includes(
    status.phase,
  );
  const detail = forkStatusDetail(status);
  const displayBuild = forkStatusDisplayBuild(status);
  const pinnedBuildLabel = forkPinnedBuildLabel(status);
  const installUnavailable =
    (status.installable === false && status.interruptible !== true) ||
    !["staged", "waiting", "failed"].includes(status.phase);
  const installReason = installUnavailable
    ? status.blockers.length
      ? `Installation is waiting: ${[...new Set(status.blockers.map((blocker) => forkWaitingLabels[blocker.reason]))].join("; ")}.`
      : status.policy.pinnedBuild
        ? "Resume updates before installing this build."
        : ["available", "downloaded"].includes(status.phase)
          ? "Download and verify this update before installing."
          : working
            ? "Wait for the current update operation to finish."
            : "The host has not authorized installation yet. Refresh its update status."
    : null;
  return (
    <>
      <SettingsRow
        title={device}
        description={`Installed: ${formatBuildVersion(status.currentBuild)} · ${status.currentBuild.commit.slice(0, 12) || "unknown"}${status.currentBuild.installationSequence === undefined ? "" : ` · Installation sequence ${status.currentBuild.installationSequence}`}`}
        status={
          <div role="status" aria-live="polite">
            <p>
              {forkPhaseLabels[status.phase]}
              {displayBuild ? ` · ${formatBuildVersion(displayBuild)}` : ""}
            </p>
            {detail ? <p className="whitespace-normal break-words">{detail}</p> : null}
            {actionFeedback?.phase === status.phase ? <p>{actionFeedback.message}</p> : null}
            {installError ? <p role="alert">{installError}</p> : null}
            {status.lastError ? (
              <p role="alert" className="text-destructive">
                {status.lastError}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={busy || working}
            onClick={() => void requestUpdate({ action: "check" })}
          >
            {pendingAction === "check" ? "Checking and downloading…" : "Check and download"}
          </Button>
        }
      />
      {status.affectedHomes?.length ? (
        <SettingsRow
          title="Affected data homes"
          description={status.affectedHomes.map((home) => home.label).join(" · ")}
        />
      ) : null}
      {status.blockers.length && environmentId ? (
        <SettingsRow
          title="Inspect host activity"
          description="Review the named host’s processes and running sessions before updating."
          control={
            <Link
              to="/settings/diagnostics"
              search={{ machine: environmentId }}
              className="text-xs underline"
            >
              View host activity
            </Link>
          }
        />
      ) : null}
      {status.blockers.some((blocker) => blocker.reason === "bootstrap") &&
      (environmentId || !isAndroidPwa) ? (
        <SettingsRow
          title="Review fork installations"
          description="Complete the stopped-work bootstrap for every known fork installation on this device before enabling delivery."
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setReview("bootstrap")}
            >
              Review installations
            </Button>
          }
        />
      ) : null}
      {mode === "full" ? (
        <SettingsRow
          title="Update channel"
          description={`Saved on ${device}. Other devices keep their own preferences.`}
          control={
            <Select
              value={status.policy.channel}
              onValueChange={(value) => {
                if (value === "stable" || value === "nightly")
                  request(controller.setPolicy({ channel: value }));
              }}
            >
              <SelectTrigger size="sm" aria-label={`${device} update channel`} disabled={busy}>
                <SelectValue>
                  {status.policy.channel === "nightly" ? "Nightly" : "Stable"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="stable">Stable</SelectItem>
                <SelectItem value="nightly">Nightly</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      {mode === "full" ? (
        <SettingsRow
          title="Automatic installation"
          description="Install automatically when idle, or turn this off and use Update now to choose when to restart. Update now asks before interrupting running sessions."
          control={
            <Switch
              aria-label={`${device} automatic installation`}
              checked={status.policy.automaticInstallation}
              disabled={busy}
              onCheckedChange={(enabled) =>
                request(controller.setPolicy({ automaticInstallation: enabled }))
              }
            />
          }
        />
      ) : null}
      {status.storageMigrationPending ? (
        <SettingsRow
          title="Historical database storage"
          description="Historical data remains readable. Plain JSON restoration requires a supported build and an explicit maintenance request."
        />
      ) : null}
      {status.countdown ? (
        <SettingsRow
          title={`${status.storageMigrationPending && status.countdown.targetArtifactSha256 === status.currentBuild.artifactSha256 ? "Database cleanup" : "Installation"} in ${Math.max(0, Math.ceil((status.countdown.installsAt - now) / 1000))} seconds`}
          description="The app will restart after the cancellable 15-second countdown. New activity defers maintenance."
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => request(controller.action({ action: "cancel-countdown" }))}
            >
              Cancel countdown
            </Button>
          }
        />
      ) : null}
      {status.targetBuild ? (
        <SettingsRow
          title="Update now"
          description={
            installReason ??
            "Restart and install now. If sessions are running, you’ll be asked before interrupting them. Saved conversations remain available after restart."
          }
          control={
            <Button
              size="sm"
              disabled={busy || working || installUnavailable}
              title={installReason ?? undefined}
              onClick={() => void updateNow()}
            >
              {pendingAction === "install" ? "Checking installation…" : "Update now"}
            </Button>
          }
        />
      ) : null}
      {mode === "full" ? (
        <SettingsRow
          title={status.policy.pinnedBuild !== null ? "Updates pinned" : "Pin this build"}
          description={
            status.policy.pinnedBuild !== null
              ? `${pinnedBuildLabel ?? "Pinned build"}. Resume updates does not resume agent work.`
              : "Keep the installed build until you explicitly resume updates."
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy ||
                (status.policy.pinnedBuild === null &&
                  !/^[a-f0-9]{64}$/.test(status.currentBuild.artifactSha256))
              }
              onClick={() =>
                request(
                  controller.setPolicy({
                    pinnedBuild:
                      status.policy.pinnedBuild !== null
                        ? null
                        : status.currentBuild.artifactSha256,
                  }),
                )
              }
            >
              {status.policy.pinnedBuild !== null ? "Resume updates" : "Pin build"}
            </Button>
          }
        />
      ) : null}
      {status.recoveryOptions.length ? (
        <SettingsRow
          title="Recovery"
          description="Select a retained build to review its compatibility and affected homes."
        >
          <div className="flex flex-wrap gap-2 pb-3">
            {status.recoveryOptions.map((option) => (
              <Button
                key={option.id}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  try {
                    const fresh = await controller.refresh();
                    const candidate = fresh.recoveryOptions.find((item) => item.id === option.id);
                    if (candidate) setRecovery(candidate);
                  } catch {
                    /* Controller displays the failure. */
                  }
                }}
              >
                Review {option.build.version}
              </Button>
            ))}
          </div>
        </SettingsRow>
      ) : null}
      {status.automationReviewRequired ? (
        <SettingsRow
          title="Review restored automation"
          description="Restored schedules and queued runs remain held. Review them before permitting agent work."
          control={
            <div className="flex flex-wrap items-center gap-3">
              <Link
                to="/settings/scheduled-tasks"
                search={environmentId ? { machine: environmentId } : {}}
                className="text-xs underline"
              >
                Review schedules and queued work
              </Link>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setReview("automation")}
              >
                Confirm automation review
              </Button>
            </div>
          }
        />
      ) : null}
      {installReview ? (
        <UpdateInstallDialog
          device={device}
          controller={controller}
          build={installReview}
          onClose={() => setInstallReview(null)}
        />
      ) : null}
      <UpdateSafetyReviewDialog
        key={review ?? "no-review"}
        controller={controller}
        device={device}
        review={review}
        onClose={() => setReview(null)}
      />
      <UpdateRecoveryDialog
        key={recovery?.id ?? "closed"}
        device={device}
        controller={controller}
        option={recovery}
        onClose={() => setRecovery(null)}
      />
    </>
  );
}
