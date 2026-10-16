import type {
  DesktopHostTelemetrySnapshot,
  ResourceMonitorSnapshotEvent,
  ResourceTelemetryHealth,
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryBucket,
  ResourceTelemetryProcess,
  ResourceTelemetryProcessSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  emptyTelemetryCounters,
  mergeProcesses,
  processIdentityKey,
  type ProcessState,
} from "./Model.ts";

const MAX_HISTORY_WINDOW_MS = 60 * 60_000;

export function normalizeResourceTelemetryHistoryInput(input: {
  readonly windowMs: number;
  readonly bucketMs: number;
}): { readonly windowMs: number; readonly bucketMs: number } {
  const windowMs = Math.max(1_000, Math.min(MAX_HISTORY_WINDOW_MS, input.windowMs));
  return {
    windowMs,
    bucketMs: Math.max(1_000, Math.min(windowMs, input.bucketMs)),
  };
}

interface AggregateSample {
  readonly sampledAtMs: number;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly processCount: number;
  readonly ioReadBytes: number;
  readonly ioWriteBytes: number;
}

interface ProcessSample {
  readonly sampledAtMs: number;
  readonly process: ResourceTelemetryProcess;
  readonly cpuTimeMs: number;
  readonly ioReadBytes: number;
  readonly ioWriteBytes: number;
}

export interface BuildResourceTelemetryHistoryInput {
  readonly readAt: DateTime.Utc;
  readonly windowMs: number;
  readonly bucketMs: number;
  readonly sampleIntervalMs: number;
  readonly serverPid: number;
  readonly sidecarPid: Option.Option<number>;
  readonly desktopSnapshot: Option.Option<DesktopHostTelemetrySnapshot>;
  readonly snapshots: ReadonlyArray<ResourceMonitorSnapshotEvent>;
  readonly health: ResourceTelemetryHealth;
}

export type ResourceTelemetryHistoryWithLegacyBuckets = ResourceTelemetryHistory & {
  readonly legacyBackendBuckets?: ReadonlyArray<ResourceTelemetryHistoryBucket>;
};

function summarizeProcesses(
  samples: ReadonlyArray<ProcessSample>,
): ReadonlyArray<ResourceTelemetryProcessSummary> {
  const groups = new Map<
    string,
    {
      first: ProcessSample;
      latest: ProcessSample;
      count: number;
      cpuTotal: number;
      maxCpu: number;
      cpuTimeMs: number;
      peakRss: number;
      ioReadBytes: number;
      ioWriteBytes: number;
    }
  >();
  for (const sample of samples) {
    const key = processIdentityKey(
      sample.process.identity.pid,
      sample.process.identity.startTimeMs,
    );
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        first: sample,
        latest: sample,
        count: 0,
        cpuTotal: 0,
        maxCpu: -Infinity,
        cpuTimeMs: 0,
        peakRss: -Infinity,
        ioReadBytes: 0,
        ioWriteBytes: 0,
      };
      groups.set(key, group);
    }
    if (sample.sampledAtMs < group.first.sampledAtMs) group.first = sample;
    if (sample.sampledAtMs >= group.latest.sampledAtMs) group.latest = sample;
    group.count += 1;
    group.cpuTotal += sample.process.cpuPercent;
    group.maxCpu = Math.max(group.maxCpu, sample.process.cpuPercent);
    group.cpuTimeMs += sample.cpuTimeMs;
    group.peakRss = Math.max(group.peakRss, sample.process.residentBytes);
    group.ioReadBytes += sample.ioReadBytes;
    group.ioWriteBytes += sample.ioWriteBytes;
  }
  return [...groups.values()]
    .map((group): ResourceTelemetryProcessSummary => {
      const latest = group.latest.process;
      return {
        identity: latest.identity,
        ppid: latest.ppid,
        depth: latest.depth,
        name: latest.name,
        command: latest.command,
        category: latest.category,
        firstSeenAt: group.first.process.firstSeenAt,
        lastSeenAt: latest.lastSeenAt,
        currentCpuPercent: latest.cpuPercent,
        avgCpuPercent: group.cpuTotal / group.count,
        maxCpuPercent: group.maxCpu,
        cpuTimeMs: group.cpuTimeMs,
        currentRssBytes: latest.residentBytes,
        peakRssBytes: group.peakRss,
        ioReadBytes: group.ioReadBytes,
        ioWriteBytes: group.ioWriteBytes,
        ioSemantics: latest.ioSemantics,
        sampleCount: group.count,
      };
    })
    .toSorted(
      (left, right) => right.cpuTimeMs - left.cpuTimeMs || right.peakRssBytes - left.peakRssBytes,
    );
}

