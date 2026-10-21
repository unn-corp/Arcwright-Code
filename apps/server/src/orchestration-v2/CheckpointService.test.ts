import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as WorkspaceGitPolicy from "../vcs/WorkspaceGitPolicy.ts";

it.effect(
  "disabling checkpoints skips new Git captures while existing rollback points remain restorable",
  () => {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("scope-disabled"),
      threadId: ThreadId.make("thread-disabled"),
      runId: RunId.make("run-disabled"),
      nodeId: NodeId.make("node-disabled"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-disabled"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe(0),
    };
    const capture = vi.fn(() => Effect.void);
    const restore = vi.fn(() => Effect.succeed(true));
    const testLayer = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          IdAllocator.layer,
          Layer.succeed(WorkspaceGitPolicy.WorkspaceGitPolicy, {
            read: () => Effect.succeed({ automaticGitStatus: true, automaticCheckpoints: false }),
          }),
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef: () => Effect.succeed(true),
            captureCheckpoint: capture,
            restoreCheckpoint: restore,
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* CheckpointService.CheckpointServiceV2;
      yield* service.captureBaseline({ scope, ordinalWithinScope: 0 });
      const checkpoint = yield* service.capture({
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId,
        nodeId: scope.nodeId!,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
      });
      assert.equal(checkpoint.status, "missing");
      assert.deepEqual(checkpoint.files, []);
      assert.equal(capture.mock.calls.length, 0);
      const existing = yield* service.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 0,
      });
      assert.equal(existing.status, "ready");
      yield* service.restore({ scope, checkpoint: existing });
      assert.equal(restore.mock.calls.length, 1);
    }).pipe(Effect.provide(testLayer));
  },
);

it.effect(
  "skips unsupported baseline and turn checkpoints without swallowing capture failures",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:capture-failure"),
        threadId: ThreadId.make("thread:capture-failure"),
        runId: RunId.make("run:capture-failure:1"),
        nodeId: NodeId.make("node:capture-failure:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:capture-failure"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/ignored",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      for (const captureError of [
        new VcsProcessTimeoutError({
          operation: "test.capture",
          command: "git",
          cwd: scope.cwd,
          timeoutMs: 30000,
        }),
        new VcsUnsupportedOperationError({
          operation: "test.capture",
          kind: "git",
          detail: "The workspace directory is ignored by its Git repository.",
        }),
      ]) {
        const layerTest = CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(CheckpointStore.CheckpointStore)({
                isGitRepository: () => Effect.succeed(true),
                hasCheckpointRef: () => Effect.succeed(false),
                captureCheckpoint: () => Effect.fail(captureError),
              }),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
        );
        yield* Effect.gen(function* () {
          const checkpoints = yield* CheckpointService.CheckpointServiceV2;
          const baseline = yield* Effect.result(
            checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 }),
          );
          const checkpoint = yield* checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          });

          assert.deepEqual(
            { baseline: baseline._tag, turn: checkpoint.status, files: checkpoint.files },
            captureError._tag === "VcsUnsupportedOperationError"
              ? { baseline: "Success", turn: "missing", files: [] }
              : { baseline: "Failure", turn: "error", files: [] },
          );
          if (baseline._tag === "Failure") {
            assert.strictEqual(baseline.failure.cause, captureError);
          } else {
            const materialized = yield* checkpoints.materializeBaselineCheckpoint({
              scope,
              ordinalWithinScope: 0,
            });
            assert.strictEqual(materialized.status, "missing");
          }
        }).pipe(Effect.provide(layerTest));
      }
    }),
);
