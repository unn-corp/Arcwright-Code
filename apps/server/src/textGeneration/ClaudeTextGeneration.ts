import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  OrganizationArchitectTurnOutput,
  OrganizationPatchProposalOutput,
  type ClaudeSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGeneration from "./TextGeneration.ts";
import { OrganizationPatchProcessObserver } from "./OrganizationPatchProcessObserver.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "@t3tools/provider-core/server/textGenerationPrompts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "@t3tools/provider-core/server/textGenerationUtils";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  getClaudeCatalogModelCapabilities,
  isClaudeCatalogUltracodeEffort,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "../provider/ClaudeModelCatalog.ts";
import {
  hasClaudeManagedMcpConfig,
  makeClaudeEnvironment,
} from "../provider/Drivers/ClaudeHome.ts";
import {
  buildOrganizationArchitectPrompt,
  validateOrganizationArchitectOutput,
} from "../organizations/OrganizationArchitectPrompt.ts";
import {
  buildOrganizationPatchPrompt,
  validateOrganizationPatchProposal,
} from "../organizations/OrganizationPatchPrompt.ts";

const CLAUDE_TIMEOUT_MS = 180_000;
const ARCHITECT_TIMEOUT_MS = 60_000;
const ARCHITECT_STDOUT_MAX_BYTES = 64_000;
const ARCHITECT_STDERR_MAX_BYTES = 8_000;
const PATCH_TIMEOUT_MS = 60_000;
const PATCH_STDOUT_MAX_BYTES = 256 * 1024;
const PATCH_STDERR_MAX_BYTES = 8_000;
const isTextGenerationError = Schema.is(TextGenerationError);
/** The tools an investigation can see. `--tools` takes bare names; patterns go in the allow list. */
const CLAUDE_INVESTIGATION_TOOLS = "Read,Grep,Glob,Bash";
/** What it may run without asking. In dontAsk mode every other call, Bash included, is refused. */
const CLAUDE_INVESTIGATION_ALLOWED = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
].join(",");
/**
 * The allowed git commands accept any trailing arguments, and `--output` makes each of them write
 * a file anywhere. Deny rules win over allow rules, so this keeps the investigation read-only.
 */
const CLAUDE_INVESTIGATION_DENIED = ["Bash(git * --output*)", "Bash(git * -o *)"].join(",");

const ClaudeOutputEnvelope = Schema.Struct({
  structured_output: Schema.Unknown,
});
const ClaudeOutputMessage = Schema.Struct({
  type: Schema.String,
  structured_output: Schema.optionalKey(Schema.Unknown),
});
const isClaudeOutputEnvelope = Schema.is(ClaudeOutputEnvelope);

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeOutput = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Union([ClaudeOutputEnvelope, Schema.Array(ClaudeOutputMessage)])),
);

const ClaudeErrorResult = Schema.Struct({ is_error: Schema.Literal(true), result: Schema.String });
const isClaudeErrorResult = Schema.is(ClaudeErrorResult);
const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * The error a failed `claude -p --output-format json` run reports on stdout. Stderr may only
 * hold notices from a wrapper around the binary, so the caller prefers this when present.
 */
function claudeErrorResult(stdout: string): string | undefined {
  const output = Option.getOrUndefined(decodeJsonOption(stdout));
  const messages: ReadonlyArray<unknown> = Array.isArray(output) ? output : [output];
  return messages
    .filter(isClaudeErrorResult)
    .map((message) => message.result.trim())
    .findLast((result) => result.length > 0);
}

