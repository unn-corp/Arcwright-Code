import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  getSwitchValueMock,
  hasSwitchMock,
  registerSchemesMock,
  setDesktopNameMock,
  setNameMock,
  appState,
  mkdirSyncMock,
  readFileSyncMock,
  writeFileSyncMock,
  copyFileSyncMock,
  execFileSyncMock,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  getSwitchValueMock: vi.fn(),
  hasSwitchMock: vi.fn(),
  registerSchemesMock: vi.fn(),
  setDesktopNameMock: vi.fn(),
  setNameMock: vi.fn(),
  appState: { version: "0.0.37", isPackaged: true },
  mkdirSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  copyFileSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    setDesktopName: setDesktopNameMock,
    setName: setNameMock,
    getVersion: () => appState.version,
    get isPackaged() {
      return appState.isPackaged;
    },
    getAppPath: () => "/tmp/.mount_T3/resources/app.asar",
    commandLine: {
      appendSwitch: appendSwitchMock,
      getSwitchValue: getSwitchValueMock,
      hasSwitch: hasSwitchMock,
    },
  },
  protocol: {
    registerSchemesAsPrivileged: registerSchemesMock,
  },
}));

vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  copyFileSync: copyFileSyncMock,
}));

import { desktopLauncherIconName } from "./DesktopLauncherIcon.ts";
vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";

const iconSource = "/tmp/.mount_T3/resources/app.asar/apps/desktop/prod-resources/icon.png";

const desktopEntryPath = "/xdg/applications/com.t3tools.T3Code.desktop";
const iconBytes = Buffer.from([0x89, 0x50, 0x00, 0xff, 0x80, 0x0a]);
const iconPath = `/xdg/icons/${desktopLauncherIconName("com.t3tools.T3Code.desktop", iconBytes)}`;

