import {
  OrganizationEdgeId,
  OrganizationRoleId,
  type Organization,
  type OrganizationChange,
} from "@t3tools/contracts";
import { ArrowRightIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export const RELATIONSHIP_LABELS = {
  "reports-to": "Reports to",
  "delegates-to": "Delegates to",
  reviews: "Reviews work from",
  consults: "Consults with",
  "escalates-to": "Escalates to",
} as const;
type EdgeKind = keyof typeof RELATIONSHIP_LABELS;
const DESCRIPTIONS: Record<EdgeKind, string> = {
  "reports-to": "The first employee reports to the second employee.",
  "delegates-to": "The first employee gives work to the second employee.",
  reviews: "The first employee reviews the second employee’s work.",
  consults: "The first employee asks the second employee for advice.",
  "escalates-to": "The first employee takes unresolved issues to the second employee.",
};

export function OrganizationRelationshipsDialog({
  organization,
  fromId,
  toId,
  busy,
  onChange,
  onClose,
}: {
  readonly organization: Organization;
  readonly fromId?: string;
  readonly toId?: string;
  readonly busy: boolean;
  readonly onChange: (change: OrganizationChange) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const [from, setFrom] = useState(fromId ?? organization.graph.roles[0]?.id ?? "");
  const [to, setTo] = useState(
    toId ??
      organization.graph.roles.find(
        (role) => role.id !== (fromId ?? organization.graph.roles[0]?.id),
      )?.id ??
      "",
  );
  const [kind, setKind] = useState<EdgeKind>("reports-to");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const locked = busy || saving;
  const roles = organization.graph.roles;
  const duplicate = organization.graph.edges.some(
    (edge) => edge.fromRoleId === from && edge.toRoleId === to && edge.kind === kind,
  );
  const valid =
    from !== to &&
    roles.some((role) => role.id === from) &&
    roles.some((role) => role.id === to) &&
    !duplicate;
  async function save(change: OrganizationChange) {
    if (locked || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      if (!(await onChange(change)))
        setError("The relationship could not be saved. Review the current draft and try again.");
    } catch {
      setError(
        "The relationship could not be saved. Your choices are still here. Try again when the connection is ready.",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  function employeePicker(label: string, value: string, onValueChange: (value: string) => void) {
    return (
      <label className="block space-y-2 text-sm font-medium">
        <span>{label}</span>
        <Select
          value={value}
          onValueChange={(value) => {
            if (value) onValueChange(value);
          }}
          disabled={locked}
          items={roles.map((role) => ({ value: role.id, label: role.title }))}
        >
          <SelectTrigger aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {roles.map((role) => (
              <SelectItem key={role.id} value={role.id}>
                {role.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </label>
    );
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
          <DialogTitle>Employee relationships</DialogTitle>
          <DialogDescription>
            Connect responsibilities across your team. Relationships do not grant permissions.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="organization-relationship-form"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid)
                void save({
                  type: "add-edge",
                  edge: {
                    id: OrganizationEdgeId.make(randomUUID()),
                    fromRoleId: OrganizationRoleId.make(from),
                    toRoleId: OrganizationRoleId.make(to),
                    kind,
                  },
                });
            }}
          >
            {employeePicker("Employee", from, setFrom)}
            <label className="block space-y-2 text-sm font-medium">
              <span>Relationship</span>
              <Select
                value={kind}
                onValueChange={(value) => {
                  if (value && value in RELATIONSHIP_LABELS) setKind(value as EdgeKind);
                }}
                disabled={locked}
                items={Object.entries(RELATIONSHIP_LABELS).map(([value, label]) => ({
                  value,
                  label,
                }))}
              >
                <SelectTrigger aria-label="Relationship">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {Object.entries(RELATIONSHIP_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
            {employeePicker("Connected employee", to, setTo)}
            <p className="text-sm text-muted-foreground">{DESCRIPTIONS[kind]}</p>
            {duplicate ? (
              <p role="status" className="text-sm text-muted-foreground">
                This relationship already exists.
              </p>
            ) : null}
            {from === to ? (
              <p role="status" className="text-sm text-muted-foreground">
                Choose two different employees.
              </p>
            ) : null}
          </form>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="space-y-3 border-t border-border pt-4">
            <h3 className="text-sm font-medium">
              Current connections ({organization.graph.edges.length})
            </h3>
            {organization.graph.edges.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No connections yet. Add your first relationship above.
              </p>
            ) : (
              <ul className="space-y-2">
                {organization.graph.edges.map((edge) => (
                  <li
                    key={edge.id}
                    className="flex items-center gap-2 rounded-lg border border-border p-3 text-sm"
                  >
                    <div className="min-w-0 flex-1 break-words">
                      <span className="font-medium">
                        {roles.find((role) => role.id === edge.fromRoleId)?.title}
                      </span>
                      <span className="block text-muted-foreground">
                        {RELATIONSHIP_LABELS[edge.kind].toLowerCase()}{" "}
                        <ArrowRightIcon aria-hidden className="inline size-3" />{" "}
                        {roles.find((role) => role.id === edge.toRoleId)?.title}
                      </span>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost-destructive"
                      disabled={locked}
                      aria-label={`Remove ${roles.find((role) => role.id === edge.fromRoleId)?.title} ${RELATIONSHIP_LABELS[edge.kind].toLowerCase()} ${roles.find((role) => role.id === edge.toRoleId)?.title}`}
                      onClick={() => void save({ type: "remove-edge", edgeId: edge.id })}
                    >
                      <Trash2Icon />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={locked} onClick={onClose}>
            Done
          </Button>
          <Button type="submit" form="organization-relationship-form" disabled={locked || !valid}>
            {saving ? "Saving…" : "Add relationship"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
