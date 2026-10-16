// @effect-diagnostics nodeBuiltinImport:off -- Native grep must run outside the server event loop.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeSea from "node:sea";
import * as NodeTimers from "node:timers";
import type { FileFinder, Result } from "@ff-labs/fff-node";

/** Entry reached before the server graph loads, in source, bundle and SEA builds. */
export function runContentSearchProcess(): void {
  let finder: FileFinder | undefined;
  process.on("disconnect", () => process.exit(0));
  process.on(
    "message",
    async (request: { id: number; method: Method | "create"; args: unknown[] }) => {
      try {
        let value: unknown;
        if (request.method === "create") {
          const [modulePath, options] = request.args as [
            string,
            Parameters<typeof FileFinder.create>[0],
          ];
          const { FileFinder } = NodeModule.createRequire(import.meta.url)(
            modulePath,
          ) as typeof import("@ff-labs/fff-node");
          const result = FileFinder.create(options);
          if (result.ok) finder = result.value;
          value = result.ok ? { ok: true, value: undefined } : result;
        } else {
          if (finder === undefined) throw new Error("Content index is not initialized.");
          // The parent owns this IPC channel and sends only the selected method's arguments.
          const invoke = finder[request.method].bind(finder) as (...args: unknown[]) => unknown;
          value = await invoke(...request.args);
        }
        process.send?.({ id: request.id, value });
      } catch (error) {
        process.send?.({
          id: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

type Method =
  | "grep"
  | "fileSearch"
  | "directorySearch"
  | "mixedSearch"
  | "scanFiles"
  | "waitForIndexReady";

/** Scoped adapter for the native content index. All calls execute on its owning process. */
export class ContentSearchProcess {
  private nextId = 0;
  private failure: Error | undefined;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly worker: NodeChildProcess.ChildProcess;
  private readonly modulePath: string;
  private readonly closed: Promise<void>;
  private exited = false;

  constructor(modulePath: string) {
    this.modulePath = modulePath;
    const entry = import.meta.url.endsWith(".ts")
      ? NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url))
      : process.argv[1]!;
    this.worker = NodeChildProcess.spawn(
      process.execPath,
      [...(NodeSea.isSea() ? [] : [entry]), "__workspace-content"],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
      },
    );
    this.closed = new Promise((resolve) =>
      this.worker.once("close", () => {
        this.exited = true;
        resolve();
      }),
    );
    this.worker.on("message", (reply: { id: number; value?: unknown; error?: string }) => {
      const pending = this.pending.get(reply.id);
      if (pending === undefined) return;
      this.pending.delete(reply.id);
      if (reply.error !== undefined) pending.reject(new Error(reply.error));
      else pending.resolve(reply.value);
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code, signal) =>
      this.fail(new Error(`Content search process exited (${signal ?? code}).`)),
    );
  }

  private fail(error: Error) {
    this.failure ??= error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private request<A>(method: string, args: ReadonlyArray<unknown>): Promise<A> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise<A>((resolve, reject) => {
      const id = this.nextId++;
      // Replies originate only from the owned process, whose method determines A.
      this.pending.set(id, { resolve: (value) => resolve(value as A), reject });
      try {
        this.worker.send({ id, method, args }, (error) => {
          if (error !== null) {
            this.pending.delete(id);
            reject(error);
          }
        });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  create(options: Parameters<typeof FileFinder.create>[0]) {
    return this.request<Result<void>>("create", [this.modulePath, options]);
  }

  private call<K extends Method>(method: K, args: Parameters<FileFinder[K]>) {
    return this.request<Awaited<ReturnType<FileFinder[K]>>>(method, args);
  }

  grep(...args: Parameters<FileFinder["grep"]>) {
    return this.call("grep", args);
  }
  fileSearch(...args: Parameters<FileFinder["fileSearch"]>) {
    return this.call("fileSearch", args);
  }
  directorySearch(...args: Parameters<FileFinder["directorySearch"]>) {
    return this.call("directorySearch", args);
  }
  mixedSearch(...args: Parameters<FileFinder["mixedSearch"]>) {
    return this.call("mixedSearch", args);
  }
  scanFiles() {
    return this.call("scanFiles", []);
  }
  waitForIndexReady(...args: Parameters<FileFinder["waitForIndexReady"]>) {
    return this.call("waitForIndexReady", args);
  }
  // Only path indexes can be returned before their initial scan completes.
  isScanning() {
    return false;
  }

  async destroy() {
    this.fail(new Error("Content search index was disposed."));
    if (this.exited) return;
    this.worker.kill();
    // Only our captured helper is eligible for escalation; a stuck native call
    // must not prevent the owning scope from closing.
    // @effect-diagnostics-next-line globalTimers:off -- This Promise adapter owns its process deadline; executing Effect.sleep here would require a nested runtime.
    const force = NodeTimers.setTimeout(() => {
      this.worker.kill("SIGKILL");
    }, 1000);
    force.unref();
    try {
      await this.closed;
    } finally {
      NodeTimers.clearTimeout(force);
    }
  }
}
