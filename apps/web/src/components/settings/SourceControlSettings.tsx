import { Link } from "@tanstack/react-router";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ChevronDownIcon, Trash2Icon } from "lucide-react";
import * as Option from "effect/Option";
import { useState, type ReactNode } from "react";
import type {
  SourceControlDiscoveryResult,
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  VcsDriverKind,
  VcsDiscoveryItem,
  GitHubAccount,
  GitHubAccountPatch,
  GitHubAccountId,
} from "@t3tools/contracts";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { WorktreeStorageSettings } from "./WorktreeStorageSettings";
import { BranchNamingSettings } from "./BranchNamingSettings";
import {
  SourceControlWorktreeSettings,
  SourceControlDiffSettings,
} from "./RelocatedGeneralSettings";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Skeleton } from "../ui/skeleton";

import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import { GitIcon, JujutsuIcon, type Icon } from "../Icons";
import { SourceControlHostSettings } from "./SourceControlHostSettings";
import { GitHubAccountSettings } from "./GitHubAccountSettings";
import { GitHubTokenSettings } from "./GitHubTokenSettings";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";
import {
  SettingsPageContainer,
  SettingsSearchTarget,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { searchableSetting, sourceControlHostSettingsSearchId } from "./settingsSearch";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { sourceControlIcon } from "~/sourceControlPresentation";

const EMPTY_DISCOVERY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

const VCS_ICONS: Partial<Record<VcsDriverKind, Icon>> = {
  git: GitIcon,
  jj: JujutsuIcon,
};

function optionLabel(value: Option.Option<string>): string | null {
  return Option.getOrNull(value);
}

function isProviderDiscoveryItem(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): item is SourceControlProviderDiscoveryItem {
  return "auth" in item;
}

function isVcsNotReady(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): boolean {
  return !isProviderDiscoveryItem(item) && !item.implemented;
}

function authPresentation(auth: SourceControlProviderAuth): {
  readonly label: string;
  readonly badge: "warning" | null;
} {
  if (auth.status === "authenticated") {
    return { label: "Authenticated", badge: null };
  }
  if (auth.status === "unauthenticated") {
    return { label: "Not authenticated", badge: "warning" };
  }
  return { label: "Status unknown", badge: null };
}

function RedactedAccount(props: { readonly account: string | null }) {
  return (
    <RedactedSensitiveText
      value={props.account}
      ariaLabel="Toggle source control account visibility"
      revealTooltip="Click to reveal account"
      hideTooltip="Click to hide account"
    />
  );
}

function itemStatusDot(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): string {
  if (isVcsNotReady(item)) return "bg-muted-foreground/35";
  if (item.status !== "available") return "bg-warning";
  if (isProviderDiscoveryItem(item) && item.auth.status !== "authenticated") return "bg-warning";
  return "bg-success";
}

function sourceControlItemIcon(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): ReactNode {
  const host = isProviderDiscoveryItem(item) ? sourceControlClients.find(item.kind) : undefined;
  const Icon = isProviderDiscoveryItem(item)
    ? host && sourceControlIcon(host)
    : VCS_ICONS[item.kind];
  return Icon ? <Icon className="size-4.5 text-foreground/80" aria-hidden /> : null;
}

function SourceControlItemMark({
  item,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
}) {
  const dotClassName = itemStatusDot(item);
  const icon = sourceControlItemIcon(item);

  if (!icon) {
    return <span className={cn("size-2 shrink-0 rounded-full", dotClassName)} aria-hidden />;
  }

  return (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      {icon}
      <span
        className={cn(
          "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
          dotClassName,
        )}
        aria-hidden
      />
    </span>
  );
}

function itemSummary({
  item,
  auth,
  authAccount,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly auth: SourceControlProviderAuth | null;
  readonly authAccount: string | null;
}) {
  if (isVcsNotReady(item)) {
    return <span>Support for {item.label} is coming soon.</span>;
  }

  if (item.status !== "available") {
    return <span>Not available on this server: {item.installHint}</span>;
  }

  if (auth) {
    if (auth.status === "authenticated") {
      const authDetail = optionLabel(auth.detail);
      return (
        <>
          <span>Authenticated</span>
          {authAccount ? (
            <>
              <span aria-hidden>as</span>
              <RedactedAccount account={authAccount} />
            </>
          ) : null}
          {authDetail ? <span>· {authDetail}</span> : null}
        </>
      );
    }

    if (!item.executable && auth.status === "unauthenticated") {
      return <span>Available. {item.installHint}</span>;
    }

    if (auth.status === "unauthenticated" && auth.accounts?.some((entry) => entry.authenticated)) {
      return <span>{optionLabel(auth.detail) ?? `Every ${item.label} host is turned off.`}</span>;
    }

    if (auth.status === "unauthenticated") {
      return (
        <span>
          {item.label} is not authenticated on this server. Sign in or configure credentials using
          the <code className="rounded bg-muted px-1 py-px text-2xs">{item.executable}</code> tool
          on the server host to enable change request features.
        </span>
      );
    }
    const authDetail = optionLabel(auth.detail);
    return (
      <span>
        Could not verify {item.label}. {authDetail ?? item.installHint}
      </span>
    );
  }

  return <span>Available</span>;
}

function DiscoveryItemRow({
  item,
  children,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly children?: ReactNode;
}) {
  const version = optionLabel(item.version);
  const enabled = isProviderDiscoveryItem(item)
    ? item.status === "available" && item.auth.status === "authenticated"
    : item.status === "available" && item.implemented;
  const auth = isProviderDiscoveryItem(item) ? item.auth : null;
  const authStatus = auth ? authPresentation(auth) : null;
  const authAccount = auth ? optionLabel(auth.account) : null;
  const [isExpanded, setIsExpanded] = useState(false);
  const hasDetails = children !== undefined;
  const searchTargetId = useSettingsSearchTargetId();
  // A search jump to a setting inside this row opens it when the target arrives.
  const [seenSearchTargetId, setSeenSearchTargetId] = useState<string | null>(null);
  const targetsThisRow =
    searchTargetId === sourceControlHostSettingsSearchId(item.kind) ||
    (item.kind === "github" && searchTargetId === searchableSetting("github-accounts").id);
  if (targetsThisRow && !isExpanded && seenSearchTargetId !== searchTargetId) {
    setIsExpanded(true);
  }
  if (seenSearchTargetId !== searchTargetId) setSeenSearchTargetId(searchTargetId);

  return (
    <div
      className={cn(
        "first:rounded-t-xl last:rounded-b-xl transition-colors hover:bg-muted/20",
        isVcsNotReady(item) && "opacity-80",
      )}
    >
      <div className="px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <SourceControlItemMark item={item} />
              <span className="truncate text-sm font-medium text-foreground">{item.label}</span>
              {version ? <code className="text-xs text-muted-foreground">{version}</code> : null}
              {isVcsNotReady(item) ? (
                <Badge variant="warning" size="sm">
                  Coming Soon
                </Badge>
              ) : null}
              {authStatus?.badge ? (
                <Badge variant={authStatus.badge} size="sm">
                  {authStatus.label}
                </Badge>
              ) : null}
            </div>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs leading-normal text-muted-foreground/80">
              {itemSummary({ item, auth, authAccount })}
            </p>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {hasDetails ? (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                onClick={() => setIsExpanded((open) => !open)}
                aria-expanded={isExpanded}
                aria-label={`Toggle ${item.label} details`}
              >
                <ChevronDownIcon
                  className={cn(
                    "size-3.5 motion-safe:transition-transform",
                    isExpanded && "rotate-180",
                  )}
                />
              </Button>
            ) : null}
            {!isVcsNotReady(item) ? (
              <Switch checked={enabled} disabled aria-label={`${item.label} availability`} />
            ) : null}
          </div>
        </div>
      </div>

      {hasDetails ? (
        <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
          <CollapsibleContent>
            <div className="px-3 pb-4 pt-1 sm:px-4">{children}</div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

function EmptySourceControlDiscovery({
  error,
  isPending,
  onScan,
}: {
  readonly error: string | null;
  readonly isPending: boolean;
  readonly onScan: () => void;
}) {
  const hasError = error !== null;

  return (
    <Empty>
      <EmptyMedia variant="icon">
        <PullRequestGlyph.pullRequest />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>
          {hasError ? "Could not scan the server environment" : "Nothing detected yet"}
        </EmptyTitle>
        <EmptyDescription>
          {hasError
            ? error
            : "Install Git on the server, add optional hosting integrations or credentials your workspace needs, then rescan."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" variant="outline" onClick={onScan} disabled={isPending}>
          <RefreshIcon size="sm" refreshing={isPending} />
          Scan
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function PrimaryGitHubAccountSettings() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const accounts = Object.entries(settings.githubAccounts);

  const persist = (next: Record<string, GitHubAccountPatch>) => {
    updateSettings({ githubAccounts: next });
  };
  const toPatch = (account: GitHubAccount): GitHubAccountPatch => ({
    label: account.label,
    ...(account.login ? { login: account.login } : {}),
    host: account.host,
  });

  return (
    <div className="space-y-3">
      <div className="space-y-3 px-3 py-1 sm:px-4">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Add identities here, then choose one in a project’s settings. A configured PAT is kept in
          the server secret store and is passed to GitHub operations and every agent session for
          that project.
        </p>
        {accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">No additional GitHub accounts configured.</p>
        ) : null}
        {accounts.map(([id, account]) => (
          <GitHubAccountRow
            key={id}
            id={id}
            account={account}
            onSave={(next) =>
              persist({
                ...Object.fromEntries(
                  accounts
                    .filter(([accountId]) => accountId !== id)
                    .map(([accountId, existing]) => [accountId, toPatch(existing)]),
                ),
                [id]: next,
              } as Record<string, GitHubAccountPatch>)
            }
            onDelete={() => {
              const next = Object.fromEntries(
                accounts
                  .filter(([accountId]) => accountId !== id)
                  .map(([accountId, existing]) => [accountId, toPatch(existing)]),
              );
              persist(next);
            }}
          />
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const base = "github-account";
            let id = base;
            let suffix = 2;
            while (settings.githubAccounts[id as GitHubAccountId]) id = `${base}-${suffix++}`;
            persist({
              ...Object.fromEntries(
                accounts.map(([accountId, existing]) => [accountId, toPatch(existing)]),
              ),
              [id]: { label: "New GitHub account", host: "github.com" },
            } as Record<string, GitHubAccountPatch>);
          }}
        >
          Add GitHub account
        </Button>
      </div>
    </div>
  );
}

function GitHubAccountRow(props: {
  readonly id: string;
  readonly account: GitHubAccount;
  readonly onSave: (account: GitHubAccountPatch) => void;
  readonly onDelete: () => void;
}) {
  const [label, setLabel] = useState(props.account.label);
  const [login, setLogin] = useState(props.account.login ?? "");
  const [host, setHost] = useState(props.account.host);
  const [token, setToken] = useState("");
  const [tokenDirty, setTokenDirty] = useState(false);

  return (
    <details className="rounded-xl border border-border/60 p-3">
      <summary className="cursor-pointer text-sm">
        {props.account.label} · {props.account.host} ·{" "}
        {props.account.tokenConfigured ? "Token configured" : "No saved token"}
      </summary>
      <div className="pt-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            aria-label={`${props.id} account label`}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Input
            aria-label={`${props.id} GitHub login`}
            placeholder="GitHub login (optional)"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
          <Input
            aria-label={`${props.id} GitHub host`}
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
          <Input
            type="password"
            aria-label={`${props.id} personal access token`}
            placeholder={
              props.account.tokenConfigured
                ? "PAT configured (leave blank to keep)"
                : "Personal access token"
            }
            value={token}
            onChange={(e) => {
              setTokenDirty(true);
              setToken(e.target.value);
            }}
          />
        </div>
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={props.onDelete}
            aria-label={`Remove ${label}`}
          >
            <Trash2Icon className="size-3.5" />
            Remove
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              props.onSave({
                label: label.trim() || props.account.label,
                ...(login.trim() ? { login: login.trim() } : {}),
                host: host.trim() || "github.com",
                ...(tokenDirty ? { token } : {}),
              })
            }
          >
            Save
          </Button>
        </div>
      </div>
    </details>
  );
}

function AdvancedHostConfiguration({ kind, children }: { kind: string; children: ReactNode }) {
  const searchTargetId = useSettingsSearchTargetId();
  const [open, setOpen] = useState(false);
  const [seenSearchTargetId, setSeenSearchTargetId] = useState<string | null>(null);
  if (seenSearchTargetId !== searchTargetId) {
    setSeenSearchTargetId(searchTargetId);
    if (searchTargetId === sourceControlHostSettingsSearchId(kind)) setOpen(true);
  }

  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm">Advanced host configuration</summary>
      {children}
    </details>
  );
}

export function SourceControlSettingsPanel() {
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Discovery scans one machine's tools, so it shows the representative
  // environment (named in the section title when several are selected);
  // the settings rows above it fan out like everywhere else.
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  const isPrimaryEnvironment = environmentId === primaryEnvironmentId;
  const aggregate = scope.environmentIds.length !== 1 && connectedEnvironments.length > 1;
  const environmentSuffix = aggregate && environment ? ` · ${environment.label}` : "";
  const discovery = useEnvironmentQuery(
    environmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId,
          input: {},
        }),
  );
  const result = discovery.data ?? EMPTY_DISCOVERY_RESULT;
  const hasVersionControlSystems = result.versionControlSystems.length > 0;
  const hasDiscoveryItems = hasVersionControlSystems || result.sourceControlProviders.length > 0;
  const isInitialScanPending = discovery.isPending && discovery.data === null;
  const handleScan = () => {
    discovery.refresh();
  };
  const hostSettingsPanel = (kind: string) => {
    const definition = sourceControlClients.find(kind);
    if (!definition?.settings || environmentId === null) return undefined;
    return (
      <SettingsSearchTarget id={sourceControlHostSettingsSearchId(kind)}>
        <SourceControlHostSettings
          // Drafts belong to one environment; switching must not carry them over.
          key={environmentId}
          environmentId={environmentId}
          definition={{ ...definition, settings: definition.settings }}
          onSaved={handleScan}
        />
      </SettingsSearchTarget>
    );
  };
  const scanButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            onClick={handleScan}
            disabled={discovery.isPending || environmentId === null}
            aria-label="Rescan server environment"
          >
            <RefreshIcon refreshing={discovery.isPending} />
          </Button>
        }
      />
      <TooltipPopup side="top">Rescan Git and hosting integrations</TooltipPopup>
    </Tooltip>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        id={searchableSetting("source-control").id}
        title={`Tools & connection status${environmentSuffix}`}
        headerAction={scanButton}
      >
        {environmentId === null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect a computer to inspect its Git and hosting tools.
          </p>
        ) : isInitialScanPending ? (
          <div className="px-4 py-3">
            <Skeleton className="h-12 w-full" />
          </div>
        ) : hasDiscoveryItems ? (
          [...result.versionControlSystems, ...result.sourceControlProviders].map((item) => (
            <DiscoveryItemRow key={`${"auth" in item ? "host" : "vcs"}:${item.kind}`} item={item} />
          ))
        ) : (
          <EmptySourceControlDiscovery
            error={discovery.error}
            isPending={discovery.isPending}
            onScan={handleScan}
          />
        )}
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Automatic Git fetch is configured in{" "}
          <Link to="/settings/general" hash="git-fetch-interval">
            General, Performance, Advanced
          </Link>
          .
        </p>
        <ProjectDefaultsSettings category="source-control" rowsOnly />
      </SettingsSection>
      <SettingsSection id="source-control-accounts" title="Accounts & authentication">
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Saved accounts are available for project selection. Choose a project's account in its
          project settings.{" "}
          <Link to="/settings/connections">Shared GitHub access between computers</Link> is managed
          in Connections.
        </p>
        {isPrimaryEnvironment ? <PrimaryGitHubAccountSettings /> : null}
        {environmentId !== null ? (
          result.sourceControlProviders.map((item) => (
            <DiscoveryItemRow key={`provider:${item.kind}`} item={item}>
              {item.kind === "github" ? (
                <SettingsSearchTarget id={searchableSetting("github-accounts").id}>
                  <div className="grid gap-6">
                    <GitHubTokenSettings
                      key={`token-${environmentId}`}
                      environmentId={environmentId}
                      onSaved={handleScan}
                    />
                    {item.status === "available" ? (
                      <GitHubAccountSettings
                        key={environmentId}
                        environmentId={environmentId}
                        auth={item.auth}
                        onSaved={handleScan}
                      />
                    ) : null}
                  </div>
                </SettingsSearchTarget>
              ) : (
                <AdvancedHostConfiguration kind={item.kind}>
                  {hostSettingsPanel(item.kind)}
                </AdvancedHostConfiguration>
              )}
            </DiscoveryItemRow>
          ))
        ) : (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect a computer to manage authentication.
          </p>
        )}
      </SettingsSection>
      <SettingsSection id="source-control-worktrees" title="Worktrees">
        <WorktreeStorageSettings />
        <SourceControlWorktreeSettings />
        <BranchNamingSettings />
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Configure the folder for new worktrees and retention in{" "}
          <Link to="/settings/storage">Storage</Link>.
        </p>
      </SettingsSection>
      <SettingsSection id="source-control-diff-viewer" title="Diff viewer">
        <SourceControlDiffSettings />
      </SettingsSection>
      <SourceControlWritingSettingsSection />
    </SettingsPageContainer>
  );
}
