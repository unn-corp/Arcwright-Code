import type { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { NonNegativeInt, TextGenerationError } from "@t3tools/contracts";
import type { OpenCodeSettings } from "../settings.ts";
import { OrganizationArchitectTurnOutput, type ModelSelection } from "@t3tools/contracts";
import {
  buildOrganizationArchitectPrompt,
  validateOrganizationArchitectOutput,
} from "@t3tools/provider-core/server/OrganizationArchitectPrompt";
import type * as TextGeneration from "@t3tools/provider-core/server/textGeneration";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";

const OpenCodeTextGenerationOperation = Schema.Literals([
  "generateCommitMessage",
  "generatePrContent",
  "generateBranchName",
  "generateThreadTitle",
  "generateOrganizationArchitectTurn",
  "generateReviewGuide",
]);
const ARCHITECT_TIMEOUT_MS = 60_000;

type OpenCodeTextGenerationOperation = typeof OpenCodeTextGenerationOperation.Type;

const openCodeTextGenerationErrorContext = {
  operation: OpenCodeTextGenerationOperation,
  cwd: Schema.String,
};

export class OpenCodeTextGenerationSessionRequestError extends Schema.TaggedError<OpenCodeTextGenerationSessionRequestError>()(
  "OpenCodeTextGenerationSessionRequestError",
  {
    ...openCodeTextGenerationErrorContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode session creation request failed for ${this.operation} in ${this.cwd}.`;
  }
}

export class OpenCodeTextGenerationSessionPayloadError extends Schema.TaggedError<OpenCodeTextGenerationSessionPayloadError>()(
  "OpenCodeTextGenerationSessionPayloadError",
  openCodeTextGenerationErrorContext,
) {
  override get message(): string {
    return `OpenCode session.create returned no session payload for ${this.operation} in ${this.cwd}.`;
  }
}

const openCodePromptErrorContext = {
  ...openCodeTextGenerationErrorContext,
  sessionId: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
};

export class OpenCodeTextGenerationPromptRequestError extends Schema.TaggedError<OpenCodeTextGenerationPromptRequestError>()(
  "OpenCodeTextGenerationPromptRequestError",
  {
    ...openCodePromptErrorContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode prompt request failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}).`;
  }
}

export class OpenCodeTextGenerationPromptResponseError extends Schema.TaggedError<OpenCodeTextGenerationPromptResponseError>()(
  "OpenCodeTextGenerationPromptResponseError",
  {
    ...openCodePromptErrorContext,
    providerErrorName: Schema.optional(Schema.String),
    providerMessage: Schema.String,
  },
) {
  override get message(): string {
    const providerError = this.providerErrorName ? ` ${this.providerErrorName}` : "";
    return `OpenCode prompt${providerError} failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}): ${this.providerMessage}`;
  }
}

export class OpenCodeTextGenerationEmptyOutputError extends Schema.TaggedError<OpenCodeTextGenerationEmptyOutputError>()(
  "OpenCodeTextGenerationEmptyOutputError",
  {
    ...openCodePromptErrorContext,
    responsePartCount: NonNegativeInt,
    textPartCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return `OpenCode returned empty output for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}, ${this.responsePartCount} response parts, ${this.textPartCount} text parts).`;
  }
}

interface OpenCodePromptFailure {
  readonly name?: string;
  readonly message: string;
}

interface OpenCodeTextPart {
  readonly type: "text";
  readonly text: string;
}

function getOpenCodePromptFailure(error: unknown): OpenCodePromptFailure | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const name =
    "name" in error && typeof error.name === "string" && error.name.trim().length > 0
      ? error.name.trim()
      : undefined;
  const message =
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string"
      ? error.data.message.trim()
      : "";
  if (message.length > 0) {
    return {
      ...(name ? { name } : {}),
      message,
    };
  }

  if (name) {
    return { name, message: name };
  }

  return null;
}

