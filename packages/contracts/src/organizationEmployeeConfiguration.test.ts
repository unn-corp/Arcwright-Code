import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  OrganizationChange,
  OrganizationGraph,
  OrganizationPublishedConfig,
} from "./organizations.ts";
import { ExecutionEnvironmentCapabilities } from "./environment.ts";

const decodeGraph = Schema.decodeUnknownSync(OrganizationGraph);
const decodePublished = Schema.decodeUnknownSync(OrganizationPublishedConfig);
const decodeChange = Schema.decodeUnknownSync(OrganizationChange);
const decodeCapabilities = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities);

const role = {
  id: "employee",
  kind: "engineering",
  title: "Engineer",
  mandate: "Build",
  poolSize: 1,
};
it("decodes legacy graphs and published configurations without employee assignments", () => {
  expect(decodeGraph({ roles: [role], edges: [] }).roles[0]).not.toHaveProperty("modelSelection");
  const config = decodePublished({
    organizationId: "org",
    revision: 1,
    title: "Studio",
    mission: "Build",
    graph: { roles: [role], edges: [] },
    bindings: [],
    publishedAt: "2026-10-16T00:00:00.000Z",
  });
  expect(config.workflows).toEqual([]);
  expect(config.graph.roles[0]).not.toHaveProperty("modelSelection");
});

it("distinguishes omitted and explicitly cleared employee choices", () => {
  const decode = decodeChange;
  expect(decode({ type: "update-role", roleId: "employee", title: "Lead" })).not.toHaveProperty(
    "modelSelection",
  );
  expect(decode({ type: "update-role", roleId: "employee", modelSelection: null })).toHaveProperty(
    "modelSelection",
    null,
  );
  expect(
    decode({
      type: "add-role",
      role: { ...role, modelSelection: { instanceId: "local-provider", model: "local-model" } },
      position: { x: 0, y: 3.5 },
    }),
  ).toMatchObject({
    role: { modelSelection: { instanceId: "local-provider" } },
    position: { x: 0, y: 3.5 },
  });
  for (const position of [
    { x: -1, y: 0 },
    { x: 0, y: Infinity },
    { x: NaN, y: 0 },
  ]) {
    expect(() => decode({ type: "add-role", role, position })).toThrow();
  }
});

it("decodes old and new server capabilities", () => {
  const decode = decodeCapabilities;
  // The capability is additive; old snapshots do not assert support.
  expect(decode({})).not.toHaveProperty("organizationEmployeeConfiguration");
  expect(decode({ organizationEmployeeConfiguration: true })).toHaveProperty(
    "organizationEmployeeConfiguration",
    true,
  );
});
