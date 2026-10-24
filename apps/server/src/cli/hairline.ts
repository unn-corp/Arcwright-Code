import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { installHairline } from "../skills/hairline/install.ts";

class HairlineInstallError extends Schema.TaggedError<HairlineInstallError>()(
  "HairlineInstallError",
  {
    reason: Schema.String,
  },
) {
  override get message() {
    return this.reason;
  }
}

export const hairlineCommand = Command.make("hairline", {
  workspace: Flag.String("workspace").pipe(
    Flag.withDescription("Existing Git workspace on this environment"),
  ),
  provider: Flag.String("provider").pipe(
    Flag.withDescription("Native project skill location: codex or claude"),
  ),
}).pipe(
  Command.withDescription(
    "Explicitly add the bundled Hairline skill to one workspace; never overwrite existing skills",
  ),
  Command.withHandler(({ workspace, provider }) =>
    Effect.try({
      try: () => installHairline(workspace, provider),
      catch: (error) =>
        new HairlineInstallError({
          reason: error instanceof Error ? error.message : "Hairline installation failed",
        }),
    }).pipe(
      Effect.flatMap((target) =>
        Console.log(
          `Hairline installed at ${target}. Restart agent context, then explicitly invoke $hairline-create. Native disable settings still apply. Preview unavailable.`,
        ),
      ),
    ),
  ),
);