function buildBuckets(input: {
  readonly samples: ReadonlyArray<AggregateSample>;
  readonly nowMs: number;
  readonly windowMs: number;
  readonly bucketMs: number;
}): ReadonlyArray<ResourceTelemetryHistoryBucket> {
  const windowStartMs = input.nowMs - input.windowMs;
  // Samples arrive in timestamp order from the snapshot traversal.
  let sampleIndex = 0;
  const buckets: ResourceTelemetryHistoryBucket[] = [];
  for (let startedAtMs = windowStartMs; startedAtMs < input.nowMs; startedAtMs += input.bucketMs) {
    const endedAtMs = Math.min(input.nowMs, startedAtMs + input.bucketMs);
    let count = 0,
      cpuTotal = 0,
      maxCpu = -Infinity,
      maxRss = -Infinity,
      ioReadBytes = 0,
      ioWriteBytes = 0,
      maxProcessCount = -Infinity;
    while (sampleIndex < input.samples.length) {
      const sample = input.samples[sampleIndex]!;
      if (
        sample.sampledAtMs > endedAtMs ||
        (sample.sampledAtMs === endedAtMs && endedAtMs !== input.nowMs)
      )
        break;
      sampleIndex += 1;
      if (sample.sampledAtMs < startedAtMs) continue;
      count += 1;
      cpuTotal += sample.cpuPercent;
      maxCpu = Math.max(maxCpu, sample.cpuPercent);
      maxRss = Math.max(maxRss, sample.rssBytes);
      ioReadBytes += sample.ioReadBytes;
      ioWriteBytes += sample.ioWriteBytes;
      maxProcessCount = Math.max(maxProcessCount, sample.processCount);
    }
    buckets.push({
      startedAt: DateTime.makeUnsafe(startedAtMs),
      endedAt: DateTime.makeUnsafe(endedAtMs),
      avgCpuPercent: count === 0 ? 0 : cpuTotal / count,
      maxCpuPercent: count === 0 ? 0 : maxCpu,
      maxRssBytes: count === 0 ? 0 : maxRss,
      ioReadBytes,
      ioWriteBytes,
      maxProcessCount: count === 0 ? 0 : maxProcessCount,
    });
  }
  return buckets;
}

