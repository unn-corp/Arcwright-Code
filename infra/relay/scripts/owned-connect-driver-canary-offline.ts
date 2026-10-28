import { resolveSource, makeSourceContext } from "@alchemy.run/cloudflare/Workers";
import * as Artifacts from "alchemy/Artifacts";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeURL from "node:url";
import { CANARY_STACK, CANARY_STAGE, canaryWorkerProps } from "../src/ownedConnectDriverCanary.ts";

export class InvalidCanaryFixture extends Schema.TaggedError<InvalidCanaryFixture>()(
  "InvalidCanaryFixture",
  {},
) {}
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const buildDriverCanaryOffline = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkout = path.resolve(NodeURL.fileURLToPath(new URL("../../../..", import.meta.url)));
  if (
    !path.isAbsolute(directory) ||
    path.normalize(directory) !== directory ||
    directory === checkout ||
    directory.startsWith(`${checkout}/`) ||
    [
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_API_KEY",
      "CLOUDFLARE_EMAIL",
      "CLOUDFLARE_ACCESS_TOKEN",
      "ARCWRIGHT_CONNECT_DRIVER_CANARY_SECRET",
    ].some((key) => key in process.env)
  )
    return yield* new InvalidCanaryFixture();
  // Fixtures own their entire output root, which must already be private.
  const stat = yield* fs.stat(directory);
  if (
    stat.type !== "Directory" ||
    (stat.mode & 0o777) !== 0o700 ||
    Option.getOrUndefined(stat.uid) !== process.getuid?.() ||
    (yield* fs.realPath(directory)) !== directory
  )
    return yield* new InvalidCanaryFixture();
  const result = yield* Effect.gen(function* () {
    const source = yield* resolveSource(canaryWorkerProps);
    return yield* source.build(
      makeSourceContext({
        dotAlchemy: directory,
        id: "OwnedConnectDriverCanary",
        fqn: "OwnedConnectDriverCanary",
        workerName: canaryWorkerProps.name,
        props: canaryWorkerProps,
        compatibility: canaryWorkerProps.compatibility,
        stack: { name: CANARY_STACK, stage: CANARY_STAGE },
      }),
    );
  }).pipe(
    Effect.provideService(
      Artifacts.Artifacts,
      Artifacts.makeScopedArtifacts(Artifacts.createArtifactStore(), "OwnedConnectDriverCanary"),
    ),
    Effect.provideService(AlchemyContext, {
      dotAlchemy: directory,
      dev: false,
      adopt: false,
      updateStateStore: false,
    }),
    Effect.scoped,
  );
  if (!result.bundle || result.assets !== undefined) return yield* new InvalidCanaryFixture();
  const emitted = path.join(directory, "emitted");
  yield* fs.makeDirectory(emitted, { recursive: true, mode: 0o700 });
  for (const file of result.bundle.files) {
    if (path.isAbsolute(file.path) || file.path.split("/").includes(".."))
      return yield* new InvalidCanaryFixture();
    const destination = path.join(emitted, file.path);
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true, mode: 0o700 });
    yield* fs.writeFile(
      destination,
      typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content,
      { mode: 0o600 },
    );
  }
  const receipt = {
    bundleHash: result.bundle.hash,
    sourceHash: result.hash,
    entry: result.bundle.files[0].path,
    files: result.bundle.files.map((file) => ({ path: file.path, hash: file.hash })),
    compatibility: canaryWorkerProps.compatibility,
  };
  yield* fs.writeFileString(
    path.join(directory, "bundle-receipt.json"),
    yield* encodeReceipt(receipt),
    { mode: 0o600 },
  );
  return { bundle: result.bundle, directory: emitted, receipt };
});

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const directory =
    process.argv[2] === "--output" && process.argv.length === 4 ? process.argv[3] : undefined;
  if (!directory) throw new Error("Require --output /absolute/private/fixture-directory.");
  await Effect.runPromise(
    buildDriverCanaryOffline(directory).pipe(Effect.provide(NodeServices.layer)),
  );
}
