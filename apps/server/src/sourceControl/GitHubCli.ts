import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  type SourceControlProjectPullRequest,
  type SourceControlPullRequestMergeMethod,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as GitHubRepositoryResolution from "@t3tools/source-control-github/server/gitHubRepositoryResolution";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { decodeGitHubProjectPullRequestListJson } from "./gitHubProjectPullRequests.ts";

const textEncoder = new TextEncoder();

const projectCredentialFingerprint = (
  crypto: Crypto.Crypto,
  host: string,
  token: string,
): Effect.Effect<string> =>
  crypto.digest("SHA-256", textEncoder.encode(token)).pipe(
    Effect.map((digest) => `${host.toLowerCase()}:${Hex.encode(digest)}`),
    Effect.orDie,
  );

const mergePullRequestRestInput = (input: {
  readonly host: string;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly expectedHeadOid: string;
  readonly method: SourceControlPullRequestMergeMethod;
}): GitHubApi.GitHubRestInput => ({
  host: input.host,
  operation: "mergePullRequest",
  method: "PUT",
  path: `repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls/${input.number}/merge`,
  body: { sha: input.expectedHeadOid, merge_method: input.method },
  allowReserve: true,
});

const GitHubCliErrorFields = {
  operation: Schema.String,
  cwd: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
} as const;

export class GitHubCliCommandError extends Schema.TaggedError<GitHubCliCommandError>()(
  "GitHubCliCommandError",
  GitHubCliErrorFields,
) {
  override get message(): string {
    return "The GitHub repository operation could not be completed.";
  }
}

const isGitHubCliCommandError = Schema.is(GitHubCliCommandError);

export class GitHubCliDecodeError extends Schema.TaggedError<GitHubCliDecodeError>()(
  "GitHubCliDecodeError",
  GitHubCliErrorFields,
) {
  override get message(): string {
    return "GitHub returned an invalid project pull request response.";
  }
}

const isGitHubCliDecodeError = Schema.is(GitHubCliDecodeError);

export type GitHubCliError = GitHubCliCommandError | GitHubCliDecodeError;

/**
 * The retained fork call surface. Other GitHub features now live in provider packages; this
 * adapter exists for the project dashboard's richer list and its optimistic merge operation.
 */
export class GitHubCli extends Context.Service<
  GitHubCli,
  {
    readonly listProjectPullRequests: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<SourceControlProjectPullRequest>, GitHubCliError>;
    readonly mergePullRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly expectedHeadOid: string;
      readonly method: SourceControlPullRequestMergeMethod;
    }) => Effect.Effect<void, GitHubCliError>;
  }
>()("t3/sourceControl/GitHubCli") {}

const graphQlEnvelope = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequests: Schema.Struct({ nodes: Schema.Array(Schema.Unknown) }),
    }),
  }),
});
function fail(operation: string, cwd: string, cause?: unknown, decode = false): GitHubCliError {
  return decode
    ? new GitHubCliDecodeError({ operation, cwd, ...(cause === undefined ? {} : { cause }) })
    : new GitHubCliCommandError({ operation, cwd, ...(cause === undefined ? {} : { cause }) });
}

