// @effect-diagnostics nodeBuiltinImport:off - Deploy bootstrap validates private external storage before constructing an Effect stack.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { readBoundedJson, jsonObject } from "../../../scripts/lib/owned-connect-web-content.ts";
import { loadRepoEnv, connectProfileReceipt } from "../../../scripts/lib/public-config.ts";
import { assertExternalPath } from "./owned-connect-web-artifact.ts";

export function readOwnedWebDeployConfig(file: string) {
  const config = jsonObject(readBoundedJson(file, 16 * 1024).value);
  function text(value: unknown) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 4096 ||
      [...value].some((char) => char.charCodeAt(0) < 32)
    )
      throw new Error("Invalid owned hosted deploy configuration field.");
    return value;
  }
  const accountId = text(config.accountId);
  const zoneId = text(config.zoneId);
  const hostname = text(config.hostname);
  const stage = text(config.stage);
  const privateStateRoot = text(config.privateStateRoot);
  const artifactReceipt = text(config.artifactReceipt);
  const profileFile = text(config.profileFile);
  if (
    Object.keys(config).sort().join(",") !==
    [
      "accountId",
      "zoneId",
      "hostname",
      "stage",
      "privateStateRoot",
      "artifactReceipt",
      "profileFile",
    ]
      .sort()
      .join(",")
  )
    throw new Error(
      "Owned hosted deploy config must contain only the seven explicit configuration fields.",
    );
  if (
    accountId !== "e0fa69f64063aa2670ad354549a34dd6" ||
    zoneId !== "71edc69babf1a57c2abca300c28c8c27" ||
    hostname !== "connect.arcwright.space" ||
    stage !== "devotek-pilot"
  )
    throw new Error(
      "Owned hosted deploy target is outside the authorized account/zone/hostname/stage.",
    );
  const profile = connectProfileReceipt(
    loadRepoEnv({
      baseEnv: { T3CODE_CONNECT_MODE: "owned", T3CODE_CONNECT_PROFILE_FILE: profileFile },
      readEnvFiles: false,
    }),
  );
  if (profile.T3CODE_HOSTED_APP_URL !== `https://${hostname}`)
    throw new Error("Owned hosted deployment origin conflicts with public profile.");
  assertExternalPath(privateStateRoot, "Private Alchemy storage");
  if (!NodePath.isAbsolute(artifactReceipt) || !NodePath.isAbsolute(profileFile))
    throw new Error("Require explicit absolute receipt and public profile paths.");
  return {
    accountId,
    zoneId,
    hostname,
    stage,
    privateStateRoot,
    artifactReceipt,
    profileFile,
    profile,
  };
}

export function preparePrivateAlchemyRoot(directory: string) {
  assertExternalPath(directory, "Private Alchemy storage");
  process.umask(0o077);
  if (!NodeFS.existsSync(directory)) NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = NodeFS.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("Private Alchemy storage must be owned by this operator with mode 0700.");
}
