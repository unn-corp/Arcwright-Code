import { formatModelSlugName } from "@t3tools/shared/model";
import { useState } from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import {
  participantInitials,
  participantColor,
  type Participant,
} from "@t3tools/client-runtime/participants";
import { AppText as Text } from "./ui/AppText";
import { ProviderIcon } from "./ProviderIcon";

export function ParticipantChip({ participant }: { participant: Participant }) {
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);
  const photo =
    participant.kind === "human" && participant.photo !== failedPhoto ? participant.photo : null;
  const model = participant.kind === "agent" ? participant.model : undefined;
  const modelLabel = model ? formatModelSlugName(model) : undefined;
  const provider =
    participant.kind === "agent"
      ? (participant.driver ??
        (model && /claude/i.test(model)
          ? "claudeAgent"
          : model && /^(gpt|codex|o[1-9])/i.test(model)
            ? "codex"
            : undefined))
      : undefined;
  return (
    <View
      className="mb-2 flex-row items-center gap-2"
      accessibilityLabel={[participant.name, modelLabel].filter(Boolean).join(", ")}
    >
      <View
        className="size-7 items-center justify-center overflow-hidden rounded-full border border-border bg-surface"
        style={
          participant.kind === "agent"
            ? {
                borderColor: participantColor(participant.id),
                backgroundColor: participantColor(participant.id),
              }
            : undefined
        }
      >
        {photo ? (
          <Image
            source={{ uri: photo }}
            style={{ width: 28, height: 28 }}
            contentFit="cover"
            onError={() => setFailedPhoto(photo)}
          />
        ) : provider ? (
          <ProviderIcon provider={provider} size={16} />
        ) : (
          <Text className="text-xs text-foreground">{participantInitials(participant.name)}</Text>
        )}
      </View>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="font-t3-medium text-sm text-foreground">
          {participant.name}
        </Text>
        {model ? (
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            {modelLabel}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