/** @public Service construction is part of the server layer API. */
export const make = Effect.gen(function* () {
  const api = yield* GitHubApi.GitHubApi;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* HostProcess.Environment;
  const crypto = yield* Crypto.Crypto;

  const resolveLocator = Effect.fn("GitHubCli.resolveLocator")(function* (
    cwd: string,
    selector: string,
  ) {
    const [remotesResult, resolvedResult] = yield* Effect.all([
      git
        .execute({
          operation: "GitHubCli.resolveRepository.remotes",
          cwd,
          args: ["remote", "-v"],
          allowNonZeroExit: true,
        })
        .pipe(Effect.result),
      git
        .execute({
          operation: "GitHubCli.resolveRepository.default",
          cwd,
          args: ["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"],
          allowNonZeroExit: true,
        })
        .pipe(Effect.result),
    ]);
    const remotes = Result.isSuccess(remotesResult) ? remotesResult.success.stdout : "";
    const resolved = Result.isSuccess(resolvedResult) ? resolvedResult.success.stdout : "";
    const fetchRemotes = GitHubRepositoryResolution.parseFetchRemotes(remotes);
    const primaryRemote =
      fetchRemotes.find((remote) => remote.name === "origin") ?? fetchRemotes[0];
    const remoteHost =
      primaryRemote === undefined
        ? undefined
        : normalizeGitRemoteUrl(primaryRemote.url).split("/")[0];
    const hostHint = environment.GH_HOST ?? remoteHost;
    const remoteResolution = GitHubRepositoryResolution.resolveGitHubRepository({
      remotes,
      resolved,
      hostHint,
      defaultHost: hostHint ?? "github.com",
    });
    const locator = GitHubRepositoryResolution.parseGitHubRepositorySelector(
      selector,
      remoteResolution.host,
    );
    if (locator === null) {
      return yield* fail("resolveRepository", cwd);
    }
    return locator;
  });

  /** Pin a project-selected account only for this Effect; never mutate process headers/env. */
  const withProjectCredential = <A, E>(
    cwd: string,
    host: string,
    use: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | GitHubCliError> =>
    settings.getGitHubAccountEnvironmentForWorkspaceRoot(cwd).pipe(
      Effect.mapError(() => fail("resolveProjectCredential", cwd)),
      Effect.flatMap((account): Effect.Effect<A, E | GitHubCliError> => {
        // No project account means the shared host credential policy applies. Once the project
        // selected an account, a missing token is a hard failure rather than a fallback to a
        // different account from GH_TOKEN or `gh auth`.
        if (!account.configured) return use;
        const token = account.environment?.GH_TOKEN?.trim();
        if (!token) return Effect.fail(fail("resolveProjectCredential", cwd));
        const accountHost = (account.environment?.GH_HOST ?? "github.com").toLowerCase();
        if (accountHost !== host.toLowerCase()) {
          return Effect.fail(fail("resolveProjectCredential", cwd));
        }
        return projectCredentialFingerprint(crypto, host, token).pipe(
          Effect.flatMap((credentialFingerprint) =>
            use.pipe(
              Effect.provideService(GitHubApi.PinnedGitHubCredential, {
                host: host.toLowerCase(),
                token: Redacted.make(token),
                credentialFingerprint,
              }),
            ),
          ),
        );
      }),
    );

  const listProjectPullRequests: GitHubCli["Service"]["listProjectPullRequests"] = (input) =>
    resolveLocator(input.cwd, input.repository).pipe(
      Effect.flatMap((locator) => {
        const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)));
        const request = api.graphql({
          host: locator.host,
          operation: "listProjectPullRequests",
          allowReserve: true,
          query: `query ProjectPullRequests($owner: String!, $name: String!, $limit: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $limit, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number title url baseRefName headRefName headRefOid isDraft mergeStateStatus reviewDecision updatedAt author { login } statusCheckRollup { __typename ... on CheckRun { status conclusion } ... on StatusContext { state } } }
    }
  }
}`,
          variables: { owner: locator.owner, name: locator.name, limit },
        });
        return withProjectCredential(input.cwd, locator.host, request).pipe(
          Effect.mapError((cause) =>
            isGitHubCliCommandError(cause) || isGitHubCliDecodeError(cause)
              ? cause
              : fail("listProjectPullRequests", input.cwd),
          ),
          Effect.flatMap((raw) => {
            const envelope = decodeJsonResult(graphQlEnvelope)(raw);
            if (Result.isFailure(envelope)) {
              return Effect.fail(
                fail("listProjectPullRequests", input.cwd, envelope.failure, true),
              );
            }
            const decoded = decodeGitHubProjectPullRequestListJson(
              JSON.stringify(envelope.success.data.repository.pullRequests.nodes),
            );
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(fail("listProjectPullRequests", input.cwd, decoded.failure, true));
          }),
        );
      }),
      Effect.mapError((cause) =>
        isGitHubCliCommandError(cause) || isGitHubCliDecodeError(cause)
          ? cause
          : fail("listProjectPullRequests", input.cwd),
      ),
    );

  const mergePullRequest: GitHubCli["Service"]["mergePullRequest"] = (input) =>
    resolveLocator(input.cwd, input.repository).pipe(
      Effect.flatMap((locator) => {
        const request = api.rest(
          mergePullRequestRestInput({
            host: locator.host,
            owner: locator.owner,
            repository: locator.name,
            number: input.number,
            expectedHeadOid: input.expectedHeadOid,
            method: input.method,
          }),
        );
        return withProjectCredential(input.cwd, locator.host, request).pipe(
          Effect.asVoid,
          Effect.mapError((cause) =>
            isGitHubCliCommandError(cause) || isGitHubCliDecodeError(cause)
              ? cause
              : fail("mergePullRequest", input.cwd),
          ),
        );
      }),
      Effect.mapError((cause) =>
        isGitHubCliCommandError(cause) || isGitHubCliDecodeError(cause)
          ? cause
          : fail("mergePullRequest", input.cwd),
      ),
    );

  return GitHubCli.of({ listProjectPullRequests, mergePullRequest });
});

export const layer = Layer.effect(GitHubCli, make);