function isOpenCodeTextPart(part: unknown): part is OpenCodeTextPart {
  return (
    part !== null &&
    typeof part === "object" &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

function getOpenCodeTextResponse(parts: ReadonlyArray<unknown> | undefined): string {
  return (parts ?? [])
    .filter(isOpenCodeTextPart)
    .map((part) => part.text)
    .join("")
    .trim();
}

export const makeOpenCodeTextGeneration = Effect.fn("makeOpenCodeTextGeneration")(function* (
  openCodeSettings: OpenCodeSettings,
) {
  const host = yield* ProviderHost.ProviderHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const serverOwner = yield* OpenCodeServerOwner.OpenCodeServerOwner;

  const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>(input: {
    readonly operation: OpenCodeTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }) {
    const parsedModel = OpenCodeRuntime.parseOpenCodeModelSlug(input.modelSelection.model);
    if (!parsedModel) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode model selection must use the 'provider/model' format.",
      });
    }

    const fileParts = OpenCodeRuntime.toOpenCodeFileParts({
      attachments: input.attachments?.filter((attachment) => attachment.type === "image"),
      resolveAttachmentPath: host.resolveAttachmentPath,
    });

    const runAgainstServer = Effect.fn("runOpenCodeJson.runAgainstServer")(
      function* (
        server: Pick<
          OpenCodeRuntime.OpenCodeServerConnection,
          "url" | "serverPassword" | "version"
        >,
      ) {
        const client = openCodeRuntime.createOpenCodeSdkClient({
          baseUrl: server.url,
          directory: input.cwd,
          ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
        });
        const session = yield* Effect.tryPromise({
          try: (signal) =>
            client.session.create(
              {
                title: `Arcwright Code ${input.operation}`,
                permission: [{ permission: "*", pattern: "*", action: "deny" }],
              },
              { signal },
            ),
          catch: (cause) =>
            new OpenCodeTextGenerationSessionRequestError({
              operation: input.operation,
              cwd: input.cwd,
              cause,
            }),
        });
        if (!session.data) {
          return yield* new OpenCodeTextGenerationSessionPayloadError({
            operation: input.operation,
            cwd: input.cwd,
          });
        }
        const selectedAgent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
        const selectedVariant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
        const promptContext = {
          operation: input.operation,
          cwd: input.cwd,
          sessionId: session.data.id,
          providerId: parsedModel.providerID,
          modelId: parsedModel.modelID,
        };

        const result = yield* Effect.tryPromise({
          try: (signal) =>
            client.session.prompt(
              {
                sessionID: session.data.id,
                model: parsedModel,
                ...(selectedAgent ? { agent: selectedAgent } : {}),
                ...(selectedVariant ? { variant: selectedVariant } : {}),
                parts: [{ type: "text", text: input.prompt }, ...fileParts],
              },
              { signal },
            ),
          catch: (cause) =>
            new OpenCodeTextGenerationPromptRequestError({
              ...promptContext,
              cause,
            }),
        }).pipe(
          // Disconnecting the HTTP request does not stop work in a shared or external server.
          Effect.onInterrupt(() =>
            OpenCodeRuntime.runOpenCodeSdk("session.abort", (signal) =>
              client.session.abort({ sessionID: session.data.id }, { signal }),
            ).pipe(
              Effect.interruptible,
              Effect.timeout("10 seconds"),
              Effect.catch(() =>
                Effect.logWarning(
                  "Failed to stop cancelled OpenCode text generation.",
                  promptContext,
                ),
              ),
              Effect.asVoid,
            ),
          ),
        );
        const promptFailure = getOpenCodePromptFailure(result.data?.info?.error);
        if (promptFailure) {
          return yield* new OpenCodeTextGenerationPromptResponseError({
            ...promptContext,
            ...(promptFailure.name ? { providerErrorName: promptFailure.name } : {}),
            providerMessage: promptFailure.message,
          });
        }
        const responseParts = result.data?.parts ?? [];
        const rawText = getOpenCodeTextResponse(responseParts);
        if (rawText.length === 0) {
          return yield* new OpenCodeTextGenerationEmptyOutputError({
            ...promptContext,
            responsePartCount: responseParts.length,
            textPartCount: responseParts.filter(isOpenCodeTextPart).length,
          });
        }
        return rawText;
      },
      Effect.catchTags({
        OpenCodeTextGenerationSessionRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.create request failed.",
              cause,
            }),
          ),
        OpenCodeTextGenerationSessionPayloadError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.create returned no session payload.",
              cause,
            }),
          ),
        OpenCodeTextGenerationPromptRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.prompt request failed.",
              cause,
            }),
          ),
        OpenCodeTextGenerationPromptResponseError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: cause.providerMessage,
              cause,
            }),
          ),
        OpenCodeTextGenerationEmptyOutputError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode returned empty output.",
              cause,
            }),
          ),
      }),
    );

    const serverOutput =
      openCodeSettings.serverUrl.length > 0
        ? openCodeRuntime
            .connectToOpenCodeServer({
              binaryPath: openCodeSettings.binaryPath,
              directory: input.cwd,
              serverUrl: openCodeSettings.serverUrl,
              ...(openCodeSettings.serverPassword
                ? { serverPassword: openCodeSettings.serverPassword }
                : {}),
            })
            .pipe(Effect.flatMap(runAgainstServer), Effect.scoped)
        : serverOwner.withServer(runAgainstServer);
    const boundedOutput =
      input.operation === "generateOrganizationArchitectTurn"
        ? serverOutput.pipe(
            Effect.timeoutOption(ARCHITECT_TIMEOUT_MS),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new TextGenerationError({
                      operation: input.operation,
                      detail: "OpenCode Architect request timed out.",
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          )
        : serverOutput;
    const rawOutput = yield* boundedOutput.pipe(
      Effect.catchTags({
        OpenCodeRuntimeError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: OpenCodeRuntime.openCodeRuntimeErrorDetail(cause),
              cause,
            }),
          ),
      }),
    );

    if (
      input.operation === "generateOrganizationArchitectTurn" &&
      Buffer.byteLength(rawOutput, "utf8") > 64_000
    ) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode Architect output exceeded the structured output size limit.",
      });
    }

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
    return yield* decodeOutput(extractJsonObject(rawOutput)).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: "OpenCode returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  return makeOpenCodeOperations(runOpenCodeJson, fileSystem);
});

