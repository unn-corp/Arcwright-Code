// @effect-diagnostics nodeBuiltinImport:off -- pure release-feed digest validation shared with the native updater boundary.
import type { DesktopUpdateChannel } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import { parse } from "yaml";
import {
  classifyForkRelease,
  compareForkVersions,
  forkDesktopAssetFor,
  forkPlatformKey,
  FORK_RELEASE_DOWNLOAD_ORIGIN,
  type ForkReleaseRecord,
} from "@t3tools/shared/forkMaintenance";

/** Only release discovery differs from upstream. Download/install remain electron-updater's. */
export function resolveForkDesktopFeed(input: {
  readonly releases: ReadonlyArray<ForkReleaseRecord>;
  readonly channel: DesktopUpdateChannel;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly deb: boolean;
  readonly installedVersion?: string;
  readonly failedDigests?: ReadonlyArray<string>;
}) {
  const platform = forkPlatformKey(input.platform, input.arch);
  if (!platform) return null;
  const packaging = input.platform === "win32" ? "nsis" : input.deb ? "deb" : "appimage";
  const record = input.releases
    .filter((entry) => {
      if (!classifyForkRelease(entry, input.releases).eligible || !entry.manifest) return false;
      if (entry.manifest.channel !== (input.channel === "latest" ? "stable" : "nightly"))
        return false;
      const asset = forkDesktopAssetFor(entry.manifest, platform, packaging);
      if (!asset || input.failedDigests?.includes(asset.sha256)) return false;
      return (
        !input.installedVersion ||
        compareForkVersions(entry.manifest.version, input.installedVersion) >= 0
      );
    })
    .toSorted((a, b) => compareForkVersions(b.manifest!.version, a.manifest!.version))[0];
  if (!record?.manifest) return null;
  const asset = forkDesktopAssetFor(record.manifest, platform, packaging)!;
  const channel = record.manifest.channel === "stable" ? "latest" : "nightly";
  const feedName = `${channel}${input.platform === "linux" ? "-linux" : ""}.yml`;
  const feed = record.manifest.assets.find(
    (entry) => entry.kind === "feed" && entry.name === feedName,
  );
  if (!feed) return null;
  return {
    provider: "generic" as const,
    url: `${FORK_RELEASE_DOWNLOAD_ORIGIN}${encodeURIComponent(record.tagName)}/`,
    version: record.manifest.version,
    // GenericProvider appends -linux itself; Windows uses the bare channel.
    channel,
    asset,
    feed,
    platformAssets: record.manifest.assets.filter(
      (entry) => entry.kind === "desktop" && entry.platform === platform,
    ),
  };
}

export function verifyForkDesktopFeed(
  selected: NonNullable<ReturnType<typeof resolveForkDesktopFeed>>,
  bytes: Uint8Array,
): void {
  if (
    bytes.length !== selected.feed.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== selected.feed.sha256
  )
    throw new Error("The Arcwright update feed failed its release digest check.");
  const document: unknown = parse(new TextDecoder().decode(bytes));
  if (
    typeof document !== "object" ||
    document === null ||
    !("version" in document) ||
    document.version !== selected.version ||
    !("files" in document) ||
    !Array.isArray(document.files)
  )
    throw new Error("The Arcwright update feed does not match the selected release.");
  const names = new Set<string>();
  for (const file of document.files as ReadonlyArray<unknown>) {
    if (
      typeof file !== "object" ||
      file === null ||
      !("url" in file) ||
      typeof file.url !== "string" ||
      !("size" in file)
    )
      throw new Error("The Arcwright update feed has invalid installer metadata.");
    const name = decodeURIComponent(file.url);
    const asset = selected.platformAssets.find((entry) => entry.name === name);
    if (!asset || asset.bytes !== file.size || names.has(name))
      throw new Error("The Arcwright update feed names a different installer.");
    names.add(name);
  }
  if (!names.has(selected.asset.name))
    throw new Error("The Arcwright update feed omits this installation's package format.");
}
