import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type Organization,
  type OrganizationChange,
  type OrganizationRoleId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  Link2Icon,
  Maximize2Icon,
  Minimize2Icon,
  PencilIcon,
  PlusIcon,
  Redo2Icon,
  SparklesIcon,
  Trash2Icon,
  Undo2Icon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { primaryServerConfigAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { OrganizationEmployeeDialog } from "./OrganizationEmployeeDialog";
import { OrganizationGraphView } from "./OrganizationGraphView";
import { OrganizationRelationshipsDialog } from "./OrganizationRelationshipsDialog";
import { inverseOrganizationChange } from "./organizationDesignerHistory";
import {
  layoutWithMovedRole,
  positionForNewEmployee,
  rolePositions,
  type Point,
} from "./organizationGraphLayout";

interface HistoryEntry {
  readonly forward: OrganizationChange;
  readonly inverse: OrganizationChange;
}
interface DesignerHistory {
  readonly revision: number;
  readonly past: ReadonlyArray<HistoryEntry>;
  readonly future: ReadonlyArray<HistoryEntry>;
}

export function OrganizationDesigner({
  organization,
  busy,
  onChange,
  assistant,
}: {
  readonly organization: Organization;
  readonly busy: boolean;
  readonly onChange: (change: OrganizationChange) => Promise<boolean>;
  readonly assistant?: ReactNode;
}) {
  const config = useAtomValue(primaryServerConfigAtom);
  const supportsEmployeeConfiguration =
    config?.environment.capabilities.organizationEmployeeConfiguration === true;
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(organization.directorRoleId);
  const [employee, setEmployee] = useState<{ id?: string; position?: Point } | null>(null);
  const [relationships, setRelationships] = useState<{ fromId?: string; toId?: string } | null>(
    null,
  );
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [chatFocused, setChatFocused] = useState(false);
  const supportsEmployeeProfiles =
    config?.environment.capabilities.organizationEmployeeProfiles === true;
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [search, setSearch] = useState("");
  const savingRef = useRef(false);
  const assistantRef = useRef<HTMLElement | null>(null);
  const assistantToggleRef = useRef<HTMLButtonElement | null>(null);
  const assistantWasOpen = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the mounted assistant panel into view and restores DOM focus when it closes
  useEffect(() => {
    if (assistantOpen && window.matchMedia("(max-width: 1279px)").matches)
      assistantRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    if (!assistantOpen && assistantWasOpen.current) assistantToggleRef.current?.focus();
    assistantWasOpen.current = assistantOpen;
  }, [assistantOpen]);
  const addEmployeeRef = useRef<HTMLButtonElement | null>(null);
  const dialogsWereOpen = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores DOM focus to Add employee after either editor dialog closes
  useEffect(() => {
    const open = employee !== null || relationships !== null;
    if (dialogsWereOpen.current && !open) addEmployeeRef.current?.focus();
    dialogsWereOpen.current = open;
  }, [employee, relationships]);

  const [history, setHistory] = useState<DesignerHistory>({
    revision: organization.draftRevision,
    past: [],
    future: [],
  });
  const selectedRole = organization.graph.roles.find((role) => role.id === selectedRoleId) ?? null;
  const normalizedSearch = search.trim().toLowerCase();
  const matchingRoles = organization.graph.roles.filter((role) =>
    `${role.title} ${role.kind} ${role.mandate} ${role.personality ?? ""} ${role.focus ?? ""} ${role.skills ?? ""}`
      .toLowerCase()
      .includes(normalizedSearch),
  );
  const historyIsCurrent = history.revision === organization.draftRevision;
  const editingRole = employee?.id
    ? organization.graph.roles.find((role) => role.id === employee.id)
    : undefined;
  const protectedRole =
    selectedRole?.id === organization.directorRoleId ||
    selectedRole?.id === organization.architectRoleId;
  function selectEmployee(id: string) {
    setSelectedRoleId(id);
    if (connectFrom && connectFrom !== id) {
      setRelationships({ fromId: connectFrom, toId: id });
      setConnectFrom(null);
    }
  }
  async function applyDesignerChange(change: OrganizationChange): Promise<boolean> {
    if (busy) return false;
    const inverse = inverseOrganizationChange(organization, change);
    const saved = await onChange(change);
    if (saved) {
      setHistory({
        revision: organization.draftRevision + 1,
        past:
          inverse === null
            ? []
            : [...(historyIsCurrent ? history.past : []), { forward: change, inverse }],
        future: [],
      });
    }
    return saved;
  }

  async function moveRole(roleId: OrganizationRoleId, point: Point): Promise<boolean> {
    const current = rolePositions(organization).get(roleId);
    if (
      !current ||
      (Math.round(current.x) === Math.round(point.x) &&
        Math.round(current.y) === Math.round(point.y))
    )
      return false;
    return applyDesignerChange({
      type: "set-layout",
      layout: layoutWithMovedRole(organization, roleId, point),
    });
  }

  async function undo() {
    if (busy || !historyIsCurrent || history.past.length === 0) return;
    const entry = history.past.at(-1)!;
    if (await onChange(entry.inverse)) {
      setHistory({
        revision: organization.draftRevision + 1,
        past: history.past.slice(0, -1),
        future: [...history.future, entry],
      });
    }
  }

  async function redo() {
    if (busy || !historyIsCurrent || history.future.length === 0) return;
    const entry = history.future.at(-1)!;
    if (await onChange(entry.forward)) {
      setHistory({
        revision: organization.draftRevision + 1,
        past: [...history.past, entry],
        future: history.future.slice(0, -1),
      });
    }
  }

  return (
    <div
      className="min-w-0 space-y-4"
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
        if (
          event.target instanceof HTMLElement &&
          event.target.closest("input, textarea, [contenteditable='true'], [role='dialog']")
        )
          return;
        event.preventDefault();
        if (event.shiftKey) void redo();
        else void undo();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Your team</h2>
          <p className="text-sm text-muted-foreground">
            {organization.graph.roles.length} employees · {organization.graph.edges.length}{" "}
            relationships
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {assistant ? (
            <Button
              variant="outline"
              ref={assistantToggleRef}
              aria-pressed={assistantOpen}
              onClick={() => setAssistantOpen(!assistantOpen)}
            >
              <SparklesIcon /> Architect
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={busy || organization.graph.roles.length < 2}
            onClick={() => setRelationships(selectedRole ? { fromId: selectedRole.id } : {})}
          >
            <Link2Icon /> Relationships
          </Button>
          <Button ref={addEmployeeRef} disabled={busy} onClick={() => setEmployee({})}>
            <PlusIcon /> Add employee
          </Button>
        </div>
      </div>
      <div
        className={
          assistantOpen && !chatFocused
            ? "grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_28rem]"
            : "min-w-0"
        }
      >
        <section
          hidden={assistantOpen && chatFocused}
          className="min-w-0 space-y-3"
          aria-label="Team designer"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-0 flex-1 sm:max-w-xs"
              aria-label="Find an employee"
              type="search"
              value={search}
              onValueChange={setSearch}
              placeholder="Find an employee…"
            />
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={outlineOpen}
              onClick={() => setOutlineOpen(!outlineOpen)}
            >
              <UsersIcon /> Team list
            </Button>
            <div className="ml-auto flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                aria-label="Undo"

                disabled={busy || !historyIsCurrent || history.past.length === 0}
                onClick={() => void undo()}
              >
                <Undo2Icon />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Redo"

                disabled={busy || !historyIsCurrent || history.future.length === 0}
                onClick={() => void redo()}
              >
                <Redo2Icon />
              </Button>
            </div>
          </div>
          {connectFrom ? (
            <div
              role="status"
              className="flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"
            >
              <span>
                Choose another employee to connect with{" "}
                <strong>
                  {organization.graph.roles.find((role) => role.id === connectFrom)?.title}
                </strong>
                .
              </span>
              <Button size="sm" variant="outline" onClick={() => setConnectFrom(null)}>
                Cancel
              </Button>
            </div>
          ) : null}
          <OrganizationGraphView
            organization={organization}
            selectedRoleId={selectedRole?.id ?? null}
            search={search}
            busy={busy}
            onSelectRole={selectEmployee}
            onMoveRole={moveRole}
            onAddEmployee={(position) => setEmployee(position ? { position } : {})}
            onEditEmployee={(id) => {
              setSelectedRoleId(id);
              setEmployee({ id });
            }}
            onConnectEmployee={(id) => {
              setSelectedRoleId(id);
              setConnectFrom(id);
            }}
          />
          {selectedRole ? (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{selectedRole.title}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {selectedRole.focus ||
                    selectedRole.mandate ||
                    "Define what this employee is responsible for."}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setEmployee({ id: selectedRole.id })}
              >
                <PencilIcon /> Edit employee
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setConnectFrom(selectedRole.id)}
              >
                <Link2Icon /> Connect
              </Button>
              {!protectedRole ? (
                <Button
                  size="icon"
                  variant="ghost-destructive"
                  disabled={busy}
                  aria-label={`Remove ${selectedRole.title}`}
                  onClick={() => setRemoveOpen(true)}
                >
                  <Trash2Icon />
                </Button>
              ) : null}
            </div>
          ) : null}
          {outlineOpen || search ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {matchingRoles.length} employees{search ? " found" : " in your team"}
              </p>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {matchingRoles.map((role) => (
                  <li key={role.id} className="min-w-0">
                    <Button
                      className="w-full min-w-0 justify-start"
                      variant={selectedRoleId === role.id ? "secondary" : "outline"}
                      onClick={() => selectEmployee(role.id)}
                      onDoubleClick={() => setEmployee({ id: role.id })}
                    >
                      <span className="truncate">{role.title}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {!historyIsCurrent && history.past.length > 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              The draft changed elsewhere. Your next edit starts a new undo history.
            </p>
          ) : null}
        </section>
        {assistant ? (
          <aside
            ref={assistantRef}
            hidden={!assistantOpen}
            className="min-w-0 space-y-2"
            aria-label="Architect assistant"
          >
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={chatFocused}
                onClick={() => setChatFocused(!chatFocused)}
              >
                {chatFocused ? <Minimize2Icon /> : <Maximize2Icon />}
                {chatFocused ? "Show graph" : "Focus chat"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAssistantOpen(false)}>
                <XIcon /> Close Architect
              </Button>
            </div>
            {assistant}
          </aside>
        ) : null}
      </div>
      {employee ? (
        <OrganizationEmployeeDialog
          organization={organization}
          {...(editingRole ? { role: editingRole } : {})}
          busy={busy}
          supportsEmployeeConfiguration={supportsEmployeeConfiguration}
          supportsEmployeeProfiles={supportsEmployeeProfiles}
          onClose={() => setEmployee(null)}
          onSave={async (role) => {
            if (savingRef.current) return false;
            savingRef.current = true;
            const operation = await settlePromise(async () => {
              if (employee.id && !organization.graph.roles.some((item) => item.id === employee.id))
                return false;
              const saved = await applyDesignerChange(
                employee.id
                  ? {
                      type: "update-role",
                      roleId: role.id,
                      title: role.title,
                      mandate: role.mandate,
                      poolSize: role.poolSize,
                      ...(supportsEmployeeProfiles
                        ? {
                            personality: role.personality ?? "",
                            focus: role.focus ?? "",
                            skills: role.skills ?? "",
                          }
                        : {}),
                      ...(supportsEmployeeConfiguration
                        ? { modelSelection: role.modelSelection ?? null }
                        : {}),
                    }
                  : {
                      type: "add-role",
                      role,
                      ...(supportsEmployeeConfiguration
                        ? { position: positionForNewEmployee(organization, employee.position) }
                        : {}),
                    },
              );
              if (saved) {
                setSelectedRoleId(role.id);
                setEmployee(null);
              }
              return saved;
            });
            savingRef.current = false;
            if (operation._tag === "Failure") throw squashAtomCommandFailure(operation);
            return operation.value;
          }}
        />
      ) : null}
      {relationships ? (
        <OrganizationRelationshipsDialog
          organization={organization}
          {...relationships}
          busy={busy}
          onChange={applyDesignerChange}
          onClose={() => setRelationships(null)}
        />
      ) : null}
      <Dialog
        open={removeOpen}
        onOpenChange={(open) => {
          if (!busy) setRemoveOpen(open);
        }}
      >
        <DialogPopup showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>Remove {selectedRole?.title}?</DialogTitle>
            <DialogDescription>
              This removes the employee and their relationships from this draft. This action cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <p className="text-sm text-muted-foreground">
              Published revisions are kept in your organization’s history.
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRemoveOpen(false)}>
              Keep employee
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !selectedRole || protectedRole}
              onClick={() => {
                if (selectedRole && !protectedRole)
                  void applyDesignerChange({ type: "remove-role", roleId: selectedRole.id }).then(
                    (saved) => {
                      if (saved) {
                        setRemoveOpen(false);
                        setSelectedRoleId(null);
                      }
                    },
                  );
              }}
            >
              Remove employee
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
