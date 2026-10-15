import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2Command,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { startThreadTurn } from "@t3tools/client-runtime/operations";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { createModelSelection } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  DraftId,
  partializeComposerDraftStoreState,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "../composerDraftStore";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { makeThreadFixture, makeThreadProjectionFixture } from "../test-fixtures";
import type { Thread } from "../types";
import {
  composerModelSelectionBase,
  captureComposerModelSelectionForDispatch,
  deriveLockedProvider,
  useThreadComposerSelection,
} from "./ChatView.logic";
import { getComposerProviderState } from "./chat/composerProviderState";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { installComposerSelectionIntentSync } from "../composerSelectionIntent";
import { environmentThreadShells } from "../state/threads";

const environmentId = EnvironmentId.make("shared-server");
const threadId = ThreadId.make("shared-conversation");
const threadRef = scopeThreadRef(environmentId, threadId);
const codex = ProviderDriverKind.make("codex");
const accountA = ProviderInstanceId.make("codex");
// Deliberately does not resemble its driver: instance ids are routing keys.
const accountB = ProviderInstanceId.make("work_account_2");
const now = "2026-10-14T10:00:00.000Z";
const selectionA = createModelSelection(accountA, "gpt-5.4", [{ id: "effort", value: "low" }]);
const selectionB = createModelSelection(accountB, "gpt-5.6-sol", [{ id: "effort", value: "high" }]);
const initialState = useComposerDraftStore.getInitialState();

