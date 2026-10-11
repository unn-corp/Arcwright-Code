import { assert, it } from "@effect/vitest";
import type { HostResourcesSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as AgentStartAdmission from "./AgentStartAdmission.ts";
import * as HostResources from "./HostResources.ts";

const GiB = 1024 ** 3;

it.effect("holds below 10% headroom and resumes with hysteresis, regardless of CPU load", () =>
  Effect.gen(function* () {
    const available = yield* Ref.make(16 * GiB);
    const admission = yield* AgentStartAdmission.AgentStartAdmission.pipe(
      Effect.provide(
        AgentStartAdmission.layer.pipe(
          Layer.provide(
            Layer.succeed(HostResources.HostResources, {
              read: Ref.get(available).pipe(
                Effect.map((availableMemoryBytes): HostResourcesSnapshot => ({
                  sampledAt: 0,
                  cpuCount: 16,
                  cpuUtilization: 1,
                  totalMemoryBytes: 64 * GiB,
                  availableMemoryBytes,
                })),
              ),
            }),
          ),
        ),
      ),
    );
    assert.isTrue(yield* admission.canStart);
    yield* Ref.set(available, 6 * GiB);
    assert.isFalse(yield* admission.canStart);
    yield* Ref.set(available, 7 * GiB);
    assert.isFalse(yield* admission.canStart);
    yield* Ref.set(available, 8 * GiB);
    assert.isTrue(yield* admission.canStart);
    yield* Ref.set(available, 7 * GiB);
    assert.isTrue(yield* admission.canStart);
  }),
);

it.effect.each([
  { total: 2 * GiB, hold: 0.4 * GiB, resume: 0.625 * GiB },
  { total: 256 * GiB, hold: 7 * GiB, resume: 10 * GiB },
])("bounds the reserve for a host with $total bytes of RAM", ({ total, hold, resume }) =>
  Effect.gen(function* () {
    const available = yield* Ref.make(hold);
    const admission = yield* AgentStartAdmission.AgentStartAdmission.pipe(
      Effect.provide(
        AgentStartAdmission.layer.pipe(
          Layer.provide(
            Layer.succeed(HostResources.HostResources, {
              read: Ref.get(available).pipe(
                Effect.map((availableMemoryBytes) => ({
                  sampledAt: 0,
                  cpuCount: 1,
                  cpuUtilization: null,
                  totalMemoryBytes: total,
                  availableMemoryBytes,
                })),
              ),
            }),
          ),
        ),
      ),
    );
    assert.isFalse(yield* admission.canStart);
    yield* Ref.set(available, resume);
    assert.isTrue(yield* admission.canStart);
  }),
);

it.effect("holds on invalid memory samples and recovers on a valid sample", () =>
  Effect.gen(function* () {
    const available = yield* Ref.make(Number.NaN);
    const admission = yield* AgentStartAdmission.AgentStartAdmission.pipe(
      Effect.provide(
        AgentStartAdmission.layer.pipe(
          Layer.provide(
            Layer.succeed(HostResources.HostResources, {
              read: Ref.get(available).pipe(
                Effect.map((availableMemoryBytes) => ({
                  sampledAt: 0,
                  cpuCount: 1,
                  cpuUtilization: null,
                  totalMemoryBytes: 64 * GiB,
                  availableMemoryBytes,
                })),
              ),
            }),
          ),
        ),
      ),
    );
    assert.isFalse(yield* admission.canStart);
    yield* Ref.set(available, 16 * GiB);
    assert.isTrue(yield* admission.canStart);
  }),
);
