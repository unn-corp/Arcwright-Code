import { searchableSetting } from "./settingsSearch";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  makeProviderSettingsSchema,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { UNKNOWN_SOURCE_CONTROL_CLIENT } from "@t3tools/client-runtime/source-control-clients";
import * as Schema from "effect/Schema";

import {
  filterAvailableSettingsSearchItems,
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
  movedSettingsPath,
  searchSettings,
  settingsTargetDestination,
  settingsTargetAnchor,
  SETTINGS_SEARCH_ITEMS,
  sourceControlHostSearchItems,
  sourceControlHostSettingsSearchId,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/general",
    searchTerms: ["long lines in code previews"],
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/access",
    searchTerms: ["remote pairing backend"],
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
    searchTerms: ["claude codex agents"],
  },
  {
    id: "provider-updates",
    title: "Update checks",
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    to: "/settings/general",
  },
  {
    id: "git-fetch-interval",
    title: "Git fetch interval",
    to: "/settings/maintenance",
  },
];

describe("searchSettings", () => {
  it("finds the standard-thread feed choice in Appearance", () => {
    expect(searchSettings("upstream chat feed")).toContainEqual(
      expect.objectContaining({ id: "standard-thread-feed", to: "/settings/appearance" }),
    );
  });
  it.each([
    ["automatic git status", "automatic-git-status"],
    ["automatic checkpoints", "automatic-checkpoints"],
    ["file rollback", "automatic-checkpoints"],
  ])("finds repository activity controls for %s", (query, id) => {
    expect(
      searchSettings(query).some(
        (item) => item.id === id && item.to === "/settings/source-control",
      ),
    ).toBe(true);
  });

  it("matches titles, sections, and remembered setting details", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("sharing", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("claude", ITEMS).map((item) => item.id)).toEqual(["providers"]);
    expect(searchSettings("long lines", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("glass").map((item) => item.id)).toEqual(["setting-glass-opacity"]);
    expect(searchSettings("panel animations").map((item) => item.id)).toEqual(["panel-animations"]);
    expect(searchSettings("thè\u{1ab0}mes")[0]?.id).toBe("theme");
    const localeLowerCase = vi.spyOn(String.prototype, "toLocaleLowerCase").mockReturnValue("gıt");
    try {
      expect(searchSettings("GIT", ITEMS).map((item) => item.id)).toEqual(["git-fetch-interval"]);
      expect(localeLowerCase).not.toHaveBeenCalled();
    } finally {
      localeLowerCase.mockRestore();
    }
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("matches query words across fields and ranks the strongest result first", () => {
    expect(searchSettings("pairing remote", ITEMS).map((item) => item.id)).toEqual([
      "network-access",
    ]);
    expect(
      searchSettings("remote pairing")
        .slice(0, 2)
        .map((item) => item.id),
    ).toEqual(["network-access", "connections-environment"]);
  });

  it("hides desktop-only settings from browser search", () => {
    expect(SETTINGS_SEARCH_ITEMS.some((item) => item.id === "quit-confirmation")).toBe(true);
    expect(searchSettings("hold to quit")).toEqual([]);
    expect(searchSettings("wsl")).toEqual([]);
    expect(searchSettings("update track").map((item) => item.id)).not.toContain("update-track");
  });

  it("finds the About update rows", () => {
    expect(searchSettings("check for updates").map((item) => item.id)).toContain("app-version");
    expect(SETTINGS_SEARCH_ITEMS.find((item) => item.id === "update-track")).toMatchObject({
      title: "Update track",
      to: "/settings/about",
      releaseChannelOnly: true,
    });
  });

  it("hides settings whose controls are unavailable", () => {
    const available = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: false,
      hasProviderSettingsEnvironment: false,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    });

    const gatedIds = new Set<string>([
      "follow-change-request-templates",
      "git-fetch-interval",
      "network-access",
      "publish-agent-activity",
      "provider-health-check-interval",
      "cursor-keychain-usage",
      "source-control-writer-model",
      "review-guide-model",
      "review-guide-instructions",
      "source-control-writing-style",
      "t3-connect",
      "hold-webhooks-while-offline",
      "tailscale-https",
      "wsl-backend",
      "auto-settle-inactive-threads",
      "auto-settle-merged-threads",
      "days-before-auto-settle",
      "linked-environments",
    ]);
    expect(available.map((item) => item.id).filter((id) => gatedIds.has(id))).toEqual([]);
  });

  it("finds linked environments on a remote host without local maintenance access", () => {
    const availability = {
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      localEnvironmentDisabled: true,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    };
    const results = (hasPeerLinkHost: boolean) =>
      searchSettings(
        "linked environments",
        filterAvailableSettingsSearchItems({ ...availability, hasPeerLinkHost }),
      );
    expect(results(false).map((item) => item.id)).not.toContain("linked-environments");
    expect(results(true)).toContainEqual(
      expect.objectContaining({
        id: "linked-environments",
        to: "/settings/connections",
        targetId: "linked-environments",
      }),
    );
  });

  it("finds keybinding commands by label, command id, and default key", () => {
    expect(searchSettings("toggle sidebar")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("sidebar.toggle")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("mod+b")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("copy link")[0]).toMatchObject({
      id: "keybinding-thread.copyReference",
      to: "/settings/keybindings",
    });
  });

  it("sends commands without a default binding to the section", () => {
    expect(searchSettings("thread.stop")[0]).toMatchObject({
      id: "keybinding-thread.stop",
      targetId: "keybindings",
    });
    expect(searchSettings("sidebar.toggle")[0]?.targetId).toBeUndefined();
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("routes appearance settings to their current section", () => {
    expect(searchSettings("Always compact composer")[0]).toMatchObject({
      id: "always-compact-composer",
      to: "/settings/chat",
    });
    expect(searchSettings("AI message bubbles")[0]).toMatchObject({
      id: "assistant-message-bubbles",
      to: "/settings/appearance",
    });
    expect(searchSettings("theme")[0]).toMatchObject({
      id: "theme",
      to: "/settings/appearance",
    });
    expect(searchSettings("word wrap")[0]).toMatchObject({
      id: "word-wrap",
      to: "/settings/appearance",
    });
    expect(searchSettings("composer context")[0]).toMatchObject({
      id: "composer-context",
      to: "/settings/appearance",
    });
    expect(searchSettings("environment identification")[0]).toMatchObject({
      id: "environment-identification",
      to: "/settings/appearance",
      targetId: "appearance-interface",
    });
  });

  it("routes unattended work to the Automation section", () => {
    expect(searchSettings("continuous improvement")[0]).toMatchObject({
      id: "continuous-improvement",
      to: "/settings/automation",
    });
    expect(searchSettings("qualification model")[0]).toMatchObject({
      id: "repository-review-model",
      to: "/settings/automation",
    });
    expect(searchSettings("qualification cadence")[0]).toMatchObject({
      id: "repository-review-interval",
      to: "/settings/automation",
    });
    expect(searchSettings("maximum automation risk")[0]).toMatchObject({
      id: "continuous-improvement-max-risk",
      to: "/settings/automation",
    });
    expect(searchSettings("consolidate pull requests")[0]).toMatchObject({
      id: "continuous-improvement-consolidate-prs",
      to: "/settings/automation",
    });
    expect(searchSettings("remove completed worktrees")[0]).toMatchObject({
      id: "continuous-improvement-remove-worktrees",
      to: "/settings/automation",
    });
    expect(searchSettings("outstanding draft")[0]).toMatchObject({
      id: "pull-request-rollup",
      to: "/settings/automation",
    });
    expect(searchSettings("repair failing pull request checks")[0]).toMatchObject({
      id: "pull-request-rollup-failing-checks",
      to: "/settings/automation",
    });
    expect(searchSettings("rollup target branch")[0]).toMatchObject({
      id: "pull-request-rollup-target",
      to: "/settings/automation",
    });
    expect(searchSettings("saved remote worktree")[0]).toMatchObject({
      id: "inactive-worktree-cleanup",
      to: "/settings/automation",
    });
    expect(searchSettings("background activity")[0]).toMatchObject({
      id: "background-activity",
      to: "/settings/maintenance",
    });
  });
});

describe("settings search targets", () => {
  it("requires an environment for the resolved telemetry export destination", () => {
    const result = searchSettings("OpenTelemetry export").find(
      (item) => item.id === "telemetry-export",
    )!;
    const target = getSettingsSearchTargetScope(result.targetId ?? result.id)!;
    expect(isSettingsSearchScopeAvailable(target.scope, "all")).toBe(false);
    expect(isSettingsSearchScopeAvailable(target.scope, "project")).toBe(false);
    expect(isSettingsSearchScopeAvailable(target.scope, "environment")).toBe(true);
  });

  it("keeps environment-wide settings out of project scopes", () => {
    const updates = getSettingsSearchTargetScope("provider-update-checks")!;
    expect(updates.scope).toBe("environment-defaults");
    expect(isSettingsSearchScopeAvailable(updates.scope, "environment")).toBe(true);
    expect(isSettingsSearchScopeAvailable(updates.scope, "all")).toBe(true);
    expect(isSettingsSearchScopeAvailable(updates.scope, "project")).toBe(false);
    const streaming = getSettingsSearchTargetScope("response-streaming")!;
    expect(streaming.scope).toBe("project-defaults");
    expect(isSettingsSearchScopeAvailable(streaming.scope, "project")).toBe(true);
    for (const id of [
      "legacy-plan-mode",
      "legacy-context-window-indicator",
      "boring-sidebar",
      "diff-layout",
      "hide-whitespace-changes",
    ]) {
      expect(getSettingsSearchTargetScope(id)!.scope).toBeNull();
    }
  });
});

describe("auto-settlement search availability", () => {
  function environment(id: string, { connected = true, loaded = true } = {}) {
    return {
      environmentId: EnvironmentId.make(id),
      connection: { phase: connected ? ("connected" as const) : ("offline" as const) },
      serverConfig: loaded ? { environment: { capabilities: {} } } : null,
    };
  }

  const capable = environment("capable");
  const offline = environment("offline", { connected: false });
  const loading = environment("loading", { loaded: false });
  const environments = [capable, offline, loading];

  it("keeps results discoverable when one connected environment supports them", () => {
    const availability = getThreadAutoSettlementSearchAvailability(environments);
    expect(availability.eligibleEnvironmentIds).toEqual([capable.environmentId]);
    const items = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: availability.eligibleEnvironmentIds.length > 0,
    });
    expect(searchSettings("auto-settle", items).map((item) => item.id)).toEqual([
      "auto-settle-inactive-threads",
      "auto-settle-merged-threads",
      "days-before-auto-settle",
      "keep-threads-with-pull-requests",
    ]);
  });

  it.each([offline, loading])(
    "does not render the target on $environmentId or silently fall back",
    (selected) => {
      expect(
        getThreadAutoSettlementSearchAvailability(environments, {
          kind: "environment",
          environmentIds: [selected.environmentId],
        }),
      ).toEqual({ eligibleEnvironmentIds: [capable.environmentId], isTargetAvailable: false });
    },
  );

  it("ignores offline and unloaded targets when all connected targets support the setting", () => {
    const selected = [capable, offline, loading];
    expect(
      getThreadAutoSettlementSearchAvailability(selected, {
        kind: "all",
        environmentIds: selected.map((entry) => entry.environmentId),
      }).isTargetAvailable,
    ).toBe(true);
  });
});

