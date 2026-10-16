import type { Organization, OrganizationLayout, OrganizationRoleId } from "@t3tools/contracts";

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 112;
const COLUMN_GAP = 76;
const ROW_GAP = 100;
const CANVAS_PADDING = 32;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface GraphBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface GraphViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export function rolePositions(organization: Organization): Map<OrganizationRoleId, Point> {
  const saved = new Map(
    organization.layout.positions.map((position) => [position.roleId, position] as const),
  );
  return new Map(
    organization.graph.roles.map((role, index) => [
      role.id,
      {
        x: saved.get(role.id)?.x ?? CANVAS_PADDING + (index % 3) * (NODE_WIDTH + COLUMN_GAP),
        y:
          saved.get(role.id)?.y ?? CANVAS_PADDING + Math.floor(index / 3) * (NODE_HEIGHT + ROW_GAP),
      },
    ]),
  );
}

export function roleBounds(positions: ReadonlyMap<OrganizationRoleId, Point>): GraphBounds {
  if (positions.size === 0) return { minX: 0, minY: 0, maxX: NODE_WIDTH, maxY: NODE_HEIGHT };
  const values = [...positions.values()];
  return {
    minX: Math.min(...values.map((point) => point.x)),
    minY: Math.min(...values.map((point) => point.y)),
    maxX: Math.max(...values.map((point) => point.x + NODE_WIDTH)),
    maxY: Math.max(...values.map((point) => point.y + NODE_HEIGHT)),
  };
}

export function fitGraphViewport(
  bounds: GraphBounds,
  size: { readonly width: number; readonly height: number },
): GraphViewport {
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  const contentWidth = Math.max(1, bounds.maxX - bounds.minX + CANVAS_PADDING * 2);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY + CANVAS_PADDING * 2);
  const zoom = Math.max(0.08, Math.min(1, width / contentWidth, height / contentHeight));
  return {
    x: (width - (bounds.minX + bounds.maxX) * zoom) / 2,
    y: (height - (bounds.minY + bounds.maxY) * zoom) / 2,
    zoom,
  };
}

export function zoomGraphAt(
  viewport: GraphViewport,
  point: Point,
  nextZoom: number,
): GraphViewport {
  const zoom = Math.max(0.08, Math.min(2, nextZoom));
  const worldX = (point.x - viewport.x) / viewport.zoom;
  const worldY = (point.y - viewport.y) / viewport.zoom;
  return { x: point.x - worldX * zoom, y: point.y - worldY * zoom, zoom };
}

export function layoutWithMovedRole(
  organization: Organization,
  roleId: OrganizationRoleId,
  next: Point,
): OrganizationLayout {
  const positions = rolePositions(organization);
  if (positions.has(roleId))
    positions.set(roleId, { x: Math.round(next.x), y: Math.round(next.y) });
  return {
    positions: organization.graph.roles.map((role) => {
      const point = positions.get(role.id)!;
      return { roleId: role.id, x: point.x, y: point.y };
    }),
  };
}

/** Keep a newly created employee clear of existing cards, including manually moved ones. */
export function positionForNewEmployee(organization: Organization, requested?: Point): Point {
  const existing = [...rolePositions(organization).values()];
  const origin = requested ?? { x: CANVAS_PADDING, y: CANVAS_PADDING };
  let point = { x: Math.max(0, Math.round(origin.x)), y: Math.max(0, Math.round(origin.y)) };
  while (
    existing.some(
      (other) =>
        point.x < other.x + NODE_WIDTH + 24 &&
        point.x + NODE_WIDTH + 24 > other.x &&
        point.y < other.y + NODE_HEIGHT + 24 &&
        point.y + NODE_HEIGHT + 24 > other.y,
    )
  ) {
    point = { x: point.x, y: point.y + NODE_HEIGHT + ROW_GAP };
  }
  return point;
}
