import { act, render, stubGlobal } from "../../../test/render";
import { WelcomeWizard } from "./WelcomeWizard";

import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  importThreads: vi.fn(),
  createProject: vi.fn(),
  complete: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  projects: [] as Array<{ id: string; environmentId: string; workspaceRoot: string }>,
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: (environments: Array<{ environmentId: string }>) =>
    new Set(environments.map((entry) => entry.environmentId)),
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/agentSessions", () => ({ agentSessionImport: "import" }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "create" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "import"
      ? mocks.importThreads
      : command === "create"
        ? mocks.createProject
        : mocks.refresh,
}));
vi.mock("../../onboarding/firstRun", () => ({ completeOnboarding: mocks.complete }));
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  readProjects: () => mocks.projects,
  waitForProject: vi.fn(async () => true),
}));
vi.mock("../../state/environments", () => {
  const environment = {
    environmentId: "test-env",
    label: "Computer",
    connection: { phase: "connected" },
    entry: { enabled: true },
  };
  return {
    useEnvironments: () => ({ environments: [environment] }),
    usePrimaryEnvironment: () => environment,
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: () => [],
    configValueAtom: () => null,
    refreshProviders: "refresh",
  },
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAtomValue: (value: unknown) => value,
}));
vi.mock("../../onboarding/useProjectScans", () => ({
  useProjectScans: () => [
    {
      environmentId: "test-env",
      isPending: false,
      error: null,
      refresh: mocks.refresh,
      data: {
        truncated: false,
        candidates: [
          {
            path: "/project",
            title: "project",
            projectId: "test-project",
            threadCount: 29,
            lastActiveAt: new Date().toISOString(),
            sources: ["codex"],
          },
        ],
      },
    },
  ],
}));
vi.mock("../../connection/onboarding", () => ({ connectPairing: vi.fn() }));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: {} }));
vi.mock("../clerk/useT3ConnectAuthPrompt", () => ({ useT3ConnectAuthPrompt: vi.fn() }));
vi.mock("../../cloud/publicConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cloud/publicConfig")>()),
  hasCloudPublicConfig: () => false,
}));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: () => null }));
vi.mock("../settings/ChatGptWelcomeCoordinator", () => ({ ChatGptWelcomeCoordinator: () => null }));
vi.mock("../settings/CodexSetupSection", () => ({
  CodexSetupSection: () => null,
  AddManagedCodexAccountDialog: () => null,
}));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({
  CloudEnvironmentConnectRows: () => null,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast, close: vi.fn(), update: vi.fn() },
}));

function setup() {
  using stack = new DisposableStack();
  vi.clearAllMocks();
  stack.use(
    stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    ),
  );
  stack.use(vi.spyOn(Element.prototype, "getAnimations").mockReturnValue([]));
  mocks.projects = [{ id: "test-project", environmentId: "test-env", workspaceRoot: "/project" }];
  mocks.complete.mockReset().mockResolvedValue(undefined);
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.importThreads
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { importedCount: 28, skippedCount: 1 } });
  return stack.move();
}

it.each(["owned", "legacy", "cloudless"])(
  "opens the selected %s privacy policy from the actual welcome step",
  async (mode) => {
    using _setup = setup();
    using _env = { [Symbol.dispose]: () => vi.unstubAllEnvs() };
    vi.stubEnv("VITE_CONNECT_MODE", mode);
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_test_${btoa("sample.accounts.dev$")}`);
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "arcwright-relay");
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "client_sample");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubEnv("VITE_CONNECT_HOSTED_APP_URL", "https://selected.example.test");
    await using _screen = await render(<WelcomeWizard localAvailable onDone={vi.fn()} />);
    const policy = [...document.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "privacy policy",
    )!;
    const navigate = vi.fn();
    policy.addEventListener("click", (event) => {
      event.preventDefault();
      navigate(policy.href, policy.target);
    });
    await act(async () => policy.click());
    expect(navigate).toHaveBeenCalledWith(
      mode === "owned"
        ? "https://selected.example.test/privacy.html"
        : "https://t3.codes/privacy-policy",
      "_blank",
    );
    const notice = policy.closest("p")!.textContent!;
    if (mode === "owned") {
      expect(notice).toContain("account information");
      expect(notice).toContain("environment connections");
      expect(notice).toContain("service availability");
      expect(notice).not.toMatch(/anonymous usage|opt out/);
    } else {
      expect(notice).toContain("Arcwright Code collects anonymous usage data");
    }
  },
);
