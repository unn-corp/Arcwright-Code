// @ts-check
const fs = require("node:fs");
const path = require("node:path");

// Include the major version, which Expo ignores, to prevent OTAs reaching older store binaries.
const appConfig = fs.readFileSync(path.join(__dirname, "app.config.ts"), "utf8");
const version =
  process.env.T3CODE_MOBILE_VERSION ??
  appConfig.match(/^ {2}version: repoEnv\.T3CODE_MOBILE_VERSION \?\? "([^"]+)"/m)?.[1];
const majorVersion = version?.match(/^(\d+)\./)?.[1];
if (!majorVersion) {
  throw new Error("fingerprint.config.js could not read the app version from app.config.ts");
}

module.exports = {
  // Diagnostic metadata must not change native compatibility or force a rebuild.
  /**
   * @param {{type: "file", filePath: string} | {type: "contents", id: string}} source
   * @param {Buffer | string | null} chunk
   */
  fileHookTransform(source, chunk) {
    if (source.type === "contents" && source.id === "expoConfig" && chunk !== null) {
      const config = JSON.parse(chunk.toString());
      if (config.extra) delete config.extra.buildIdentity;
      return JSON.stringify(config);
    }
    return chunk;
  },
  // Hash the pinned Screens fork's native source, rather than only its version.
  nativeModuleSourceType: "files",
  extraSources: [{ type: "contents", id: "appMajorVersion", contents: majorVersion }],
};
