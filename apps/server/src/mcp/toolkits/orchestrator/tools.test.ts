import { assert, describe, it } from "@effect/vitest";
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
