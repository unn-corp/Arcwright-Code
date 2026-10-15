import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  DEFAULT_CLIENT_SETTINGS,
} from "@t3tools/contracts";
import {
  agentInstanceId,
  authorContext,
  currentHuman,
  participantColor,
  participantInitials,
  resolveMessageParticipant,
  resolveHumanParticipant,
  seedProfile,
} from "./participants.ts";

const alice = { id: "account:alice", name: "Alice", photo: "https://example.com/alice.png" };
const message = {
  id: "message",
  role: "assistant" as const,
  text: "Hello",
  runId: RunId.make("old-run"),
};
const run = {
  id: message.runId,
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-old" },
};

describe("participant profiles", () => {
  it("seeds the first personal account and preserves its photo across later connections", () => {
    const first = seedProfile(undefined, alice, [
      { id: "github", label: "GitHub", photo: alice.photo },
    ]);
    const next = seedProfile(first, { ...alice, photo: "https://example.com/google.png" }, [
      { id: "google", label: "Google", photo: null },
    ]);
    expect(next.participant).toEqual(alice);
    expect(next.accounts[0]?.id).toBe("google");
  });
  it("preserves a manual upload and an explicit initials choice", () => {
    for (const photo of ["data:image/webp;base64,AA==", null]) {
      const edited = seedProfile(undefined, { ...alice, photo }, []);
      expect(seedProfile(edited, alice, []).participant.photo).toBe(photo);
    }
  });
  it("keeps separate principals separate and has an unsigned fallback", () => {
    const profiles = {
      alice: seedProfile(undefined, alice, []),
      bob: seedProfile(undefined, { id: "bob", name: "Bob", photo: null }, []),
    };
    expect(
      currentHuman({ participantProfiles: profiles, activeParticipantProfile: "alice" }),
    ).toEqual(alice);
    expect(
      currentHuman({ participantProfiles: profiles, activeParticipantProfile: "bob" }).name,
    ).toBe("Bob");
    expect(currentHuman(DEFAULT_CLIENT_SETTINGS).photo).toBeNull();
  });
  it("captures an immutable display snapshot without dropping reply/context records", () => {
    const context = {
      version: 1 as const,
      records: [],
      replyTo: {
        threadId: ThreadId.make("chat"),
        messageId: MessageId.make("parent"),
        role: "user" as const,
        text: "Question",
      },
    };
    const snapshot = authorContext(context, alice);
    expect(snapshot.author).toEqual(alice);
    expect(snapshot.records).toBe(context.records);
    expect(snapshot.replyTo).toBe(context.replyTo);
    expect(context).not.toHaveProperty("author");
  });
});

describe("historical attribution", () => {
  it("recovers the recorded model instead of a later run's model", () => {
    const later = {
      ...run,
      id: RunId.make("new-run"),
      ordinal: 2,
      modelSelection: { ...run.modelSelection, model: "gpt-new" },
    };
    expect(resolveMessageParticipant(message, "chat", [run, later], [])).toMatchObject({
      kind: "agent",
      model: "gpt-old",
    });
  });
  it("uses durable model attribution even after a run leaves the loaded history", () => {
    const context = {
      version: 1 as const,
      records: [],
      agent: {
        threadId: ThreadId.make("chat"),
        providerInstanceId: run.providerInstanceId,
        model: "gpt-recorded",
      },
    };
    expect(resolveMessageParticipant({ ...message, context }, "chat", [run], [])).toMatchObject({
      model: "gpt-recorded",
    });
    expect(resolveMessageParticipant({ ...message, context }, "chat", [], [])).toMatchObject({
      model: "gpt-recorded",
    });
  });
  it("does not guess models or apply today's human profile to legacy messages", () => {
    expect(resolveMessageParticipant(message, "chat", [], [])).toMatchObject({
      kind: "agent",
      model: undefined,
    });
    expect(resolveMessageParticipant({ ...message, role: "user" }, "chat", [], [])).toMatchObject({
      kind: "human",
      name: "You",
      photo: null,
    });
    expect(
      resolveMessageParticipant(
        { ...message, role: "user", context: { version: 1, records: [], author: alice } },
        "chat",
        [],
        [],
      ),
    ).toMatchObject(alice);
  });
  it("labels agent-to-agent and scheduled messages independently of human photos", () => {
    expect(
      resolveMessageParticipant(
        { ...message, role: "user", senderThreadId: "child" },
        "chat",
        [],
        [],
      ),
    ).toMatchObject({ kind: "agent" });
    expect(
      resolveMessageParticipant(
        { ...message, role: "user", createdBy: "agent", creationSource: "server" },
        "chat",
        [],
        [],
      ),
    ).toMatchObject({ kind: "system" });
  });
});

