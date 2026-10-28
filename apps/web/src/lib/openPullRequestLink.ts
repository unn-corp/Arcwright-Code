import type { EnvironmentId, GitHubAccountId, LocalApi, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { type MouseEvent } from "react";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  resolveChangeRequestLinkTarget,
  resolvePullRequestPreviewTarget,
} from "@t3tools/client-runtime/change-request-links";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { useOpenLink } from "../browser/useOpenLink";
import { useClientSettings } from "../hooks/useSettings";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useRightPanelStore } from "../rightPanelStore";
import { readLocalApi } from "~/localApi";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, useProjects } from "../state/entities";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { usePrimaryEnvironmentId } from "../state/environments";

export class PullRequestLinkOpenError extends Schema.TaggedError<PullRequestLinkOpenError>()(
  "PullRequestLinkOpenError",
  {
    targetOrigin: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  static fromCause(targetUrl: string, cause: unknown): PullRequestLinkOpenError {
    let targetOrigin: string | null = null;
    try {
      targetOrigin = new URL(targetUrl).origin;
    } catch {
      // Keep malformed URLs out of diagnostics while preserving the open failure below.
    }
    return new PullRequestLinkOpenError({ targetOrigin, cause });
  }

  override get message(): string {
    return this.targetOrigin === null
      ? "Unable to open pull request link."
      : `Unable to open pull request link at ${this.targetOrigin}.`;
  }
}

export async function openPullRequestLink(
  shell: Pick<LocalApi["shell"], "openExternal" | "openExternalInGitHubAccount">,
  targetUrl: string,
  githubAccountId?: GitHubAccountId | null,
): Promise<void> {
  try {
    if (githubAccountId && shell.openExternalInGitHubAccount) {
      await shell.openExternalInGitHubAccount(targetUrl, githubAccountId);
    } else {
      await shell.openExternal(targetUrl);
    }
  } catch (cause) {
    throw PullRequestLinkOpenError.fromCause(targetUrl, cause);
  }
}

/** Opens a known GitHub link in the selected project's account session. */
export async function openExternalWithGitHubAccount(
  shell: Pick<LocalApi["shell"], "openExternal" | "openExternalInGitHubAccount">,
  targetUrl: string,
  githubAccountId?: GitHubAccountId | null,
): Promise<void> {
  if (githubAccountId && shell.openExternalInGitHubAccount) {
    await shell.openExternalInGitHubAccount(targetUrl, githubAccountId);
    return;
  }
  await shell.openExternal(targetUrl);
}

/**
 * Uses an account session only when the URL belongs to the project's GitHub
 * host. Research sources can be arbitrary websites and must stay ordinary
 * links even when the record came from a GitHub-backed project.
 */
export async function openProjectExternalLink(
  shell: Pick<LocalApi["shell"], "openExternal" | "openExternalInGitHubAccount">,
  targetUrl: string,
  project: Pick<EnvironmentProject, "githubAccountId" | "repositoryIdentity"> | null | undefined,
): Promise<void> {
  const identity = project?.repositoryIdentity;
  const accountId = project?.githubAccountId ?? null;
  let isProjectGitHubUrl = false;
  if (identity?.provider === "github" && accountId) {
    try {
      const host = new URL(targetUrl).hostname.toLowerCase();
      const projectHost = sourceControlClients.changeRequestHost(identity, "github");
      isProjectGitHubUrl =
        host === projectHost || (projectHost === "github" && host === "github.com");
    } catch {
      isProjectGitHubUrl = false;
    }
  }
  await openExternalWithGitHubAccount(shell, targetUrl, isProjectGitHubUrl ? accountId : null);
}

export function usePullRequestPreviewTarget(environmentId: EnvironmentId | null, url: string) {
  const projects = useProjects();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return resolvePullRequestPreviewTarget({
    environmentId,
    projects,
    pullRequestsEnabled: serverConfig !== null,
    url,
  });
}

function shouldOpenPullRequestExternally(
  event: Pick<MouseEvent<HTMLElement>, "metaKey" | "ctrlKey"> &
    Partial<Pick<MouseEvent<HTMLElement>, "button">>,
): boolean {
  return event.metaKey || event.ctrlKey || event.button === 1;
}

export function useOpenChangeRequestLink(
  threadRef?: ScopedThreadRef,
  panelRef?: ScopedThreadRef,
): (
  event: Pick<
    MouseEvent<HTMLElement>,
    "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
  >,
  targetUrl: string,
  targetThreadRef?: ScopedThreadRef,
  targetEnvironmentId?: EnvironmentId,
) => boolean {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const openInApp = useClientSettings((settings) => settings.pullRequestLinksOpenInApp);
  return (event, targetUrl, targetThreadRef, targetEnvironmentId) => {
    // Read at click time: every provider status push replaces the config map, and
    // subscribing would hand every rendered link a new handler. Projects likewise, so a
    // link can resolve against a snapshot that arrived after this handler was built.
    const serverConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    const resolvedThreadRef = targetThreadRef ?? threadRef;
    const resolvedPanelRef = panelRef ?? resolvedThreadRef;
    const target = resolveChangeRequestLinkTarget({
      url: targetUrl,
      projects: readProjects(),
      configLoaded: (environmentId) => serverConfigs.has(environmentId),
      environmentId: resolvedThreadRef?.environmentId ?? targetEnvironmentId,
      primaryEnvironmentId,
      lendHostProject: resolvedPanelRef !== undefined,
    });
    if (target === null) return false;
    const { project, repository, number, host } = target;
    if (!openInApp || shouldOpenPullRequestExternally(event)) {
      if (project.repositoryIdentity?.provider !== "github" || !project.githubAccountId) {
        return false;
      }
      const api = readLocalApi();
      if (!api) return false;
      event.preventDefault();
      event.stopPropagation();
      void openPullRequestLink(api.shell, targetUrl, project.githubAccountId).catch((error) => {
        console.error(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open pull request link",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      });
      return true;
    }
    event.preventDefault();
    event.stopPropagation();
    const pullRequestsSearch = {
      repository,
      number,
      ...(host === undefined ? {} : { selectedHost: host }),
      selectedProjectId: project.id,
      selectedEnvironmentId: project.environmentId,
    };
    if (resolvedPanelRef) {
      useRightPanelStore.getState().openPullRequest(resolvedPanelRef, {
        // The standalone PR panel has a synthetic ref; each tab keeps its real environment.
        ...(resolvedPanelRef.environmentId === project.environmentId
          ? {}
          : { environmentId: project.environmentId }),
        projectId: project.id,
        ...(host === undefined ? {} : { host }),
        repository,
        url: targetUrl,
        number,
      });
      if (!resolvedThreadRef) {
        void navigate({
          to: "/pull-requests",
          search: (previous) => ({
            ...previous,
            involvement: previous.involvement ?? "all",
            state: previous.state ?? "all",
            ...pullRequestsSearch,
          }),
          replace: true,
        });
      }
      return true;
    }
    void navigate({
      to: "/pull-requests",
      search: { involvement: "all", state: "all", ...pullRequestsSearch },
    });
    return true;
  };
}

export function useOpenPrLink(threadRef?: ScopedThreadRef) {
  const openChangeRequest = useOpenChangeRequestLink(threadRef);
  const openLink = useOpenLink(threadRef);
  return (event: MouseEvent<HTMLElement>, prUrl: string, targetThreadRef?: ScopedThreadRef) => {
    if (event.button > 1) return false;
    event.stopPropagation();
    const openInBrowser = shouldOpenPullRequestExternally(event);
    const isAnchor =
      event.currentTarget instanceof HTMLAnchorElement && event.currentTarget.href.length > 0;
    // Native links handle modified clicks; buttons still need openExternal.
    if (openInBrowser && isAnchor) return openChangeRequest(event, prUrl, targetThreadRef);

    event.preventDefault();
    if (!openInBrowser && openChangeRequest(event, prUrl, targetThreadRef)) return true;

    void openLink(prUrl, { event, threadRef: targetThreadRef }).catch((error: unknown) => {
      console.error(error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
    return false;
  };
}