export const makeClaudeTextGeneration = Effect.fn("makeClaudeTextGeneration")(function* (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  modelCatalog: Effect.Effect<ClaudeModelCatalog> = Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const scopedModelCatalog = modelCatalog.pipe(
    Effect.map((catalog) => scopeClaudeModelCatalog(catalog, claudeSettings.customModels)),
  );

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
    maxBytes?: number,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => ({ text: "", bytes: 0, exceeded: false }),
        (acc, chunk) => {
          if (acc.exceeded) return acc;
          const bytes = Buffer.byteLength(chunk, "utf8");
          if (maxBytes !== undefined && acc.bytes + bytes > maxBytes) {
            return { ...acc, exceeded: true };
          }
          return { text: acc.text + chunk, bytes: acc.bytes + bytes, exceeded: false };
        },
      ),
      Effect.flatMap((output) =>
        output.exceeded
          ? Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Claude CLI output exceeded the structured output size limit.",
              }),
            )
          : Effect.succeed(output.text),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : normalizeCliError("claude", operation, cause, "Failed to collect process output"),
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
    detail: string,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail,
            cause,
          }),
      ),
    );

  const runClaudeJson = Effect.fn("runClaudeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
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
    modelSelection: ModelSelection;
    investigate?: { readonly timeoutMs: number } | undefined;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const catalog = yield* scopedModelCatalog;
    const resolvedModelSelection = {
      ...modelSelection,
      model: resolveClaudeModelSlug(catalog, modelSelection.model),
    };
    const jsonSchemaStr = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
      "Failed to encode structured output schema.",
    );
    const caps = getClaudeCatalogModelCapabilities(catalog, resolvedModelSelection.model);
    const descriptors = getProviderOptionDescriptors({
      caps,
      selections: resolvedModelSelection.options,
    });
    const findDescriptor = (id: string) => descriptors.find((descriptor) => descriptor.id === id);
    const rawEffortSelection = getModelSelectionStringOptionValue(resolvedModelSelection, "effort");
    const resolvedEffort = resolveClaudeCatalogEffort(
      catalog,
      resolvedModelSelection.model,
      rawEffortSelection,
    );
    const cliEffort = normalizeClaudeCatalogEffort(
      catalog,
      resolvedEffort,
      resolvedModelSelection.model,
    );
    const ultracode = isClaudeCatalogUltracodeEffort(resolvedEffort);
    const thinkingDescriptor = findDescriptor("thinking");
    const fastModeDescriptor = findDescriptor("fastMode");
    // Only a chosen value; otherwise Claude Code's own default applies, as in chat turns.
    const thinking =
      thinkingDescriptor?.type === "boolean"
        ? getModelSelectionBooleanOptionValue(resolvedModelSelection, "thinking")
        : undefined;
    const fastMode =
      fastModeDescriptor?.type === "boolean" ? fastModeDescriptor.currentValue : undefined;
    const settings = {
      disableAllHooks: true,
      ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
      ...(fastMode ? { fastMode: true } : {}),
      ...(ultracode ? { ultracode: true } : {}),
    };
    const settingsJson = yield* encodeJsonForOperation(
      operation,
      settings,
      "Failed to encode Claude CLI settings.",
    );

    const runClaudeCommand = Effect.fn("runClaudeJson.runClaudeCommand")(function* () {
      // Titles and Architect turns need only the supplied prompt, never checkout context.
      const workingDirectory =
        operation === "generateThreadTitle" ||
        operation === "generateOrganizationArchitectTurn" ||
        operation === "generateOrganizationPatchProposal"
          ? yield* fileSystem
              .makeTempDirectoryScoped({
                prefix:
                  operation === "generateThreadTitle"
                    ? "t3code-claude-title-"
                    : operation === "generateOrganizationArchitectTurn"
                      ? "t3code-claude-architect-"
                      : "t3code-claude-org-patch-",
              })
              .pipe(
                Effect.mapError((cause) =>
                  normalizeCliError(
                    "claude",
                    operation,
                    cause,
                    "Failed to create isolated generation directory",
                  ),
                ),
              )
          : cwd;
      const managedMcpConfig = yield* hasClaudeManagedMcpConfig();
      const spawnCommand = yield* resolveSpawnCommand(
        claudeSettings.binaryPath || "claude",
        [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          jsonSchemaStr,
          "--model",
          resolveClaudeCatalogApiModelId(catalog, resolvedModelSelection),
          ...(cliEffort ? ["--effort", cliEffort] : []),
          "--settings",
          settingsJson,
          ...(investigate
            ? [
                "--tools",
                CLAUDE_INVESTIGATION_TOOLS,
                "--allowedTools",
                CLAUDE_INVESTIGATION_ALLOWED,
                "--disallowedTools",
                CLAUDE_INVESTIGATION_DENIED,
              ]
            : ["--tools", ""]),
          "--disable-slash-commands",
          // Claude refuses this flag next to a managed-mcp.json, which already keeps the
          // user's own MCP servers out.
          ...(managedMcpConfig ? [] : ["--strict-mcp-config"]),
          "--permission-mode",
          "dontAsk",
        ],
        { env: claudeEnvironment },
      );
      const observer =
        operation === "generateOrganizationPatchProposal"
          ? yield* OrganizationPatchProcessObserver
          : null;
      if (observer) yield* observer.preparing();
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: { ...claudeEnvironment, ...observer?.environment },
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
              normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process"),
            ),
          ),
        (child) =>
          Effect.gen(function* () {
            if (observer) yield* observer.spawned(child);
            return yield* Effect.all(
              [
                readStreamAsString(
                  operation,
                  child.stdout,
                  operation === "generateOrganizationArchitectTurn"
                    ? ARCHITECT_STDOUT_MAX_BYTES
                    : operation === "generateOrganizationPatchProposal"
                      ? PATCH_STDOUT_MAX_BYTES
                      : undefined,
                ),
                readStreamAsString(
                  operation,
                  child.stderr,
                  operation === "generateOrganizationArchitectTurn"
                    ? ARCHITECT_STDERR_MAX_BYTES
                    : operation === "generateOrganizationPatchProposal"
                      ? PATCH_STDERR_MAX_BYTES
                      : undefined,
                ),
                child.exitCode.pipe(
                  Effect.mapError((cause) =>
                    normalizeCliError(
                      "claude",
                      operation,
                      cause,
                      "Failed to read Claude CLI exit code",
                    ),
                  ),
                ),
              ],
              { concurrency: "unbounded" },
            );
          }),
        (child) =>
          Effect.gen(function* () {
            if (yield* child.isRunning) yield* child.kill({ forceKillAfter: "2 seconds" });
            yield* Effect.exit(child.exitCode);
            if (yield* child.isRunning)
              return yield* new TextGenerationError({
                operation,
                detail: "Claude CLI process exit could not be verified.",
              });
            if (observer) yield* observer.exited(child);
          }).pipe(
            Effect.mapError((cause) =>
              Schema.is(TextGenerationError)(cause)
                ? cause
                : normalizeCliError("claude", operation, cause, "Failed to verify Claude CLI exit"),
            ),
          ),
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail =
          claudeErrorResult(stdoutDetail) ??
          (stderrDetail.length > 0 ? stderrDetail : stdoutDetail);
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Claude CLI command failed: ${detail}`
              : `Claude CLI command failed with code ${exitCode}.`,
        });
      }

      return stdout;
    });

    const rawStdout = yield* runClaudeCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(
        operation === "generateOrganizationArchitectTurn"
          ? ARCHITECT_TIMEOUT_MS
          : operation === "generateOrganizationPatchProposal"
            ? PATCH_TIMEOUT_MS
            : (investigate?.timeoutMs ?? CLAUDE_TIMEOUT_MS),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const output = yield* decodeClaudeOutput(rawStdout).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude CLI returned unexpected output format.",
              cause,
            }),
          ),
      }),
    );
    const envelope = isClaudeOutputEnvelope(output)
      ? output
      : output.findLast((message) => message.type === "result");

    const decodeOutput = Schema.decodeEffect(outputSchemaJson);
    return yield* decodeOutput(envelope?.structured_output).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  // TextGeneration service methods

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("ClaudeTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runClaudeJson({
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
    Effect.fn("ClaudeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runClaudeJson({
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
    Effect.fn("ClaudeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        naming: input.naming,
      });

      const generated = yield* runClaudeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: formatGeneratedBranchName(generated.branch, input.naming),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("ClaudeTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runClaudeJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    });

  const generateOrganizationArchitectTurn: NonNullable<
    TextGeneration.TextGeneration["Service"]["generateOrganizationArchitectTurn"]
  > = Effect.fn("ClaudeTextGeneration.generateOrganizationArchitectTurn")(function* (input) {
    const prompt = yield* buildOrganizationArchitectPrompt(input);
    const generated = yield* runClaudeJson({
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
  > = Effect.fn("ClaudeTextGeneration.generateOrganizationPatchProposal")(function* (input) {
    const prompt = yield* buildOrganizationPatchPrompt(input);
    const generated = yield* runClaudeJson({
      operation: "generateOrganizationPatchProposal",
      cwd: process.cwd(),
      prompt,
      outputSchemaJson: OrganizationPatchProposalOutput,
      modelSelection: input.modelSelection,
    });
    return yield* validateOrganizationPatchProposal(generated, input);
  });

  return {
    generateReviewGuide: TextGenerationOperations.fromRunner("ClaudeTextGeneration", (request) =>
      runClaudeJson({ ...request, outputSchemaJson: request.outputSchema }),
    ).generateReviewGuide,
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateOrganizationArchitectTurn,
    generateOrganizationPatchProposal,
  } satisfies TextGeneration.TextGeneration["Service"];
});