describe("relocated settings links", () => {
  it("keeps main's remote-start terminology at the relocated destination", () => {
    expect(searchableSetting("start-from-origin")).toMatchObject({ title: "Start from remote" });
    expect(searchSettings("start remote")).toContainEqual(
      expect.objectContaining({ id: "start-from-origin", to: "/settings/worktrees" }),
    );
  });
  it("redirects old section anchors to a visible destination", () => {
    expect(settingsTargetDestination("#browser")).toBe("/settings/browser");
    expect(settingsTargetAnchor("#browser")).toBe("browser");
    expect(settingsTargetDestination("#text-generation")).toBe("/settings/threads");
    expect(settingsTargetAnchor("#text-generation")).toBe("text-generation");
    expect(settingsTargetAnchor("#behavior")).toBe("composer");
    expect(settingsTargetDestination("#legacy-sidebar")).toBe("/settings/labs");
    expect(settingsTargetAnchor("#legacy-sidebar")).toBe("boring-sidebar");
    expect(settingsTargetDestination("#performance")).toBe("/settings/maintenance");
    expect(settingsTargetAnchor("#performance")).toBe("background");
    expect(settingsTargetAnchor("#project-defaults")).toBe("new-projects");
    expect(settingsTargetDestination("#source-control-defaults")).toBe("/settings/source-control");
    expect(settingsTargetAnchor("#source-control-defaults")).toBe("source-control");
    expect(settingsTargetAnchor("#dictation-microphone")).toBe("dictation-microphone");
  });
  it.each([
    ["dictation-microphone", "/settings/devices"],
    ["diff-layout", "/settings/diffs"],
    ["start-from-origin", "/settings/worktrees"],
    ["standard-thread-feed", "/settings/appearance"],
    ["math-rendering", "/settings/appearance"],
    ["compact-idle-threads", "/settings/providers"],
    ["worktree-submodules", "/settings/worktrees"],
    ["text-generation-model", "/settings/threads"],
    ["provider-update-checks", "/settings/maintenance"],
    ["app-updates", "/settings/about"],
    ["privacy-policy", "/settings/about"],
    ["legacy-plan-mode", "/settings/labs"],
    ["git-fetch-interval", "/settings/maintenance"],
    ["provider-health-check-interval", "/settings/maintenance"],
    ["background-activity", "/settings/maintenance"],
    ["background-shared-policy", "/settings/maintenance"],
    ["host-power-active-interval", "/settings/maintenance"],
    ["host-power-idle-interval", "/settings/maintenance"],
    ["pause-when-host-locked", "/settings/maintenance"],
    ["pause-when-host-low-power", "/settings/maintenance"],
    ["pause-when-client-low-power", "/settings/maintenance"],
    ["pause-when-on-battery", "/settings/maintenance"],
    ["composer-context", "/settings/appearance"],
  ])("resolves old anchors for %s to its current page", (id, destination) => {
    expect(settingsTargetDestination(`#${id}`)).toBe(destination);
    expect(settingsTargetDestination(id)).toBe(destination);
  });
  it("leaves page-local and unknown anchors alone", () => {
    expect(settingsTargetDestination("provider-instance-example-models")).toBeNull();
    expect(settingsTargetDestination("")).toBeNull();
  });
});

