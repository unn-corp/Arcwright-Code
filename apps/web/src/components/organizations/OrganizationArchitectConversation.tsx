import { useAtomValue } from "@effect/atom-react";
import {
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  OrganizationArchitectMessageId,
  type Organization,
  type OrganizationArchitectAllowedChange,
  type OrganizationArchitectProposal,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  RefreshCwIcon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { randomUUID } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { organizationEnvironment } from "../../state/organizations";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerProvidersAtom, primaryServerConfigAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import ChatMarkdown from "../ChatMarkdown";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { InputGroup, InputGroupAddon } from "../ui/input-group";
import { Textarea } from "../ui/textarea";

const START_SETUP_PROMPT =
  "Walk me through designing and setting up this Organization. Start with one question about the mission and outcomes. Guide me through roles, handoffs, workflows, resources, and authority, then Project work, GitHub sharing, and a final setup review.";
const CONTINUE_SETUP_PROMPT =
  "Continue the Organization setup walkthrough from our conversation and current draft. Ask one focused question about the next unconfirmed design or setup step.";

function proposalPresentation(
  change: OrganizationArchitectAllowedChange,
  organization: Organization,
) {
  const roleName = (id: string) =>
    organization.graph.roles.find((role) => role.id === id)?.title ?? id;
  switch (change.type) {
    case "add-role":
      return {
        title: `Add ${change.role.title}`,
        detail: [
          `${change.role.kind} employee. ${change.role.mandate || "No responsibilities proposed."}`,
          ...(["personality", "focus", "skills"] as const).flatMap((field) =>
            change.role[field] ? [`${field}: ${change.role[field]}`] : [],
          ),
        ].join("\n\n"),
      };
    case "update-role":
      return {
        title: `Update ${roleName(change.roleId)}`,
        detail:
          [
            change.title ? `Name: ${change.title}` : null,
            change.mandate !== undefined ? `Mandate: ${change.mandate || "empty"}` : null,
            change.poolSize !== undefined ? `Pool size: ${change.poolSize}` : null,
            ...(["personality", "focus", "skills"] as const).flatMap((field) =>
              change[field] !== undefined
                ? [
                    `${field === "focus" ? "Areas of focus" : field === "personality" ? "Personality" : "Skills"}: ${change[field] || "Clear this field"}`,
                  ]
                : [],
            ),
          ]
            .filter(Boolean)
            .join(" · ") || "No field changes were proposed.",
      };
    case "add-edge":
      return {
        title: `Connect ${roleName(change.edge.fromRoleId)} to ${roleName(change.edge.toRoleId)}`,
        detail: `Relationship: ${change.edge.kind}.`,
      };
    case "upsert-workflow": {
      const previous = organization.workflows.find(
        (workflow) => workflow.id === change.workflow.id,
      );
      const steps = change.workflow.steps
        .slice(0, 6)
        .map(
          (step) =>
            `${step.title} (${step.kind}${step.roleId ? `, ${roleName(step.roleId)}` : ""})`,
        );
      return {
        title: `${previous ? "Update" : "Add"} workflow ${change.workflow.title}`,
        detail: `Version ${change.workflow.version}, ${change.workflow.steps.length} steps, ${change.workflow.transitions.length} transitions. ${steps.join(" → ")}${change.workflow.steps.length > steps.length ? " → more steps" : ""}`,
      };
    }
    case "set-title":
      return { title: "Change Organization name", detail: change.title };
    case "set-mission":
      return { title: "Change mission", detail: change.mission || "Clear the mission." };
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

export function OrganizationArchitectConversation({
  organization,
  offline,
  busy,
  onApplyBatch,
}: {
  readonly organization: Organization;
  readonly offline: boolean;
  readonly busy: boolean;
  readonly onApplyBatch: (
    proposals: ReadonlyArray<OrganizationArchitectProposal>,
  ) => Promise<boolean>;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const { networkStatus } = useEnvironments();
  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const supportsProfiles =
    serverConfig?.environment.capabilities.organizationEmployeeProfiles === true;
  const entries = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(providers),
    settings,
    null,
  );
  const architectEntries = entries.filter(
    (entry) =>
      entry.enabled &&
      entry.isAvailable &&
      entry.installed &&
      entry.snapshot.supportsTextGeneration !== false &&
      entry.status === "ready",
  );
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [selectedModelSlug, setSelectedModelSlug] = useState<string | null>(null);
  const preferredSelection =
    organization.graph.roles.find((role) => role.id === organization.architectRoleId)
      ?.modelSelection ?? settings.textGenerationModelSelection;
  const selectedEntry: ProviderInstanceEntry | undefined =
    architectEntries.find((entry) => entry.instanceId === selectedInstanceId) ??
    architectEntries.find((entry) => entry.instanceId === preferredSelection.instanceId) ??
    architectEntries[0];
  const models = selectedEntry ? getAppModelOptionsForInstance(settings, selectedEntry) : [];
  const selectedModel =
    models.find((model) => model.slug === selectedModelSlug) ??
    models.find(
      (model) =>
        selectedEntry?.instanceId === preferredSelection.instanceId &&
        model.slug === preferredSelection.model,
    ) ??
    models.find((model) => model.isDefault) ??
    models[0];
  const list = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.architectList({
          environmentId,
          input: { organizationId: organization.id },
        }),
  );
  const sendCommand = useAtomCommand(organizationEnvironment.architectSend, {
    reportFailure: false,
  });
  const [draft, setDraft] = useState("");
  const [pendingTurn, setPendingTurn] = useState<{
    id: OrganizationArchitectMessageId;
    text: string;
    createdAt: string;
  } | null>(null);
  const [failedTurns, setFailedTurns] = useState<
    Array<{ id: OrganizationArchitectMessageId; text: string; createdAt: string; failure: string }>
  >([]);
  const sendInFlight = useRef(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const nearBottom = useRef(true);
  const [sending, setSending] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [appliedIds, setAppliedIds] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const draftBytes = new TextEncoder().encode(draft.trim()).length;
  const wasOffline = useRef(offline || networkStatus === "offline");
  const blocked =
    offline ||
    networkStatus === "offline" ||
    environmentId === null ||
    organization.lifecycle === "archived";
  const canSend =
    !blocked &&
    !busy &&
    !sending &&
    !!selectedEntry &&
    !!selectedModel &&
    draft.trim().length > 0 &&
    draft.trim().length <= 4_000 &&
    draftBytes <= 4_000;
  const messages = [...(list.data?.messages ?? [])].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const requestsById = new Map(
    (list.data?.requests ?? []).map((request) => [request.requestId, request]),
  );
  const appliedMutationIds = new Set(list.data?.appliedProposalIds ?? []);
  const localTurns = [...failedTurns, ...(pendingTurn ? [pendingTurn] : [])];
  const visibleMessages = [
    ...messages,
    ...localTurns
      .filter((turn) => !messages.some((message) => message.id === turn.id))
      .map((turn) => ({ ...turn, role: "user" as const, requestId: turn.id })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const lastMessageId = visibleMessages.at(-1)?.id;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the mounted transcript DOM scrolled to its end while the reader is following new messages
  useEffect(() => {
    if ((lastMessageId || sending) && nearBottom.current && transcriptRef.current)
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [lastMessageId, sending]);
  if (pendingTurn && messages.some((message) => message.id === pendingTurn.id)) {
    setPendingTurn(null);
  }
  function jumpToLatest() {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    nearBottom.current = true;
    setAtBottom(true);
  }

  const listRefresh = list.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- revalidates architect conversation history when the external connection recovers
  useEffect(() => {
    const currentlyOffline = offline || networkStatus === "offline";
    if (wasOffline.current && !currentlyOffline) {
      listRefresh();
    }
    wasOffline.current = currentlyOffline;
  }, [offline, networkStatus, listRefresh]);

  function resultError<A, E>(result: AtomCommandResult<A, E>): string | null {
    if (result._tag !== "Failure") return null;
    const cause = squashAtomCommandFailure(result);
    return cause instanceof Error ? cause.message : String(cause);
  }

  async function send(value = draft) {
    const text = value.trim();
    if (
      blocked ||
      busy ||
      sending ||
      sendInFlight.current ||
      !selectedEntry ||
      !selectedModel ||
      environmentId === null ||
      !text ||
      text.length > 4_000 ||
      new TextEncoder().encode(text).length > 4_000
    )
      return;
    sendInFlight.current = true;
    const messageId = OrganizationArchitectMessageId.make(randomUUID());
    // oxlint-disable-next-line react/purity -- this timestamp is created only inside a user-action callback, never while rendering
    const turn = { id: messageId, text, createdAt: new Date().toISOString() };
    setPendingTurn(turn);
    function retainFailedTurn(failure: string) {
      setFailedTurns((current) => [...current, { ...turn, failure }]);
      setPendingTurn(null);
      setDraft((current) => current || text);
    }
    setDraft((current) => (current.trim() === text ? "" : current));
    nearBottom.current = true;
    setSending(true);
    setError(null);
    setNotice(null);
    const operation = await settlePromise(async () => {
      try {
        const result = await sendCommand({
          environmentId,
          input: {
            organizationId: organization.id,
            messageId,
            baseRevision: organization.draftRevision,
            text,
            modelSelection: createModelSelection(selectedEntry.instanceId, selectedModel.slug),
          },
        });
        const failure = resultError(result);
        if (failure) {
          setError(failure);
          retainFailedTurn(failure);
        }
        list.refresh();
      } catch (cause) {
        const failure =
          cause instanceof Error
            ? cause.message
            : "The message could not be sent. Try again when the connection is ready.";
        setError(failure);
        retainFailedTurn(failure);
      }
    });
    sendInFlight.current = false;
    setSending(false);
    if (operation._tag === "Failure") throw squashAtomCommandFailure(operation);
  }

  function unsupportedProfile(change: OrganizationArchitectAllowedChange) {
    if (supportsProfiles) return false;
    const role =
      change.type === "add-role" ? change.role : change.type === "update-role" ? change : null;
    return (
      role !== null &&
      [role.personality, role.focus, role.skills].some((value) => value !== undefined)
    );
  }

  async function applyProposal(proposal: OrganizationArchitectProposal) {
    if (blocked || busy || applyingId !== null || unsupportedProfile(proposal.change)) return;
    if (proposal.baseRevision !== organization.draftRevision) {
      setError(
        "This proposal uses an earlier draft revision. Refresh and ask the Architect for an updated suggestion.",
      );
      return;
    }
    setApplyingId(proposal.id);
    setError(null);
    setNotice(null);
    const operation = await settlePromise(async () => {
      const saved = await onApplyBatch([proposal]);
      if (saved) {
        setAppliedIds((current) => new Set([...current, proposal.id]));
        setNotice(
          "Proposal applied to the draft. Review the updated Designer and publish separately when ready.",
        );
        list.refresh();
      } else {
        setError(
          "The proposal was not applied. Refresh the Organization and review its current revision.",
        );
      }
    });
    setApplyingId(null);
    if (operation._tag === "Failure") throw squashAtomCommandFailure(operation);
  }

  async function applyBatch(proposals: ReadonlyArray<OrganizationArchitectProposal>) {
    if (
      blocked ||
      busy ||
      applyingId !== null ||
      proposals.length < 2 ||
      proposals.some((proposal) => unsupportedProfile(proposal.change))
    )
      return;
    if (proposals.some((proposal) => proposal.baseRevision !== organization.draftRevision)) {
      setError(
        "The draft changed since these suggestions. Ask Architect to review the updated canvas.",
      );
      return;
    }
    setApplyingId(`batch:${proposals[0]!.responseMessageId}`);
    setError(null);
    setNotice(null);
    const operation = await settlePromise(async () => {
      const saved = await onApplyBatch(proposals);
      if (saved) {
        setAppliedIds(
          (current) => new Set([...current, ...proposals.map((proposal) => proposal.id)]),
        );
        setNotice(
          `${proposals.length} suggestions applied to the draft together. Review the canvas before publishing.`,
        );
        list.refresh();
      } else {
        setError(
          "The suggestions were not applied. Refresh the Organization and review its current revision.",
        );
      }
    });
    setApplyingId(null);
    if (operation._tag === "Failure") throw squashAtomCommandFailure(operation);
  }

  return (
    <section
      aria-label="Chat with Architect"
      className="flex h-[clamp(32rem,calc(100dvh-20rem),52rem)] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <SparklesIcon className="size-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">Architect</h2>
            <p className="text-xs text-muted-foreground">Build your organization together</p>
          </div>
        </div>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Refresh Architect conversation"
          disabled={environmentId === null || sending}
          onClick={() => list.refresh()}
        >
          <RefreshCwIcon />
        </Button>
      </header>
      {blocked ? (
        <p
          role="status"
          className="shrink-0 border-b border-border px-4 py-2 text-sm text-muted-foreground"
        >
          {organization.lifecycle === "archived"
            ? "This organization is archived. Conversation and draft changes are read only."
            : "Offline. Reconnect to send messages or apply changes."}
        </p>
      ) : null}
      {list.error ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive-foreground">
          Could not load conversation: {list.error}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <div
          ref={transcriptRef}
          role="log"
          aria-label="Architect conversation"
          aria-busy={sending}
          className="h-full space-y-6 overflow-y-auto overscroll-contain p-4"
          onScroll={(event) => {
            const el = event.currentTarget;
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
            nearBottom.current = bottom;
            setAtBottom(bottom);
          }}
        >
          {list.isPending && !list.data ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading conversation…
            </p>
          ) : null}
          {!list.isPending && visibleMessages.length === 0 ? (
            <div className="flex min-h-48 flex-col justify-center gap-4 py-4">
              <div className="space-y-2">
                <h3 className="text-lg font-semibold">Let’s shape your team</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Tell Architect what you want to build. Work through responsibilities,
                  personalities, skills, and how your employees collaborate.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked || busy || sending || !selectedModel}
                  onClick={() => void send(START_SETUP_PROMPT)}
                >
                  Guide me through setup
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked || busy || sending || !selectedModel}
                  onClick={() =>
                    void send(
                      "Review our organization and suggest what is missing from the employee responsibilities, personalities, focus, skills, and relationships.",
                    )
                  }
                >
                  Review my team
                </Button>
              </div>
            </div>
          ) : null}
          {visibleMessages.map((message) => {
            const proposals =
              message.role === "architect"
                ? (list.data?.proposals ?? []).filter(
                    (proposal) => proposal.responseMessageId === message.id,
                  )
                : [];
            const request =
              message.role === "user" ? requestsById.get(message.requestId) : undefined;
            const localFailure = failedTurns.find((turn) => turn.id === message.id)?.failure;
            const failed = request?.status === "failed" || (!request && !!localFailure);
            return (
              <article
                key={message.id}
                aria-label={message.role === "user" ? "Your message" : "Architect reply"}
                className={
                  message.role === "user" ? "ml-auto max-w-[90%] space-y-2" : "min-w-0 space-y-3"
                }
              >
                <div
                  className={
                    message.role === "user"
                      ? "rounded-2xl bg-message p-3 text-message-foreground"
                      : settings.assistantMessageBubbles
                        ? "rounded-2xl rounded-ss-md border border-border/50 bg-muted/40 px-4 py-3"
                        : "min-w-0 space-y-2"
                  }
                >
                  {message.role === "architect" ? (
                    <p className="mb-2 text-xs font-medium text-muted-foreground">Architect</p>
                  ) : null}
                  {message.role === "architect" ? (
                    <ChatMarkdown text={message.text} cwd={undefined} parseRawHtml={false} />
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                      {message.text}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <time
                    dateTime={message.createdAt}
                    aria-label={new Date(message.createdAt).toLocaleString()}
                  >
                    {new Date(message.createdAt).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </time>
                  {failed ? (
                    <span className="text-destructive-foreground">Couldn’t complete reply</span>
                  ) : null}
                </div>
                {failed ? (
                  <div className="space-y-2">
                    <p className="text-sm text-destructive-foreground">
                      {request?.failureMessage ||
                        localFailure ||
                        "Architect couldn’t complete this reply. Your organization draft is unchanged."}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={blocked || sending}
                      onClick={() => {
                        if (!draft.trim()) setDraft(message.text);
                        else
                          setError(
                            "Your current draft is kept. Clear it before restoring an earlier message.",
                          );
                      }}
                    >
                      Use message again
                    </Button>
                  </div>
                ) : null}
                {proposals.length > 0 ? (
                  <details className="min-w-0 rounded-xl border border-border bg-background">
                    <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm font-medium">
                      <ChevronDownIcon className="size-4" /> Review {proposals.length} suggested{" "}
                      {proposals.length === 1 ? "change" : "changes"}
                    </summary>
                    <div className="space-y-3 px-3 pb-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium">Suggested draft changes</p>
                        {proposals.length > 1 &&
                        proposals.every(
                          (proposal) =>
                            !appliedIds.has(proposal.id) && !appliedMutationIds.has(proposal.id),
                        ) ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={
                              blocked ||
                              busy ||
                              !list.isSuccess ||
                              applyingId !== null ||
                              proposals.some(
                                (proposal) =>
                                  proposal.baseRevision !== organization.draftRevision ||
                                  unsupportedProfile(proposal.change),
                              )
                            }
                            onClick={() => void applyBatch(proposals)}
                          >
                            {applyingId === `batch:${message.id}`
                              ? "Applying suggestions…"
                              : `Apply all ${proposals.length} to draft`}
                          </Button>
                        ) : null}
                      </div>
                      {proposals.map((proposal) => {
                        const presentation = proposalPresentation(proposal.change, organization);
                        const applied =
                          appliedIds.has(proposal.id) || appliedMutationIds.has(proposal.id);
                        const stale = proposal.baseRevision !== organization.draftRevision;
                        return (
                          <div
                            key={proposal.id}
                            className="min-w-0 rounded-lg border border-border bg-muted/30 p-3"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <h4 className="min-w-0 break-words text-sm font-semibold">
                                {presentation.title}
                              </h4>
                              <Badge variant={applied ? "success" : "outline"}>
                                {applied ? "Applied" : `Draft ${proposal.baseRevision}`}
                              </Badge>
                            </div>
                            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                              {presentation.detail}
                            </p>
                            {!applied ? (
                              <div className="mt-3 space-y-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={
                                    blocked ||
                                    busy ||
                                    !list.isSuccess ||
                                    applyingId !== null ||
                                    stale ||
                                    unsupportedProfile(proposal.change)
                                  }
                                  onClick={() => void applyProposal(proposal)}
                                >
                                  {applyingId === proposal.id ? "Applying…" : "Apply to draft"}
                                </Button>
                                {unsupportedProfile(proposal.change) ? (
                                  <p className="text-sm text-muted-foreground">
                                    Update this environment before applying employee profile
                                    changes.
                                  </p>
                                ) : null}
                                {stale ? (
                                  <p className="text-sm text-muted-foreground">
                                    The draft changed since this suggestion. Ask Architect to review
                                    the updated canvas before applying another change.
                                  </p>
                                ) : null}
                                {!list.isSuccess && !stale ? (
                                  <p className="text-sm text-muted-foreground">
                                    Apply is available after proposal history loads.
                                  </p>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </details>
                ) : null}
              </article>
            );
          })}
          {sending || [...requestsById.values()].some((request) => request.status === "pending") ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <SparklesIcon className="size-4" /> Architect is thinking…
            </p>
          ) : null}
        </div>
        {!atBottom ? (
          <div className="absolute inset-x-0 bottom-2 flex justify-center">
            <Button size="sm" variant="secondary" onClick={jumpToLatest}>
              <ArrowDownIcon /> Latest messages
            </Button>
          </div>
        ) : null}
      </div>
      <div className="shrink-0 space-y-2 border-t border-border p-3">
        {error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-xs text-muted-foreground">
            {notice}
          </p>
        ) : null}
        {architectEntries.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            Connect an enabled provider in Settings to chat with Architect.
          </p>
        ) : null}
        {selectedEntry && models.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            This provider has no configured model. Choose another provider or update its settings.
          </p>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <InputGroup>
            <Textarea
              unstyled
              aria-label="Message Architect"
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              maxLength={4_000}
              placeholder="Message Architect…"
              disabled={blocked || architectEntries.length === 0}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  !event.repeat
                ) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <InputGroupAddon align="block-end">
              {selectedEntry ? (
                <ProviderModelPicker
                  environmentId={environmentId}
                  activeInstanceId={selectedEntry.instanceId}
                  model={selectedModel?.slug ?? ""}
                  lockedProvider={null}
                  instanceEntries={architectEntries}
                  modelOptionsByInstance={
                    new Map(
                      architectEntries.map((entry) => [
                        entry.instanceId,
                        getAppModelOptionsForInstance(settings, entry),
                      ]),
                    )
                  }
                  disabled={blocked || sending}
                  triggerAriaLabel="Choose Architect model"
                  onInstanceModelChange={(instanceId, model) => {
                    setSelectedInstanceId(instanceId);
                    setSelectedModelSlug(model);
                  }}
                />
              ) : null}
              <div className="ml-auto">
                <Button
                  type="submit"
                  size="icon"
                  aria-label="Send message to Architect"
                  disabled={!canSend}
                >
                  <ArrowUpIcon />
                </Button>
              </div>
            </InputGroupAddon>
          </InputGroup>
        </form>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {sending
              ? "You can draft your next message while waiting."
              : "Enter to send · Shift+Enter for a new line"}
          </span>
          {draftBytes > 3200 ? (
            <span className={draftBytes > 4000 ? "text-destructive-foreground" : ""}>
              {draftBytes.toLocaleString()} / 4,000 bytes
            </span>
          ) : null}
        </div>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">What Architect can access</summary>
          <p className="pt-2">
            Your organization draft and this conversation are sent to the selected model. Repository
            files and credentials are not included. Suggested changes wait for your review and
            Apply.
          </p>
        </details>
        {messages.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={blocked || busy || sending || !selectedModel}
            onClick={() => void send(CONTINUE_SETUP_PROMPT)}
          >
            Continue guided setup
          </Button>
        ) : null}
      </div>
    </section>
  );
}
