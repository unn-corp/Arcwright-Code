import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  type CodexSettings,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  OrganizationArchitectTurnOutput,
  OrganizationPatchProposalOutput,
  type ModelSelection,
  type ServerProviderModel,
  TextGenerationError,
} from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { codexExecLaunchArgs, resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { normalizeCodexArchitectOutputJson } from "./CodexArchitectOutput.ts";
import { OrganizationPatchProcessObserver } from "./OrganizationPatchProcessObserver.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "@t3tools/provider-core/server/textGenerationPrompts";
import {
  normalizeCliError,
  requireAllJsonSchemaProperties,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "@t3tools/provider-core/server/textGenerationUtils";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { codexModelFamily, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import {
  buildOrganizationArchitectPrompt,
  validateOrganizationArchitectOutput,
} from "../organizations/OrganizationArchitectPrompt.ts";
import {
  buildOrganizationPatchPrompt,
  validateOrganizationPatchProposal,
} from "../organizations/OrganizationPatchPrompt.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const isTextGenerationError = Schema.is(TextGenerationError);

const CODEX_TIMEOUT_MS = 180_000;
const CODEX_MCP_LIST_TIMEOUT_MS = 10_000;
// Plugins/apps add MCP servers; use trailing config overrides because --disable loses to user -c flags.
const CODEX_NO_PLUGIN_ARGS = [
  "--config",
  "features.plugins=false",
  "--config",
  "features.apps=false",
] as const;
const CodexMcpServers = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean })),
);
const decodeCodexMcpServers = Schema.decodeEffect(CodexMcpServers);

