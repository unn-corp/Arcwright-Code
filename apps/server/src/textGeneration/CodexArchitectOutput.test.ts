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
