import { useState } from "react";
import { currentHuman, seedProfile } from "@t3tools/client-runtime/participants";
import { useClientSettings, persistClientSettingsUpdate } from "../../hooks/useSettings";
import { ParticipantChip } from "../chat/ParticipantChip";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection, SettingsRow } from "./settingsLayout";

/** Crop once at upload, keeping both persistence and message snapshots bounded. */
export async function profileThumbnail(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 10_000_000) {
    throw new Error("Choose a PNG, JPEG or WebP image smaller than 10 MB.");
  }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the profile image.");
    const edge = Math.min(bitmap.width, bitmap.height);
    context.drawImage(
      bitmap,
      (bitmap.width - edge) / 2,
      (bitmap.height - edge) / 2,
      edge,
      edge,
      0,
      0,
      96,
      96,
    );
    const photo = canvas.toDataURL("image/webp", 0.8);
    if (photo.length > 16_384)
      throw new Error("This image is too detailed. Choose a simpler image.");
    return photo;
  } finally {
    bitmap.close();
  }
}

export function ParticipantProfileSettings() {
  const settings = useClientSettings();
  const human = currentHuman(settings);
  const profile = settings.participantProfiles[settings.activeParticipantProfile];
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const save = async (patch: Partial<typeof human>) => {
    const profileKey = settings.activeParticipantProfile;
    await persistClientSettingsUpdate((current) => {
      const existing = current.participantProfiles[profileKey];
      const participant = { ...(existing?.participant ?? human), ...patch };
      return {
        ...current,
        participantProfiles: {
          ...current.participantProfiles,
          [profileKey]: seedProfile(undefined, participant, existing?.accounts ?? []),
        },
      };
    });
  };
  return (
    <SettingsSection id="profile" title="Profile">
      <SettingsRow
        title="Chat identity"
        description="Your profile is separate for each signed-in account. Your chats display your current name and photo."
      >
        <ParticipantChip participant={{ kind: "human", ...human }} variant="expanded" />
      </SettingsRow>
      <SettingsRow title="Display name">
        <div className="w-full sm:max-w-64">
          <Input
            aria-label="Profile display name"
            key={human.id}
            defaultValue={human.name}
            maxLength={100}
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (name) void save({ name }).catch((cause: unknown) => setError(String(cause)));
              else event.target.value = human.name;
            }}
          />
        </div>
      </SettingsRow>
      <SettingsRow
        title="Profile image"
        description="The first account you sign in with supplies your starting photo. You can replace it or use initials."
      >
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <label className="relative inline-flex cursor-pointer items-center rounded-md border border-input px-3 py-2 text-sm focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring">
            {uploading ? "Preparing image…" : "Upload photo"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="Upload profile photo"
              disabled={uploading}
              className="absolute inset-0 w-full cursor-pointer opacity-0"
              onChange={async (event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (!file) return;
                setUploading(true);
                setError(null);
                try {
                  await save({ photo: await profileThumbnail(file) });
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setUploading(false);
                }
              }}
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void save({ photo: null }).catch((cause: unknown) => setError(String(cause)))
            }
          >
            Use initials
          </Button>
          {(profile?.accounts ?? [])
            .filter((account) => account.photo)
            .map((account) => (
              <Button
                key={account.id}
                variant="outline"
                size="sm"
                onClick={() =>
                  void save({ photo: account.photo }).catch((cause: unknown) =>
                    setError(String(cause)),
                  )
                }
              >
                {account.label}
              </Button>
            ))}
        </div>
      </SettingsRow>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </SettingsSection>
  );
}
