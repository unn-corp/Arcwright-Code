// @effect-diagnostics nodeBuiltinImport:off -- release-integrity tests hash fixture bytes.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import type { ForkReleaseManifest } from "@t3tools/contracts";
import type { ForkReleaseRecord } from "@t3tools/shared/forkMaintenance";
import { resolveForkDesktopFeed, verifyForkDesktopFeed } from "./forkDesktopFeed.ts";

function makeRelease(version: string): ForkReleaseRecord & { manifest: ForkReleaseManifest } {
  const commit = NodeCrypto.createHash("sha1").update(version).digest("hex");
  const asset = (
    name: string,
    kind: ForkReleaseManifest["assets"][number]["kind"],
    platform: ForkReleaseManifest["assets"][number]["platform"],
  ): ForkReleaseManifest["assets"][number] => ({
    name,
    kind,
    platform,
    bytes: 100,
    sha256: "a".repeat(64),
  });
  const normal = asset("android.apk", "android", "android");
  const recovery = asset("recovery.apk", "android-recovery", "android");
  const android = (name: string, code: number) => ({
    asset: name,
    versionCode: code,
    sourceVersion: version,
    sourceCommit: commit,
    packageName: "com.devotek.t3code.pwa" as const,
    signerSha256: "b".repeat(64),
    updaterProtocol: 1 as const,
  });
  const manifest: ForkReleaseManifest = {
    format: 1,
    repository: "unn-corp/t3code",
    version,
    commit,
    channel: version.includes("nightly") ? "nightly" : "stable",
    releasedAt: "2026-10-16T12:00:00Z",
    assets: [
      asset("desktop.exe", "desktop", "windows-x64"),
      asset("desktop.AppImage", "desktop", "linux-x64"),
      normal,
      recovery,
    ],
    android: {
      normal: android(normal.name, 100),
      recovery: {
        ...android(recovery.name, 101),
        sourceVersion: "0.9.0",
        sourceCommit: "c".repeat(40),
      },
    },
    checks: { build: true, install: true, update: true, recovery: true },
  };
  return {
    id: 1,
    tagName: `fork-v${version}`,
    draft: false,
    body: "",
    createdAt: manifest.releasedAt,
    publishedAt: manifest.releasedAt,
    assets: [
      ...manifest.assets.map((a) => ({ name: a.name, size: a.bytes })),
      { name: "fork-release.json", size: 100 },
    ],
    manifest,
  };
}

function release(version: string) {
  const record = makeRelease(version);
  const manifest = record.manifest!;
  const asset = manifest.assets.find((a) => a.name.endsWith(".AppImage"))!;
  const feedBytes = new TextEncoder().encode(
    `version: ${version}\nfiles:\n  - url: ${asset.name}\n    size: ${asset.bytes}\n    sha512: fixture\n`,
  );
  const name = version.includes("nightly") ? "nightly-linux.yml" : "latest-linux.yml";
  const feed = {
    name,
    kind: "feed" as const,
    platform: "linux-x64" as const,
    bytes: feedBytes.length,
    sha256: NodeCrypto.createHash("sha256").update(feedBytes).digest("hex"),
  };
  return {
    record: {
      ...record,
      manifest: { ...manifest, assets: [...manifest.assets, feed] },
      assets: [...record.assets, { name, size: feed.bytes }],
    },
    feedBytes,
  };
}
const platform = { platform: "linux" as const, arch: "x64", deb: false };

describe("owned desktop release feed", () => {
  it("keeps numbered nightlies separate from a newer stable release", () => {
    const nightly = release("1.0.1-nightly.20261016.125");
    const stable = release("2.0.0");
    const selected = resolveForkDesktopFeed({
      ...platform,
      channel: "nightly",
      releases: [stable.record, nightly.record],
    });
    expect(selected?.version).toBe(nightly.record.manifest.version);
    expect(selected?.channel).toBe("nightly");
    expect(selected?.url).toContain("/fork-v1.0.1-nightly.20261016.125/");
    expect(() => verifyForkDesktopFeed(selected!, nightly.feedBytes)).not.toThrow();
  });

  it("rejects withdrawn, failed and older installers", () => {
    const { record } = release("1.0.1-nightly.20261016.125");
    const args = { ...platform, channel: "nightly" as const, releases: [record] };
    expect(
      resolveForkDesktopFeed({ ...args, installedVersion: "1.0.1-nightly.20261016.126" }),
    ).toBeNull();
    expect(
      resolveForkDesktopFeed({ ...args, failedDigests: [record.manifest.assets[1]!.sha256] }),
    ).toBeNull();
    expect(
      resolveForkDesktopFeed({
        ...args,
        releases: [{ ...record, body: "<!-- t3-fork-release:withdrawn -->" }],
      }),
    ).toBeNull();
  });

  it("detects same-size corrupted feeds and binds the version and installer", () => {
    const { record, feedBytes } = release("1.0.1-nightly.20261016.125");
    const selected = resolveForkDesktopFeed({
      ...platform,
      channel: "nightly",
      releases: [record],
    })!;
    const corrupted = feedBytes.slice();
    corrupted[0] = (corrupted[0] ?? 0) ^ 1;
    expect(() => verifyForkDesktopFeed(selected, corrupted)).toThrow("digest");
    const mutate = (text: string) => {
      const bytes = new TextEncoder().encode(text);
      return {
        bytes,
        selected: {
          ...selected,
          feed: {
            ...selected.feed,
            bytes: bytes.length,
            sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          },
        },
      };
    };
    const wrongVersion = mutate(
      new TextDecoder().decode(feedBytes).replace(record.manifest.version, "9.9.9"),
    );
    expect(() => verifyForkDesktopFeed(wrongVersion.selected, wrongVersion.bytes)).toThrow(
      "selected release",
    );
    const foreign = mutate(
      new TextDecoder()
        .decode(feedBytes)
        .replace(selected.asset.name, "https://example.com/foreign.AppImage"),
    );
    expect(() => verifyForkDesktopFeed(foreign.selected, foreign.bytes)).toThrow(
      "different installer",
    );
  });
});
