// @effect-diagnostics nodeBuiltinImport:off globalDate:off — isolated local HTTP/CLI regression fixtures.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import { CoordinatorStore } from "@t3tools/shared/forkMaintenanceStore";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { createLivePairingLink, LocalPairingError } from "./localPairing.ts";
import { issueOperatorToken, OPERATOR_TOKEN_HEADER } from "../maintenance/operatorAuth.ts";

const roots: string[] = [];
const servers: NodeHttp.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(status = 200) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-live-pairing-"));
  roots.push(root);
  const home = NodePath.join(root, "home");
  await NodeFSP.mkdir(NodePath.join(home, "userdata"), { recursive: true });
  const store = await CoordinatorStore.open(NodePath.join(root, "coordinator"));
  await store.register(
    { id: "live-server", label: "Live server", kind: "desktop", homes: [home], updateTarget: true },
    Date.now(),
  );
  const token = await issueOperatorToken(home);
  const requests: unknown[] = [];
  const server = NodeHttp.createServer((request, response) => {
    if (request.headers[OPERATOR_TOKEN_HEADER] !== token) {
      response.writeHead(401);
      response.end();
      return;
    }
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => {
      const input = JSON.parse(text);
      requests.push(input);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "issued-by-live-server",
          credential: "TESTPAIRCODE",
          scopes: input.scopes,
          subject: "one-time-token",
          label: input.label,
          createdAt: "2026-01-01T00:00:00Z",
          expiresAt: "2026-01-01T00:05:00Z",
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP listener.");
  const origin = `http://127.0.0.1:${address.port}`;
  await NodeFSP.writeFile(
    NodePath.join(home, "userdata", "server-runtime.json"),
    JSON.stringify({ pid: process.pid, origin }),
  );
  return { home, store, requests };
}

describe("pairing through a running server", () => {
  it.effect(
    "pairs while another runtime owns the home without opening a database or registering a second owner",
    () =>
      Effect.gen(function* () {
        const { home, store, requests } = yield* Effect.promise(() => fixture());
        const issued = yield* createLivePairingLink(
          { baseDir: home },
          { scopes: AuthStandardClientScopes, label: "SSH client" },
        );
        expect(Option.isSome(issued) && issued.value.id).toBe("issued-by-live-server");
        expect(requests).toEqual([{ scopes: AuthStandardClientScopes, label: "SSH client" }]);
        const status = yield* Effect.promise(() => store.status(Date.now()));
        expect(status.participants.map((p) => p.id)).toEqual(["live-server"]);
        expect(
          yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(home, "userdata"))),
        ).toEqual(["server-runtime.json"]);
      }),
  );

  it.effect.each([409, 404])(
    "does not fall back to database access when the live server refuses with %s",
    (status) =>
      Effect.gen(function* () {
        const { home } = yield* Effect.promise(() => fixture(status));
        const result = yield* Effect.flip(
          createLivePairingLink({ baseDir: home }, { scopes: AuthStandardClientScopes }),
        );
        expect(result).toBeInstanceOf(LocalPairingError);
        expect(result.stage).toBe(status === 404 ? "server-upgrade" : "response");
        expect(
          yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(home, "userdata"))),
        ).toEqual(["server-runtime.json"]);
      }),
  );

  it.effect("rejects a nonlocal runtime origin before sending the owner credential", () =>
    Effect.gen(function* () {
      const { home, requests } = yield* Effect.promise(() => fixture());
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(home, "userdata", "server-runtime.json"),
          JSON.stringify({ pid: process.pid, origin: "https://example.com" }),
        ),
      );
      const result = yield* Effect.flip(
        createLivePairingLink({ baseDir: home }, { scopes: AuthStandardClientScopes }),
      );
      expect(result.stage).toBe("discovery");
      expect(requests).toEqual([]);
    }),
  );
});
