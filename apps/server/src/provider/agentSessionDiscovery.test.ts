// @effect-diagnostics nodeBuiltinImport:off - exercise the native provider's on-disk layout.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { discoverAgentSessions } from "./agentSessionDiscovery.ts";

const cwd = "/workspace/project";
const group = cwd.replaceAll("/", "%2F");
const earlier = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-01T12:00:00Z")) / 1000;
const laterIso = "2026-10-02T12:00:00.000Z";
const later = DateTime.toEpochMillis(DateTime.makeUnsafe(laterIso)) / 1000;

async function withHome(run: (home: string) => Promise<void>) {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agent-discovery-"));
  try {
    await run(home);
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
}

async function writeGrokSession(home: string, sessionId: string, text: string) {
  const dir = NodePath.join(home, "sessions", group, sessionId);
  await NodeFSP.mkdir(dir, { recursive: true });
  const path = NodePath.join(dir, "chat_history.jsonl");
  await NodeFSP.writeFile(
    path,
    JSON.stringify({ type: "user", content: [{ type: "text", text }] }) + "\n",
  );
  return { dir, path };
}

describe("discoverAgentSessions", () => {
  it("orders and limits Grok sessions by transcript updates rather than folder creation", async () => {
    await withHome(async (home) => {
      const resumed = await writeGrokSession(home, "resumed", "Recent work");
      const stale = await writeGrokSession(home, "stale", "Older work");
      await NodeFSP.utimes(resumed.path, later, later);
      await NodeFSP.utimes(resumed.dir, earlier, earlier);
      await NodeFSP.utimes(stale.path, earlier, earlier);
      await NodeFSP.utimes(stale.dir, later, later);

      const sessions = await discoverAgentSessions({ driver: "grok", home, cwd, limit: 1 });
      expect(sessions).toEqual([
        expect.objectContaining({
          sessionId: "resumed",
          preview: "Recent work",
          startedAt: laterIso,
          rolloutPath: resumed.dir,
        }),
      ]);
    });
  });

  it("does not let missing or invalid Grok histories displace resumable sessions", async () => {
    await withHome(async (home) => {
      await writeGrokSession(home, "available", "Keep this");
      await NodeFSP.mkdir(NodePath.join(home, "sessions", group, "missing"));
      await NodeFSP.mkdir(NodePath.join(home, "sessions", group, "invalid", "chat_history.jsonl"), {
        recursive: true,
      });
      const sessions = await discoverAgentSessions({ driver: "grok", home, cwd });
      expect(sessions.map((session) => session.sessionId)).toEqual(["available"]);
    });
  });

  it("keeps Grok discovery scoped to the selected account and project", async () => {
    await withHome(async (home) => {
      await writeGrokSession(home, "selected", "<user_query>Help me fix this</user_query>");
      const other = NodePath.join(home, "sessions", "%2Fworkspace%2Fother", "other");
      await NodeFSP.mkdir(other, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(other, "chat_history.jsonl"),
        JSON.stringify({ type: "user", content: "Other project" }),
      );
      const selected = await discoverAgentSessions({ driver: "grok", home, cwd });
      expect(selected.map(({ sessionId, preview }) => [sessionId, preview])).toEqual([
        ["selected", "Help me fix this"],
      ]);
      expect(await discoverAgentSessions({ driver: "grok", home, cwd: "/missing" })).toEqual([]);
      expect(await discoverAgentSessions({ driver: "grok", cwd })).toEqual([]);
      expect(await discoverAgentSessions({ driver: "grok", home, limit: 0 })).toEqual([]);
      const all = await discoverAgentSessions({ driver: "grok", home });
      expect(all.map((session) => session.sessionId).toSorted()).toEqual(["other", "selected"]);
    });
  });

  it.each(["claude", "claudeAgent"])(
    "preserves %s previews and skips nested subagent sessions",
    async (driver) => {
      await withHome(async (home) => {
        const project = NodePath.join(home, "projects", cwd.replace(/[/\\.]/g, "-"));
        await NodeFSP.mkdir(NodePath.join(project, "subagents"), { recursive: true });
        const contents = JSON.stringify({
          type: "user",
          message: {
            content: [
              { type: "text", text: "<INSTRUCTIONS>Injected context</INSTRUCTIONS>" },
              { type: "text", text: "Actual question" },
            ],
          },
        });
        await NodeFSP.writeFile(NodePath.join(project, "selected.jsonl"), contents);
        await NodeFSP.writeFile(NodePath.join(project, "subagents", "nested.jsonl"), contents);
        const sessions = await discoverAgentSessions({ driver, home, cwd });
        expect(sessions).toEqual([
          expect.objectContaining({ sessionId: "selected", preview: "Actual question", cwd }),
        ]);
      });
    },
  );

  it("returns no sessions for missing homes and unsupported providers", async () => {
    await withHome(async (home) => {
      expect(await discoverAgentSessions({ driver: "grok", home })).toEqual([]);
      expect(await discoverAgentSessions({ driver: "claude", home })).toEqual([]);
      expect(await discoverAgentSessions({ driver: "claude" })).toEqual([]);
      expect(await discoverAgentSessions({ driver: "unknown", home })).toEqual([]);
    });
  });
});
