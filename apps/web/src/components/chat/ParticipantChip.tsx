import { formatModelSlugName } from "@t3tools/shared/model";
import { useState } from "react";
import { Popover, PopoverTrigger, PopoverPopup } from "../ui/popover";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Button } from "../ui/button";
import { BotIcon, InfoIcon } from "lucide-react";
import {
  resolveHumanParticipant,
  participantColor,
  participantInitials,
  type Participant,
} from "@t3tools/client-runtime/participants";
import { OpenAI, ClaudeAI } from "../Icons";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { useClientSettings, persistClientSettingsUpdate } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";

export type ParticipantChipVariant = "standard" | "compact" | "avatar" | "expanded";
/** One identity treatment for chat, reply previews and participant stacks. */
export function ParticipantChip({
  participant: recordedParticipant,
  variant = "standard",
  status,
}: {
  participant: Participant;
  variant?: ParticipantChipVariant;
  status?: string | undefined;
}) {
  const settings = useClientSettings((settings) => settings);
  const participant =
    recordedParticipant.kind === "human"
      ? { kind: "human" as const, ...resolveHumanParticipant(recordedParticipant, settings) }
      : recordedParticipant;
  const override = settings.agentColorOverrides[participant.id];
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);
  const model = participant.kind === "agent" ? participant.model : undefined;
  const modelLabel = model ? formatModelSlugName(model) : undefined;
  const label = [participant.name, modelLabel, variant === "expanded" ? status : undefined]
    .filter(Boolean)
    .join(", ");
  const color =
    participant.kind === "agent" ? participantColor(participant.id, override) : undefined;
  const photo =
    participant.kind === "human" && participant.photo !== failedPhoto ? participant.photo : null;
  const showAvatar =
    participant.kind !== "human" ||
    participant.name !== "You" ||
    photo !== null ||
    variant === "avatar" ||
    variant === "expanded";
  const ModelIcon =
    model && /^(?:gpt|o[1-9]|codex)(?:[- .]|$)/i.test(model)
      ? OpenAI
      : model && /claude/i.test(model)
        ? ClaudeAI
        : null;
  const chip = (
    <span
      data-participant-kind={
        participant.kind === "human" ? "User" : participant.kind === "agent" ? "Agent" : "System"
      }
      data-participant-id={participant.id}
      aria-label={variant === "avatar" ? label : undefined}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-2 align-middle",
        variant === "expanded" && "gap-3",
      )}
    >
      {showAvatar && (
        <span
          aria-hidden
          className={cn(
            "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/50 bg-muted text-xs font-medium text-foreground",
            variant === "expanded"
              ? "size-12"
              : variant === "compact" || variant === "avatar"
                ? "size-6"
                : "size-7",
          )}
          style={
            color
              ? {
                  backgroundColor: `color-mix(in srgb, ${color} 24%, var(--color-background))`,
                  borderColor: color,
                }
              : undefined
          }
        >
          {photo ? (
            <img
              src={photo}
              alt=""
              className="size-full object-cover"
              referrerPolicy="no-referrer"
              onError={() => setFailedPhoto(photo)}
            />
          ) : participant.kind === "human" ? (
            participantInitials(participant.name)
          ) : participant.kind === "system" ? (
            <InfoIcon className="size-4" />
          ) : ModelIcon ? (
            <ModelIcon className="size-4" />
          ) : participant.driver ? (
            <ProviderInstanceIcon
              driverKind={participant.driver}
              displayName={participant.name}
              acpRegistryIconUrl={participant.iconUrl}
              className="z-auto"
              iconClassName="size-4"
            />
          ) : (
            <BotIcon className="size-4" />
          )}
        </span>
      )}
      {variant !== "avatar" && (
        <span className="min-w-0 text-sm">
          <span className="block truncate font-medium">{participant.name}</span>
          {model && variant !== "compact" && (
            <span className="block truncate text-xs text-muted-foreground">{modelLabel}</span>
          )}
          {variant === "expanded" && (
            <span className="block truncate text-xs text-muted-foreground">
              {participant.kind === "human"
                ? "User"
                : participant.kind === "agent"
                  ? "Agent"
                  : "System"}
              {status ? ` · ${status}` : ""}
            </span>
          )}
        </span>
      )}
    </span>
  );
  if (variant === "expanded") return chip;
  if (participant.kind !== "agent" || variant !== "standard")
    return (
      <Tooltip>
        <TooltipTrigger render={chip} />
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
    );
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="max-w-full cursor-pointer rounded-lg text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            aria-label={`View ${label} profile`}
          />
        }
      >
        {chip}
      </PopoverTrigger>
      <PopoverPopup width="sm">
        <div className="flex min-w-0 flex-col gap-4">
          <ParticipantChip participant={participant} variant="expanded" status={status} />
          <label className="flex items-center justify-between gap-3 text-sm">
            Agent color
            <input
              type="color"
              aria-label="Agent color"
              value={color}
              className="size-10 cursor-pointer"
              onChange={(event) => {
                const color = event.target.value;
                void persistClientSettingsUpdate((current) => ({
                  ...current,
                  agentColorOverrides: { ...current.agentColorOverrides, [participant.id]: color },
                })).catch(() => console.error("Could not save agent color"));
              }}
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void persistClientSettingsUpdate((current) => {
                const colors = { ...current.agentColorOverrides };
                delete colors[participant.id];
                return { ...current, agentColorOverrides: colors };
              }).catch(() => console.error("Could not reset agent color"))
            }
          >
            Use automatic color
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
