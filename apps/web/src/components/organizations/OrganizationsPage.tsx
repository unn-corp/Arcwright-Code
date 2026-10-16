import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { OrganizationId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  FolderIcon,
  NetworkIcon,
  PlusIcon,
  RefreshCwIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { organizationEnvironment, useOrganizations } from "../../state/organizations";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardPanel } from "../ui/card";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import { OrganizationPageShell } from "./OrganizationPageShell";
import { OrganizationRepositoryLoader } from "./OrganizationRepository";

export function OrganizationsPage() {
  const navigate = useNavigate();
  const organizations = useOrganizations();
  const { networkStatus } = useEnvironments();
  const create = useAtomCommand(organizationEnvironment.create, { reportFailure: false });
  const [title, setTitle] = useState("");
  const [mission, setMission] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const records = organizations.data?.organizations ?? [];
  const unavailable = organizations.environmentId === null || networkStatus === "offline";

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (unavailable || organizations.environmentId === null || !title.trim() || isCreating) return;
    setIsCreating(true);
    setActionError(null);
    try {
      const result = await create({
        environmentId: organizations.environmentId,
        input: {
          organizationId: OrganizationId.make(randomUUID()),
          mutationId: randomUUID(),
          title: title.trim(),
          mission: mission.trim(),
          actor: "user",
        },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        setActionError(error instanceof Error ? error.message : String(error));
        return;
      }
      organizations.refresh();
      setCreateOpen(false);
      void navigate({
        to: "/organizations/$organizationId",
        params: { organizationId: result.value.id },
      });
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <Dialog
      open={createOpen}
      onOpenChange={(open) => {
        if (!isCreating) setCreateOpen(open);
      }}
    >
      <OrganizationPageShell>
        <header className="flex flex-col gap-5 border-b border-border/70 pb-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              A home for your team’s mission, roles, and workflows.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={organizations.refresh}
              disabled={unavailable || organizations.isPending}
              aria-label="Refresh organizations"
              title="Refresh organizations"
            >
              <RefreshCwIcon />
            </Button>
            <OrganizationRepositoryLoader disabled={unavailable} />
            <DialogTrigger render={<Button disabled={unavailable} />}>
              <PlusIcon /> New organization
            </DialogTrigger>
          </div>
        </header>

        {unavailable ? (
          <Alert role="status">
            <AlertTitle>
              {organizations.environmentId === null ? "Connect an environment" : "You’re offline"}
            </AlertTitle>
            <AlertDescription>
              {organizations.environmentId === null
                ? "Connect an environment to view, create, or import organizations."
                : "Saved organizations are still available to view. Reconnect to make changes."}
            </AlertDescription>
          </Alert>
        ) : null}
        {organizations.error ? (
          <Alert variant="error">
            <AlertTitle>Could not load organizations</AlertTitle>
            <AlertDescription>{organizations.error} Try refreshing the list.</AlertDescription>
          </Alert>
        ) : null}

        <section aria-labelledby="organizations-list-heading" className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 id="organizations-list-heading" className="text-base font-medium">
              Your organizations
            </h2>
            {organizations.data !== null && organizations.data !== undefined ? (
              <span className="text-sm tabular-nums text-muted-foreground">
                {records.length} {records.length === 1 ? "organization" : "organizations"}
              </span>
            ) : null}
          </div>

          {organizations.isPending && organizations.data === null ? (
            <div
              role="status"
              aria-label="Loading organizations"
              className="grid gap-4 md:grid-cols-2"
            >
              {[0, 1].map((index) => (
                <Skeleton key={index} shape="card" className="h-52" />
              ))}
              <span className="sr-only">Loading organizations…</span>
            </div>
          ) : null}

          {organizations.isSuccess && records.length === 0 ? (
            <Card>
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <NetworkIcon />
                  </EmptyMedia>
                  <EmptyTitle>Create your first organization</EmptyTitle>
                  <EmptyDescription>
                    Start with a purpose. Shape the team, define responsibilities, and connect
                    Projects when you’re ready.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <DialogTrigger render={<Button disabled={unavailable} />}>
                    <PlusIcon /> New organization
                  </DialogTrigger>
                  <p className="text-sm text-muted-foreground">
                    No Project or repository needed to get started.
                  </p>
                </EmptyContent>
              </Empty>
            </Card>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            {records.map((organization) => {
              const projectCount = organization.bindings.filter(
                (binding) => binding.detachedAt === null,
              ).length;
              return (
                <Card key={organization.id}>
                  <CardPanel>
                    <div className="flex h-full flex-col gap-5">
                      <div className="flex items-start gap-3">
                        <div
                          aria-hidden="true"
                          className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-muted/50 text-muted-foreground"
                        >
                          <NetworkIcon className="size-5" />
                        </div>
                        <div className="min-w-0 flex-1 self-center">
                          <h3 className="wrap-anywhere text-lg font-semibold leading-snug">
                            <Link
                              to="/organizations/$organizationId"
                              params={{ organizationId: organization.id }}
                              className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                            >
                              {organization.title}
                            </Link>
                          </h3>
                        </div>
                        <Badge
                          variant={organization.lifecycle === "active" ? "success" : "outline"}
                        >
                          {organization.lifecycle[0]!.toUpperCase() +
                            organization.lifecycle.slice(1)}
                        </Badge>
                      </div>
                      <p className="line-clamp-3 flex-1 wrap-anywhere text-sm leading-relaxed text-muted-foreground">
                        {organization.mission ||
                          "Give this organization a mission, then shape the team around it."}
                      </p>
                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
                          <span className="inline-flex items-center gap-1.5">
                            <UsersIcon aria-hidden="true" className="size-4" />
                            {organization.graph.roles.length}{" "}
                            {organization.graph.roles.length === 1 ? "role" : "roles"}
                          </span>
                          <span className="inline-flex items-center gap-1.5">
                            <FolderIcon aria-hidden="true" className="size-4" />
                            {projectCount} {projectCount === 1 ? "Project" : "Projects"}
                          </span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full sm:w-auto"
                          render={
                            <Link
                              to="/organizations/$organizationId"
                              params={{ organizationId: organization.id }}
                            />
                          }
                        >
                          {organization.lifecycle === "draft" ? "Open draft" : "Open organization"}
                          <ArrowRightIcon />
                        </Button>
                      </div>
                    </div>
                  </CardPanel>
                </Card>
              );
            })}
          </div>
        </section>
      </OrganizationPageShell>

      <DialogPopup showCloseButton={!isCreating}>
        <DialogHeader>
          <DialogTitle>New organization</DialogTitle>
          <DialogDescription>
            Start with a name and a purpose. You can shape the team together with the Architect.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => void handleCreate(event)}
          aria-busy={isCreating}
          className="flex min-h-0 flex-1 flex-col"
        >
          <DialogPanel>
            <div className="space-y-2">
              <label htmlFor="organization-name" className="text-sm font-medium">
                Name
              </label>
              <Input
                id="organization-name"
                value={title}
                onValueChange={setTitle}
                placeholder="e.g. Product engineering"
                disabled={isCreating}
                required
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="organization-mission" className="text-sm font-medium">
                Mission <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Textarea
                id="organization-mission"
                value={mission}
                onChange={(event) => setMission(event.currentTarget.value)}
                placeholder="What should this team accomplish?"
                rows={4}
                disabled={isCreating}
              />
              <p className="text-sm text-muted-foreground">
                A sentence or two is enough. You can refine it later.
              </p>
            </div>
            {actionError ? (
              <Alert variant="error">
                <AlertTitle>Organization wasn’t created</AlertTitle>
                <AlertDescription>{actionError}</AlertDescription>
              </Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={isCreating} />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={unavailable || isCreating || !title.trim()}>
              {isCreating ? "Creating…" : "Create organization"}
              <ArrowRightIcon />
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
