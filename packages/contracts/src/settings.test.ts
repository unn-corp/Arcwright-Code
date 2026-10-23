import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { type CommandId, ProjectId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction,
  idleCompactionPatch,
  requiredScopesForProjectMutation,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  withIdleCompaction,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("ServerSettings restart continuation", () => {
  it("defaults on while preserving an explicit opt-out", () => {
    expect(DEFAULT_SERVER_SETTINGS.continueThreadsAfterServerUpdate).toBe(true);
    expect(decodeServerSettings({}).continueThreadsAfterServerUpdate).toBe(true);
    const disabled = { continueThreadsAfterServerUpdate: false };
    expect(encodeServerSettings(decodeServerSettings(disabled))).toMatchObject(disabled);
    expect(decodeServerSettingsPatch(disabled)).toEqual(disabled);
  });
});

describe("automatic repository activity settings", () => {
  it("preserves existing defaults and round-trips environment and project choices", () => {
    expect(decodeServerSettings({})).toMatchObject({
      automaticGitStatus: true,
      automaticCheckpoints: true,
    });
    const input = {
      automaticGitStatus: false,
      automaticCheckpoints: false,
      projectSettingsOverrides: {
        assets: { automaticGitStatus: true, automaticCheckpoints: false },
      },
    };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toMatchObject(input);
  });
});

describe("storage cleanup settings", () => {
  it("keeps cleanup disabled for existing installations", () => {
    expect(decodeServerSettings({}).worktreeCleanup).toBeNull();
    expect(decodeServerSettings({}).storageCleanup).toEqual({
      conversationEvidenceOnArchive: false,
      conversationEvidenceAfterDays: null,
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    });
  });

  it("accepts partial custom patches but requires complete stored project rules", () => {
    expect(
      decodeServerSettingsPatch({
        worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } },
      }),
    ).toEqual({ worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } });
    expect(() =>
      decodeServerSettings({
        projectSettingsOverrides: {
          project: { worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } },
        },
      }),
    ).toThrow();
    expect(
      decodeServerSettings({
        projectSettingsOverrides: {
          project: {
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: null,
                worktreeOnMerge: false,
                worktreeOnDelete: false,
                worktreeUnchanged: false,
              },
            },
          },
        },
      }).projectSettingsOverrides[ProjectId.make("project")]?.worktreeCleanup,
    ).toMatchObject({
      mode: "custom",
      rules: { worktreeSettledAfterDays: null, worktreeKeepWhen: "uncommitted-changes" },
    });
  });

  it("decodes older custom rules with the default local-file policy", () => {
    const settings = decodeServerSettings({
      worktreeCleanup: {
        mode: "custom",
        rules: {
          worktreeAfterDays: 8,
          worktreeOnMerge: false,
          worktreeOnDelete: false,
          worktreeUnchanged: false,
        },
      },
    });
    expect(settings.worktreeCleanup).toMatchObject({
      rules: { worktreeKeepWhen: "uncommitted-changes" },
    });
    expect(
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } }),
    ).toEqual({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } });
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "unknown" } }),
    ).toThrow();
  });

  it.each([0, -1, 1.5, 3651])("rejects invalid retention %s", (days) => {
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { browserArtifactsAfterDays: days } }),
    ).toThrow();
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { conversationEvidenceAfterDays: days } }),
    ).toThrow();
  });
});

describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });
});

describe("custom model settings", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };

  it("accepts legacy bare slugs alongside full entries", () => {
    const decoded = decodeClaudeSettings({
      customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
    });
    expect(decoded.customModels).toEqual([
      "bare-slug",
      { slug: "named", name: "Named", capabilities },
    ]);
  });
});

