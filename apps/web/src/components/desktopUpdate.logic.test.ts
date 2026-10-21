import { getDesktopUpdateInstallConfirmationMessage } from "./desktopUpdate.logic";
import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("hides the install action while checking for a newer release", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });
});

describe("desktop update UI helpers", () => {
  it("builds the stable release URL for a downloaded version", () => {
    expect(getDesktopUpdateReleaseUrl("0.0.30")).toBe(
      "https://github.com/unn-corp/Arcwright-Code/releases/tag/fork-v0.0.30",
    );
  });

  it("uses the configured desktop update repository for release URLs", () => {
    expect(getDesktopUpdateReleaseUrl("1.2.3", "JustYannicc/t3code")).toBe(
      "https://github.com/JustYannicc/t3code/releases/tag/fork-v1.2.3",
    );
    expect(getDesktopUpdateReleaseHistoryUrl("JustYannicc/t3code")).toBe(
      "https://github.com/JustYannicc/t3code/releases",
    );
  });

  it.each([
    "owner/repo/extra",
    "owner#notes/repo",
    "owner/repo#notes",
    "owner?tab=notes/repo",
    "owner/repo?tab=notes",
  ])("falls back to the fork for an invalid configured repository: %s", (repository) => {
    expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBe(
      "https://github.com/unn-corp/Arcwright-Code/releases",
    );
    expect(getDesktopUpdateReleaseUrl("1.2.3", repository)).toBe(
      "https://github.com/unn-corp/Arcwright-Code/releases/tag/fork-v1.2.3",
    );
  });

  it("builds the nightly release URL without dropping its version suffix", () => {
    expect(getDesktopUpdateReleaseUrl("0.0.30-nightly.20260728.931")).toBe(
      "https://github.com/unn-corp/Arcwright-Code/releases/tag/fork-v0.0.30-nightly.20260728.931",
    );
  });

  it("builds the release history URL", () => {
    expect(getDesktopUpdateReleaseHistoryUrl()).toBe(
      "https://github.com/unn-corp/Arcwright-Code/releases",
    );
  });

  it("keeps the same install confirmation copy across desktop platforms", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(
      "Install update 1.1.0 and restart Arcwright Code?\n\nInstallation waits until all registered agents and background work on this device are stopped. Updates never stop agents.",
    );
  });
});

describe("canCheckForUpdate", () => {
  it("returns true once an update has been downloaded so newer releases can be found", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(true);
  });
});