export function buildResourceTelemetryHistory(
  input: BuildResourceTelemetryHistoryInput,
): ResourceTelemetryHistoryWithLegacyBuckets & {
  readonly legacyBackendBuckets: ReadonlyArray<ResourceTelemetryHistoryBucket>;
} {
  const readAtMs = DateTime.toEpochMillis(input.readAt);
  const { windowMs, bucketMs } = normalizeResourceTelemetryHistoryInput(input);
  const windowStartMs = readAtMs - windowMs;
  const eligibleSnapshots = input.snapshots
    .filter((snapshot) => snapshot.sampledAtUnixMs <= readAtMs)
    .toSorted((left, right) => left.sampledAtUnixMs - right.sampledAtUnixMs);
  const snapshotsInWindow = eligibleSnapshots.filter(
    (snapshot) => snapshot.sampledAtUnixMs >= windowStartMs,
  );
  const precedingSnapshot = eligibleSnapshots.findLast(
    (snapshot) => snapshot.sampledAtUnixMs < windowStartMs,
  );
  const snapshots = precedingSnapshot
    ? [precedingSnapshot, ...snapshotsInWindow]
    : snapshotsInWindow;
  const aggregateSamples: AggregateSample[] = [];
  const legacyBackendAggregateSamples: AggregateSample[] = [];
  const processSamples: ProcessSample[] = [];
  const previous = new Map<string, ProcessState>();
  const counters = emptyTelemetryCounters();
  let previousSnapshotAtMs: number | undefined;

  for (const snapshot of snapshots) {
    const deltaWindowFraction =
      previousSnapshotAtMs !== undefined &&
      previousSnapshotAtMs < windowStartMs &&
      snapshot.sampledAtUnixMs > previousSnapshotAtMs
        ? Math.max(
            0,
            Math.min(
              1,
              (snapshot.sampledAtUnixMs - windowStartMs) /
                (snapshot.sampledAtUnixMs - previousSnapshotAtMs),
            ),
          )
        : 1;
    previousSnapshotAtMs = snapshot.sampledAtUnixMs;
    const recordedExternalProcesses =
      snapshot.externalProcesses ??
      Option.match(input.desktopSnapshot, {
        onNone: () => [],
        onSome: (desktopSnapshot) => [
          {
            pid: desktopSnapshot.electronPid,
            startTimeMs: desktopSnapshot.electronProcesses.find(
              (metric) => metric.pid === desktopSnapshot.electronPid,
            )?.creationTimeMs,
          },
        ],
      });
    const electronRootPids = new Set(recordedExternalProcesses.map((process) => process.pid));
    const electronRootStartTimes = new Map(
      recordedExternalProcesses.flatMap((process) =>
        process.startTimeMs === undefined ? [] : [[process.pid, process.startTimeMs] as const],
      ),
    );
    const merged = mergeProcesses({
      serverPid: input.serverPid,
      sidecarPid: input.sidecarPid,
      fallbackSampledAtMs: snapshot.sampledAtUnixMs,
      nativeSnapshot: Option.some(snapshot),
      desktopSnapshot: Option.none(),
      electronRootPids,
      electronRootStartTimes,
      previous,
      counters,
      updatePrevious: true,
      accumulateCounters: false,
    });
    // Keep absent identities' baselines without copying every exited process on each sample.
    for (const [identityKey, state] of merged.previous) {
      previous.set(identityKey, state);
    }
    if (snapshot.sampledAtUnixMs < windowStartMs) {
      continue;
    }
    const deltas =
      deltaWindowFraction === 1
        ? merged.deltas
        : merged.deltas.map((delta) => ({
            ...delta,
            cpuTimeMs: Math.round(delta.cpuTimeMs * deltaWindowFraction),
            ioReadBytes: Math.round(delta.ioReadBytes * deltaWindowFraction),
            ioWriteBytes: Math.round(delta.ioWriteBytes * deltaWindowFraction),
          }));
    const deltasByIdentity = new Map(
      deltas.map((processDelta) => [processDelta.identityKey, processDelta]),
    );
    aggregateSamples.push({
      sampledAtMs: snapshot.sampledAtUnixMs,
      cpuPercent: merged.groups.allT3.currentCpuPercent,
      rssBytes: merged.groups.allT3.currentRssBytes,
      processCount: merged.groups.allT3.processCount,
      ioReadBytes: deltas.reduce((total, process) => total + process.ioReadBytes, 0),
      ioWriteBytes: deltas.reduce((total, process) => total + process.ioWriteBytes, 0),
    });
    const backendDeltas = deltas.filter(
      (processDelta) =>
        processDelta.category === "server" ||
        processDelta.category === "server-child" ||
        processDelta.category === "provider-root" ||
        processDelta.category === "terminal-root",
    );
    legacyBackendAggregateSamples.push({
      sampledAtMs: snapshot.sampledAtUnixMs,
      cpuPercent: merged.groups.backend.currentCpuPercent,
      rssBytes: merged.groups.backend.currentRssBytes,
      processCount: merged.groups.backend.processCount,
      ioReadBytes: backendDeltas.reduce((total, process) => total + process.ioReadBytes, 0),
      ioWriteBytes: backendDeltas.reduce((total, process) => total + process.ioWriteBytes, 0),
    });
    for (const process of merged.processes) {
      const processDelta = deltasByIdentity.get(
        processIdentityKey(process.identity.pid, process.identity.startTimeMs),
      );
      processSamples.push({
        sampledAtMs: snapshot.sampledAtUnixMs,
        process,
        cpuTimeMs: processDelta?.cpuTimeMs ?? 0,
        ioReadBytes: processDelta?.ioReadBytes ?? 0,
        ioWriteBytes: processDelta?.ioWriteBytes ?? 0,
      });
    }
  }

  return {
    readAt: input.readAt,
    windowMs,
    bucketMs,
    sampleIntervalMs: input.sampleIntervalMs,
    retainedSampleCount: aggregateSamples.length + processSamples.length,
    buckets: buildBuckets({ samples: aggregateSamples, nowMs: readAtMs, windowMs, bucketMs }),
    legacyBackendBuckets: buildBuckets({
      samples: legacyBackendAggregateSamples,
      nowMs: readAtMs,
      windowMs,
      bucketMs,
    }),
    topProcesses: summarizeProcesses(processSamples),
    health: input.health,
  };
}
