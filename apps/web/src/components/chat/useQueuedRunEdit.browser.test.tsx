import { useLayoutEffect } from "react";
import { act, render } from "../../../test/render";
import {
  EnvironmentId,
  MessageId,
  RunId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "../../composerDraftStore";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { useQueuedRunEdit } from "./useQueuedRunEdit";

const state = vi.hoisted(() => ({ edit: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.edit }));
vi.mock("../../assets/assetUrls", () => ({ useAssetUrls: () => [] }));

it.each([true, false])(
  "preserves a queued quote through editing, unless removed (keep: %s)",
  async (keepReply) => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    state.edit.mockReset().mockResolvedValue({ _tag: "Success" });
    const base = makeThreadProjectionFixture();
    const threadId = base.thread.id;
    const runId = RunId.make("queued-run");
    const messageId = MessageId.make("queued-message");
    const replyTo = {
      threadId,
      messageId: MessageId.make("quoted-message"),
      role: "assistant" as const,
      text: "Quoted answer",
    };
    const projection: OrchestrationV2ThreadProjection = {
      ...base,
      messages: [
        {
          id: messageId,
          threadId,
          runId,
          nodeId: null,
          role: "user",
          text: "Follow up",
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: base.updatedAt,
          updatedAt: base.updatedAt,
          context: { version: 1, replyTo, records: [] },
        },
      ],
      runs: [
        {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: base.thread.providerInstanceId,
          modelSelection: base.thread.modelSelection,
          providerThreadId: null,
          userMessageId: messageId,
          rootNodeId: null,
          activeAttemptId: null,
          status: "queued",
          requestedAt: base.updatedAt,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      ],
    };
    const environmentId = EnvironmentId.make("remote-host");
    const target = scopeThreadRef(environmentId, threadId);
    const input = {
      environmentId,
      routeThreadRef: target,
      threadDraftTarget: target,
      activeThreadId: threadId,
      serverProjection: projection,
      promptRef: { current: "Follow up" },
      composerRef: { current: null },
    };
    let editor!: ReturnType<typeof useQueuedRunEdit>;
    function Probe() {
      const edit = useQueuedRunEdit(input);
      useLayoutEffect(() => {
        editor = edit;
      });
      return <div>{edit.isEditing ? "Editing" : "Ready"}</div>;
    }
    await using screen = await render(<Probe />, { router: false });
    const container = screen.container;
    await act(() => editor.beginEdit({ runId, messageId, text: "Follow up", attachments: [] }));
    const store = useComposerDraftStore.getState();
    expect(container.textContent).toBe("Editing");
    expect(store.getComposerDraft(editor.draftTarget)?.replyTo).toEqual(replyTo);
    if (!keepReply) store.setReplyTo(editor.draftTarget, null);
    await act(() =>
      editor.saveEdit(
        {
          prompt: "Edited follow up",
          replyTo: store.getComposerDraft(editor.draftTarget)?.replyTo ?? undefined,
          images: [],
          files: [],
          terminalContexts: [],
          reviewComments: [],
          previewAnnotations: [],
          threadContexts: [],
        },
        vi.fn(),
      ),
    );
    expect(state.edit).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        threadId,
        runId,
        text: "Edited follow up",
        edit: {
          messageId,
          attachments: [],
          context: { version: 1, records: [], ...(keepReply ? { replyTo } : {}) },
        },
      },
    });
    expect(container.textContent).toBe("Ready");
  },
);