it("keeps colors stable across retries, model changes, reconnects and independent same-model agents", () => {
  const first = agentInstanceId("child-a", "codex");
  const second = agentInstanceId("child-b", "codex");
  expect(participantColor(first)).not.toBe(participantColor(second));
  expect(participantColor(first)).toBe(participantColor(agentInstanceId("child-a", "codex")));
  expect(participantColor(first, "#aabbcc")).toBe("#aabbcc");
  expect(participantColor(first, "invalid")).toBe(participantColor(first));
  expect(resolveMessageParticipant(message, "chat", [run], []).id).toBe(
    resolveMessageParticipant(
      message,
      "chat",
      [{ ...run, modelSelection: { ...run.modelSelection, model: "gpt-new" } }],
      [],
    ).id,
  );
});
it("initials handle names, single words, emoji and empty values", () => {
  expect(participantInitials("Alice Smith")).toBe("AS");
  expect(participantInitials("Alice")).toBe("AL");
  expect(participantInitials("🐶 Dog")).toBe("🐶D");
  expect(participantInitials("")).toBe("");
});

describe("current human display profiles", () => {
  const updated = { ...alice, name: "Alice Updated", photo: "data:image/webp;base64,AA==" };
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    activeParticipantProfile: "alice",
    participantProfiles: {
      alice: seedProfile(undefined, updated, []),
      bob: seedProfile(undefined, { id: "account:bob", name: "Bob Updated", photo: null }, []),
    },
  };
  it("uses the current name and picture across chats without mutating snapshots", () => {
    for (const thread of ["old-chat", "new-chat", "remote-chat"]) {
      const context = { version: 1 as const, records: [], author: alice };
      expect(
        resolveMessageParticipant({ ...message, role: "user", context }, thread, [], [], settings),
      ).toEqual({ kind: "human", ...updated });
      expect(context.author).toEqual(alice);
    }
  });
  it("uses the active profile for unrecorded and legacy reply authors", () => {
    expect(resolveHumanParticipant(undefined, settings)).toEqual(updated);
    expect(
      resolveHumanParticipant({ id: "legacy-user", name: "You", photo: null }, settings),
    ).toEqual(updated);
  });
  it("preserves other users and resolves known inactive profiles by participant id", () => {
    const unknown = { id: "account:other", name: "Other", photo: "https://example.com/other.png" };
    expect(resolveHumanParticipant(unknown, settings)).toEqual(unknown);
    expect(
      resolveHumanParticipant({ id: "account:bob", name: "Old Bob", photo: alice.photo }, settings),
    ).toEqual(settings.participantProfiles.bob.participant);
  });
  it("honors removing a photo instead of falling back to a historical photo", () => {
    const initials = {
      ...settings,
      participantProfiles: { alice: seedProfile(undefined, { ...updated, photo: null }, []) },
    };
    expect(resolveHumanParticipant(alice, initials).photo).toBeNull();
  });
});

it("uses the signed-in profile for bootstrap identities while preserving customized local users", () => {
  const local = { id: "local:device", name: "You", photo: null };
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    activeParticipantProfile: "account:alice",
    participantProfiles: {
      local: { participant: local, initialized: false, accounts: [] },
      "account:alice": seedProfile(undefined, alice, []),
    },
  };
  expect(resolveHumanParticipant(local, settings)).toEqual(alice);
  expect(resolveHumanParticipant({ ...local, id: "local" }, settings)).toEqual(alice);
  const customized = { ...local, name: "Local Guest" };
  expect(
    resolveHumanParticipant(local, {
      ...settings,
      participantProfiles: {
        ...settings.participantProfiles,
        local: seedProfile(undefined, customized, []),
      },
    }),
  ).toEqual(customized);
});
