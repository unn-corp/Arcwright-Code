import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { CircleAlertIcon, CircleCheckIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";

type CollapsedStatusThread = Omit<SidebarThreadSummary, "lastVisitedAt"> & {
  readonly lastVisitedAt?: string | null | undefined;
};

export function summarizeCollapsedThreadStatuses(
  threads: ReadonlyArray<CollapsedStatusThread>,
  localVisits: Readonly<Record<string, string>>,
  includeFailures = true,
) {
  const counts = { input: 0, failed: 0, done: 0 };
  for (const thread of threads) {
    const status = resolveSidebarThreadStatus(thread);
    if (status === "input" || status === "approval" || status === "request") counts.input += 1;
    else if (includeFailures && (status === "failed" || status === "limited")) counts.failed += 1;
    else if (
      status === "ready" &&
      hasUnseenCompletion({
        ...thread,
        lastVisitedAt: resolveThreadLastVisitedAt(
          thread.lastVisitedAt,
          localVisits[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
        ),
      })
    )
      counts.done += 1;
  }
  return counts;
}

/** Summarizes hidden rows without acquiring any thread-detail or VCS subscriptions. */
export function CollapsedThreadStatusIndicators({
  threads,
  id,
  includeFailures = true,
}: {
  threads: ReadonlyArray<CollapsedStatusThread>;
  id?: string;
  includeFailures?: boolean;
}) {
  const counts = useUiStateStore(
    useShallow((state) =>
      summarizeCollapsedThreadStatuses(threads, state.threadLastVisitedAtById, includeFailures),
    ),
  );
  const badges = [
    {
      count: counts.input,
      label: "Need input",
      Icon: MessageCircleQuestionIcon,
      tone: "text-indigo-600 dark:text-indigo-300",
    },
    { count: counts.failed, label: "Failed or limited", Icon: CircleAlertIcon, tone: "text-error" },
    { count: counts.done, label: "Done, unread", Icon: CircleCheckIcon, tone: "text-success" },
  ];
  if (!badges.some((badge) => badge.count > 0)) return null;
  return (
    <span
      id={id}
      className="inline-flex shrink-0 items-center gap-1.5"
      data-collapsed-thread-statuses
    >
      {badges
        .filter((badge) => badge.count > 0)
        .map(({ count, label, Icon, tone }) => (
          <Tooltip key={label}>
            <TooltipTrigger
              render={
                <span
                  role="img"
                  aria-label={`${label}: ${count} ${count === 1 ? "chat" : "chats"}`}
                  className={`inline-flex items-center gap-0.5 text-3xs tabular-nums ${tone}`}
                />
              }
            >
              <Icon aria-hidden className="size-3.5" />
              {count > 1 ? <span aria-hidden>×{count}</span> : null}
            </TooltipTrigger>
            <TooltipPopup>
              {label}: {count} {count === 1 ? "chat" : "chats"}
            </TooltipPopup>
          </Tooltip>
        ))}
    </span>
  );
}
