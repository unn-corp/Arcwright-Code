import { normalizeCodexArchitectOutputJson } from "./CodexArchitectOutput.ts";
import { expect, it } from "vite-plus/test";
import { requireAllJsonSchemaProperties } from "@t3tools/provider-core/server/textGenerationUtils";

it("allows null placeholders only for fields that were optional before Codex requires all keys", () => {
  expect(
    requireAllJsonSchemaProperties({
      type: "object",
      properties: {
        type: { const: "update-role" },
        roleId: { type: "string" },
        title: { type: "string", minLength: 1 },
        poolSize: { type: "integer", minimum: 1, maximum: 4 },
      },
      required: ["type", "roleId"],
      additionalProperties: false,
    }),
  ).toEqual({
    type: "object",
    properties: {
      type: { const: "update-role" },
      roleId: { type: "string" },
      title: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
      poolSize: { anyOf: [{ type: "integer", minimum: 1, maximum: 4 }, { type: "null" }] },
    },
    required: ["type", "roleId", "title", "poolSize"],
    additionalProperties: false,
  });
});

it("omits Codex null profile placeholders without erasing explicit clears", () => {
  const result = JSON.parse(
    normalizeCodexArchitectOutputJson(
      JSON.stringify({
        proposals: [
          {
            change: {
              type: "update-role",
              roleId: "worker",
              personality: null,
              focus: "",
              skills: null,
            },
          },
          {
            change: {
              type: "add-role",
              role: { id: "new", personality: null, focus: null, skills: "TypeScript" },
            },
          },
        ],
      }),
    ),
  );
  expect(result.proposals[0].change).toEqual({ type: "update-role", roleId: "worker", focus: "" });
  expect(result.proposals[1].change.role).toEqual({ id: "new", skills: "TypeScript" });
});
