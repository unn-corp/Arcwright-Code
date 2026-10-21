import { EnvironmentId } from "@t3tools/contracts";
import { planProjectRemoval } from "@t3tools/client-runtime/state/projects";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId, type AgentDashboardRepositoryPolicy } from "@t3tools/contracts";

import {
  buildProductDiscoveryConversationPrompt,
  enabledProjectAutomationKinds,
  isValidProductContextPath,
} from "./ProjectSettingsPanel.logic";

const policy = {
  repository: { projectId: ProjectId.make("project-1") },
  enabled: true,
  cadenceMinutes: 120,
  priority: 0,
  riskTier: "low",
  branch: null,
  owner: null,
  enabledChecks: ["repository-review"],
  model: null,
  budgetMinutes: null,
  maxConcurrentRuns: 1,
  exclusions: [],
  updatedAt: "2026-09-02T12:00:00.000Z",
} satisfies AgentDashboardRepositoryPolicy;

describe("enabledProjectAutomationKinds", () => {
  it("keeps every automation enabled for policies created before per-type controls", () => {
    expect(enabledProjectAutomationKinds(policy)).toEqual([
      "repository-review",
      "continuous-improvement",
      "pull-request-rollup",
      "inactive-worktree-cleanup",
      "product-opportunity-discovery",
      "decision-follow-up",
    ]);
  });

  it("preserves an older allow-list while enabling newly introduced automation types", () => {
    expect(
      enabledProjectAutomationKinds({
        ...policy,
        enabledAutomations: ["pull-request-rollup"],
      }),
    ).toEqual([
      "pull-request-rollup",
      "inactive-worktree-cleanup",
      "product-opportunity-discovery",
      "decision-follow-up",
    ]);
  });

  it("uses explicit exclusions for forward-compatible per-type controls", () => {
    expect(
      enabledProjectAutomationKinds({
        ...policy,
        enabledAutomations: ["repository-review"],
        disabledAutomations: ["continuous-improvement", "pull-request-rollup"],
      }),
    ).toEqual([
      "repository-review",
      "inactive-worktree-cleanup",
      "product-opportunity-discovery",
      "decision-follow-up",
    ]);
  });

  it("honors the existing repository-wide automation pause", () => {
    expect(enabledProjectAutomationKinds({ ...policy, enabled: false })).toEqual([]);
  });
});

describe("product context", () => {
  it("accepts repository-relative Markdown paths only", () => {
    expect(isValidProductContextPath("PRODUCT.md")).toBe(true);
    expect(isValidProductContextPath("docs/product/context.md")).toBe(true);
    expect(isValidProductContextPath("/tmp/product.md")).toBe(false);
    expect(isValidProductContextPath("C:\\temp\\product.md")).toBe(false);
    expect(isValidProductContextPath("../PRODUCT.md")).toBe(false);
    expect(isValidProductContextPath("PRODUCT.txt")).toBe(false);
  });

  it("builds a repository-informed, approval-gated discovery interview", () => {
    const prompt = buildProductDiscoveryConversationPrompt({
      projectName: "Arcwright Code",
      workspaceRoot: "/workspace/t3code",
      productContextPath: "PRODUCT.md",
      hasConfirmedContext: false,
    });
    expect(prompt).toContain("inspecting repository documentation");
    expect(prompt).toContain("Human-confirmed, Inferred from repository, or Unknown");
    expect(prompt).toContain("explicit approval before writing");
    expect(prompt).toContain("request_user_input");
  });
});

describe("project removal confirmation", () => {
  const local = {
    id: ProjectId.make("shared-id"),
    environmentId: EnvironmentId.make("local"),
    title: "Repo",
    workspaceRoot: "/work/repo",
    environmentLabel: "Local",
  };
  const remote = {
    ...local,
    environmentId: EnvironmentId.make("remote"),
    environmentLabel: "Remote",
  };

  it("limits a checkout's thread count to its environment and project", () => {
    const plan = planProjectRemoval({
      members: [local],
      groupMemberCount: 2,
      hasOtherMembers: false,
      displayName: "Repo",
      threads: [
        { environmentId: local.environmentId, projectId: local.id },
        { environmentId: remote.environmentId, projectId: remote.id },
      ],
    });
    expect(plan.projectThreads).toHaveLength(1);
    expect(plan.confirmationMessage).toBe(
      'Remove checkout "Repo" and delete its 1 thread?\nPath: /work/repo\nEnvironment: Local\nThis permanently clears conversation history for those threads and any archived threads.\nOther entries in this grouped project are unaffected.\nThis action cannot be undone.',
    );
  });

  it("keeps an environment-filtered group scoped to its selected checkout", () => {
    const plan = planProjectRemoval({
      members: [remote],
      groupMemberCount: 1,
      hasOtherMembers: true,
      displayName: "Repo",
      threads: [],
    });
    expect(plan.targetKind).toBe("checkout");
    expect(plan.confirmationMessage).toContain("Environment: Remote");
    expect(plan.confirmationMessage).toContain(
      "Other entries in this grouped project are unaffected.",
    );
    expect(plan.confirmationMessage).toContain(
      "This permanently clears any archived conversation history.",
    );
  });

  // regression: #21409 project-wide removal must count every checkout's threads and keep files
  it("states the full group count and preserves files when removing a project everywhere", () => {
    const plan = planProjectRemoval({
      members: [local, remote],
      groupMemberCount: 2,
      hasOtherMembers: false,
      displayName: "Repo",
      threads: [],
    });
    expect(plan.targetKind).toBe("project");
    expect(plan.confirmationMessage).toContain("This removes 2 grouped project entries.");
    expect(plan.confirmationMessage).toContain(
      "This removes only the project entries, not the files on disk.",
    );
  });
});