describe("resolveIdleCompaction", () => {
  it("lets a Claude instance override the global default", () => {
    const settings = decodeServerSettings({
      idleCompaction: "off",
      providerInstances: {
        claude_work: { driver: "claudeAgent", config: { idleCompaction: "onReturn" } },
        claude_personal: { driver: "claudeAgent" },
      },
    });
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_work"))).toBe(
      "onReturn",
    );
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_personal"))).toBe("off");
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claudeAgent"))).toBe("off");
  });

  it("reads the mode from the legacy switch, in either form servers saved it", () => {
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: true }))).toBe(
      "beforeCacheExpires",
    );
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: "off" }))).toBe("off");
    expect(globalIdleCompaction(decodeServerSettings({}))).toBe("onReturn");
  });

  it("keeps the legacy switch a boolean, as shipped clients decode it", () => {
    const encode = Schema.encodeSync(Schema.toCodecJson(ServerSettings));
    for (const mode of ["onReturn", "beforeCacheExpires", "off"] as const) {
      const encoded = encode(withIdleCompaction(DEFAULT_SERVER_SETTINGS, mode)) as {
        readonly compactIdleThreads: unknown;
        readonly idleCompaction: unknown;
      };
      expect(encoded.compactIdleThreads).toBe(mode === "beforeCacheExpires");
      expect(encoded.idleCompaction).toBe(mode);
    }
  });

  it("patches the field the server reads", () => {
    expect(
      idleCompactionPatch({ compactIdleThreads: false, idleCompaction: "onReturn" }, "off"),
    ).toEqual({
      idleCompaction: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: "onReturn" }, "off")).toEqual({
      compactIdleThreads: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: false }, "beforeCacheExpires")).toEqual({
      compactIdleThreads: true,
    });
  });
});

