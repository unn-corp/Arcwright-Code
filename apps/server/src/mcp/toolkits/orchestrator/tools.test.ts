import { assert, describe, expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { OrchestratorToolkit } from "./tools.ts";

describe("orchestrator MCP tool guidance", () => {
  it("publishes direct replies with stable message IDs and explains the response flow", () => {
    const tool = OrchestratorToolkit.tools.t3_message_reply;
    assert.include(tool.description ?? "", "messageId from t3_thread_read");
    assert.include(tool.description ?? "", "No new turn is started");
    assert.include(tool.description ?? "", "Use ordinary chat by default");
    assert.include(tool.description ?? "", "only the next assistant response");
    assert.include(tool.description ?? "", "own active conversation");
    const schema = Tool.getJsonSchema(tool) as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["messageId"]);
    assert.hasAllKeys(schema.properties ?? {}, ["messageId", "clientRequestId"]);
  });
});

// Oversized page sizes clamp on decode, so the schema has no `maximum`; Codex also drops
// bounds from its TypeScript view. The description is the only place a model sees a limit.
it("states t3_thread_read page size limits in the parameter descriptions", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.t3_thread_read) as {
    readonly properties: Readonly<Record<string, { readonly description?: string }>>;
  };
  const limits = { limit: "100", runLimit: "50", maxCharsPerItem: "50000" };
  for (const [name, maximum] of Object.entries(limits)) {
    expect(schema.properties[name]?.description, name).toContain(maximum);
  }
});