describe("DesktopPreReadyPlatform", () => {
  beforeEach(() => {
    appendSwitchMock.mockReset();
    getSwitchValueMock.mockReset();
    hasSwitchMock.mockReset();
    registerSchemesMock.mockReset();
    setDesktopNameMock.mockReset();
    setNameMock.mockReset();
    appState.version = "0.0.37";
    appState.isPackaged = true;
    mkdirSyncMock.mockReset();
    readFileSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    copyFileSyncMock.mockReset();
    execFileSyncMock.mockReset();
    readFileSyncMock.mockReset().mockImplementation((path: string) => {
      if (path.endsWith("/desktop-settings.json")) return "{}";
      if (path === iconSource) return Buffer.from(iconBytes);
      throw new Error(`missing file: ${path}`);
    });
  });

  it.effect("persists Linux scaling synchronously across relaunches and settings rewrites", () => {
    vi.stubEnv("T3CODE_HOME", "/isolated");
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    const settingsPath = "/isolated/userdata/desktop-settings.json";
    const files = new Map([[settingsPath, "{}"]]);
    const commandLine = new Map<string, string>();
    readFileSyncMock.mockImplementation((path: string) => {
      const contents = files.get(path);
      if (contents === undefined) throw new Error("ENOENT");
      return contents;
    });
    writeFileSyncMock.mockImplementation((path: string, contents: string) => {
      files.set(path, contents);
    });
    hasSwitchMock.mockImplementation((name: string) => commandLine.has(name));
    getSwitchValueMock.mockImplementation((name: string) => commandLine.get(name) ?? "");
    appendSwitchMock.mockImplementation((name: string, value: string) => {
      commandLine.set(name, value);
    });
    const launch = Effect.gen(function* () {
      const startup = Promise.resolve().then(() => commandLine.get("force-device-scale-factor"));
      yield* DesktopPreReadyPlatform.make;
      return yield* Effect.promise(() => startup);
    });

    return Effect.gen(function* () {
      for (const explicitScale of ["1.75", "1"]) {
        commandLine.clear();
        commandLine.set("force-device-scale-factor", explicitScale);
        appendSwitchMock.mockClear();
        assert.equal(yield* launch, explicitScale);
        assert.isFalse(
          appendSwitchMock.mock.calls.some(([name]) => name === "force-device-scale-factor"),
        );

        // The settings service discards fields it does not own when rewriting its document.
        files.set(settingsPath, JSON.stringify({ linuxPasswordStore: "basic" }));
        commandLine.clear();
        assert.equal(yield* launch, explicitScale);
      }
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  });

  it.effect.each([
    { previousEntry: undefined, label: "missing", wrapper: undefined },
    {
      previousEntry: 'Exec="/Applications/deleted-previous.AppImage" %U',
      label: "stale",
      wrapper: undefined,
    },
    {
      previousEntry: undefined,
      label: "wrapper",
      wrapper: "/home/alice/.local/bin/arcwright-code",
    },
  ])(
    "prepares a $label Linux desktop entry before startup yields",
    ({ previousEntry, wrapper }) => {
      vi.stubEnv("VITE_DEV_SERVER_URL", "");
      vi.stubEnv("XDG_DATA_HOME", "/xdg");
      vi.stubEnv("APPIMAGE", "/Applications/current.AppImage");
      vi.stubEnv("T3CODE_URL_HANDLER_EXEC_TARGET", wrapper);
      getSwitchValueMock.mockReturnValue("");
      let desktopName = "t3code.desktop";
      let desktopEntry = previousEntry;
      let iconInstalled = false;
      setDesktopNameMock.mockImplementation((name: string) => {
        desktopName = name;
      });
      writeFileSyncMock.mockImplementation((path: string, contents: string | Buffer) => {
        if (path === iconPath)
          iconInstalled = Buffer.isBuffer(contents) && contents.equals(iconBytes);
        if (path === desktopEntryPath && typeof contents === "string") desktopEntry = contents;
      });

      return Effect.scoped(
        Effect.gen(function* () {
          const portalIdentity = Promise.resolve().then(() => ({
            desktopName,
            desktopEntry,
            iconInstalled,
          }));
          yield* Layer.build(
            DesktopPreReadyPlatform.layer.pipe(
              Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
            ),
          );
          const identity = yield* Effect.promise(() => portalIdentity);
          assert.equal(identity.desktopName, "com.t3tools.T3Code.desktop");
          assert.include(
            identity.desktopEntry ?? "",
            `Exec=${wrapper ?? "/Applications/current.AppImage"} %U`,
          );
          assert.include(identity.desktopEntry ?? "", "Name=Arcwright Code");
          assert.include(identity.desktopEntry ?? "", "MimeType=x-scheme-handler/t3code;");
          assert.include(identity.desktopEntry ?? "", `Icon=${iconPath}`);
          assert.isTrue(identity.iconInstalled);
          assert.deepEqual(
            readFileSyncMock.mock.calls.filter(([path]) => path === iconSource),
            [[iconSource]],
          );
          assert.deepEqual(
            writeFileSyncMock.mock.calls.filter(([path]) => path === iconPath),
            [[iconPath, iconBytes, { mode: 0o600 }]],
          );
          assert.equal(copyFileSyncMock.mock.calls.length, 0);
        }),
      ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
    },
  );

  it.effect.each([
    { platform: "linux" as const, version: "0.1.0", isPackaged: true },
    { platform: "darwin" as const, version: "0.1.1-preview.20261017.3", isPackaged: false },
    { platform: "win32" as const, version: "0.1.0", isPackaged: true },
  ])(
    "preserves the $platform encryption identity before startup yields",
    ({ platform, version, isPackaged }) => {
      appState.version = version;
      appState.isPackaged = isPackaged;
      getSwitchValueMock.mockReturnValue("");
      let appName = "T3 Code (Beta)";
      setNameMock.mockImplementation((name: string) => {
        appName = name;
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const nameBeforeYield = Promise.resolve().then(() => appName);
          yield* Layer.build(
            DesktopPreReadyPlatform.layer.pipe(
              Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
            ),
          );
          assert.equal(
            yield* Effect.promise(() => nameBeforeYield),
            platform === "win32" ? "T3 Code (Beta)" : "T3 Code (Alpha)",
          );
        }),
      );
    },
  );

  it.effect("refreshes a stale icon once across repeated launches", () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    vi.stubEnv("XDG_DATA_HOME", "/xdg");
    getSwitchValueMock.mockReturnValue("");
    let installedIcon = Buffer.from([0x89, 0x50, 0x00, 0xfe, 0x80, 0x0a]);
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === iconSource) return Buffer.from(iconBytes);
      if (path === iconPath) return Buffer.from(installedIcon);
      return "{}";
    });
    writeFileSyncMock.mockImplementation((path: string, contents: Buffer) => {
      if (path === iconPath) installedIcon = Buffer.from(contents);
    });

    return Effect.gen(function* () {
      yield* DesktopPreReadyPlatform.make;
      assert.deepEqual(installedIcon, iconBytes);
      yield* DesktopPreReadyPlatform.make;
      assert.deepEqual(
        writeFileSyncMock.mock.calls.filter(([path]) => path === iconPath),
        [[iconPath, iconBytes, { mode: 0o600 }]],
      );
      assert.equal(copyFileSyncMock.mock.calls.length, 0);
      assert.equal(
        writeFileSyncMock.mock.calls.filter(([path]) => path === desktopEntryPath).length,
        2,
      );
      assert.equal(setDesktopNameMock.mock.calls.length, 2);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  });

  it.effect("still prepares the portal entry when the bundled icon cannot be read", () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    vi.stubEnv("XDG_DATA_HOME", "/xdg");
    getSwitchValueMock.mockReturnValue("");
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === iconSource) throw new Error("unreadable bundled icon");
      return "{}";
    });
    return Effect.gen(function* () {
      yield* DesktopPreReadyPlatform.make;
      assert.isTrue(readFileSyncMock.mock.calls.some(([path]) => path === iconSource));
      assert.equal(copyFileSyncMock.mock.calls.length, 0);
      assert.equal(writeFileSyncMock.mock.calls.length, 1);
      const [path, contents] = writeFileSyncMock.mock.calls[0]!;
      assert.equal(path, desktopEntryPath);
      assert.include(contents, "MimeType=x-scheme-handler/t3code;");
      assert.include(contents, "Icon=/xdg/icons/com.t3tools.T3Code.desktop.png");
      assert.equal(setDesktopNameMock.mock.calls.length, 1);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  });

  it.effect("points the early portal entry at a configured distribution launcher", () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    vi.stubEnv("XDG_DATA_HOME", "/xdg");
    vi.stubEnv("APPIMAGE", "/Applications/current.AppImage");
    vi.stubEnv("T3CODE_DESKTOP_LAUNCHER_PATH", " /opt/T3 Code/t3code ");
    getSwitchValueMock.mockReturnValue("");

    return Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(
          DesktopPreReadyPlatform.layer.pipe(
            Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
          ),
        );
        const entry = writeFileSyncMock.mock.calls.find(
          ([path]) => path === "/xdg/applications/com.t3tools.T3Code.desktop",
        )?.[1];
        assert.include(entry, 'Exec="/opt/T3 Code/t3code" %U');
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
  });

  it.effect(
    "acquires a synchronous pre-ready layer before an asynchronous Clerk-shaped layer",
    () =>
      Effect.gen(function* () {
        class ClerkShaped extends Context.Service<ClerkShaped, { readonly ready: true }>()(
          "@t3tools/desktop/app/DesktopPreReadyPlatform.test/ClerkShaped",
        ) {}

        const events: Array<string> = [];
        registerSchemesMock.mockImplementation(() => {
          events.push("pre-ready");
        });

        const layerPreReady = DesktopPreReadyPlatform.layer.pipe(
          Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
        );

        const layerClerkShaped = Layer.effect(
          ClerkShaped,
          Effect.promise(() => Promise.resolve()).pipe(
            Effect.map(() => {
              events.push("clerk");
              return { ready: true as const };
            }),
          ),
        );

        const layerRuntime = layerClerkShaped.pipe(
          Layer.flatMap((clerkContext) => Layer.succeedContext(clerkContext)),
          Layer.provideMerge(layerPreReady),
        );

        const result = yield* Effect.all({
          clerk: ClerkShaped,
          preReady: DesktopPreReadyPlatform.DesktopPreReadyElectronOptions,
        }).pipe(Effect.provide(layerRuntime));

        assert.deepEqual(result, {
          clerk: { ready: true },
          preReady: {
            linux: null,
            linuxPasswordStoreCommandLine: null,
          },
        });
        assert.deepEqual(events, ["pre-ready", "clerk"]);
        assert.equal(registerSchemesMock.mock.calls.length, 1);
        assert.equal(appendSwitchMock.mock.calls.length, 0);
        assert.equal(setDesktopNameMock.mock.calls.length, 0);
      }),
  );
});
