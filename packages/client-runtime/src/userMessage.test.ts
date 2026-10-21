import { describe, expect, it } from "vite-plus/test";

import { isUserMessageRightAligned, resolveUserMessagePresentation } from "./userMessage.ts";

describe("resolveUserMessagePresentation", () => {
  const legacyText = "[Triggered by schedule task: Daily audit]\n\nCheck for crashes.\n";

  it("preserves user-written and assistant-quoted schedule headers", () => {
    for (const message of [
      { role: "user", createdBy: "user" as const },
      { role: "user" },
      { role: "assistant", createdBy: "agent" as const },
    ]) {
      expect(resolveUserMessagePresentation({ ...message, text: legacyText })).toEqual({
        text: legacyText,
        attribution: null,
        scheduledTaskId: undefined,
      });
    }
  });

  it("attributes older server-sent restart continuations to T3 Code, not another agent", () => {
    const text = "Note: the T3 server restarted.";
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        creationSource: "server",
        text,
      }),
    ).toMatchObject({ attribution: "t3code" });
    for (const creationSource of ["mcp", "provider"] as const) {
      expect(
        resolveUserMessagePresentation({ role: "user", createdBy: "agent", creationSource, text }),
      ).toMatchObject({ attribution: "agent" });
    }
  });

  it("recovers the triggering automation from older scheduler message ids", () => {
    for (const trigger of ["scheduled", "manual"]) {
      expect(
        resolveUserMessagePresentation({
          id: `scheduled-task-message:task:daily-audit:1788661140000:${trigger}`,
          role: "user",
          createdBy: "user",
          text: legacyText,
        }),
      ).toEqual({
        text: "Check for crashes.\n",
        attribution: "automation",
        scheduledTaskId: "task:daily-audit",
      });
    }
  });
});

it("puts main and delivering agents on the left while keeping human input on the right", () => {
  const human = { role: "user", text: "Hello" };
  expect(isUserMessageRightAligned(human)).toBe(true);
  expect(isUserMessageRightAligned({ ...human, role: "assistant" })).toBe(false);
  expect(
    isUserMessageRightAligned({ ...human, createdBy: "agent", creationSource: "provider" }),
  ).toBe(false);
  expect(isUserMessageRightAligned({ ...human, senderThreadId: "other-thread" })).toBe(false);
});