// mcp_servers={} merges instead of replacing; disable named entries and quote dotted names.
const codexMcpServersOff = (names: ReadonlyArray<string>): string | null =>
  names.length === 0
    ? null
    : `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`;
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
export const makeCodexTextGeneration = Effect.fn("makeCodexTextGeneration")(function* (
  codexConfig: CodexSettings,
  environment?: NodeJS.ProcessEnv,
  getModels: Effect.Effect<ReadonlyArray<ServerProviderModel>> = Effect.succeed([]),
  resolveRuntime?: Effect.Effect<
    import("../provider/CodexManagedRuntime.ts").CodexEffectiveRuntime,
    import("@t3tools/contracts").ProviderSetupError,
    Scope.Scope
  >,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
  const resolvedEnvironment = environment ?? process.env;

  type MaterializedImageAttachments = {
    readonly imagePaths: ReadonlyArray<string>;
  };

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("codex", operation, cause, "Failed to collect process output"),
      ),
    );

  const safeUnlink = (filePath: string): Effect.Effect<void, never> =>
    fileSystem.remove(filePath).pipe(Effect.ignoreCause);

  const removeTempFileDir = (filePath: string): Effect.Effect<void, never> =>
    fileSystem.remove(path.dirname(filePath), { recursive: true }).pipe(Effect.ignore);

  // Background fibers may inherit closed scopes that immediately reap temp files; write unscoped.
  const writeTempFile = (
    operation: string,
    prefix: string,
    content: string,
  ): Effect.Effect<string, TextGenerationError> =>
    fileSystem
      .makeTempFile({
        prefix: `t3code-${prefix}-${process.pid}-`,
      })
      .pipe(
        Effect.tap((filePath) =>
          fileSystem
            .writeFileString(filePath, content)
            .pipe(Effect.onError(() => removeTempFileDir(filePath))),
        ),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to write temp file`,
              cause,
            }),
        ),
      );

  const encodeJsonForOperation = (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateReviewGuide"
      | "generateOrganizationArchitectTurn"
      | "generateOrganizationPatchProposal",
    value: unknown,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to encode structured output schema.",
            cause,
          }),
      ),
    );

  const materializeImageAttachments = Effect.fn("materializeImageAttachments")(function* (
    _operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle",
    attachments: TextGeneration.BranchNameGenerationInput["attachments"],
  ): Effect.fn.Return<MaterializedImageAttachments, TextGenerationError> {
    if (!attachments || attachments.length === 0) {
      return { imagePaths: [] };
    }

    const imagePaths: string[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== "image") {
        continue;
      }

      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
        continue;
      }
      const fileInfo = yield* fileSystem.stat(resolvedPath).pipe(Effect.orElseSucceed(() => null));
      if (!fileInfo || fileInfo.type !== "File") {
        continue;
      }
      imagePaths.push(resolvedPath);
    }
    return { imagePaths };
  });

  const listEnabledMcpServers = Effect.fn("listEnabledMcpServers")(
    function* (input: {
      readonly binary: string;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly launchArgs: ReadonlyArray<string>;
    }) {
      const spawnCommand = yield* resolveSpawnCommand(
        input.binary,
        [...input.launchArgs, ...CODEX_NO_PLUGIN_ARGS, "mcp", "list", "--json"],
        { env: input.env },
      );
      const child = yield* commandSpawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: input.env,
          cwd: input.cwd,
          shell: spawnCommand.shell,
          forceKillAfter: "1 second",
        }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        yield* Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
          reason: "exit",
          exitCode,
        });
        return [];
      }
      const servers = yield* decodeCodexMcpServers(stdout).pipe(
        Effect.tapError(() =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "decode",
          }),
        ),
      );
      return servers.filter((server) => server.enabled).map((server) => server.name);
    },
    Effect.scoped,
    Effect.timeoutOption(CODEX_MCP_LIST_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "timeout",
          }).pipe(Effect.as<ReadonlyArray<string>>([])),
        onSome: (names) => Effect.succeed(names),
      }),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  const runCodexJson = Effect.fn("runCodexJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    imagePaths = [],
    cleanupPaths = [],
    modelSelection,
    investigate,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateReviewGuide"
      | "generateThreadTitle"
      | "generateOrganizationArchitectTurn"
      | "generateOrganizationPatchProposal";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    imagePaths?: ReadonlyArray<string>;
    cleanupPaths?: ReadonlyArray<string>;
    modelSelection: ModelSelection;
    investigate?: { readonly timeoutMs: number } | undefined;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const outputSchema = toJsonSchemaObject(outputSchemaJson);
    const schemaJson = yield* encodeJsonForOperation(
      operation,
      operation === "generateOrganizationArchitectTurn" ||
        operation === "generateOrganizationPatchProposal"
        ? requireAllJsonSchemaProperties(outputSchema)
        : outputSchema,
    );
    const schemaPath = yield* writeTempFile(operation, "codex-schema", schemaJson);
    const outputPath = yield* writeTempFile(operation, "codex-output", "").pipe(
      Effect.onError(() => removeTempFileDir(schemaPath)),
    );

    const runCodexCommand = Effect.fn("runCodexJson.runCodexCommand")(function* () {
      const resolved = resolveRuntime
        ? yield* resolveRuntime.pipe(
            Effect.mapError(
              (cause) => new TextGenerationError({ operation, detail: cause.detail }),
            ),
          )
        : undefined;
      const effectiveConfig = resolved?.config ?? codexConfig;
      const effectiveEnvironment = resolved?.environment ?? resolvedEnvironment;
      const models = yield* getModels;
      const requestedModel = modelSelection.model;
      const model =
        models.find((candidate) => candidate.slug === requestedModel)?.slug ??
        models.find(
          (candidate) => !candidate.isCustom && codexModelFamily(candidate.slug) === requestedModel,
        )?.slug ??
        requestedModel;
      const launchArgs = resolveCodexLaunchArgs(effectiveConfig.launchArgs, effectiveEnvironment);
      const reasoningEffort =
        getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
        DEFAULT_TEXT_GENERATION_REASONING_EFFORT;
      const serviceTier = resolved ? undefined : getCodexServiceTierOptionValue(modelSelection);
      const binary = effectiveConfig.binaryPath || "codex";
      const env = {
        ...effectiveEnvironment,
        ...(effectiveConfig.homePath
          ? {
              CODEX_HOME: expandHomePath(
                effectiveConfig.homePath,
                yield* HostProcess.HomeDirectory,
              ),
            }
          : {}),
      };
      const execLaunchArgs = codexExecLaunchArgs(launchArgs);
      const mcpServersOff = yield* listEnabledMcpServers({
        binary,
        cwd,
        env,
        // `codex mcp` rejects --strict-config; the overrides still apply.
        launchArgs: execLaunchArgs.filter((arg) => arg !== "--strict-config"),
      }).pipe(Effect.map(codexMcpServersOff));
      const spawnCommand = yield* resolveSpawnCommand(
        binary,
        [
          "exec",
          ...execLaunchArgs,
          // A user's MCP server could act on the text-generation prompt.
          ...CODEX_NO_PLUGIN_ARGS,
          ...(mcpServersOff ? ["--config", mcpServersOff] : []),
          "--ephemeral",
          "--skip-git-repo-check",
          "-s",
          "read-only",
          "--model",
          model,
          "--config",
          `model_reasoning_effort="${reasoningEffort}"`,
          ...(serviceTier ? ["--config", `service_tier="${serviceTier}"`] : []),
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
          "-",
        ],
        { env: effectiveEnvironment },
      );
      const workingDirectory =
        operation === "generateOrganizationArchitectTurn" ||
        operation === "generateOrganizationPatchProposal"
          ? yield* fileSystem
              .makeTempDirectoryScoped({
                prefix:
                  operation === "generateOrganizationArchitectTurn"
                    ? "t3code-codex-architect-"
                    : "t3code-codex-org-patch-",
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new TextGenerationError({
                      operation,
                      detail: "Failed to create isolated generation directory.",
                      cause,
                    }),
                ),
              )
          : cwd;
      const observer =
        operation === "generateOrganizationPatchProposal"
          ? yield* OrganizationPatchProcessObserver
          : null;
      if (observer) yield* observer.preparing();
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: { ...env, ...observer?.environment },
        cwd: workingDirectory,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
        forceKillAfter: "1 second",
      });

      const [stdout, stderr, exitCode] = yield* Effect.acquireUseRelease(
        commandSpawner
          .spawn(command)
          .pipe(
            Effect.mapError((cause) =>
              normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process"),
            ),
          ),
        (handle) =>
          Effect.gen(function* () {
            if (observer) yield* observer.spawned(handle);
            return yield* Effect.all(
              [
                readStreamAsString(operation, handle.stdout),
                readStreamAsString(operation, handle.stderr),
                handle.exitCode.pipe(
                  Effect.mapError((cause) =>
                    normalizeCliError(
                      "codex",
                      operation,
                      cause,
                      "Failed to read Codex CLI exit code",
                    ),
                  ),
                ),
              ],
              { concurrency: "unbounded" },
            );
          }),
        (handle) =>
          Effect.gen(function* () {
            const running = yield* handle.isRunning;
            if (running) yield* handle.kill({ forceKillAfter: "2 seconds" });
            // A signal exit may have no successful numeric exit code, but the
            // handle must report that the exact spawned process has exited.
            yield* Effect.exit(handle.exitCode);
            if (yield* handle.isRunning)
              return yield* new TextGenerationError({
                operation,
                detail: "Codex CLI process exit could not be verified.",
              });
            if (observer) yield* observer.exited(handle);
          }).pipe(
            Effect.mapError((cause) =>
              isTextGenerationError(cause)
                ? cause
                : normalizeCliError("codex", operation, cause, "Failed to verify Codex CLI exit"),
            ),
          ),
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
        });
      }
    });

    const cleanup = Effect.all(
      [
        removeTempFileDir(schemaPath),
        removeTempFileDir(outputPath),
        ...cleanupPaths.map((filePath) => safeUnlink(filePath)),
      ],
      {
        concurrency: "unbounded",
      },
    ).pipe(Effect.asVoid);

    return yield* Effect.gen(function* () {
      yield* runCodexCommand().pipe(
        Effect.scoped,
        Effect.timeoutOption(
          operation === "generateOrganizationArchitectTurn" ||
            operation === "generateOrganizationPatchProposal"
            ? 60_000
            : (investigate?.timeoutMs ?? CODEX_TIMEOUT_MS),
        ),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));

      if (
        operation === "generateOrganizationArchitectTurn" ||
        operation === "generateOrganizationPatchProposal"
      ) {
        const info = yield* fileSystem.stat(outputPath).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "Failed to inspect Codex structured output.",
                cause,
              }),
          ),
        );
        if (
          info.size > (operation === "generateOrganizationArchitectTurn" ? 64_000n : 256n * 1024n)
        ) {
          return yield* new TextGenerationError({
            operation,
            detail: "Codex output exceeded the structured output size limit.",
          });
        }
      }
      return yield* fileSystem.readFileString(outputPath).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to read Codex output file.",
              cause,
            }),
        ),
        Effect.map((raw) =>
          operation === "generateOrganizationArchitectTurn"
            ? normalizeCodexArchitectOutputJson(raw)
            : raw,
        ),
        Effect.flatMap(decodeOutput),
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Codex returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(Effect.ensuring(cleanup));
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CodexTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runCodexJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("CodexTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runCodexJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("CodexTextGeneration.generateBranchName")(function* (input) {
      const { imagePaths } = yield* materializeImageAttachments(
        "generateBranchName",
        input.attachments,
      );
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        naming: input.naming,
      });

      const generated = yield* runCodexJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        imagePaths,
        modelSelection: input.modelSelection,
      });

      return {
        branch: formatGeneratedBranchName(generated.branch, input.naming),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CodexTextGeneration.generateThreadTitle")(function* (input) {
      const { imagePaths } = yield* materializeImageAttachments(
        "generateThreadTitle",
        input.attachments,
      );
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runCodexJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        imagePaths,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  const generateOrganizationArchitectTurn: NonNullable<
    TextGeneration.TextGeneration["Service"]["generateOrganizationArchitectTurn"]
  > = Effect.fn("CodexTextGeneration.generateOrganizationArchitectTurn")(function* (input) {
    const prompt = yield* buildOrganizationArchitectPrompt(input);
    const generated = yield* runCodexJson({
      operation: "generateOrganizationArchitectTurn",
      cwd: process.cwd(),
      prompt,
      outputSchemaJson: OrganizationArchitectTurnOutput,
      modelSelection: input.modelSelection,
    });
    return yield* validateOrganizationArchitectOutput(generated, input.organization.draftRevision);
  });

  const generateOrganizationPatchProposal: NonNullable<
    TextGeneration.TextGeneration["Service"]["generateOrganizationPatchProposal"]
  > = Effect.fn("CodexTextGeneration.generateOrganizationPatchProposal")(function* (input) {
    const prompt = yield* buildOrganizationPatchPrompt(input);
    const generated = yield* runCodexJson({
      operation: "generateOrganizationPatchProposal",
      cwd: process.cwd(),
      prompt,
      outputSchemaJson: OrganizationPatchProposalOutput,
      modelSelection: input.modelSelection,
    });
    return yield* validateOrganizationPatchProposal(generated, input);
  });

  return {
    generateReviewGuide: TextGenerationOperations.fromRunner("CodexTextGeneration", (request) =>
      runCodexJson({ ...request, outputSchemaJson: request.outputSchema }),
    ).generateReviewGuide,
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateOrganizationArchitectTurn,
    generateOrganizationPatchProposal,
  } satisfies TextGeneration.TextGeneration["Service"];
});
