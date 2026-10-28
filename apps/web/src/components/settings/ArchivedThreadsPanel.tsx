import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ArchiveIcon, ArchiveX, EllipsisIcon } from "lucide-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import { useSettingsScope } from "./SettingsScopeContext";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { readThreadShell } from "../../state/entities";
import { readLocalApi } from "../../localApi";
import { RelativeTime } from "../RelativeTime";
import { ProjectFavicon } from "../ProjectFavicon";
import { Spinner } from "../ui/spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { purgeArchivedThreads, selectArchivePurgeTargets } from "./archivePurge";

export function ArchivedThreadsPanel() {
  const { scope, groups: projectGroups, environments, connectedEnvironments } = useSettingsScope();
  const { unarchiveThread, confirmAndDeleteThread, deleteThread } = useThreadActions();
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(scope.environmentIds);

  const { groups: archivedGroups, hasMultipleEnvironments } = (() => {
    const selectedProjectKeys =
      scope.kind === "project" || scope.kind === "checkout"
        ? new Set(scope.members.map((member) => `${member.environmentId}:${member.id}`))
        : null;
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects
          .filter(
            (project) =>
              selectedProjectKeys === null ||
              selectedProjectKeys.has(`${environmentId}:${project.id}`),
          )
          .map(
            (project) => [`${environmentId}:${project.id}`, { ...project, environmentId }] as const,
          ),
      ),
    );
    const environmentLabels = new Map(
      environments.map((environment) => {
        const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
        return [environment.environmentId, secondary ? `${primary} (${secondary})` : primary];
      }),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads
        .filter((thread) => thread.archivedAt !== null)
        .map((thread) => ({
          ...presentThreadShell(environmentId, thread),
          environmentLabel: environmentLabels.get(environmentId) ?? environmentId,
        })),
    );
    const hasMultipleEnvironments =
      new Set(
        threads
          .filter((thread) =>
            projectsByEnvironmentAndId.has(`${thread.environmentId}:${thread.projectId}`),
          )
          .map((thread) => thread.environmentId),
      ).size > 1;
    const logicalGroupsByProjectKey = new Map(
      projectGroups.flatMap((group) =>
        group.memberProjectRefs.map(
          (member) => [`${member.environmentId}:${member.projectId}`, group] as const,
        ),
      ),
    );

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values());
    const groups = new Map<
      string,
      {
        readonly project: (typeof archivedProjects)[number];
        readonly title: string;
        readonly threads: Array<(typeof threads)[number]>;
      }
    >();
    for (const project of archivedProjects) {
      const projectThreads: Array<(typeof threads)[number]> = [];
      for (const thread of threads) {
        if (thread.projectId === project.id && thread.environmentId === project.environmentId) {
          projectThreads.push(thread);
        }
      }
      if (projectThreads.length > 0) {
        const physicalProjectKey = `${project.environmentId}:${project.id}` as const;
        const logicalGroup = hasMultipleEnvironments
          ? logicalGroupsByProjectKey.get(physicalProjectKey)
          : undefined;
        const groupKey = logicalGroup?.projectKey ?? physicalProjectKey;
        const group = groups.get(groupKey);
        if (group) {
          group.threads.push(...projectThreads);
        } else {
          groups.set(groupKey, {
            project,
            title: logicalGroup?.displayName ?? project.title,
            threads: projectThreads,
          });
        }
      }
    }
    const sortedGroups = Array.from(groups, ([key, group]) => ({
      ...group,
      key,
      threads: group.threads.toSorted((left, right) => {
        const leftKey = left.archivedAt ?? left.createdAt;
        const rightKey = right.archivedAt ?? right.createdAt;
        return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
      }),
    }));
    return { groups: sortedGroups, hasMultipleEnvironments };
  })();

  const [query, setQuery] = useState("");
  const [computer, setComputer] = useState("all");
  const [project, setProject] = useState("all");
  const [oldestFirst, setOldestFirst] = useState(false);
  const [purgeProject, setPurgeProject] = useState("all");
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeResult, setPurgeResult] = useState<{
    removed: number;
    failed: string[];
    unavailable: number;
  } | null>(null);
  const [removedKeys, setRemovedKeys] = useState<ReadonlySet<string>>(new Set());
  const threadKey = (thread: { environmentId: string; id: string }) =>
    `${thread.environmentId}:${thread.id}`;
  const allThreads = archivedGroups
    .flatMap((group) => group.threads)
    .filter((thread) => !removedKeys.has(threadKey(thread)));
  const currentThreads = useRef(allThreads);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes current archived threads to the mounted undo callback so it can resolve the latest selection
  useEffect(() => {
    currentThreads.current = allThreads;
  }, [allThreads, currentThreads]);
  const visibleGroups = archivedGroups.flatMap((group) => {
    if (project !== "all" && group.key !== project) return [];
    const threads = group.threads.filter(
      (thread) =>
        !removedKeys.has(threadKey(thread)) &&
        (computer === "all" || thread.environmentId === computer) &&
        thread.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    );
    if (oldestFirst) threads.reverse();
    return threads.length ? [{ ...group, threads }] : [];
  });
  const computerIds = scope.environmentIds.filter((id) => computer === "all" || id === computer);
  const unavailableComputers = computerIds.filter(
    (id) =>
      !connectedEnvironments.some((environment) => environment.environmentId === id) ||
      !archivedSnapshots.some((entry) => entry.environmentId === id),
  );
  const unsupportedComputers = connectedEnvironments.filter(
    (environment) =>
      computerIds.includes(environment.environmentId) &&
      environment.serverConfig?.environment.capabilities.threadArchiveOnlyDelete !== true,
  );
  const purgeGroup = archivedGroups.find((group) => group.key === purgeProject);
  const purgeTargets = selectArchivePurgeTargets(allThreads, {
    environmentIds: computerIds.filter((id) => !unavailableComputers.includes(id)),
    projectKeys:
      purgeProject === "all"
        ? null
        : new Set(
            (purgeGroup?.threads ?? []).map(
              (thread) => `${thread.environmentId}:${thread.projectId}`,
            ),
          ),
  });
  const [confirmedTargets, setConfirmedTargets] = useState<typeof purgeTargets>([]);
  const [confirmedScope, setConfirmedScope] = useState("");
  const [confirmedUnavailable, setConfirmedUnavailable] = useState(0);
  const purgeRunning = useRef(false);
  const startPurge = async () => {
    if (purgeRunning.current) return;
    purgeRunning.current = true;
    setPurgeBusy(true);
    const outcome = await settlePromise(async () => {
      const result = await purgeArchivedThreads({
        confirmed: true,
        targets: confirmedTargets,
        isStillArchived: (thread) => {
          const ref = scopeThreadRef(thread.environmentId, thread.id);
          const shell = readThreadShell(ref);
          return (
            currentThreads.current.some((entry) => threadKey(entry) === threadKey(thread)) &&
            (!shell || shell.archivedAt !== null)
          );
        },
        remove: async (thread) => {
          const result = await deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
            archivedOnly: true,
          });
          if (result._tag === "Success") return { success: true };
          const failure = squashAtomCommandFailure(result);
          return {
            success: false,
            message:
              failure instanceof Error
                ? failure.message
                : "Deletion was interrupted or unavailable.",
          };
        },
      });
      setRemovedKeys((previous) => new Set([...previous, ...result.removed.map(threadKey)]));
      setPurgeResult({
        removed: result.removed.length,
        unavailable: confirmedUnavailable,
        failed: result.failed.map(({ target, message }) => `${target.title}: ${message}`),
      });
      setPurgeOpen(false);
      refreshArchivedThreads();
    });
    purgeRunning.current = false;
    setPurgeBusy(false);
    if (outcome._tag === "Failure") {
      const error = squashAtomCommandFailure(outcome);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not purge archived threads",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const handleArchivedThreadContextMenu = async (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(
      [
        { id: "unarchive", label: "Unarchive" },
        { id: "delete", label: "Delete", destructive: true },
      ],
      position,
    );

    if (clicked === "unarchive") {
      const result = await unarchiveThread(threadRef);
      if (result._tag === "Success") {
        refreshArchivedThreads();
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to unarchive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return;
    }

    if (clicked === "delete") {
      const result = await confirmAndDeleteThread(threadRef);
      if (result._tag === "Success") {
        refreshArchivedThreads();
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection id="archive" title="Archived conversations">
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            Archiving hides conversations while keeping their history. Deletion permanently removes
            conversation history.{" "}
            <Link to="/settings/storage" hash="conversation-evidence" className="underline">
              Evidence retention rules
            </Link>{" "}
            still apply.
          </p>
          <div className="flex flex-wrap gap-3">
            <Input
              aria-label="Search archived titles"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search archived titles"
            />
            <label className="text-sm">
              Computer{" "}
              <select
                aria-label="Filter archive by computer"
                value={computer}
                onChange={(event) => setComputer(event.target.value)}
              >
                <option value="all">All selected computers</option>
                {environments
                  .filter((environment) => scope.environmentIds.includes(environment.environmentId))
                  .map((environment) => (
                    <option key={environment.environmentId} value={environment.environmentId}>
                      {environment.label}
                    </option>
                  ))}
              </select>
            </label>
            <label className="text-sm">
              Project{" "}
              <select
                aria-label="Filter archive by project"
                value={project}
                onChange={(event) => setProject(event.target.value)}
              >
                <option value="all">All projects</option>
                {archivedGroups.map((group) => (
                  <option key={group.key} value={group.key}>
                    {group.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Sort{" "}
              <select
                aria-label="Sort archived conversations"
                value={oldestFirst ? "oldest" : "newest"}
                onChange={(event) => setOldestFirst(event.target.value === "oldest")}
              >
                <option value="newest">Newest archived</option>
                <option value="oldest">Oldest archived</option>
              </select>
            </label>
          </div>
          {archiveError ? (
            <p role="alert" className="text-sm text-destructive">
              {archiveError} Loaded conversations remain available.{" "}
              <Button variant="outline" size="sm" onClick={refreshArchivedThreads}>
                Retry loading
              </Button>
            </p>
          ) : null}
          {unavailableComputers.length ? (
            <p role="status" className="text-sm">
              {unavailableComputers.length} computer(s) unavailable or not loaded. Their archived
              conversations cannot be purged.
            </p>
          ) : null}
          {unsupportedComputers.length > 0 ? (
            <p role="status" className="text-sm">
              Update {unsupportedComputers.map((environment) => environment.label).join(", ")} to
              use safe archive purge, or select a supporting computer.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm">
              Purge scope{" "}
              <select
                aria-label="Purge project scope"
                disabled={purgeBusy}
                value={purgeProject}
                onChange={(event) => setPurgeProject(event.target.value)}
              >
                <option value="all">All archived conversations</option>
                {archivedGroups.map((group) => (
                  <option key={group.key} value={group.key}>
                    {group.title}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="outline"
              size="sm"
              disabled={
                purgeBusy ||
                isLoadingArchive ||
                purgeTargets.length === 0 ||
                unsupportedComputers.length > 0
              }
              onClick={() => {
                setConfirmedTargets(purgeTargets);
                const labels = environments
                  .filter((environment) => computerIds.includes(environment.environmentId))
                  .map((environment) => environment.label)
                  .join(", ");
                setConfirmedScope(
                  `${purgeProject === "all" ? "All projects" : (purgeGroup?.title ?? "Selected project")} on ${labels || "selected computers"}`,
                );
                setConfirmedUnavailable(unavailableComputers.length);
                setPurgeOpen(true);
              }}
            >
              Purge all
            </Button>
            <span className="text-xs text-muted-foreground">
              Title search and the browse project filter do not change purge scope.
            </span>
          </div>
          {purgeResult ? (
            <div role="status" className="text-sm">
              <p>
                Removed {purgeResult.removed}; failed {purgeResult.failed.length}; unavailable
                computers {purgeResult.unavailable}. Unavailable computers were not purged.
              </p>
              {purgeResult.failed.length ? (
                <>
                  <ul>
                    {purgeResult.failed.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                  <p>
                    Failed conversations remain in the archive. Review the scope and choose Purge
                    all to retry.
                  </p>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </SettingsSection>
      <Dialog
        open={purgeOpen}
        onOpenChange={(open) => {
          if (!purgeBusy) setPurgeOpen(open);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Permanently purge archived conversations?</DialogTitle>
            <DialogDescription>
              {confirmedScope}. {confirmedTargets.length} eligible archived conversation(s). This
              permanently clears conversation history. Existing worktree deletion prompts,
              permissions, and cleanup protections still apply. Evidence retention rules continue to
              apply; deleted evidence may leave broken links. Active conversations are excluded.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <p>
              {confirmedUnavailable} unavailable computer(s) excluded. Search text does not limit
              this confirmed scope.
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={purgeBusy} onClick={() => setPurgeOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={purgeBusy} onClick={() => void startPurge()}>
              {purgeBusy ? "Purging…" : `Permanently delete ${confirmedTargets.length}`}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {visibleGroups.length === 0 ? (
        <SettingsSection id="archive-results" title={searchableSetting("archive").title}>
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <Spinner size="sm" tone="muted" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? "Loading archived threads"
                  : archiveError
                    ? "Could not load archived threads"
                    : allThreads.length > 0
                      ? "No matching archived conversations"
                      : "No archived threads"}
              </span>
            }
            description={
              isLoadingArchive
                ? "Checking connected environments."
                : (archiveError ?? "Archived threads will appear here.")
            }
          />
        </SettingsSection>
      ) : (
        visibleGroups.map(({ key, project, title, threads: projectThreads }) => (
          <SettingsSection
            key={key}
            id={`archive-project-${encodeURIComponent(key)}`}
            title={`${title} (${projectThreads.length})`}
            icon={<ProjectFavicon project={project} />}
          >
            {projectThreads.map((thread) => (
              <SettingsRow
                key={`${thread.environmentId}:${thread.id}`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void (async () => {
                    const result = await settlePromise(() =>
                      handleArchivedThreadContextMenu(
                        scopeThreadRef(thread.environmentId, thread.id),
                        {
                          x: event.clientX,
                          y: event.clientY,
                        },
                      ),
                    );
                    if (result._tag === "Failure") {
                      const error = squashAtomCommandFailure(result);
                      toastManager.add(
                        stackedThreadToast({
                          type: "error",
                          title: "Archived thread action failed",
                          description:
                            error instanceof Error ? error.message : "An error occurred.",
                        }),
                      );
                    }
                  })();
                }}
                title={thread.title}
                description={
                  <span className={hasMultipleEnvironments ? "block truncate" : undefined}>
                    {hasMultipleEnvironments ? `${thread.environmentLabel} · ` : null}
                    Archived <RelativeTime timestamp={thread.archivedAt ?? thread.createdAt} />
                    {" \u00b7 Created "}
                    <RelativeTime timestamp={thread.createdAt} />
                  </span>
                }
                control={
                  <div className="flex items-center gap-2">
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="outline"
                            aria-label={`Actions for ${thread.title}`}
                          />
                        }
                      >
                        <EllipsisIcon className="size-4" />
                      </MenuTrigger>
                      <MenuPopup>
                        <MenuItem
                          onClick={() =>
                            void (async () => {
                              const result = await confirmAndDeleteThread(
                                scopeThreadRef(thread.environmentId, thread.id),
                              );
                              if (result._tag === "Success") refreshArchivedThreads();
                              else if (!isAtomCommandInterrupted(result)) {
                                const error = squashAtomCommandFailure(result);
                                toastManager.add(
                                  stackedThreadToast({
                                    type: "error",
                                    title: "Failed to delete thread",
                                    description:
                                      error instanceof Error ? error.message : "Deletion failed.",
                                  }),
                                );
                              }
                            })()
                          }
                        >
                          Delete conversation
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="shrink-0"
                      onClick={() => {
                        void (async () => {
                          const result = await unarchiveThread(
                            scopeThreadRef(thread.environmentId, thread.id),
                          );
                          if (result._tag === "Success") {
                            refreshArchivedThreads();
                            return;
                          }
                          if (!isAtomCommandInterrupted(result)) {
                            const error = squashAtomCommandFailure(result);
                            toastManager.add(
                              stackedThreadToast({
                                type: "error",
                                title: "Failed to unarchive thread",
                                description:
                                  error instanceof Error ? error.message : "An error occurred.",
                              }),
                            );
                          }
                        })();
                      }}
                    >
                      <ArchiveX className="size-3.5" />
                      <span>Unarchive</span>
                    </Button>
                  </div>
                }
              />
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
