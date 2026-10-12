import { ProjectReadFileError } from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";

const isReadError = Schema.is(ProjectReadFileError);

/** Only a confirmed unsupported binary file falls back; read/permission failures remain in the panel. */
export async function openChatFile(input: {
  readonly read: () => Promise<AtomCommandResult<unknown, unknown>>;
  readonly openDefaultApp: () => Promise<AtomCommandResult<unknown, unknown>>;
  readonly preview: () => void;
  readonly isCurrent: () => boolean;
}): Promise<AtomCommandResult<unknown, unknown> | undefined> {
  const result = await input.read();
  if (!input.isCurrent()) return;
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    if (isReadError(error) && error.failure === "binary_file") return input.openDefaultApp();
  }
  input.preview();
}
