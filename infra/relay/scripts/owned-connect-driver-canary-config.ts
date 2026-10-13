import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  APPROVED_ACCOUNT_ID,
  APPROVED_HYPERDRIVE_ID,
  CANARY_STAGE,
  canaryWorkerProps,
} from "../src/ownedConnectDriverCanary.ts";

export class InvalidDriverCanaryConfig extends Schema.TaggedError<InvalidDriverCanaryConfig>()(
  "InvalidDriverCanaryConfig",
  {},
) {}
const decodePublicJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

export const readDriverCanaryConfig = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const invalid = () => Effect.fail(new InvalidDriverCanaryConfig());
  if (!path.isAbsolute(file) || (yield* fs.realPath(file)) !== file) return yield* invalid();
  const stat = yield* fs.stat(file);
  if (stat.type !== "File" || stat.size > 8192n) return yield* invalid();
  const contents = yield* fs.readFileString(file);
  if (new TextEncoder().encode(contents).length > 8192) return yield* invalid();
  const value = yield* decodePublicJson(contents).pipe(
    Effect.mapError(() => new InvalidDriverCanaryConfig()),
  );
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).sort().join(",") !==
      "accountId,hyperdriveId,privateStateRoot,stage,workerName" ||
    !("accountId" in value) ||
    !("hyperdriveId" in value) ||
    !("workerName" in value) ||
    !("stage" in value) ||
    !("privateStateRoot" in value) ||
    value.accountId !== APPROVED_ACCOUNT_ID ||
    value.hyperdriveId !== APPROVED_HYPERDRIVE_ID ||
    value.workerName !== canaryWorkerProps.name ||
    value.stage !== CANARY_STAGE ||
    typeof value.privateStateRoot !== "string"
  )
    return yield* invalid();
  const root = value.privateStateRoot;
  if (
    !path.isAbsolute(root) ||
    path.normalize(root) !== root ||
    [...root].some((char) => char.charCodeAt(0) < 32) ||
    root.length > 4096 ||
    path.basename(root) !== "alchemy" ||
    path.basename(path.dirname(root)) !== "driver-canary"
  )
    return yield* invalid();
  let component = root;
  while (component !== path.dirname(component)) {
    if (yield* fs.exists(component)) {
      const directory = yield* fs.stat(component);
      if (directory.type !== "Directory" || (yield* fs.realPath(component)) !== component)
        return yield* invalid();
    }
    component = path.dirname(component);
  }
  if (yield* fs.exists(root)) {
    const directory = yield* fs.stat(root);
    if (
      (directory.mode & 0o777) !== 0o700 ||
      Option.getOrUndefined(directory.uid) !== process.getuid?.()
    )
      return yield* invalid();
  }
  return {
    accountId: value.accountId,
    hyperdriveId: value.hyperdriveId,
    workerName: value.workerName,
    stage: value.stage,
    privateStateRoot: root,
  };
});

export type DriverCanaryConfig = Effect.Success<ReturnType<typeof readDriverCanaryConfig>>;

export const assertDriverCanaryOperatorContext = Effect.fnUntraced(function* (
  config: DriverCanaryConfig,
  stage: string,
) {
  const path = yield* Path.Path;
  if (
    path.resolve(process.cwd()) !== config.privateStateRoot ||
    stage !== config.stage ||
    process.env.CLOUDFLARE_ACCOUNT_ID !== config.accountId ||
    process.env.CI !== "true" ||
    !process.env.CLOUDFLARE_API_TOKEN ||
    !process.env.ARCWRIGHT_CONNECT_DRIVER_CANARY_SECRET
  )
    return yield* new InvalidDriverCanaryConfig();
});