describe("source control host search items", () => {
  const definition = {
    ...UNKNOWN_SOURCE_CONTROL_CLIENT,
    kind: SourceControlProviderKind.make("example"),
    label: "Example",
    searchKeywords: ["sample"],
    settings: makeProviderSettingsSchema({ apiToken: Schema.String }),
  };

  it("lists a host by its label, its keywords, and its settings fields", () => {
    const items = sourceControlHostSearchItems([UNKNOWN_SOURCE_CONTROL_CLIENT, definition]);
    expect(items.map((item) => item.title)).toEqual(["Example credentials"]);
    expect(searchSettings("sample apitoken", items).map((item) => item.id)).toEqual([
      sourceControlHostSettingsSearchId("example"),
    ]);
  });

  it("lists a host with credentials by its accounts, token and CLI", () => {
    const items = sourceControlHostSearchItems([
      {
        ...definition,
        credentials: {
          cliName: "ex",
          cliLabel: "Example CLI",
          loginCommand: "ex login",
          tokenEnvVar: "EX_TOKEN",
          tokenAccess: "access",
          newTokenUrl: (host) => `https://${host}/tokens`,
        },
      },
    ]);
    expect(items.map((item) => item.title)).toEqual(["Example accounts and token"]);
    expect(searchSettings("ex switch accounts", items)).toHaveLength(1);
  });

  it("finds the built-in hosts by their own words", () => {
    expect(searchSettings("codeberg").map((item) => item.id)).toContain("source-control");
    expect(searchSettings("ghes").map((item) => item.id)).toContain(
      sourceControlHostSettingsSearchId("github"),
    );
  });
});

