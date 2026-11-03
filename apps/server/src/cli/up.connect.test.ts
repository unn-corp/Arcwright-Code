import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";
import * as BootService from "../cloud/bootService.ts";
import * as Connect from "./connect.ts";
import { upCommand } from "./up.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("t3 up admission", (it) => {
  it.effect("rejects Connect setup before link or service lifecycle work", () =>
    Effect.gen(function* () {
      const link = vi.spyOn(Connect, "linkEnvironmentForConnect");
      const unlink = vi.spyOn(Connect, "disconnectCloud");
      const service = vi.spyOn(BootService, "layer");
      const error = yield* Command.runWith(upCommand, { version: "0.0.0" })([
        "--connect",
        "--yes",
      ]).pipe(Effect.flip);
      expect(error.message).toContain("unavailable until maintenance admission is supported");
      expect(link).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
      expect(service).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }),
  );
});
