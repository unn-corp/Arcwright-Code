import type { OrganizationPatchProposalInput } from "@t3tools/contracts";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";

export type { OrganizationArchitectTurnInput } from "@t3tools/provider-core/server/textGeneration";

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateOrganizationArchitectTurn"
  | "generateOrganizationPatchProposal"
  | "generateReviewGuide";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  return TextGeneration.of({
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return resolveInstance(
        registry,
        "generateCommitMessage",
        input.modelSelection.instanceId,
      ).pipe(Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)));
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
      );
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return resolveInstance(registry, "generateReviewGuide", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateReviewGuide(input)),
      );
    }),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* textGeneration.generateThreadTitle({ ...input, linkedContext });
          }),
        ),
      );
    }),
    generateOrganizationArchitectTurn: Effect.fn(
      "TextGeneration.generateOrganizationArchitectTurn",
    )((input) =>
      registry.getInstance(input.modelSelection.instanceId).pipe(
        Effect.flatMap((instance) =>
          instance === undefined
            ? Effect.fail(
                new TextGenerationError({
                  operation: "generateOrganizationArchitectTurn",
                  detail: `No provider instance registered for id '${input.modelSelection.instanceId}'.`,
                }),
              )
            : !instance.enabled
              ? Effect.fail(
                  new TextGenerationError({
                    operation: "generateOrganizationArchitectTurn",
                    detail: `Provider instance '${input.modelSelection.instanceId}' is disabled.`,
                  }),
                )
              : instance.textGeneration.generateOrganizationArchitectTurn
                ? instance.textGeneration.generateOrganizationArchitectTurn(input)
                : Effect.fail(
                    new TextGenerationError({
                      operation: "generateOrganizationArchitectTurn",
                      detail: `Provider instance '${input.modelSelection.instanceId}' does not support tool-free Organization Architect generation.`,
                    }),
                  ),
        ),
      ),
    ),
    generateOrganizationPatchProposal: Effect.fn(
      "TextGeneration.generateOrganizationPatchProposal",
    )((input) =>
      registry.getInstance(input.modelSelection.instanceId).pipe(
        Effect.flatMap((instance) =>
          instance === undefined
            ? Effect.fail(
                new TextGenerationError({
                  operation: "generateOrganizationPatchProposal",
                  detail: `No provider instance registered for id '${input.modelSelection.instanceId}'.`,
                }),
              )
            : !instance.enabled
              ? Effect.fail(
                  new TextGenerationError({
                    operation: "generateOrganizationPatchProposal",
                    detail: `Provider instance '${input.modelSelection.instanceId}' is disabled.`,
                  }),
                )
              : instance.textGeneration.generateOrganizationPatchProposal
                ? instance.textGeneration.generateOrganizationPatchProposal(input)
                : Effect.fail(
                    new TextGenerationError({
                      operation: "generateOrganizationPatchProposal",
                      detail: `Provider instance '${input.modelSelection.instanceId}' does not support tool-free Organization patch proposals.`,
                    }),
                  ),
        ),
      ),
    ),
  });
});

/** A required facade for the optional per-provider patch proposal method. */
export const generateOrganizationPatchProposal = (input: OrganizationPatchProposalInput) =>
  Effect.flatMap(TextGeneration, (service) =>
    service.generateOrganizationPatchProposal
      ? service.generateOrganizationPatchProposal(input)
      : Effect.fail(
          new TextGenerationError({
            operation: "generateOrganizationPatchProposal",
            detail: "Organization patch proposal generation is unavailable.",
          }),
        ),
  );

export const layer = Layer.effect(TextGeneration, make);