describe("movedSettingsPath", () => {
  it("sends old links to the page their row moved to", () => {
    expect(movedSettingsPath("/settings/general", "text-generation-model")).toBe(
      "/settings/threads",
    );
    expect(movedSettingsPath("/settings/connections", "authorized-clients")).toBe(
      "/settings/access",
    );
    expect(movedSettingsPath("/settings/source-control", "worktree-branch-naming")).toBe(
      "/settings/worktrees",
    );
    expect(movedSettingsPath("/settings/appearance", "diff-color-scheme")).toBe("/settings/diffs");
    expect(movedSettingsPath("/settings/connections", "network-access")).toBe("/settings/access");
    expect(movedSettingsPath("/settings/storage", "storage-worktrees")).toBe("/settings/worktrees");
    expect(movedSettingsPath("/settings/storage", "")).toBe("/settings/maintenance");
    expect(movedSettingsPath("/settings/general", "performance")).toBe("/settings/maintenance");
    expect(movedSettingsPath("/settings/integrations", "devices")).toBe("/settings/devices");
    expect(movedSettingsPath("/settings/beta", "")).toBe("/settings/labs");
  });

  it("leaves current pages alone", () => {
    expect(movedSettingsPath("/settings/general", "time-format")).toBeNull();
    expect(movedSettingsPath("/settings/projects", "project-defaults")).toBeNull();
    expect(movedSettingsPath("/settings/connections", "remote-environments")).toBeNull();
    expect(movedSettingsPath("/settings/appearance", "theme")).toBeNull();
  });
});
