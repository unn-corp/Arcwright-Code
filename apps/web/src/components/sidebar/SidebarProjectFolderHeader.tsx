import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, GripVerticalIcon, SquarePenIcon } from "lucide-react";
import { memo, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { CollapsedThreadStatusIndicators } from "./CollapsedThreadStatusIndicators";

/** The folder's sidebar tree row; its thread rows name it as their parent. */
export function sidebarFolderRowId(projectKey: string) {
  return `folder:${projectKey}`;
}

/**
 * A project folder in the boring sidebar. It reads like a shelf header: a trailing
 * count and chevron, with the count and a status dot only while it is closed, so a
 * closed folder still says when a hidden thread needs you.
 */
export const SidebarProjectFolderHeader = memo(function SidebarProjectFolderHeader(props: {
  group: SidebarProjectSnapshot;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: (group: SidebarProjectSnapshot) => void;
  onNewThread: (group: SidebarProjectSnapshot) => void;
  onContextMenu: (group: SidebarProjectSnapshot, position: { x: number; y: number }) => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  isDragging: boolean;
  isDropTarget: boolean;
}) {
  const { group, collapsed, hiddenThreads } = props;
  const rowId = sidebarFolderRowId(group.projectKey);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = collapsed
    ? resolveSidebarFolderDot(
        hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  return (
    <li
      data-testid="sidebar-project-folder"
      data-repository-key={group.projectKey}
      data-repository-group-drop-key={group.projectKey}
      className={cn(
        "group/project-folder relative mt-2 flex list-none items-center rounded-(--control-radius) first:mt-0",
        props.isDragging && "opacity-50",
        props.isDropTarget && "bg-sidebar-row-hover ring-1 ring-inset ring-primary/60",
      )}
    >
      <button
        type="button"
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={rowId}
        aria-expanded={!collapsed}
        onClick={() => props.onToggle(group)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(group, { x: event.clientX, y: event.clientY });
        }}
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ProjectFavicon project={group} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
          {group.displayName}
        </span>
        {collapsed ? <CollapsedThreadStatusIndicators threads={hiddenThreads} /> : null}
        {dot === "working" ? (
          <span className="size-1.5 shrink-0 rounded-full bg-info">
            <span className="sr-only">Working</span>
          </span>
        ) : null}
        {collapsed && hiddenThreads.length > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
            {hiddenThreads.length}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </button>
      <span className="flex shrink-0 items-center opacity-0 focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100">
        <Button
          data-sidebar-action-for={rowId}
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`New thread in ${group.displayName}`}
          onClick={() => props.onNewThread(group)}
        >
          <SquarePenIcon aria-hidden />
        </Button>
      </span>
      <button
        type="button"
        data-sidebar-action-for={rowId}
        data-testid="sidebar-repository-group-handle"
        aria-label={`Reorder ${group.displayName} repository group`}
        aria-description="Drag to reorder, or press Arrow Up or Arrow Down."
        onPointerDown={props.onPointerDown}
        onKeyDown={props.onKeyDown}
        className="flex size-8 shrink-0 touch-none cursor-grab items-center justify-center rounded-sm text-sidebar-muted-foreground/70 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:cursor-grabbing sm:size-5 [@media(pointer:coarse)]:size-11"
      >
        <GripVerticalIcon aria-hidden className="size-3.5" />
      </button>
    </li>
  );
});
