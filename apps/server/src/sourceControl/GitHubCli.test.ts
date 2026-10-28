import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as GitHubCli from "./GitHubCli.ts";

const node = {
  number: 42,
  title: "Review",
  url: "https://git.acme.internal/acme/web/pull/42",
  baseRefName: "main",
  headRefName: "change",
  headRefOid: "head-sha",
  isDraft: false,
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  updatedAt: "2026-10-12T12:00:00Z",
  author: { login: "octocat" },
  statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
};

function harness(
  input: {
    readonly failMerge?: boolean;
    readonly account?: { readonly configured: boolean; readonly environment?: NodeJS.ProcessEnv };
  } = {},
) {
  const seen: {
    readonly pins: Array<{
      readonly host: string;
      readonly token: string;
      readonly fingerprint: string;
    } | null>;
    readonly mergeRequests: Array<GitHubApi.GitHubRestInput>;
  } = { pins: [], mergeRequests: [] };
  const api = GitHubApi.GitHubApi.of({
    credential: (host) =>
      Effect.succeed({ token: Redacted.make("global-token"), fingerprint: `${host}:global` }),
    graphql: () =>
      Effect.context<never>().pipe(
        Effect.map((context) => {
          const pin = Context.getOrElse(context, GitHubApi.PinnedGitHubCredential, () => null);
          seen.pins.push(
            pin === null
              ? null
              : {
                  host: pin.host,
                  token: Redacted.value(pin.token),
                  fingerprint: pin.credentialFingerprint,
                },
          );
          return JSON.stringify({ data: { repository: { pullRequests: { nodes: [node] } } } });
        }),
      ),
    rest: (request) =>
      Effect.context<never>().pipe(
        Effect.map((context) => {
          seen.mergeRequests.push(request);
          const pin = Context.getOrElse(context, GitHubApi.PinnedGitHubCredential, () => null);
          seen.pins.push(
            pin === null
              ? null
              : {
                  host: pin.host,
                  token: Redacted.value(pin.token),
                  fingerprint: pin.credentialFingerprint,
                },
          );
        }),
        Effect.flatMap(() =>
          input.failMerge
            ? Effect.fail(
                new GitHubApi.GitHubApiAuthenticationError({
                  host: request.host,
                  operation: request.operation,
                }),
              )
            : Effect.succeed({
                status: 200,
                headers: {},
                body: "{}",
                truncated: false,
                invalidUtf8: false,
              }),
        ),
      ),
  });
  const git = GitVcsDriver.GitVcsDriver.of({
    execute: ({ args }: Parameters<GitVcsDriver.GitVcsDriver["Service"]["execute"]>[0]) =>
      Effect.succeed({
        exitCode: 0,
        stdout:
          args[0] === "remote"
            ? "origin https://git.acme.internal/acme/web.git (fetch)\norigin https://git.acme.internal/acme/web.git (push)\n"
            : "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
  } as unknown as GitVcsDriver.GitVcsDriver["Service"]);
  const settings = ServerSettings.ServerSettingsService.of({
    getGitHubAccountEnvironmentForWorkspaceRoot: () =>
      Effect.succeed(
        input.account ?? {
          configured: true,
          environment: { GH_TOKEN: "selected-project-token", GH_HOST: "git.acme.internal" },
        },
      ),
  } as unknown as ServerSettings.ServerSettingsService["Service"]);
  const layer = GitHubCli.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(GitHubApi.GitHubApi, api),
        Layer.succeed(GitVcsDriver.GitVcsDriver, git),
        Layer.succeed(ServerSettings.ServerSettingsService, settings),
        Layer.succeed(HostProcess.Environment, {} as never),
        NodeCrypto.layer,
      ),
    ),
  );
  return { layer, seen };
}

describe("GitHubCli compatibility adapter", () => {
  it.effect("pins the selected project token to the exact enterprise host and fingerprint", () => {
    const { layer, seen } = harness();
    return Effect.gen(function* () {
      const cli = yield* GitHubCli.GitHubCli;
      const rows = yield* cli.listProjectPullRequests({
        cwd: "/workspace/acme/web",
        repository: "acme/web",
      });
      expect(rows[0]).toMatchObject({
        headRefOid: "head-sha",
        authorLogin: "octocat",
        reviewDecision: "approved",
        checkStatus: "passing",
      });
      expect(seen.pins).toHaveLength(1);
      expect(seen.pins[0]).toMatchObject({
        host: "git.acme.internal",
        token: "selected-project-token",
      });
      expect(seen.pins[0]?.fingerprint).toMatch(/^git\.acme\.internal:[0-9a-f]+$/);
      expect(seen.pins[0]?.fingerprint).not.toContain("selected-project-token");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "does not fall back to a global credential when the selected account lacks its PAT",
    () => {
      const { layer, seen } = harness({ account: { configured: true } });
      const envBefore = process.env.GH_TOKEN;
      return Effect.gen(function* () {
        const cli = yield* GitHubCli.GitHubCli;
        const error = yield* Effect.flip(
          cli.listProjectPullRequests({ cwd: "/workspace/acme/web", repository: "acme/web" }),
        );
        expect(error._tag).toBe("GitHubCliCommandError");
        expect(seen.pins).toHaveLength(0);
        expect(process.env.GH_TOKEN).toBe(envBefore);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "does not send an account token to a host other than the account's saved GH_HOST",
    () => {
      const { layer, seen } = harness({
        account: {
          configured: true,
          environment: { GH_TOKEN: "wrong-host-token", GH_HOST: "github.com" },
        },
      });
      return Effect.gen(function* () {
        const cli = yield* GitHubCli.GitHubCli;
        const error = yield* Effect.flip(
          cli.listProjectPullRequests({ cwd: "/workspace/acme/web", repository: "acme/web" }),
        );
        expect(error._tag).toBe("GitHubCliCommandError");
        expect(seen.pins).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("sends expectedHeadOid to REST merge and keeps failed auth request scoped", () => {
    const { layer, seen } = harness({ failMerge: true });
    const envBefore = process.env.GH_TOKEN;
    return Effect.gen(function* () {
      const cli = yield* GitHubCli.GitHubCli;
      const error = yield* Effect.flip(
        cli.mergePullRequest({
          cwd: "/workspace/acme/web",
          repository: "acme/web",
          number: 42,
          expectedHeadOid: "exact-head-sha",
          method: "squash",
        }),
      );
      expect(error._tag).toBe("GitHubCliCommandError");
      expect(seen.mergeRequests[0]).toMatchObject({
        host: "git.acme.internal",
        method: "PUT",
        path: "repos/acme/web/pulls/42/merge",
        body: { sha: "exact-head-sha", merge_method: "squash" },
      });
      expect(seen.pins[0]?.host).toBe("git.acme.internal");
      expect(process.env.GH_TOKEN).toBe(envBefore);
    }).pipe(Effect.provide(layer));
  });
});
