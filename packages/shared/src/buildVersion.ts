/** Presentation only. Installer/recovery identities and their ordering always retain the exact release version. */
export interface DisplayBuild {
  readonly version: string;
  readonly upstreamVersion?: string;
  readonly forkBuildNumber?: number;
}

const legacyFork = /^(\d+\.\d+\.\d+)-fork\.(\d+)$/;
const nightly = /^\d+\.\d+\.\d+-nightly\.\d{8}\.(\d+)$/;
const localNightly = /^\d+\.\d+\.\d+-preview\.\d{8}\.(\d+)$/;

function numberedBuild(build: DisplayBuild) {
  const legacy = legacyFork.exec(build.version);
  const published = nightly.exec(build.version);
  const local = localNightly.exec(build.version);
  return {
    number: local
      ? Number(local[1])
      : (build.forkBuildNumber ??
        (legacy ? Number(legacy[2]) : published ? Number(published[1]) : null)),
    channel: local ? "Local Nightly" : legacy ? "Legacy" : published ? "Nightly" : "Stable",
  };
}

/** An unlabelled release from the independent 1.x series does not prove its upstream base. */
export function includedUpstreamVersion(build: DisplayBuild): string | null {
  return build.upstreamVersion ?? legacyFork.exec(build.version)?.[1] ?? null;
}

export function formatBuildVersion(build: DisplayBuild): string {
  const { number, channel } = numberedBuild(build);
  const upstream = includedUpstreamVersion(build);
  if (number !== null) {
    return [upstream, `Arcwright build ${number}`, channel].filter(Boolean).join(" · ");
  }
  if (upstream)
    return `${upstream} · Arcwright ${build.version === upstream ? "Development" : "Stable"}`;
  return build.version;
}

/** Put the channel and counter first so a narrow sidebar cannot truncate them away. */
export function formatCompactBuildVersion(build: DisplayBuild): string {
  const { number, channel } = numberedBuild(build);
  if (number === null) return formatBuildVersion(build);
  const label =
    channel === "Stable"
      ? `Arcwright build ${number}`
      : channel === "Legacy"
        ? `Legacy build ${number}`
        : `${channel} ${number}`;
  const upstream = includedUpstreamVersion(build);
  return upstream ? `${label} · T3 ${upstream}` : label;
}
