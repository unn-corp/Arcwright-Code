import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import { TextGenerationError } from "@t3tools/contracts";
import type { GrokSettings } from "../settings.ts";
import { OrganizationArchitectTurnOutput } from "@t3tools/contracts";
import {
  buildOrganizationArchitectPrompt,
  validateOrganizationArchitectOutput,
} from "@t3tools/provider-core/server/OrganizationArchitectPrompt";
import type * as TextGeneration from "@t3tools/provider-core/server/textGeneration";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  currentGrokReasoningEffortFromSessionSetup,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "./acpSupport.ts";
import { denyArchitectAcpTools } from "./organizationTools.ts";

const GROK_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeGrokTextGeneration = Effect.fn("makeGrokTextGeneration")(function* (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;

  const runGrokJson: TextGenerationOperations.Runner<
    TextGenerationOperations.Operation | "generateOrganizationArchitectTurn"
  > = Effect.fn("GrokTextGeneration.runGrokJson")(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;

      const resolvedModel = resolveGrokAcpBaseModelId(modelSelection.model);
      const outputRef = yield* Ref.make("");
      let toolAttempted = false;
      const outputExceeded = yield* Ref.make(false);
      const workingDirectory =
        operation === "generateOrganizationArchitectTurn"
          ? yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-grok-architect-" }).pipe(
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({
                    operation,
                    detail: "Failed to create isolated Architect directory.",
                    cause,
                  }),
              ),
            )
          : cwd;
      const runtime = yield* makeGrokAcpRuntime({
        grokSettings,
        environment,
        cwd: workingDirectory,
        alwaysApprove: operation !== "generateOrganizationArchitectTurn",
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
        // Observe forbidden tool activity synchronously during decoding, before a
        // protocol completion can wake the isolated generation's prompt waiter.
        transformSessionUpdate: (notification) => {
          const update = notification.update;
          if (
            operation === "generateOrganizationArchitectTurn" &&
            (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
          ) {
            toolAttempted = true;
          }
          return notification;
        },
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
      );

      if (operation === "generateOrganizationArchitectTurn") {
        yield* denyArchitectAcpTools(runtime);
      }

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (
          operation === "generateOrganizationArchitectTurn" &&
          (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
        ) {
          return Effect.void;
        }
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.modify(outputRef, (current) => {
          if (
            operation === "generateOrganizationArchitectTurn" &&
            Buffer.byteLength(current, "utf8") + Buffer.byteLength(content.text, "utf8") > 64_000
          ) {
            return [true, current] as const;
          }
          return [false, current + content.text] as const;
        }).pipe(
          Effect.flatMap((exceeded) => (exceeded ? Ref.set(outputExceeded, true) : Effect.void)),
        );
      });

      const promptResult = yield* Effect.gen(function* () {
        const started = yield* runtime.start();
        const requestedReasoningEffort = getModelSelectionStringOptionValue(
          modelSelection,
          "reasoningEffort",
        );
        yield* applyGrokAcpModelSelection({
          runtime,
          currentModelId: currentGrokModelIdFromSessionSetup(started.sessionSetupResult),
          currentReasoningEffort: currentGrokReasoningEffortFromSessionSetup(
            started.sessionSetupResult,
          ),
          requestedModelId: resolvedModel,
          requestedReasoningEffort,
          mapError: (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to set Grok ACP base model for text generation.",
              cause,
            }),
        });

        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(
          operation === "generateOrganizationArchitectTurn" ? 60_000 : GROK_TIMEOUT_MS,
        ),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Grok ACP request timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Grok ACP request failed.",
                cause,
              }),
        ),
      );

      if (toolAttempted) {
        return yield* new TextGenerationError({
          operation,
          detail: "Grok attempted tool work during Architect generation.",
        });
      }
      if (yield* Ref.get(outputExceeded)) {
        return yield* new TextGenerationError({
          operation,
          detail: "Grok Architect output exceeded the structured output size limit.",
        });
      }

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Grok ACP request was cancelled."
              : "Grok Agent returned empty output.",
        });
      }

      return yield* TextGenerationOperations.decodeJsonReply(request, "Grok Agent", trimmed);
    },
    (effect, request) => {
      const { operation } = request;
      return effect.pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Grok ACP text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      );
    },
  );

  const generateOrganizationArchitectTurn: NonNullable<
    TextGeneration.ProviderTextGeneration["generateOrganizationArchitectTurn"]
  > = Effect.fn("GrokTextGeneration.generateOrganizationArchitectTurn")(function* (input) {
    const prompt = yield* buildOrganizationArchitectPrompt(input);
    const generated = yield* runGrokJson({
      operation: "generateOrganizationArchitectTurn",
      cwd: process.cwd(),
      prompt,
      outputSchema: OrganizationArchitectTurnOutput,
      modelSelection: input.modelSelection,
    });
    return yield* validateOrganizationArchitectOutput(generated, input.organization.draftRevision);
  });

  return {
    ...TextGenerationOperations.fromRunner(
      "GrokTextGeneration",
      TextGenerationOperations.withoutInvestigation("GrokTextGeneration", (request) =>
        runGrokJson(request),
      ),
    ),
    generateOrganizationArchitectTurn,
  };
});
