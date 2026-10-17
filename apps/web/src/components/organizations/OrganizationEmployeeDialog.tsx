import { useAtomValue } from "@effect/atom-react";
import {
  ORGANIZATION_EMPLOYEE_FOCUS_MAX_LENGTH,
  ORGANIZATION_EMPLOYEE_PERSONALITY_MAX_LENGTH,
  ORGANIZATION_EMPLOYEE_SKILLS_MAX_LENGTH,
  OrganizationRoleId,
  type Organization,
  type OrganizationRole,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useId, useRef, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

export interface OrganizationEmployeeDialogProps {
  readonly organization: Organization;
  readonly role?: OrganizationRole;
  readonly busy: boolean;
  readonly supportsEmployeeConfiguration: boolean;
  readonly supportsEmployeeProfiles: boolean;
  readonly onSave: (role: OrganizationRole) => Promise<boolean>;
  readonly onClose: () => void;
}

const EMPLOYEE_KINDS = ["engineering", "qa", "security", "research", "custom"] as const;
const STEPS = [
  "Identity",
  "Responsibilities",
  "Profile",
  "AI provider and model",
  "Review",
] as const;
const PROFILE_FIELDS = [
  {
    key: "personality",
    label: "Personality",
    limit: ORGANIZATION_EMPLOYEE_PERSONALITY_MAX_LENGTH,
    help: "Describe writing style, collaboration, and decision habits.",
    placeholder: "Write concisely, ask early about tradeoffs, and explain decisions.",
  },
  {
    key: "focus",
    label: "Areas of focus",
    limit: ORGANIZATION_EMPLOYEE_FOCUS_MAX_LENGTH,
    help: "Set priorities and the domains this employee should concentrate on.",
    placeholder: "Prioritize accessible interfaces and reliable account flows.",
  },
  {
    key: "skills",
    label: "Skills",
    limit: ORGANIZATION_EMPLOYEE_SKILLS_MAX_LENGTH,
    help: "Author instructions for how this employee works. These do not install skills or grant tool access.",
    placeholder: "For reviews, trace failure paths and suggest a focused regression test.",
  },
] as const;

export function OrganizationEmployeeDialog({
  organization,
  role,
  busy,
  supportsEmployeeConfiguration,
  supportsEmployeeProfiles,
  onSave,
  onClose,
}: OrganizationEmployeeDialogProps) {
  const id = useId();
  const [snapshot] = useState(() => ({
    organizationId: organization.id,
    revision: organization.draftRevision,
    role,
    id: role?.id ?? OrganizationRoleId.make(randomUUID()),
  }));
  const [step, setStep] = useState(0);
  const [furthestStep, setFurthestStep] = useState(0);
  const [title, setTitle] = useState(role?.title ?? "");
  const [kind, setKind] = useState<OrganizationRole["kind"]>(role?.kind ?? "engineering");
  const [mandate, setMandate] = useState(role?.mandate ?? "");
  const [profile, setProfile] = useState(() => ({
    personality: role?.personality ?? "",
    focus: role?.focus ?? "",
    skills: role?.skills ?? "",
  }));
  const [poolSize, setPoolSize] = useState(String(role?.poolSize ?? 1));
  const originalSelection = snapshot.role?.modelSelection;
  const [instanceId, setInstanceId] = useState<string>(originalSelection?.instanceId ?? "");
  const [model, setModel] = useState(originalSelection?.model ?? "");
  const [selectionChanged, setSelectionChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const entries = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(providers),
    settings,
    null,
  ).filter(
    (entry) => entry.enabled && entry.isAvailable && entry.installed && entry.status === "ready",
  );
  const selectedEntry = entries.find((entry) => entry.instanceId === instanceId);
  const models = selectedEntry ? getAppModelOptionsForInstance(settings, selectedEntry) : [];
  const selectedModel = models.find((entry) => entry.slug === model);
  const unavailable = !!instanceId && (!selectedEntry || !selectedModel);
  const locked = busy || saving;
  const stale =
    organization.id !== snapshot.organizationId ||
    organization.draftRevision !== snapshot.revision ||
    role?.id !== snapshot.role?.id;
  const validIdentity = title.trim().length > 0;
  const validPoolSize = Number.isSafeInteger(Number(poolSize)) && Number(poolSize) >= 1;
  const validSelection =
    !supportsEmployeeConfiguration ||
    !selectionChanged ||
    instanceId === "" ||
    (!!selectedEntry && !!selectedModel);
  const validProfile =
    !supportsEmployeeProfiles ||
    PROFILE_FIELDS.every((field) => profile[field.key].length <= field.limit);
  const validSteps = [validIdentity, validPoolSize, validProfile, validSelection];
  const canAdvance = validSteps.slice(0, step + 1).every(Boolean);

  function navigate(target: number) {
    if (locked || savingRef.current || stale) return;
    if (target > step && !validSteps.slice(0, target).every(Boolean)) return;
    setStep(target);
    setFurthestStep((previous) => Math.max(previous, target));
  }

  const providerLabel = selectedEntry?.displayName ?? instanceId;
  const modelLabel = selectedModel?.name ?? model;

  async function save() {
    if (
      locked ||
      savingRef.current ||
      stale ||
      !validIdentity ||
      !validPoolSize ||
      !validProfile ||
      !validSelection
    )
      return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    // Strip unsupported fields even if this role came from a newer server.
    const {
      modelSelection: _selection,
      personality: _personality,
      focus: _focus,
      skills: _skills,
      ...originalRole
    } = snapshot.role ?? {};
    const employee: OrganizationRole = {
      ...originalRole,
      id: snapshot.id,
      kind: snapshot.role?.kind ?? kind,
      title: title.trim(),
      mandate,
      poolSize: Number(poolSize),
      ...(supportsEmployeeProfiles ? profile : {}),
      ...(supportsEmployeeConfiguration
        ? selectionChanged
          ? {
              modelSelection:
                selectedEntry && selectedModel
                  ? createModelSelection(selectedEntry.instanceId, selectedModel.slug)
                  : null,
            }
          : originalSelection !== undefined
            ? { modelSelection: originalSelection }
            : {}
        : {}),
    };
    try {
      if (await onSave(employee)) {
        onClose();
      } else {
        setError(
          "Employee was not saved. Your entries are still here. Check the connection and current draft, then try again.",
        );
      }
    } catch (cause) {
      setError(
        `Employee could not be saved. Your entries are still here. ${cause instanceof Error ? cause.message : "Check the connection and try again."}`,
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked && !savingRef.current) onClose();
      }}
    >
      <DialogPopup showCloseButton={!locked}>
        <DialogHeader>
          <DialogTitle>{snapshot.role ? "Edit employee" : "Add employee"}</DialogTitle>
          <DialogDescription>
            {STEPS[step]} (step {step + 1} of {STEPS.length}). Save this employee to the
            organization draft.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <nav aria-label="Employee setup steps" className="mb-4 flex flex-wrap gap-1.5">
            {STEPS.map((label, index) => (
              <Button
                key={label}
                size="sm"
                variant={step === index ? "secondary" : "ghost"}
                aria-current={step === index ? "step" : undefined}
                disabled={
                  locked ||
                  stale ||
                  (index > step &&
                    ((!snapshot.role && index > furthestStep) ||
                      !validSteps.slice(0, index).every(Boolean)))
                }
                onClick={() => navigate(index)}
              >
                {label}
              </Button>
            ))}
          </nav>
          {stale ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              The organization draft changed while this dialog was open. Close and reopen it to
              review the latest draft before saving.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          ) : null}
          <fieldset disabled={locked || stale} className="min-w-0 space-y-4">
            <legend className="sr-only">{STEPS[step]}</legend>
            {step === 0 ? (
              <>
                <div className="space-y-1.5">
                  <label htmlFor={`${id}-title`} className="text-sm font-medium">
                    Employee name
                  </label>
                  <Input
                    id={`${id}-title`}
                    value={title}
                    onValueChange={setTitle}
                    required
                    autoFocus
                  />
                </div>
                <div className="space-y-1.5">
                  <label id={`${id}-kind`} className="text-sm font-medium">
                    Employee kind
                  </label>
                  <Select
                    value={kind}
                    disabled={!!snapshot.role || locked || stale}
                    onValueChange={(value) => {
                      const next = EMPLOYEE_KINDS.find((entry) => entry === value);
                      if (next) setKind(next);
                    }}
                  >
                    <SelectTrigger aria-labelledby={`${id}-kind`}>
                      <SelectValue>{kind}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {snapshot.role &&
                      !EMPLOYEE_KINDS.some((entry) => entry === snapshot.role?.kind) ? (
                        <SelectItem value={snapshot.role.kind}>{snapshot.role.kind}</SelectItem>
                      ) : null}
                      {EMPLOYEE_KINDS.map((entry) => (
                        <SelectItem key={entry} value={entry}>
                          {entry}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  {snapshot.role ? (
                    <p className="text-sm text-muted-foreground">
                      An existing employee's kind stays fixed.
                    </p>
                  ) : null}
                </div>
              </>
            ) : null}
            {step === 1 ? (
              <>
                <div className="space-y-1.5">
                  <label htmlFor={`${id}-mandate`} className="text-sm font-medium">
                    Responsibilities
                  </label>
                  <Textarea
                    id={`${id}-mandate`}
                    value={mandate}
                    onChange={(event) => setMandate(event.currentTarget.value)}
                    placeholder="Describe what this employee owns and when to involve them"
                  />
                </div>
                <details>
                  <summary className="cursor-pointer text-sm font-medium">
                    Advanced settings
                  </summary>
                  <div className="mt-3 space-y-1.5">
                    <label htmlFor={`${id}-pool`} className="text-sm font-medium">
                      Pool size
                    </label>
                    <Input
                      id={`${id}-pool`}
                      type="number"
                      min={1}
                      step={1}
                      value={poolSize}
                      onValueChange={setPoolSize}
                      aria-invalid={!validPoolSize}
                      aria-describedby={`${id}-pool-help`}
                    />
                    <p id={`${id}-pool-help`} className="text-sm text-muted-foreground">
                      Use a whole number of at least 1.
                    </p>
                  </div>
                </details>
              </>
            ) : null}
            {step === 2 ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Shape how this employee approaches work. All profile fields are optional.
                </p>
                {!supportsEmployeeProfiles ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    This server does not support employee profiles yet. Profile fields are read-only
                    and will not be sent. You can save other employee details.
                  </p>
                ) : null}
                {PROFILE_FIELDS.map((field) => (
                  <div key={field.key} className="min-w-0 space-y-1.5">
                    <label htmlFor={`${id}-${field.key}`} className="text-sm font-medium">
                      {field.label}
                    </label>
                    <p id={`${id}-${field.key}-help`} className="text-sm text-muted-foreground">
                      {field.help}
                    </p>
                    <Textarea
                      id={`${id}-${field.key}`}
                      value={profile[field.key]}
                      disabled={!supportsEmployeeProfiles}
                      maxLength={field.limit}
                      rows={3}
                      aria-invalid={
                        supportsEmployeeProfiles && profile[field.key].length > field.limit
                      }
                      aria-describedby={`${id}-${field.key}-help ${id}-${field.key}-count`}
                      placeholder={field.placeholder}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setProfile((previous) => ({ ...previous, [field.key]: value }));
                      }}
                    />
                    <p id={`${id}-${field.key}-count`} className="text-sm text-muted-foreground">
                      {profile[field.key].length} / {field.limit} characters
                    </p>
                  </div>
                ))}
              </>
            ) : null}
            {step === 3 ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Choose this employee’s preferred AI, or set it up later. Project work still uses
                  the model you choose when starting a task.
                </p>
                {!supportsEmployeeConfiguration ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    This server does not support employee AI configuration yet. You can save other
                    employee details; AI configuration is not sent.
                  </p>
                ) : null}
                {originalSelection && !selectionChanged && unavailable ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    The saved assignment is unavailable. It will be preserved exactly unless you
                    choose another provider and model or Set up later.
                  </p>
                ) : null}
                <div className="space-y-1.5">
                  <label id={`${id}-provider`} className="text-sm font-medium">
                    Provider
                  </label>
                  <Select
                    value={instanceId}
                    disabled={locked || stale || !supportsEmployeeConfiguration}
                    onValueChange={(value) => {
                      if (value === null || value === instanceId) return;
                      setInstanceId(value);
                      setModel("");
                      setSelectionChanged(true);
                    }}
                  >
                    <SelectTrigger aria-labelledby={`${id}-provider`}>
                      <SelectValue>{instanceId ? providerLabel : "Set up later"}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="">Set up later</SelectItem>
                      {instanceId && !selectedEntry ? (
                        <SelectItem value={instanceId} disabled>
                          {instanceId} (unavailable)
                        </SelectItem>
                      ) : null}
                      {entries.map((entry) => (
                        <SelectItem key={entry.instanceId} value={entry.instanceId}>
                          {entry.displayName}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                {instanceId ? (
                  <div className="space-y-1.5">
                    <label id={`${id}-model`} className="text-sm font-medium">
                      Model
                    </label>
                    <Select
                      value={model}
                      disabled={locked || stale || !supportsEmployeeConfiguration || !selectedEntry}
                      onValueChange={(value) => {
                        if (value === null || value === model) return;
                        setModel(value);
                        setSelectionChanged(true);
                      }}
                    >
                      <SelectTrigger aria-labelledby={`${id}-model`}>
                        <SelectValue>{model ? modelLabel : "Choose a model"}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {model && !selectedModel ? (
                          <SelectItem value={model} disabled>
                            {model} (unavailable)
                          </SelectItem>
                        ) : null}
                        {models.map((entry) => (
                          <SelectItem key={entry.slug} value={entry.slug}>
                            {entry.name}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    {selectedEntry && models.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No configured models are available for this provider. Choose another
                        provider or Set up later.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {entries.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No ready providers are configured. Connect a provider in Settings, or choose Set
                    up later.
                  </p>
                ) : null}
              </>
            ) : null}
            {step === 4 ? (
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="font-medium">Employee</dt>
                  <dd className="break-words">
                    {title.trim()} ({kind})
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">Responsibilities</dt>
                  <dd className="whitespace-pre-wrap break-words">
                    {mandate || "No responsibilities entered"}
                  </dd>
                </div>
                {PROFILE_FIELDS.map((field) => (
                  <div key={field.key} className="min-w-0">
                    <dt className="font-medium">{field.label}</dt>
                    <dd className="whitespace-pre-wrap wrap-anywhere">
                      {profile[field.key] || "Not entered"}
                    </dd>
                  </div>
                ))}
                {!supportsEmployeeProfiles ? (
                  <div>
                    <dd className="text-muted-foreground">
                      This server does not support employee profiles. Profile fields will not be
                      sent.
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt className="font-medium">Pool size</dt>
                  <dd>{poolSize}</dd>
                </div>
                <div>
                  <dt className="font-medium">AI preference</dt>
                  <dd className="break-words">
                    {instanceId
                      ? `${providerLabel} / ${modelLabel}${unavailable ? " (unavailable, preserved)" : ""}`
                      : "Set up later"}
                  </dd>
                </div>
                <div>
                  <dd className="text-muted-foreground">
                    {supportsEmployeeConfiguration
                      ? "Saved for this employee. Project work still uses the model chosen when starting a task."
                      : "This server does not support employee AI configuration. AI configuration will not be sent."}
                  </dd>
                </div>
              </dl>
            ) : null}
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={locked} onClick={onClose}>
            Cancel
          </Button>
          {step > 0 ? (
            <Button variant="outline" disabled={locked || stale} onClick={() => navigate(step - 1)}>
              Back
            </Button>
          ) : null}
          {step < STEPS.length - 1 ? (
            <Button disabled={locked || stale || !canAdvance} onClick={() => navigate(step + 1)}>
              Continue
            </Button>
          ) : (
            <Button
              disabled={
                locked ||
                stale ||
                !validIdentity ||
                !validPoolSize ||
                !validProfile ||
                !validSelection
              }
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save employee"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
