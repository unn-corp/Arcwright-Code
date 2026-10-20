import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import { decryptChromiumValue } from "../preview/BrowserImport/ChromiumCookies.ts";
import { resolveChromiumKeys } from "../preview/BrowserImport/ChromiumKeys.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export class DesktopSafeStorageIdentity extends Context.Service<
  DesktopSafeStorageIdentity,
  {
    readonly decryptWithPreviousName: (
      encrypted: Uint8Array,
    ) => Effect.Effect<Option.Option<string>>;
  }
>()("@t3tools/desktop/app/DesktopSafeStorageIdentity") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();

  const decryptWithPreviousName = Effect.fn("desktop.safeStorageIdentity.decryptWithPreviousName")(
    function* (encrypted: Uint8Array) {
      if (environment.platform !== "darwin" && environment.platform !== "linux") {
        return Option.none<string>();
      }
      // Cookie imports also accept plaintext; safeStorage requires an OSCrypt prefix.
      const prefix = Buffer.from(encrypted.subarray(0, 3)).toString("latin1");
      if (prefix !== (environment.platform === "darwin" ? "v10" : "v11")) {
        return Option.none<string>();
      }
      // Chromium may have captured the package name before app.setName or the
      // channel name after it. Branding must not strand either saved catalog.
      const previousNames = [
        "T3 Code (Beta)",
        "Arcwright Code",
        "Arcwright Code Beta",
        "Arcwright Code Alpha",
        "Arcwright Code Nightly",
        "Arcwright Code (Alpha)",
        "Arcwright Code (Nightly)",
      ];
      const decodeCatalog = Schema.decodeOption(Schema.fromJsonString(ConnectionCatalogDocument));
      for (const name of previousNames) {
        const keys = yield* resolveChromiumKeys({
          platform: environment.platform,
          keychainService: `${name} Safe Storage`,
          keychainAccount: name,
          linuxSecretApplication: name,
        }).pipe(Effect.option);
        const decrypted = Option.flatMapNullishOr(keys, (material) =>
          decryptChromiumValue(encrypted, material, "", undefined, environment.platform),
        );
        // CBC can produce valid padding under a wrong key. Keep searching until
        // the decoded value is a catalog, without rewriting the original bytes.
        if (Option.isSome(decrypted) && Option.isSome(decodeCatalog(decrypted.value))) {
          return decrypted;
        }
      }
      return Option.none<string>();
    },
    Effect.provide(services),
  );

  return DesktopSafeStorageIdentity.of({ decryptWithPreviousName });
});

export const layer = Layer.effect(DesktopSafeStorageIdentity, make);
