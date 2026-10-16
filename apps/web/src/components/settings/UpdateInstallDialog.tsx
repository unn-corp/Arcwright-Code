import type { ForkBuildIdentity } from "@t3tools/contracts";
import { formatBuildVersion } from "@t3tools/shared/buildVersion";
import { useState } from "react";
import type { ForkUpdateController } from "../../state/forkUpdates";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/** Rendered only after a fresh status reports running sessions or their work. */
export function UpdateInstallDialog({
  controller,
  device,
  build,
  onClose,
}: {
  controller: ForkUpdateController;
  device: string;
  build: ForkBuildIdentity;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const fresh = await controller.refresh();
      if (fresh.targetBuild?.artifactSha256 !== build.artifactSha256)
        throw new Error("The update changed. Cancel and review the current build before updating.");
      await controller.action({
        action: "install",
        targetArtifactSha256: build.artifactSha256,
        interruptActiveWork: true,
      });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The update could not start.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Interrupt sessions and update?</DialogTitle>
          <DialogDescription>
            {device} will restart to install {formatBuildVersion(build)}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p>
            Running sessions and commands on this device will be interrupted. Saved conversations
            remain available after restart, and session recovery follows your continuation settings.
            In-progress commands may not finish.
          </p>
          {error ? <p role="alert">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void install()}>
            {busy ? "Preparing update…" : "Interrupt and update"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
