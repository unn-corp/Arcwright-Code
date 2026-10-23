import { use } from "react";
import type { ChatMessage } from "../../types";
import { TimelineRowCtx } from "./timelineRowContext";
import { useClientSettings } from "../../hooks/useSettings";
import { resolveMessageParticipant } from "@t3tools/client-runtime/participants";
import { isUserMessageRightAligned } from "@t3tools/client-runtime/user-message";
import { ParticipantChip } from "./ParticipantChip";
import { MessageReplyActions } from "./MessageReplies";
import { type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";

export const MESSAGE_HEADING_LEVEL = 3;

export function MessageAuthorHeading({
  message,
  showChip = true,
}: {
  message: ChatMessage;
  showChip?: boolean;
}) {
  const ctx = use(TimelineRowCtx);
  if (!ctx.enhancedFeed) {
    return (
      <h3 className="sr-only select-none">{message.role === "user" ? "You" : "Arcwright Code"}</h3>
    );
  }
  return <ParticipantMessageAuthorHeading message={message} showChip={showChip} />;
}

function ParticipantMessageAuthorHeading({
  message,
  showChip,
}: {
  message: ChatMessage;
  showChip: boolean;
}) {
  const ctx = use(TimelineRowCtx);
  const profileSettings = useClientSettings((settings) => settings);
  const participant = resolveMessageParticipant(
    message,
    ctx.threadRef?.threadId ?? ctx.routeThreadKey,
    ctx.runs,
    ctx.providerStatuses,
    profileSettings,
  );
  return (
    <h3
      className={
        showChip
          ? cn("mb-2 flex min-w-0 select-none", isUserMessageRightAligned(message) && "justify-end")
          : "sr-only"
      }
    >
      {showChip ? <ParticipantChip participant={participant} /> : participant.name}
    </h3>
  );
}

export function MessageBubbleReply({ message }: { message: ChatMessage }) {
  const ctx = use(TimelineRowCtx);
  if (!ctx.enhancedFeed || !ctx.onReplyToMessage) return null;
  return (
    <div
      data-bubble-reply-side={isUserMessageRightAligned(message) ? "left" : "right"}
      style={{
        position: "absolute",
        top: "50%",
        transform: "translateY(-50%)",
        ...(isUserMessageRightAligned(message)
          ? { insetInlineEnd: "calc(100% + 0.25rem)" }
          : { insetInlineStart: "calc(100% + 0.25rem)" }),
      }}
    >
      <MessageReplyActions
        message={message}
        showChain={false}
        onReply={ctx.onReplyToMessage}
        onOpenChain={ctx.onOpenReplyChain}
      />
    </div>
  );
}

export function TimelineRowTimestamp({
  createdAt,
  timestampFormat,
  className,
  alwaysVisible = false,
}: {
  createdAt: string;
  timestampFormat: TimestampFormat;
  className?: string;
  alwaysVisible?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "pointer-events-none absolute me-1 shrink-0 whitespace-nowrap rounded-md text-muted-foreground text-xs tabular-nums opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100",
              alwaysVisible && "pointer-events-auto static opacity-100",
              className,
            )}
          />
        }
      >
        {formatDayAwareTimestamp(createdAt, timestampFormat)}
      </TooltipTrigger>
      <TooltipPopup>{formatChatTimestampTooltip(createdAt, timestampFormat)}</TooltipPopup>
    </Tooltip>
  );
}

export function ActivityShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}
