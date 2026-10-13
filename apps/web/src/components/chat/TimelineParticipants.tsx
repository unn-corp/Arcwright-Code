import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { resolveMessageParticipant, type Participant } from "@t3tools/client-runtime/participants";
import { observeResize } from "~/lib/observeResize";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { ParticipantChip } from "./ParticipantChip";
import { isAndroidPwa } from "../../env";

export interface TimelineParticipantGroup {
  readonly rowId: string;
  readonly start: number;
  readonly end: number;
  readonly role: "user" | "assistant" | "system";
  readonly participant: Participant;
}

/** Work and metadata rows belong to the speaker until another message takes over. */
export function timelineParticipantGroups(
  rows: ReadonlyArray<MessagesTimelineRow>,
  thread: string,
  runs: Parameters<typeof resolveMessageParticipant>[2],
  providers: Parameters<typeof resolveMessageParticipant>[3],
  profiles?: Parameters<typeof resolveMessageParticipant>[4],
): ReadonlyArray<TimelineParticipantGroup> {
  const groups: TimelineParticipantGroup[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.kind !== "message") continue;
    const participant = resolveMessageParticipant(row.message, thread, runs, providers, profiles);
    const previous = groups.at(-1);
    if (
      previous?.participant.id === participant.id &&
      previous.participant.kind === participant.kind
    ) {
      continue;
    }
    if (previous) groups[groups.length - 1] = { ...previous, end: index };
    groups.push({
      rowId: row.id,
      start: index,
      end: rows.length,
      role: row.message.role,
      participant,
    });
  }
  return groups;
}

/** The next speaker pushes the pinned chip away instead of overlapping it. */
export function pinnedParticipant(
  groups: ReadonlyArray<TimelineParticipantGroup>,
  rowTop: (index: number) => number | undefined,
  contentEnd: number,
  chipHeight: number,
) {
  let low = 0;
  let high = groups.length - 1;
  let selected: TimelineParticipantGroup | undefined;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const group = groups[middle]!;
    const top = rowTop(group.start);
    if (top === undefined || !Number.isFinite(top)) return null;
    if (top < 0) {
      selected = group;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (!selected) return null;
  const end = rowTop(selected.end) ?? contentEnd;
  if (!Number.isFinite(end) || end <= 0) return null;
  return { group: selected, offset: Math.min(0, end - chipHeight) };
}

/** Kept outside recycled rows so the first message can leave the DOM while its chip stays. */
export function PinnedTimelineParticipant({
  groups,
  listRef,
  refreshRef,
}: {
  groups: ReadonlyArray<TimelineParticipantGroup>;
  listRef: RefObject<LegendListRef | null>;
  refreshRef: RefObject<() => void>;
}) {
  const headerRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState<ReturnType<typeof pinnedParticipant>>(null);
  useLayoutEffect(() => {
    if (isAndroidPwa) return;
    const refresh = () => {
      const list = listRef.current;
      const state = list?.getState();
      const viewport = list?.getScrollableNode();
      const anchor = state?.elementAtIndex?.(state.start);
      const position = state?.positionAtIndex?.(state.start);
      if (!state || !viewport || !anchor || position === undefined) {
        setPinned(null);
        return;
      }
      // Includes list headers, restored offsets and Legend's layout adjustment.
      const origin =
        anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - position;
      const last = state.data.length - 1;
      const contentEnd =
        origin + (state.positionAtIndex(last) ?? 0) + (state.sizeAtIndex(last) ?? 0);
      const next = pinnedParticipant(
        groups,
        (index) => {
          const top = state.positionAtIndex(index);
          return top === undefined ? undefined : origin + top;
        },
        contentEnd,
        headerRef.current?.getBoundingClientRect().height || 48,
      );
      setPinned((previous) =>
        previous?.group === next?.group && previous?.offset === next?.offset ? previous : next,
      );
    };
    refreshRef.current = refresh;
    const frame = requestAnimationFrame(refresh);
    const viewport = listRef.current?.getScrollableNode();
    const stopObserving = viewport ? observeResize(viewport, refresh) : undefined;
    return () => {
      cancelAnimationFrame(frame);
      stopObserving?.();
      refreshRef.current = () => {};
    };
  }, [groups, listRef, refreshRef]);
  useLayoutEffect(() => {
    if (!headerRef.current) return;
    refreshRef.current();
    return observeResize(headerRef.current, () => refreshRef.current());
  }, [pinned?.group, refreshRef]);
  if (isAndroidPwa || !pinned) return null;
  return (
    <div
      className="chat-pinned-participant pointer-events-none absolute inset-0 z-20 hidden overflow-hidden sm:block"
      data-pinned-participant={pinned.group.participant.id}
      aria-hidden="true"
      inert
    >
      <div
        className="chat-content-lane flex items-start"
        style={{
          transform: `translateY(${pinned.offset}px)`,
          justifyContent:
            pinned.group.role === "user" && pinned.group.participant.kind !== "agent"
              ? "flex-end"
              : "flex-start",
        }}
      >
        <div ref={headerRef} className="chat-pinned-participant-tab">
          <ParticipantChip participant={pinned.group.participant} />
        </div>
      </div>
    </div>
  );
}