function provider(
  instanceId: ProviderInstanceId,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId,
    driver: codex,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: now,
    models: ["gpt-5.4", "gpt-5.6-sol"].map((model) => ({
      slug: model,
      name: model,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            currentValue: "low",
            options: [
              { id: "low", label: "Low", isDefault: true },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    })),
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}
const providers = [provider(accountA), provider(accountB)];

function server(modelSelection = selectionA, runId = "run-1"): Thread {
  return makeThreadFixture({
    id: threadId,
    environmentId,
    modelSelection,
    itemCount: 2,
    latestRun: {
      runId: RunId.make(runId),
      status: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
    },
  });
}

function makeShellAtom() {
  const source = Atom.make<Thread | null>(null).pipe(Atom.keepAlive);
  // Match the production shell's derived-atom notification path.
  return { source, value: Atom.make((get) => get(source)).pipe(Atom.keepAlive) };
}
const shellAtoms = new Map<string, ReturnType<typeof makeShellAtom>>();
function shellAtom(ref: typeof threadRef) {
  const key = scopedThreadKey(ref);
  let atom = shellAtoms.get(key);
  if (!atom) {
    atom = makeShellAtom();
    shellAtoms.set(key, atom);
  }
  return atom.value;
}
function observeShell(thread: Thread) {
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  shellAtom(ref);
  const atom = shellAtoms.get(scopedThreadKey(ref));
  if (!atom) throw new Error("Missing test shell");
  appAtomRegistry.set(atom.source, thread);
}

type Selection = ReturnType<typeof useThreadComposerSelection>;
let observed: Selection;
function Probe({
  thread,
  catalog,
  target,
}: {
  thread: Thread | null | undefined;
  catalog: ServerProvider[];
  target: ComposerThreadTarget;
}) {
  const selection = useThreadComposerSelection({
    threadRef: target,
    serverThread: thread,
    threadModelSelection: thread?.modelSelection,
    projectModelSelection: selectionB,
    entries: deriveProviderInstanceEntries(catalog),
    providers: catalog,
    lockedProvider: null,
    settings: DEFAULT_UNIFIED_SETTINGS,
  });
  useLayoutEffect(() => {
    observed = selection;
  });
  return null;
}

// Each client owns an independent immutable Zustand snapshot, including the
// same scoped thread key. Only the simulated authoritative shell is shared.
class Client {
  state = initialState;
  edit(edit: (store: typeof initialState) => void) {
    useComposerDraftStore.setState(this.state, true);
    edit(useComposerDraftStore.getState());
    this.state = useComposerDraftStore.getState();
  }
  restore() {
    const serialized: unknown = JSON.parse(
      JSON.stringify(partializeComposerDraftStoreState(this.state)),
    );
    const merge = useComposerDraftStore.persist.getOptions().merge;
    if (!merge) throw new Error("Composer persistence merge is missing");
    this.state = merge(serialized, initialState);
  }
  async observe(
    thread: Thread | null | undefined,
    catalog = providers,
    target: ComposerThreadTarget = threadRef,
  ) {
    useComposerDraftStore.setState(this.state, true);
    if (thread) observeShell(thread);
    let renderer: ReactTestRenderer | undefined;
    await act(() => {
      renderer = create(<Probe thread={thread} catalog={catalog} target={target} />);
    });
    const result = observed;
    await act(() => renderer?.unmount());
    this.state = useComposerDraftStore.getState();
    return result;
  }
}

function observe(
  client: Client,
  thread: Thread | null | undefined,
  catalog = providers,
  target: ComposerThreadTarget = threadRef,
) {
  return Effect.promise(() => client.observe(thread, catalog, target));
}

function dispatch(
  selection: Selection,
  preparation = Effect.void,
  target = threadRef,
  legacyPreparation?: Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    if (!selection.selectedProviderEntry) return [];
    const commands: OrchestrationV2Command[] = [];
    // In-memory transport, with production command construction and RPC routing.
    const client = {
      [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: () =>
        (legacyPreparation ?? Effect.void).pipe(Effect.as(makeThreadProjectionFixture())),
      [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    } as unknown as WsRpcProtocolClient;
    const session: RpcSession = {
      client,
      // This test transport exposes only the capability read by auto mode.
      initialConfig:
        legacyPreparation === undefined
          ? Effect.die("Unexpected server config request")
          : Effect.succeed({
              environment: { capabilities: { serverResolvedCommandContext: false } },
            } as never),
      subscribeServerConfig: () => {
        throw new Error("Unexpected subscription");
      },
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
    const providerState = getComposerProviderState({
      provider: selection.selectedProvider,
      model: selection.selectedModel,
      models: selection.selectedProviderEntry.models,
      modelOptions: selection.modelOptions?.[selection.selectedInstanceId],
      planModeEnabled: true,
    });
    const getModelSelectionForDispatch = captureComposerModelSelectionForDispatch({
      threadRef: target,
      draftTarget: target,
      isLocalDraft: selection.selectionBase === undefined,
      modelSelection:
        selection.modelSelectionForDispatch === undefined
          ? undefined
          : createModelSelection(
              selection.selectedInstanceId,
              selection.selectedModel,
              providerState.modelOptionsForDispatch,
            ),
      selectionBase: selection.selectionBase,
      intentSelection: selection.modelSelectionIntent,
    });
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: new PrimaryConnectionTarget({
        environmentId,
        label: "Test",
        httpBaseUrl: "https://server.test",
        wsBaseUrl: "wss://server.test",
      }),
      state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
      session: yield* SubscriptionRef.make(Option.some(session)),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    yield* preparation;
    yield* startThreadTurn({
      commandId: CommandId.make("selection-regression"),
      threadId: target.threadId,
      dispatchMode: legacyPreparation === undefined ? "start" : "auto",
      message: {
        messageId: MessageId.make("selection-message"),
        role: "user",
        text: "Continue",
        attachments: [],
      },
      ...(selection.modelSelectionForDispatch === undefined
        ? {}
        : {
            // Keep a static value too: an invalid getter must override it with omission.
            modelSelection: createModelSelection(
              selection.selectedInstanceId,
              selection.selectedModel,
              providerState.modelOptionsForDispatch,
            ),
            getModelSelectionForDispatch,
          }),
      runtimeMode: "full-access",
      interactionMode: "default",
    }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
    return commands;
  }).pipe(
    Effect.provideService(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );
}

function expectSelection(selection: Selection, expected: ModelSelection) {
  expect(selection.selectedInstanceId).toBe(expected.instanceId);
  expect(selection.selectedModel).toBe(expected.model);
  expect(selection.modelOptions?.[expected.instanceId] ?? []).toEqual(expected.options ?? []);
}
function expectDispatch(selection: Selection, expected: ModelSelection) {
  return Effect.gen(function* () {
    expectSelection(selection, expected);
    const commands = yield* dispatch(selection);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "message.dispatch" });
    if (selection.modelSelectionForDispatch === undefined) {
      expect(commands[0]).not.toHaveProperty("modelSelection");
    } else {
      expect(commands[0]).toMatchObject({ modelSelection: expected });
    }
  });
}

beforeEach(() => {
  shellAtoms.clear();
  vi.spyOn(environmentThreadShells, "threadShellAtom").mockImplementation(shellAtom);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useComposerDraftStore.setState(initialState, true);
});
afterEach(() => {
  useComposerDraftStore.setState(initialState, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("provider selection across desktop and APK client snapshots", () => {
  it.effect("ignores a restored device selection in favor of the exact server account", () =>
    Effect.gen(function* () {
      const desktop = new Client();
      const apk = new Client();
      desktop.edit((store) => {
        store.setPrompt(threadRef, "Keep this draft");
        store.setModelSelection(threadRef, selectionA, { explicit: true });
        store.setStickyModelSelection(selectionA);
      });
      desktop.restore();
      for (const client of [desktop, apk])
        yield* expectDispatch(yield* observe(client, server(selectionB)), selectionB);
      expect(desktop.state.draftsByThreadKey).toMatchObject({
        [Object.keys(desktop.state.draftsByThreadKey)[0]!]: {
          prompt: "Keep this draft",
          activeProvider: accountA,
        },
      });
      expect(desktop.state.stickyActiveProvider).toBe(accountA);
    }),
  );

  it.effect(
    "omits a passive stale snapshot override when another client has changed the server",
    () =>
      Effect.gen(function* () {
        const desktop = new Client();
        const apk = new Client();
        const passive = yield* observe(desktop, server(selectionA));
        const newer = yield* observe(apk, server(selectionB, "run-2"));
        expectSelection(passive, selectionA);
        expectSelection(newer, selectionB);
        // The real RPC command omits modelSelection, allowing the serialized
        // server policy to resolve its current B instead of reverting to A.
        const [command] = yield* dispatch(passive);
        expect(command).toMatchObject({ type: "message.dispatch", threadId });
        expect(command).not.toHaveProperty("modelSelection");
        yield* expectDispatch(yield* observe(desktop, server(selectionB, "run-2")), selectionB);
      }),
  );

  it.effect("follows remote A -> B -> A changes and reconnect snapshots after a prior send", () =>
    Effect.gen(function* () {
      const desktop = new Client();
      const apk = new Client();
      desktop.edit((store) =>
        store.setModelSelection(threadRef, selectionA, {
          explicit: true,
          replaceOptions: true,
          selectionBase: composerModelSelectionBase(server()),
        }),
      );
      yield* expectDispatch(yield* observe(desktop, server()), selectionA);
      desktop.edit((store) => store.clearComposerContent(threadRef));
      for (const thread of [server(selectionB, "run-2"), server(selectionA, "run-3")]) {
        for (const client of [desktop, apk])
          yield* expectDispatch(yield* observe(client, thread), thread.modelSelection);
        desktop.restore();
      }
    }),
  );

  it.effect(
    "replaces same-account remote model/options and keeps prompt and attachment metadata",
    () =>
      Effect.gen(function* () {
        const desktop = new Client();
        const apk = new Client();
        desktop.edit((store) => {
          store.setModelSelection(threadRef, selectionA, {
            explicit: true,
            selectionBase: composerModelSelectionBase(server()),
          });
          store.setPrompt(threadRef, "Unsent text");
          store.addFiles(
            threadRef,
            [
              {
                type: "file",
                id: "unsent-file",
                name: "notes.txt",
                mimeType: "text/plain",
                sizeBytes: 12,
                file: null,
                uploadedAttachmentId: "stored-file",
                uploadEnvironmentId: environmentId,
              },
            ],
            { appendReference: false },
          );
        });
        const next = createModelSelection(accountA, selectionB.model, selectionB.options);
        for (const client of [desktop, apk])
          yield* expectDispatch(yield* observe(client, server(next)), next);
        const draft = Object.values(desktop.state.draftsByThreadKey)[0]!;
        expect(draft.prompt).toBe("Unsent text");
        expect(draft.files).toMatchObject([
          {
            id: "unsent-file",
            uploadedAttachmentId: "stored-file",
            uploadEnvironmentId: environmentId,
          },
        ]);
        expect(draft.modelSelectionExplicit).toBeUndefined();
      }),
  );

  it.effect(
    "preserves a valid explicit handoff through reload, status updates and catalog errors until acknowledgement",
    () =>
      Effect.gen(function* () {
        const desktop = new Client();
        const apk = new Client();
        const base = server();
        desktop.edit((store) => {
          store.setPrompt(threadRef, "Next turn");
          store.setModelSelection(threadRef, selectionB, {
            explicit: true,
            replaceOptions: true,
            selectionBase: composerModelSelectionBase(base),
          });
        });
        desktop.restore();
        yield* expectDispatch(
          yield* observe(desktop, {
            ...base,
            title: "Renamed",
            updatedAt: "2026-10-14T11:00:00.000Z",
          }),
          selectionB,
        );
        yield* expectDispatch(yield* observe(apk, base), selectionA);
        // A provider error leaves the authoritative base unchanged, allowing retry.
        yield* expectDispatch(
          yield* observe(desktop, base, [providers[0]!, provider(accountB, { status: "error" })]),
          selectionB,
        );
        const acknowledged = server(selectionB, "run-2");
        for (const client of [desktop, apk])
          yield* expectDispatch(yield* observe(client, acknowledged), selectionB);
        expect(
          Object.values(desktop.state.draftsByThreadKey)[0]?.modelSelectionExplicit,
        ).toBeUndefined();
      }),
  );

  it.effect(
    "binds explicit trait edits to the displayed remote model and clears default options",
    () =>
      Effect.gen(function* () {
        const desktop = new Client();
        desktop.edit((store) => store.setModelSelection(threadRef, selectionA));
        const remote = server(createModelSelection(accountA, selectionB.model, selectionB.options));
        desktop.edit((store) =>
          store.setProviderModelOptions(threadRef, codex, [], {
            instanceId: accountA,
            model: remote.modelSelection.model,
            persistSticky: true,
            selectionBase: composerModelSelectionBase(remote),
          }),
        );
        const selected = yield* observe(desktop, remote);
        expectSelection(selected, createModelSelection(accountA, selectionB.model));
        expect((yield* dispatch(selected))[0]).toMatchObject({
          modelSelection: { instanceId: accountA, model: selectionB.model },
        });
        const next = server(selectionA, "run-2");
        yield* expectDispatch(yield* observe(desktop, next), selectionA);
      }),
  );

  it.effect.each(["loading", "missing", "disabled", "unavailable"] as const)(
    "never substitutes a same-driver account when the authoritative catalog is %s",
    (state) =>
      Effect.gen(function* () {
        const desktop = new Client();
        const catalog =
          state === "loading"
            ? []
            : state === "missing"
              ? [providers[0]!]
              : [
                  providers[0]!,
                  provider(
                    accountB,
                    state === "disabled" ? { enabled: false } : { availability: "unavailable" },
                  ),
                ];
        const selected = yield* observe(desktop, server(selectionB), catalog);
        expectSelection(selected, selectionB);
        expect(selected.selectedProviderEntry).toBeUndefined();
        expect(selected.unavailableProviderInstanceId).toBe(accountB);
        expect(yield* dispatch(selected)).toEqual([]);
        yield* expectDispatch(yield* observe(desktop, server(selectionB)), selectionB);
      }),
  );

  it.effect(
    "keeps a pending exact account while its catalog loads and discards it after a remote run starts",
    () =>
      Effect.gen(function* () {
        const desktop = new Client();
        desktop.edit((store) =>
          store.setModelSelection(threadRef, selectionB, {
            explicit: true,
            selectionBase: composerModelSelectionBase(server()),
          }),
        );
        const pending = yield* observe(desktop, server(), []);
        expectSelection(pending, selectionB);
        expect(yield* dispatch(pending)).toEqual([]);
        yield* expectDispatch(yield* observe(desktop, server(selectionA, "run-2")), selectionA);
        yield* expectDispatch(yield* observe(desktop, server()), selectionA);
      }),
  );

  it.effect("invalidates an unsent choice when an already queued remote run starts", () =>
    Effect.gen(function* () {
      const desktop = new Client();
      const queued = {
        ...server(),
        latestRun: {
          ...server().latestRun!,
          status: "queued" as const,
          startedAt: null,
          completedAt: null,
        },
      };
      desktop.edit((store) =>
        store.setModelSelection(threadRef, selectionB, {
          explicit: true,
          selectionBase: composerModelSelectionBase(queued),
        }),
      );
      yield* expectDispatch(yield* observe(desktop, queued), selectionB);
      yield* expectDispatch(
        yield* observe(desktop, {
          ...queued,
          latestRun: { ...queued.latestRun, status: "running", startedAt: now },
        }),
        selectionA,
      );
    }),
  );

  it.effect(
    "does not revive pending intent after an observed model change returns to the original base",
    () =>
      Effect.gen(function* () {
        const desktop = new Client();
        desktop.edit((store) =>
          store.setModelSelection(threadRef, selectionB, {
            explicit: true,
            selectionBase: composerModelSelectionBase(server()),
          }),
        );
        yield* observe(desktop, server(createModelSelection(accountA, selectionB.model)));
        yield* expectDispatch(yield* observe(desktop, server()), selectionA);
      }),
  );

  it.effect(
    "uses authoritative thread metadata when a runtime still names the previous driver",
    () =>
      Effect.gen(function* () {
        const thread = {
          ...server(selectionB),
          runtime: {
            status: "running" as const,
            providerName: "claudeAgent",
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            activeRunId: RunId.make("previous-active-run"),
            lastError: null,
            updatedAt: now,
          },
        };
        expect(
          deriveLockedProvider({
            thread,
            selectedProvider: accountA,
            threadProvider: accountB,
            providers,
          }),
        ).toBe(codex);
        const desktop = new Client();
        yield* expectDispatch(yield* observe(desktop, thread), selectionB);
        expect(thread.runtime.activeRunId).toBe("previous-active-run");
        expect(thread.runtime.providerInstanceId).toBe("claudeAgent");
      }),
  );

  it.effect(
    "preserves new-draft sticky defaults and scopes intent to the exact environment/thread",
    () =>
      Effect.gen(function* () {
        const desktop = new Client();
        const draftId = DraftId.make("new-local-draft");
        desktop.edit((store) => {
          store.setStickyModelSelection(selectionB);
          store.applyStickyState(draftId);
        });
        yield* expectDispatch(yield* observe(desktop, undefined, providers, draftId), selectionB);
        desktop.edit((store) =>
          store.setModelSelection(threadRef, selectionB, {
            explicit: true,
            selectionBase: composerModelSelectionBase(server()),
          }),
        );
        const other = { ...server(), environmentId: EnvironmentId.make("other-server") };
        yield* expectDispatch(yield* observe(desktop, other), selectionA);
      }),
  );
});

describe("pending selection during asynchronous send preparation", () => {
  function choosePending(client: Client) {
    client.edit((store) =>
      store.setModelSelection(threadRef, selectionB, {
        explicit: true,
        replaceOptions: true,
        selectionBase: composerModelSelectionBase(server()),
      }),
    );
  }

  it.effect(
    "omits a captured choice invalidated by an observed remote change while uploads wait",
    () =>
      Effect.gen(function* () {
        const desktop = new Client();
        choosePending(desktop);
        const captured = yield* observe(desktop, server());
        const waiting = yield* Deferred.make<void>();
        const releaseUpload = yield* Deferred.make<void>();
        const pending = yield* dispatch(
          captured,
          Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(releaseUpload))),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        const remote = createModelSelection(accountA, selectionB.model, selectionB.options);
        yield* observe(desktop, server(remote, "remote-run"));
        expect(
          Object.values(desktop.state.draftsByThreadKey)[0]?.modelSelectionExplicit,
        ).toBeUndefined();
        yield* Deferred.succeed(releaseUpload, undefined);
        const commands = yield* Fiber.join(pending);
        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject({ type: "message.dispatch", threadId });
        expect(commands[0]).not.toHaveProperty("modelSelection");
      }),
  );

  it.effect(
    "retains an unchanged captured choice through deferred settings and content edits",
    () =>
      Effect.gen(function* () {
        const desktop = new Client();
        choosePending(desktop);
        const captured = yield* observe(desktop, server());
        const waiting = yield* Deferred.make<void>();
        const releaseSettings = yield* Deferred.make<void>();
        const pending = yield* dispatch(
          captured,
          Deferred.succeed(waiting, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSettings)),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        desktop.edit((store) => store.setPrompt(threadRef, "Typed while preparing"));
        yield* observe(desktop, {
          ...server(),
          title: "Renamed",
          updatedAt: "2026-10-14T12:00:00.000Z",
        });
        yield* Deferred.succeed(releaseSettings, undefined);
        expect(yield* Fiber.join(pending)).toMatchObject([{ modelSelection: selectionB }]);
        expect(Object.values(desktop.state.draftsByThreadKey)[0]?.prompt).toBe(
          "Typed while preparing",
        );
      }),
  );

  it.effect("does not retarget a captured message to a replacement local choice", () =>
    Effect.gen(function* () {
      const desktop = new Client();
      choosePending(desktop);
      const captured = yield* observe(desktop, server());
      const waiting = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const pending = yield* dispatch(
        captured,
        Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(waiting);
      desktop.edit((store) =>
        store.setModelSelection(threadRef, selectionA, {
          explicit: true,
          replaceOptions: true,
          selectionBase: composerModelSelectionBase(server()),
        }),
      );
      yield* Deferred.succeed(release, undefined);
      const [command] = yield* Fiber.join(pending);
      expect(command).not.toHaveProperty("modelSelection");
      expect(Object.values(desktop.state.draftsByThreadKey)[0]?.modelSelectionExplicit).toBe(true);
    }),
  );

  it.effect.each([false, true])(
    "revalidates after a deferred legacy projection (remote changed: %s)",
    (remoteChanged) =>
      Effect.gen(function* () {
        const desktop = new Client();
        choosePending(desktop);
        const captured = yield* observe(desktop, server());
        const waiting = yield* Deferred.make<void>();
        const releaseProjection = yield* Deferred.make<void>();
        const pending = yield* dispatch(
          captured,
          Effect.void,
          threadRef,
          Deferred.succeed(waiting, undefined).pipe(
            Effect.andThen(Deferred.await(releaseProjection)),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        if (remoteChanged) yield* observe(desktop, server(selectionA, "remote-run"));
        else desktop.edit((store) => store.setPrompt(threadRef, "Keep the captured choice"));
        yield* Deferred.succeed(releaseProjection, undefined);
        const [command] = yield* Fiber.join(pending);
        expect(command).toMatchObject({ type: "message.dispatch", threadId });
        expect(command).not.toHaveProperty("getModelSelectionForDispatch");
        if (remoteChanged) expect(command).not.toHaveProperty("modelSelection");
        else expect(command).toMatchObject({ modelSelection: selectionB });
      }),
  );

  it.effect.each([false, true])(
    "stays on the original thread after navigation (remote changed: %s)",
    (remoteChanged) =>
      Effect.gen(function* () {
        const desktop = new Client();
        choosePending(desktop);
        const captured = yield* observe(desktop, server());
        const waiting = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const pending = yield* dispatch(
          captured,
          Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        const other = {
          ...server(),
          environmentId: EnvironmentId.make("other-server"),
          id: ThreadId.make("other-thread"),
        };
        const otherRef = scopeThreadRef(other.environmentId, other.id);
        desktop.edit((store) =>
          store.setModelSelection(otherRef, selectionA, {
            explicit: true,
            replaceOptions: true,
            selectionBase: composerModelSelectionBase(other),
          }),
        );
        yield* observe(desktop, other, providers, otherRef);
        // The original composer is no longer mounted. Its live scoped shell still
        // invalidates the captured choice without reading the newly displayed one.
        if (remoteChanged) observeShell(server(selectionA, "remote-run"));
        yield* Deferred.succeed(release, undefined);
        const [command] = yield* Fiber.join(pending);
        expect(command).toMatchObject({ threadId });
        if (remoteChanged) expect(command).not.toHaveProperty("modelSelection");
        else expect(command).toMatchObject({ modelSelection: selectionB });
      }),
  );
});

describe("pending selection while its composer is unmounted", () => {
  const selectionC = createModelSelection(accountB, "gpt-5.4");
  const attachment = {
    id: "pending-file",
    type: "file" as const,
    name: "pending.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
    file: null,
    uploadedAttachmentId: "fixture-upload",
    uploadEnvironmentId: environmentId,
  };
  let stopSync: (() => void) | undefined;
  beforeEach(() => {
    stopSync = installComposerSelectionIntentSync();
  });
  afterEach(() => stopSync?.());

  function choosePending(client: Client) {
    client.edit((store) => {
      store.setPrompt(threadRef, "Keep this pending draft");
      store.addFiles(threadRef, [attachment]);
      store.setStickyModelSelection(selectionC);
      store.setModelSelection(threadRef, selectionC, {
        explicit: true,
        replaceOptions: true,
        selectionBase: composerModelSelectionBase(server()),
      });
    });
  }

  it.effect("invalidates before an unmounted B -> A return and the prepared RPC dispatch", () =>
    Effect.gen(function* () {
      const desktop = new Client();
      choosePending(desktop);
      const captured = yield* observe(desktop, server());
      expectSelection(captured, selectionC);
      const waiting = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const pending = yield* dispatch(
        captured,
        Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(waiting);
      const other = { ...server(), id: ThreadId.make("newly-displayed-thread") };
      yield* observe(desktop, other, providers, scopeThreadRef(other.environmentId, other.id));
      // The original composer is unmounted. Neither shell update gets a React
      // render/effect; the run identity is unchanged throughout.
      observeShell(server(selectionB));
      observeShell(server(selectionA));
      const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
      expect(draft?.modelSelectionExplicit).toBeUndefined();
      expect(draft?.prompt).toBe("Keep this pending draft");
      expect(draft?.files).toEqual([attachment]);
      expect(draft?.modelSelectionByProvider[accountB]).toEqual(selectionC);
      expect(useComposerDraftStore.getState().stickyActiveProvider).toBe(accountB);
      yield* Deferred.succeed(release, undefined);
      const [command] = yield* Fiber.join(pending);
      expect(command).toMatchObject({ type: "message.dispatch", threadId });
      expect(command).not.toHaveProperty("modelSelection");
      desktop.state = useComposerDraftStore.getState();
      const remounted = yield* observe(desktop, server());
      expectSelection(remounted, selectionA);
      yield* expectDispatch(remounted, selectionA);
    }),
  );

  it.effect("invalidates restored intent after loading without an in-flight send", () =>
    Effect.gen(function* () {
      const desktop = new Client();
      choosePending(desktop);
      desktop.restore();
      useComposerDraftStore.setState(desktop.state, true);
      const restoredDraft = useComposerDraftStore.getState().getComposerDraft(threadRef);
      // No shell was loaded when the restored choice was registered.
      expect(
        useComposerDraftStore.getState().getComposerDraft(threadRef)?.modelSelectionExplicit,
      ).toBe(true);
      observeShell(server());
      expect(
        useComposerDraftStore.getState().getComposerDraft(threadRef)?.modelSelectionExplicit,
      ).toBe(true);
      observeShell(server(selectionB));
      observeShell(server());
      desktop.state = useComposerDraftStore.getState();
      const remounted = yield* observe(desktop, server());
      expectSelection(remounted, selectionA);
      expect(remounted.modelSelectionForDispatch).toBeUndefined();
      expect(desktop.state.getComposerDraft(threadRef)?.prompt).toBe(restoredDraft?.prompt);
      expect(desktop.state.getComposerDraft(threadRef)?.files).toEqual(restoredDraft?.files);
      expect(desktop.state.stickyModelSelectionByProvider[accountB]).toEqual(selectionC);
    }),
  );

  it.effect(
    "keeps unchanged intent across navigation and isolates thread/environment updates",
    () =>
      Effect.gen(function* () {
        const desktop = new Client();
        choosePending(desktop);
        const captured = yield* observe(desktop, server());
        const waiting = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const pending = yield* dispatch(
          captured,
          Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        for (const other of [
          { ...server(selectionB), environmentId: EnvironmentId.make("other-server") },
          { ...server(selectionB), id: ThreadId.make("other-thread") },
        ]) {
          yield* observe(desktop, other, providers, scopeThreadRef(other.environmentId, other.id));
          observeShell({ ...other, modelSelection: selectionA });
        }
        desktop.state = useComposerDraftStore.getState();
        expectSelection(yield* observe(desktop, server()), selectionC);
        yield* Deferred.succeed(release, undefined);
        const [command] = yield* Fiber.join(pending);
        expect(command).toMatchObject({ threadId, modelSelection: selectionC });
      }),
  );

  it.effect("does not retarget an invalidated capture to a fresh choice after B -> A", () =>
    Effect.gen(function* () {
      const desktop = new Client();
      choosePending(desktop);
      const captured = yield* observe(desktop, server());
      const waiting = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const pending = yield* dispatch(
        captured,
        Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(waiting);
      observeShell(server(selectionB));
      observeShell(server());
      useComposerDraftStore.getState().setModelSelection(threadRef, selectionB, {
        explicit: true,
        replaceOptions: true,
        selectionBase: composerModelSelectionBase(server()),
      });
      yield* Deferred.succeed(release, undefined);
      const [command] = yield* Fiber.join(pending);
      expect(command).not.toHaveProperty("modelSelection");
      desktop.state = useComposerDraftStore.getState();
      yield* expectDispatch(yield* observe(desktop, server()), selectionB);
    }),
  );

  it.effect("closes shell subscriptions when intent clears and when the root disposes", () =>
    Effect.sync(() => {
      stopSync?.();
      const subscribe = appAtomRegistry.subscribe.bind(appAtomRegistry);
      const stopped = vi.fn();
      const subscribed = vi
        .spyOn(appAtomRegistry, "subscribe")
        .mockImplementation((atom, f, options) => {
          const stop = subscribe(atom, f, options);
          return () => {
            stopped();
            stop();
          };
        });
      stopSync = installComposerSelectionIntentSync();
      const desktop = new Client();
      choosePending(desktop);
      expect(subscribed).toHaveBeenCalledTimes(1);
      observeShell(server(selectionB));
      expect(stopped).toHaveBeenCalledTimes(1);
      observeShell(server());
      desktop.state = useComposerDraftStore.getState();
      choosePending(desktop);
      expect(subscribed).toHaveBeenCalledTimes(2);
      stopSync();
      expect(stopped).toHaveBeenCalledTimes(2);
      observeShell(server(selectionB));
      observeShell(server());
      expect(
        useComposerDraftStore.getState().getComposerDraft(threadRef)?.modelSelectionExplicit,
      ).toBe(true);
      useComposerDraftStore.getState().setPrompt(threadRef, "Root is disposed");
      expect(subscribed).toHaveBeenCalledTimes(2);
      stopSync = undefined;
    }),
  );
});