/** Runs one prompt and decodes its reply as `outputSchemaJson`, for either OpenCode runtime. */
export type OpenCodeJsonRunner = <S extends Schema.Top>(input: {
  readonly operation: OpenCodeTextGenerationOperation;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchemaJson: S;
  readonly modelSelection: ModelSelection;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
}) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

/** The four text generation operations over an OpenCode prompt runner. */
export function makeOpenCodeOperations(
  runOpenCodeJson: OpenCodeJsonRunner,
  fileSystem: FileSystem.FileSystem,
): TextGeneration.ProviderTextGeneration & {
  readonly generateOrganizationArchitectTurn: NonNullable<
    TextGeneration.ProviderTextGeneration["generateOrganizationArchitectTurn"]
  >;
} {
  const generateOrganizationArchitectTurn: NonNullable<
    TextGeneration.ProviderTextGeneration["generateOrganizationArchitectTurn"]
  > = Effect.fn("OpenCodeTextGeneration.generateOrganizationArchitectTurn")(function* (input) {
    const prompt = yield* buildOrganizationArchitectPrompt(input);
    const generated = yield* Effect.gen(function* () {
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3code-opencode-architect-" })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: "generateOrganizationArchitectTurn",
                detail: "Failed to create isolated Architect directory.",
                cause,
              }),
          ),
        );
      return yield* runOpenCodeJson({
        operation: "generateOrganizationArchitectTurn",
        cwd,
        prompt,
        outputSchemaJson: OrganizationArchitectTurnOutput,
        modelSelection: input.modelSelection,
      });
    }).pipe(Effect.scoped);
    return yield* validateOrganizationArchitectOutput(generated, input.organization.draftRevision);
  });

  return {
    ...TextGenerationOperations.fromRunner(
      "OpenCodeTextGeneration",
      TextGenerationOperations.withoutInvestigation("OpenCode", (request) =>
        runOpenCodeJson({ ...request, outputSchemaJson: request.outputSchema }),
      ),
    ),
    generateOrganizationArchitectTurn,
  } satisfies TextGeneration.ProviderTextGeneration;
}