describe("ClientSettings notifications", () => {
  it("requires opt-in when existing settings omit notification preferences", () => {
    expect(decodeClientSettings({}).notificationMode).toBe("off");
    expect(decodeClientSettings({}).inAppNotificationsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("inAppNotificationsEnabled");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("notificationMode");
  });
});

describe("ClientSettings word wrap", () => {
  it("keeps notifications opt-in for existing installations", () => {
    expect(decodeClientSettings({}).agentNotifications).toMatchObject({
      enabled: false,
      notifyOnPlanReady: true,
    });
  });
});

describe("ServerSettings continuous improvement", () => {
  it("is off by default and keeps its automation model configurable", () => {
    expect(decodeServerSettings({}).continuousImprovement).toEqual({
      enabled: false,
      consolidatePullRequests: false,
      removeCompletedWorktrees: true,
      maxRiskTier: "medium",
      minimumConfidence: "medium",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6-luna",
        options: [{ id: "reasoningEffort", value: "max" }],
      },
    });
    expect(
      decodeServerSettingsPatch({
        continuousImprovement: {
          enabled: true,
          consolidatePullRequests: true,
          removeCompletedWorktrees: false,
        },
      }).continuousImprovement,
    ).toEqual({
      enabled: true,
      consolidatePullRequests: true,
      removeCompletedWorktrees: false,
    });
  });

  it("defaults scheduled reviews off while keeping their model policy", () => {
    expect(decodeServerSettings({}).repositoryReview).toEqual({
      enabled: false,
      intervalMinutes: 120,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6-luna",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    });
  });

  it("defaults every top-level automatic-work policy off and preserves explicit opt-ins", () => {
    const defaults = decodeServerSettings({});
    expect([
      defaults.continuousImprovement.enabled,
      defaults.pullRequestRollup.enabled,
      defaults.inactiveWorktreeCleanup.enabled,
      defaults.repositoryReview.enabled,
      defaults.productOpportunityDiscovery.enabled,
      defaults.decisionFollowUp.enabled,
    ]).toEqual([false, false, false, false, false, false]);

    expect(
      decodeServerSettings({ repositoryReview: { enabled: true } }).repositoryReview.enabled,
    ).toBe(true);
  });

  it("keeps product opportunity discovery and decision follow-up opt-in", () => {
    expect(decodeServerSettings({}).productOpportunityDiscovery).toEqual({
      enabled: false,
      maximumCandidates: 2,
    });
    expect(decodeServerSettings({}).decisionFollowUp).toEqual({
      enabled: false,
      intervalMinutes: 360,
      reminderDays: 7,
      maximumConversationsPerRun: 3,
      minimumSeverity: "medium",
      includeNeedsResearch: true,
      includeAboveRisk: true,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6-luna",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    });

    expect(
      decodeServerSettingsPatch({
        productOpportunityDiscovery: { enabled: true, maximumCandidates: 4 },
        decisionFollowUp: {
          enabled: true,
          intervalMinutes: 60,
          reminderDays: 14,
          maximumConversationsPerRun: 5,
          minimumSeverity: "high",
          includeNeedsResearch: false,
        },
      }),
    ).toMatchObject({
      productOpportunityDiscovery: { enabled: true, maximumCandidates: 4 },
      decisionFollowUp: {
        enabled: true,
        intervalMinutes: 60,
        reminderDays: 14,
        maximumConversationsPerRun: 5,
        minimumSeverity: "high",
        includeNeedsResearch: false,
      },
    });
  });

  it.each([
    { productOpportunityDiscovery: { maximumCandidates: 0 } },
    { productOpportunityDiscovery: { maximumCandidates: 7 } },
    { decisionFollowUp: { intervalMinutes: 14 } },
    { decisionFollowUp: { reminderDays: 0 } },
    { decisionFollowUp: { maximumConversationsPerRun: 11 } },
  ])("rejects an invalid discovery or decision policy: %o", (patch) => {
    expect(() => decodeServerSettingsPatch(patch)).toThrow();
  });

  it("accepts qualification cadence and implementation guardrails", () => {
    expect(
      decodeServerSettingsPatch({
        repositoryReview: { enabled: false, intervalMinutes: 30 },
        continuousImprovement: { maxRiskTier: "high", minimumConfidence: "high" },
      }),
    ).toMatchObject({
      repositoryReview: { enabled: false, intervalMinutes: 30 },
      continuousImprovement: { maxRiskTier: "high", minimumConfidence: "high" },
    });
  });

  it("keeps pull request rollups opt-in with a configurable N-day policy", () => {
    expect(decodeServerSettings({}).pullRequestRollup).toEqual({
      enabled: false,
      intervalDays: 7,
      includeDrafts: true,
      includeReady: true,
      minimumIdleDays: 0,
      maximumPullRequests: 100,
      fixFailingChecks: true,
      fixMergeConflicts: true,
      repairAttempts: 2,
      targetBranch: "",
      branchPrefix: "pre-release",
      pullRequestTitle: "Pre-release rollup",
      openAsDraft: true,
      removeCompletedWorktrees: true,
      customInstructions: "",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6-luna",
        options: [{ id: "reasoningEffort", value: "max" }],
      },
    });

    expect(
      decodeServerSettingsPatch({
        pullRequestRollup: {
          enabled: true,
          intervalDays: 14,
          includeDrafts: false,
          minimumIdleDays: 3,
          maximumPullRequests: 25,
          repairAttempts: 4,
          targetBranch: "release/next",
          branchPrefix: "release-candidate",
          pullRequestTitle: "Release candidate",
          openAsDraft: false,
          customInstructions: "Preserve the changelog entries from every source PR.",
        },
      }).pullRequestRollup,
    ).toMatchObject({
      enabled: true,
      intervalDays: 14,
      includeDrafts: false,
      minimumIdleDays: 3,
      maximumPullRequests: 25,
      repairAttempts: 4,
      targetBranch: "release/next",
      branchPrefix: "release-candidate",
      pullRequestTitle: "Release candidate",
      openAsDraft: false,
    });
  });

  it.each([
    { intervalDays: 0 },
    { intervalDays: 91 },
    { minimumIdleDays: -1 },
    { maximumPullRequests: 101 },
    { repairAttempts: 6 },
  ])("rejects an invalid pull request rollup policy: %o", (pullRequestRollup) => {
    expect(() => decodeServerSettingsPatch({ pullRequestRollup })).toThrow();
  });

  it("keeps inactive worktree cleanup opt-in with configurable timing", () => {
    expect(decodeServerSettings({}).inactiveWorktreeCleanup).toEqual({
      enabled: false,
      intervalDays: 1,
      minimumInactiveDays: 14,
    });
    expect(
      decodeServerSettingsPatch({
        inactiveWorktreeCleanup: {
          enabled: true,
          intervalDays: 7,
          minimumInactiveDays: 30,
        },
      }).inactiveWorktreeCleanup,
    ).toEqual({ enabled: true, intervalDays: 7, minimumInactiveDays: 30 });
  });

  it.each([
    { intervalDays: 0 },
    { intervalDays: 31 },
    { minimumInactiveDays: 0 },
    { minimumInactiveDays: 366 },
  ])("rejects an invalid inactive worktree cleanup policy: %o", (inactiveWorktreeCleanup) => {
    expect(() => decodeServerSettingsPatch({ inactiveWorktreeCleanup })).toThrow();
  });
});

describe("ClientSettings quit confirmation", () => {
  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });
});

describe("ClientSettings dictation", () => {
  it("defaults to the system microphone and no injected keybinds for older settings", () => {
    expect(decodeClientSettings({}).dictationMicrophoneDeviceId).toBe("");
    expect(decodeClientSettings({}).dictationStartKeybinds).toEqual([]);
    expect(decodeClientSettings({}).dictationEndKeybinds).toEqual([]);
  });

  it("persists the microphone and injected keybinds in full settings and patches", () => {
    expect(
      decodeClientSettings({
        dictationMicrophoneDeviceId: "studio-mic",
        dictationStartKeybinds: ["ctrl+shift"],
        dictationEndKeybinds: ["ctrl"],
      }),
    ).toMatchObject({
      dictationMicrophoneDeviceId: "studio-mic",
      dictationStartKeybinds: ["ctrl+shift"],
      dictationEndKeybinds: ["ctrl"],
    });
    expect(
      decodeClientSettingsPatch({
        dictationMicrophoneDeviceId: "studio-mic",
        dictationStartKeybinds: ["ctrl+shift"],
        dictationEndKeybinds: ["ctrl"],
      }),
    ).toEqual({
      dictationMicrophoneDeviceId: "studio-mic",
      dictationStartKeybinds: ["ctrl+shift"],
      dictationEndKeybinds: ["ctrl"],
    });
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("hydrates Hermes legacy provider settings and accepts its patch fields", () => {
    const settings = decodeServerSettings({});
    expect(settings.providers.hermes).toMatchObject({
      enabled: true,
      binaryPath: "hermes",
      homePath: "",
      customModels: [],
    });
    expect(
      decodeServerSettingsPatch({
        providers: { hermes: { homePath: "~/.hermes-work", customModels: ["openrouter:hermes"] } },
      }).providers?.hermes,
    ).toEqual({ homePath: "~/.hermes-work", customModels: ["openrouter:hermes"] });
  });

  it("defaults text generation to Luna at low reasoning effort", () => {
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });
});

describe("provider enabled defaults", () => {
  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("ollama"), config: {} }),
    ).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults the thread env mode to inherit and keeps stored values", () => {
    expect(decodeServerSettings({}).defaultThreadEnvMode).toBeNull();
    expect(decodeServerSettings({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe(
      "worktree",
    );
    expect(
      decodeServerSettings({ defaultThreadEnvMode: "remote" }).defaultThreadEnvMode,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ defaultThreadEnvMode: null }).defaultThreadEnvMode,
    ).toBeNull();
  });

  it("keeps an inherited thread env mode off the wire for older clients", () => {
    const encode = Schema.encodeSync(ServerSettings);
    expect("defaultThreadEnvMode" in encode(decodeServerSettings({}))).toBe(false);
    expect(
      encode(decodeServerSettings({ defaultThreadEnvMode: "worktree" })).defaultThreadEnvMode,
    ).toBe("worktree");
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it.each([
    { legacy: "", mode: "repo_conventions", customInstructions: "" },
    { legacy: " \t\n ", mode: "repo_conventions", customInstructions: "" },
    {
      legacy: "  Prefer concise wording.\nKeep issue references.  ",
      mode: "custom",
      customInstructions: "Prefer concise wording.\nKeep issue references.",
    },
  ])("normalizes legacy writing style $legacy in snapshots only", ({ legacy, ...expected }) => {
    const style = { ...expected, followChangeRequestTemplates: true };
    for (const [input, normalized] of [
      [{ sourceControlWritingStyle: legacy }, { sourceControlWritingStyle: style }],
      [
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: legacy } } },
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: style } } },
      ],
    ] as const) {
      const settings = decodeServerSettings(input);
      expect(settings).toMatchObject(normalized);
      expect(encodeServerSettings(settings)).toMatchObject(normalized);
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
  });
});

