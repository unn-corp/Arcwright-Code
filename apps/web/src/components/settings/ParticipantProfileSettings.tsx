import { useLayoutEffect, useRef, useState } from "react";
import { currentHuman } from "@t3tools/client-runtime/participants";
import { useClientSettings, persistClientSettingsUpdate } from "../../hooks/useSettings";
import { ParticipantChip } from "../chat/ParticipantChip";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection, SettingsRow } from "./settingsLayout";
import { useManagedAuth } from "../../auth/managedAuthContext";

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
  const auth = useManagedAuth();
  const active = useRef({ auth, profileKey: settings.activeParticipantProfile });
  useLayoutEffect(() => {
    active.current = { auth, profileKey: settings.activeParticipantProfile };
  }, [auth, settings.activeParticipantProfile]);
  const accountProfile = settings.activeParticipantProfile.startsWith("account:");
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const save = async (patch: Partial<typeof human>, photoSource?: "account" | "custom") => {
    const profileKey = settings.activeParticipantProfile;
    await persistClientSettingsUpdate((current) => {
      const existing = current.participantProfiles[profileKey];
      const participant = { ...(existing?.participant ?? human), ...patch };
      return {
        ...current,
        participantProfiles: {
          ...current.participantProfiles,
          [profileKey]: {
            ...existing,
            participant,
            initialized: true,
            accounts: existing?.accounts ?? [],
            ...(photoSource === undefined ? {} : { photoSource }),
          },
        },
      };
    });
  };
  const savePhoto = async (photo: string | null) => {
    const captured = active.current;
    if (!accountProfile) return save({ photo }, "custom");
    if (
      !auth.isSignedIn ||
      captured.profileKey !== `account:${auth.userId}` ||
      !auth.setProfilePhoto
    )
      throw new Error("Sign in again to update your account photo.");
    const updated = await auth.setProfilePhoto(photo);
    const stillCurrent = () => {
      const next = active.current;
      return (
        next.profileKey === captured.profileKey &&
        next.auth.isSignedIn &&
        next.auth.userId === auth.userId &&
        next.auth.sessionId === auth.sessionId &&
        next.auth.generation === auth.generation
      );
    };
    if (!stillCurrent()) throw new Error("Account changed. Please try again.");
    await persistClientSettingsUpdate((current) => {
      if (!stillCurrent()) return current;
      const existing = current.participantProfiles[captured.profileKey];
      return {
        ...current,
        participantProfiles: {
          ...current.participantProfiles,
          [captured.profileKey]: {
            initialized: true,
            accounts: existing?.accounts ?? [],
            participant: { ...(existing?.participant ?? human), photo: updated },
            photoSource: "account",
          },
        },
      };
    });
  };
  const updatePhoto = async (photo: string | null) => {
    setUploading(true);
    setError(null);
    return await (async () => {
      await savePhoto(photo);
    })()
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setUploading(false);
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
        description={
          accountProfile
            ? "Upload a photo or use initials everywhere you sign in to this account."
            : "Choose a photo for this device, or use initials."
        }
      >
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <label className="relative inline-flex cursor-pointer items-center rounded-md border border-input px-3 py-2 text-sm focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring">
            {uploading ? "Saving photo…" : "Upload photo"}
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
                return await (async () => {
                  await savePhoto(await profileThumbnail(file));
                })()
                  .catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  })
                  .finally(() => {
                    setUploading(false);
                  });
              }}
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => void updatePhoto(null)}
          >
            Use initials
          </Button>
          {(accountProfile ? [] : (profile?.accounts ?? []))
            .filter((account) => account.photo)
            .map((account) => (
              <Button
                key={account.id}
                variant="outline"
                size="sm"
                onClick={() =>
                  void save({ photo: account.photo }, "custom").catch((cause: unknown) =>
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
