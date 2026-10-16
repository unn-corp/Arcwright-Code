import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest } from "effect/http";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as GitHubRest from "./GitHubRest.ts";
import * as Policy from "./GitHubRequestPolicy.ts";
export {
  PinnedGitHubCredential,
  GitHubApiRequestError,
  GitHubApiAuthenticationError,
  GitHubApiRateLimitError,
  GitHubApiNotFoundError,
  GitHubApiResponseError,
  type GitHubApiError,
  gitHubApiUrls,
} from "./GitHubRequestPolicy.ts";
import type { GitHubApiError } from "./GitHubRequestPolicy.ts";

/** Compatibility API for fork project pull requests; upstream owns credentials, quota and REST. */
export interface GitHubRestResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  readonly truncated: boolean;
  /** The body was not valid UTF-8, which a raw file read takes to mean binary. */
  readonly invalidUtf8: boolean;
}

export interface GitHubRestInput {
  readonly host: string;
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Relative to the API root, e.g. `repos/acme/web/pulls/7`; query string included. */
  readonly path: string;
  readonly body?: unknown;
  /** Defaults to `application/vnd.github+json`. */
  readonly accept?: string;
  /** Revalidates a cached answer. A 304 is returned rather than failed, and is free. */
  readonly ifNoneMatch?: string;
  readonly maxResponseBytes?: number;
  /** Defaults to 30 seconds; a whole pull request's patch may need longer. */
  readonly timeout?: Duration.Input;
  /** Overrides `SourceControlRateLimit.Interactive` for this one request. */
  readonly allowReserve?: boolean;
}

export interface GitHubGraphQlInput {
  readonly host: string;
  readonly operation: string;
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly allowReserve?: boolean;
  readonly maxResponseBytes?: number;
}

export class GitHubApi extends Context.Service<
  GitHubApi,
  {
    /** The raw JSON body of a successful GraphQL answer, with `rateLimit` recorded. */
    readonly graphql: (input: GitHubGraphQlInput) => Effect.Effect<string, GitHubApiError>;
    readonly rest: (input: GitHubRestInput) => Effect.Effect<GitHubRestResponse, GitHubApiError>;
    /** The credential a request to `host` would carry right now. */
    readonly credential: (
      host: string,
    ) => Effect.Effect<
      { readonly token: Redacted.Redacted<string>; readonly fingerprint: string },
      GitHubApiError
    >;
  }
>()("@t3tools/source-control-github/server/GitHubApi") {}

export const make = Effect.gen(function* () {
  const rest = yield* GitHubRest.GitHubRest;
  const policy = yield* Policy.GitHubRequestPolicy;
  const client = yield* HttpClient.HttpClient;
  const graphql: GitHubApi["Service"]["graphql"] = (input) =>
    policy.request(
      {
        host: input.host,
        operation: input.operation,
        resource: "graphql",
        allowReserve: input.allowReserve ?? false,
      },
      (headers) =>
        client
          .execute(
            HttpClientRequest.post(Policy.gitHubApiUrls(input.host).graphql).pipe(
              HttpClientRequest.setHeaders(headers),
              HttpClientRequest.bodyJsonUnsafe({ query: input.query, variables: input.variables }),
            ),
          )
          .pipe(
            Effect.flatMap((response) =>
              collectUint8StreamText({
                stream: response.stream,
                maxBytes: input.maxResponseBytes ?? 8 * 1024 * 1024,
              }).pipe(
                Effect.map((body): Policy.GitHubAnswer<string> => {
                  const meta = { status: response.status, headers: response.headers };
                  if (body.truncated)
                    return {
                      ...meta,
                      _tag: "Failed",
                      messages: ["GitHub response exceeded the size limit."],
                    };
                  let errors: unknown;
                  try {
                    const parsed: unknown = JSON.parse(body.text);
                    errors =
                      typeof parsed === "object" && parsed !== null && "errors" in parsed
                        ? parsed.errors
                        : undefined;
                  } catch {
                    return { ...meta, _tag: "Failed" };
                  }
                  if (
                    Policy.isRateLimited({
                      ...meta,
                      body: body.text,
                      ...(Array.isArray(errors) ? { graphqlErrors: errors } : {}),
                    })
                  )
                    return { ...meta, _tag: "RateLimited" };
                  if (response.status === 401 || response.status === 403)
                    return { ...meta, _tag: "Unauthorized" };
                  if (response.status === 404) return { ...meta, _tag: "NotFound" };
                  return response.status >= 200 &&
                    response.status < 300 &&
                    (!Array.isArray(errors) ? errors === undefined : errors.length === 0)
                    ? { ...meta, _tag: "Ok", value: body.text }
                    : { ...meta, _tag: "Failed" };
                }),
              ),
            ),
            Effect.mapError(
              (cause) =>
                new Policy.GitHubApiRequestError({
                  host: input.host,
                  operation: input.operation,
                  cause,
                }),
            ),
          ),
    );
  return GitHubApi.of({ graphql, rest: rest.rest, credential: rest.credential });
});
export const layer = Layer.effect(GitHubApi, make);
