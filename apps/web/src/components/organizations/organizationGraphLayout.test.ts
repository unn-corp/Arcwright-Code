import { OrganizationId, OrganizationRoleId, type Organization } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { inverseOrganizationChange } from "./organizationDesignerHistory";
import {
  fitGraphViewport,
  layoutWithMovedRole,
  roleBounds,
  rolePositions,
  positionForNewEmployee,
  zoomGraphAt,
} from "./organizationGraphLayout";

const directorId = OrganizationRoleId.make("director");
const architectId = OrganizationRoleId.make("architect");
const organization: Organization = {
  id: OrganizationId.make("organization"),
  title: "Example",
  mission: "Maintain the repository",
  lifecycle: "draft",
  draftRevision: 2,
  publishedRevision: null,
  directorRoleId: directorId,
  architectRoleId: architectId,
  graph: {
    roles: [
      { id: directorId, kind: "director", title: "Director", mandate: "Coordinate", poolSize: 1 },
      { id: architectId, kind: "architect", title: "Architect", mandate: "Design", poolSize: 1 },
    ],
    edges: [],
  },
  layout: { positions: [] },
  workflows: [],
  bindings: [],
  createdAt: "2026-09-26T00:00:00Z",
  updatedAt: "2026-09-26T00:00:00Z",
};

describe("organization graph interaction geometry", () => {
  it("persists a moved role while preserving other role positions and the semantic graph", () => {
    const before = rolePositions(organization);
    const layout = layoutWithMovedRole(organization, directorId, { x: 123.4, y: 245.6 });
    expect(layout.positions).toEqual([
      { roleId: directorId, x: 123, y: 246 },
      { roleId: architectId, ...before.get(architectId)! },
    ]);
    expect(organization.layout.positions).toEqual([]);
    expect(organization.graph.roles).toHaveLength(2);
    expect(inverseOrganizationChange(organization, { type: "set-layout", layout })).toEqual({
      type: "set-layout",
      layout: organization.layout,
    });
  });

  it("fits graph bounds into a narrow viewport and zooms around the pointer", () => {
    const bounds = roleBounds(rolePositions(organization));
    const viewport = fitGraphViewport(bounds, { width: 320, height: 280 });
    expect(bounds.minX * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(0);
    expect(bounds.maxX * viewport.zoom + viewport.x).toBeLessThanOrEqual(320);
    const anchor = { x: 160, y: 140 };
    const before = {
      x: (anchor.x - viewport.x) / viewport.zoom,
      y: (anchor.y - viewport.y) / viewport.zoom,
    };
    const zoomed = zoomGraphAt(viewport, anchor, viewport.zoom * 1.2);
    expect((anchor.x - zoomed.x) / zoomed.zoom).toBeCloseTo(before.x);
    expect((anchor.y - zoomed.y) / zoomed.zoom).toBeCloseTo(before.y);
  });

  it("does not offer one-step undo for role deletion that may remove relationships", () => {
    expect(
      inverseOrganizationChange(organization, { type: "remove-role", roleId: directorId }),
    ).toBeNull();
  });
});

it("places a new employee near the requested point without covering a moved employee", () => {
  const requested = { x: 32, y: 32 };
  const free = positionForNewEmployee(organization, requested);
  expect(free.x).toBe(requested.x);
  expect(free.y).toBeGreaterThan(requested.y + 100);
  expect(positionForNewEmployee(organization, { x: 900, y: 300 })).toEqual({ x: 900, y: 300 });
});
it("undo restores or clears employee AI selection only when that selection was edited", () => {
  const change = { type: "update-role", roleId: directorId, title: "New director" } as const;
  expect(inverseOrganizationChange(organization, change)).not.toHaveProperty("modelSelection");
  expect(
    inverseOrganizationChange(organization, {
      ...change,
      modelSelection: {
        instanceId: "codex" as import("@t3tools/contracts").ProviderInstanceId,
        model: "model",
      },
    }),
  ).toMatchObject({ modelSelection: null });
});

it("undo restores edited profile fields, clears newly added fields, and preserves unedited fields", () => {
  const profiled: Organization = {
    ...organization,
    graph: {
      ...organization.graph,
      roles: organization.graph.roles.map((role) =>
        role.id === directorId ? { ...role, personality: "Calm", skills: "Review failures" } : role,
      ),
    },
  };
  expect(
    inverseOrganizationChange(profiled, {
      type: "update-role",
      roleId: directorId,
      personality: "Direct",
      focus: "Delivery",
      skills: "",
    }),
  ).toMatchObject({ personality: "Calm", focus: "", skills: "Review failures" });
  const rename = inverseOrganizationChange(profiled, {
    type: "update-role",
    roleId: directorId,
    title: "Lead",
  });
  expect(rename).not.toHaveProperty("personality");
  expect(rename).not.toHaveProperty("focus");
  expect(rename).not.toHaveProperty("skills");
});