describe("ServerSettings environment icon", () => {
  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

// `deviceHosts` as it was decoded before EAS hosts existed: an SSH host needs a target.
const decodeOlderDeviceHostSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceHosts: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
  }),
);

it("keeps EAS hosts out of the SSH host list servers and clients before EAS hosts decode", () => {
  const settings = decodeDeviceHostSettings({
    deviceHosts: [{ id: "mini", label: "Mac mini", target: "user@mini" }],
    easDeviceHosts: [{ kind: "eas", id: "eas", label: "EAS Simulator" }],
  });
  const wire = encodeServerSettings(settings);
  expect(decodeOlderDeviceHostSettings(wire).deviceHosts).toEqual([
    { id: "mini", target: "user@mini" },
  ]);
  expect(settings.easDeviceHosts.map((host) => host.id)).toEqual(["eas"]);
});

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  // Hosts saved before EAS hosts existed have no `kind`; they are SSH hosts.
  expect(decodeDeviceHostSettings({ deviceHosts: [host] }).deviceHosts).toEqual([
    { kind: "ssh", ...host },
  ]);
  expect(() => decodeDeviceHostSettings({ deviceHosts: [host, host] })).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, id: "local" }] })).toThrow();
  expect(() =>
    decodeDeviceHostSettings({ deviceHosts: [{ ...host, target: "-oProxyCommand=bad" }] }),
  ).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, port: 0 }] })).toThrow();
});

