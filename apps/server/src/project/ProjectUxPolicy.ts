// @effect-diagnostics-next-line nodeBuiltinImport:off -- This bounded read-only Git probe is also used by native fixture tests; no shell or network is invoked.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous verification keeps unverified bundled bytes out of the pure context builder.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Canonicalize native Git roots before granting automatic adoption.
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import { unnUxCore } from "./policies/unnUxCore.ts";

const runFile = NodeUtil.promisify(NodeChildProcess.execFile);
export const UNN_UX_CORE_SHA256 =
  "ff19ffa117f1c78d1e9fd4b28ca1d7b6bdcc497ab961c6be30ee21bdf1c7571f";
const MAX_POLICY_BYTES = 24_000;
const ENTRY_BYTES = 6_000;

/** Exact public GitHub authority only; no aliases, nonstandard ports, credentials or encoded paths. */
export function normalizeUxOrigin(remote: string): string | null {
  const match =
    /^(?:https:\/\/github\.com(?::443)?\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([a-z0-9-]+)\/([a-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
      remote,
    );
  if (!match || match[2] === "." || match[2] === "..") return null;
  return `github.com/${match[1]}/${match[2]}`.toLowerCase();
}

/** Read the effective fetch origin each turn, including shared worktree configuration. */
export async function readUxOrigin(
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<string | null> {
  try {
    const env = Object.fromEntries(
      Object.entries(environment).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
    );
    const root = await runFile("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      env,
      timeout: 5_000,
      maxBuffer: 16_384,
      encoding: "utf8",
    });
    const normalizePath = (path: string) => path.replaceAll("\\", "/");
    if (
      normalizePath(await NodeFSP.realpath(cwd)) !==
      normalizePath(await NodeFSP.realpath(root.stdout.trim()))
    )
      return null;
    const { stdout } = await runFile("git", ["-C", cwd, "remote", "get-url", "--all", "origin"], {
      env,
      timeout: 5_000,
      maxBuffer: 16_384,
      encoding: "utf8",
    });
    const urls = stdout.trim().split(/\r?\n/);
    // An ambiguous origin does not establish automatic adoption.
    return urls.length === 1 ? normalizeUxOrigin(urls[0] ?? "") : null;
  } catch {
    return null;
  }
}

export function buildProjectUxPolicy(input: {
  readonly projectId: string;
  readonly origin: string | null;
  readonly mode?: "auto" | "on" | "off" | undefined;
  readonly core?: string | undefined;
}): NonNullable<ProviderAdapterV2TurnInput["projectPolicy"]> {
  const enabled =
    input.mode === "on" ||
    (input.mode !== "off" && input.origin?.startsWith("github.com/unn-corp/") === true);
  const core = input.core ?? unnUxCore;
  const verified =
    NodeCrypto.createHash("sha256").update(core, "utf8").digest("hex") === UNN_UX_CORE_SHA256;
  if (!enabled || !verified) {
    return {
      projectId: input.projectId,
      active: false,
      text: "No application UX guidance is active for this project. Any application UX guidance supplied for an earlier project or turn is inactive.",
    };
  }
  const start = core.indexOf("### UX-laws review: evidence and applicability");
  const end = core.indexOf("### Chart reference evaluation", start);
  const text = [
    "Project UX guidance: UNNDEV UI Standards Core v1.2, proposed UNNui PR #18, commit 7d59b31594442433de9bb1b4b5b141db194edcc9.",
    `Pinned source SHA-256: ${UNN_UX_CORE_SHA256}.`,
    "Apply this guidance only when designing, implementing or reviewing UX. Backend-only work has no additional UX requirements. Preserve explicit user direction, project-specific constraints and local components/tokens, accessibility and security. This proposed guidance does not authorize redesign, publication or claims of compliance.",
    "For delegated UX work, pass the applicable guidance and local constraints to the delegate; verify its evidence. Do not add irrelevant requirements to backend delegates.",
    core.slice(start, end).trim(),
  ].join("\n\n");
  if (start < 0 || end <= start || Buffer.byteLength(text, "utf8") > MAX_POLICY_BYTES) {
    throw new Error("Invalid bundled project UX guidance");
  }
  return { projectId: input.projectId, text };
}

/** Fixed keys overwrite earlier policy on resumed threads; order is lexical in Codex. */
export function projectUxContext(policy: ProviderAdapterV2TurnInput["projectPolicy"]) {
  if (!policy) return {};
  if (Buffer.byteLength(policy.text, "utf8") > MAX_POLICY_BYTES) {
    throw new Error("Project policy exceeds context budget");
  }
  const chunks: string[] = [""];
  let chunkBytes = 0;
  for (const character of policy.text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (chunkBytes + characterBytes > ENTRY_BYTES) {
      chunks.push(character);
      chunkBytes = characterBytes;
    } else {
      chunks[chunks.length - 1] += character;
      chunkBytes += characterBytes;
    }
  }
  return Object.fromEntries(
    Array.from({ length: 4 }, (_, index) => [
      `t3_project_ux_${String(index + 1).padStart(2, "0")}`,
      { kind: "application" as const, value: chunks[index] ?? "" },
    ]),
  );
}