describe("opt-in run limits", () => {
  it("keeps old settings unlimited and supports inheritance or a thread opt-out", () => {
    expect(decodeServerSettings({})).toMatchObject({
      runLimits: { maxDurationMinutes: null, maxOutputTokens: null },
      threadRunLimits: {},
    });
    const patch = {
      runLimits: { maxDurationMinutes: 15, maxOutputTokens: 1000 },
      threadRunLimits: {
        inherited: null,
        unlimited: { maxDurationMinutes: null, maxOutputTokens: null },
        custom: { maxDurationMinutes: 5, maxOutputTokens: 100 },
      },
    };
    expect(encodeServerSettings(decodeServerSettings(patch))).toMatchObject(patch);
    expect(decodeServerSettingsPatch(patch)).toEqual(patch);
  });
  it.each([0, -1, 1.5, 10081])("rejects invalid minute limits: %s", (maxDurationMinutes) => {
    expect(() =>
      decodeServerSettingsPatch({ runLimits: { maxDurationMinutes, maxOutputTokens: null } }),
    ).toThrow();
  });
});

describe("ClientSettings standard thread feed", () => {
  it("defaults standard threads without a saved preference to the upstream feed", () => {
    expect(decodeClientSettings({}).standardThreadFeed).toBe("upstream");
  });
  it.each(["arcwright", "upstream"] as const)(
    "round-trips the %s feed preference",
    (standardThreadFeed) => {
      expect(encodeClientSettings(decodeClientSettings({ standardThreadFeed }))).toMatchObject({
        standardThreadFeed,
      });
      expect(decodeClientSettingsPatch({ standardThreadFeed })).toEqual({ standardThreadFeed });
    },
  );
  it("rejects unknown feed choices", () => {
    expect(() => decodeClientSettingsPatch({ standardThreadFeed: "unknown" })).toThrow();
  });
});

describe("ClientSettings AI message bubbles", () => {
  it("defaults clients without a saved preference to chat bubbles", () => {
    expect(decodeClientSettings({}).assistantMessageBubbles).toBe(true);
  });
  it.each([true, false])("persists the selected layout: %s", (assistantMessageBubbles) => {
    expect(decodeClientSettings({ assistantMessageBubbles }).assistantMessageBubbles).toBe(
      assistantMessageBubbles,
    );
    expect(encodeClientSettings(decodeClientSettings({ assistantMessageBubbles }))).toMatchObject({
      assistantMessageBubbles,
    });
    expect(decodeClientSettingsPatch({ assistantMessageBubbles })).toEqual({
      assistantMessageBubbles,
    });
  });
  it("rejects non-boolean preferences", () => {
    expect(() => decodeClientSettingsPatch({ assistantMessageBubbles: "yes" })).toThrow();
  });
});

describe("resolveProjectProviderInstanceEnabled", () => {
  const projectId = "project-a" as ProjectId;
  const instanceId = ProviderInstanceId.make("codex_work");

  it("lets a project disable an instance the machine enabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });
});

describe("requiredScopesForProjectMutation", () => {
  it("adds the settings scope only when a mutation carries scripts", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    expect(
      requiredScopesForProjectMutation({ type: "project.update", commandId, projectId }),
    ).toEqual(["orchestration:operate"]);
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write"]);
  });
});

describe("server model preferences", () => {
  it("distinguishes unmigrated lists from deliberately cleared lists", () => {
    expect(decodeServerSettings({})).toMatchObject({
      favorites: null,
      providerModelPreferences: null,
    });
    const input = { favorites: [], providerModelPreferences: {} };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });
});

describe("ClientSettings always compact composer", () => {
  it("preserves automatic layout for existing settings", () => {
    expect(decodeClientSettings({}).alwaysCompactComposer).toBe(false);
  });
  it.each([true, false])("round trips the saved preference: %s", (alwaysCompactComposer) => {
    expect(decodeClientSettings({ alwaysCompactComposer }).alwaysCompactComposer).toBe(
      alwaysCompactComposer,
    );
    expect(decodeClientSettingsPatch({ alwaysCompactComposer })).toEqual({ alwaysCompactComposer });
  });
  it("rejects non-boolean preferences", () => {
    expect(() => decodeClientSettingsPatch({ alwaysCompactComposer: "yes" })).toThrow();
  });
});
