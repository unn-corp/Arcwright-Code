// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer through a PTY and a gated HTTP fixture.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer terminal", () => {
  it.each([
    ["explicit", false],
    ["explicit", true],
    ["stable", false],
    ["nightly", false],
  ] as const)(
    "preserves %s selection and install behavior (HTTP failure: %s)",
    async (channel, fail) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-progress-"));
      const version = channel === "nightly" ? "1.2.4-nightly.20261028.7" : "1.2.3";
      const stem = `t3-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
      const archiveName = `${stem}.tar.gz`;
      let resumeDownload: (() => void) | undefined;
      let sawPartialProgress = false;
      let output = "";
      await NodeFSP.mkdir(NodePath.join(root, stem));
      await NodeFSP.writeFile(
        NodePath.join(root, stem, "t3"),
        `#!/bin/sh\necho 't3 v${version}'\n`,
        {
          mode: 0o755,
        },
      );
      await NodeFSP.writeFile(
        NodePath.join(root, stem, "payload"),
        NodeCrypto.randomBytes(64 * 1024),
      );
      NodeChildProcess.execFileSync("tar", [
        "-czf",
        NodePath.join(root, archiveName),
        "-C",
        root,
        stem,
      ]);
      const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
      const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      const manifest = JSON.stringify({
        format: 1,
        repository: "unn-corp/Arcwright-Code",
        version,
        checks: { build: true, install: true, update: true, recovery: true },
        assets: [{ name: archiveName, kind: "server", bytes: archive.length, sha256: checksum }],
      });
      const release = {
        tag_name: `fork-v${version}`,
        draft: false,
        published_at: "2026-10-01T00:00:00Z",
        assets: [
          { name: archiveName, size: archive.length },
          { name: "fork-release.json", size: Buffer.byteLength(manifest) },
          { name: "SHA256SUMS", size: Buffer.byteLength(`${checksum}  ${archiveName}\n`) },
        ],
      };
      const server = NodeHttp.createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname === "/index") {
          response.end(
            JSON.stringify(
              url.searchParams.get("page") === "1"
                ? Array.from({ length: 100 }, () => ({ ...release, tag_name: "fork-v1.2.3" }))
                : [
                    {
                      ...release,
                      tag_name: "fork-v1.2.4-nightly.20261028.8",
                      body: "<!-- t3-fork-release:withdrawn -->",
                    },
                    release,
                  ],
            ),
          );
        } else if (request.url === "/release.json") {
          response.end(JSON.stringify(release));
        } else if (request.url?.endsWith("/fork-release.json")) {
          response.end(manifest);
        } else if (request.url?.endsWith("/SHA256SUMS")) {
          response.end(`${checksum}  ${archiveName}\n`);
        } else if (request.url?.endsWith(`/${archiveName}`)) {
          if (fail) response.writeHead(500).end();
          else {
            response.writeHead(200, { "Content-Length": archive.length });
            resumeDownload = () => response.end(archive.subarray(Math.floor(archive.length / 2)));
            response.write(archive.subarray(0, Math.floor(archive.length / 2)));
          }
        } else {
          response.writeHead(404).end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const fixtureBin = NodePath.join(root, "fixture-bin");
      await NodeFSP.mkdir(fixtureBin);
      await NodeFSP.writeFile(NodePath.join(fixtureBin, "package.json"), '{"type":"commonjs"}\n');
      const curl = NodeChildProcess.execFileSync("sh", ["-c", "command -v curl"], {
        encoding: "utf8",
      }).trim();
      // Keep the real eligibility and checksum checks, routing every request to
      // this fixture. An unexpected URL must fail instead of reaching GitHub.
      await NodeFSP.writeFile(
        NodePath.join(fixtureBin, "curl"),
        `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2).map((arg) => {
  if (arg === ${JSON.stringify(`https://api.github.com/repos/unn-corp/Arcwright-Code/releases/tags/fork-v${version}`)})
    return ${JSON.stringify(`${baseUrl}/release.json`)};
  if (arg === "https://api.github.com/repos/unn-corp/Arcwright-Code/releases/latest")
    return ${JSON.stringify(`${baseUrl}/release.json`)};
  if (arg.startsWith("https://api.github.com/repos/unn-corp/Arcwright-Code/releases?"))
    return ${JSON.stringify(`${baseUrl}/index`)} + new URL(arg).search;
  if (/^https?:/.test(arg) && !arg.startsWith(${JSON.stringify(`${baseUrl}/`)})) process.exit(2);
  return arg;
});
const result = spawnSync(${JSON.stringify(curl)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
        { mode: 0o755 },
      );
      const installer = NodePath.resolve(import.meta.dirname, "install.sh").replaceAll(
        "'",
        "'\\''",
      );
      const child = NodeChildProcess.spawn("script", ["-qec", `sh '${installer}'`, "/dev/null"], {
        env: {
          ...process.env,
          PATH: `${fixtureBin}${NodePath.delimiter}${process.env.PATH}`,
          TERM: "xterm",
          NO_COLOR: "1",
          T3CODE_VERSION: channel === "explicit" ? version : "",
          T3CODE_CHANNEL: channel === "explicit" ? "stable" : channel,
          T3CODE_HOME: NodePath.join(root, "home"),
          T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
          T3CODE_RELEASE_BASE_URL: baseUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sawPartialProgress && /\b[1-9]\d?%/.test(output)) {
          sawPartialProgress = true;
          resumeDownload?.();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
        const versions = NodePath.join(root, "home/runtime/versions");
        if (fail) {
          expect(code).not.toBe(0);
          expect(output).toContain("500");
          expect(output).not.toContain("100%");
          expect(output).not.toContain("Installed Arcwright Code");
          expect(await NodeFSP.readdir(versions)).toEqual([]);
        } else {
          expect(code).toBe(0);
          expect(sawPartialProgress).toBe(true);
          expect(output).toContain("100%");
          expect(output).toContain("0.1 / 0.1 MB");
          expect(output).toContain(`Installed Arcwright Code ${version}`);
          expect(
            await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
          ).toBe(`${version}\n`);
          expect(
            NodeChildProcess.execFileSync(NodePath.join(root, "bin/t3"), ["--version"], {
              encoding: "utf8",
            }).trim(),
          ).toBe(`t3 v${version}`);
          expect(await NodeFSP.readdir(versions)).toEqual([version]);
          expect(
            await NodeFSP.readFile(NodePath.join(root, "home/runtime/launchers"), "utf8"),
          ).toBe(`${NodePath.join(root, "bin/t3")}\n`);
        }
      } finally {
        if (child.exitCode === null) child.kill();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer home", () => {
  it("installs a relative home from a directory ending in a newline", async () => {
    const temporaryRoot = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-home-")),
    );
    const root = NodePath.join(temporaryRoot, "cwd\n");
    const homeName = "-custom home\\home\n";
    const home = NodePath.join(root, homeName);
    const version = "1.2.3";
    const target = NodePath.join(home, "runtime/versions", version);
    const launcher = NodePath.join(root, "bin/t3");
    try {
      await NodeFSP.mkdir(target, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), `${version}\n`);
      await NodeFSP.writeFile(NodePath.join(target, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      const fixtureBin = NodePath.join(root, "tools");
      await NodeFSP.mkdir(fixtureBin);
      const eligible = {
        tag_name: `fork-v${version}`,
        draft: false,
        published_at: "2026-10-28T00:00:00Z",
        assets: [
          { name: "fork-release.json", size: 1 },
          { name: "SHA256SUMS", size: 1 },
        ],
      };
      await NodeFSP.writeFile(
        NodePath.join(fixtureBin, "curl"),
        `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (!args.includes(${JSON.stringify(`https://api.github.com/repos/unn-corp/Arcwright-Code/releases/tags/fork-v${version}`)})) process.exit(2);
fs.writeFileSync(args[args.indexOf("-o") + 1], ${JSON.stringify(JSON.stringify(eligible))});
process.stdout.write("200");
`,
        { mode: 0o755 },
      );
      const { status, stdout, stderr } = NodeChildProcess.spawnSync(
        "sh",
        [NodePath.resolve(import.meta.dirname, "install.sh")],
        {
          cwd: root,
          env: {
            ...process.env,
            HOME: root,
            PATH: `${fixtureBin}${NodePath.delimiter}${process.env.PATH}`,
            T3CODE_HOME: homeName,
            T3CODE_VERSION: version,
            T3CODE_INSTALL_BIN_DIR: NodePath.dirname(launcher),
            T3CODE_RELEASE_BASE_URL: "http://127.0.0.1:1",
          },
          encoding: "utf8",
        },
      );
      expect(status, stdout + stderr).toBe(0);
      expect(stderr).toContain(`Installed Arcwright Code ${version}`);
      expect(await NodeFSP.readlink(launcher)).toBe(NodePath.join(target, "t3"));
      expect(
        NodeChildProcess.execFileSync(launcher, ["--version"], {
          cwd: NodeOS.tmpdir(),
          encoding: "utf8",
        }).trim(),
      ).toBe("t3 v1.2.3");
    } finally {
      await NodeFSP.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

// regression: #22490
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer channel lookup", () => {
  it.each([
    ["stable", "1.2.3"],
    ["preview", "1.2.4-preview.20261019.50"],
  ])("finds the newest %s release behind a full page of nightlies", async (channel, version) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-index-"));
    const target = NodePath.join(root, "home/runtime/versions", version);
    const release = (version: string) => ({
      tag_name: `fork-v${version}`,
      draft: false,
      published_at: "2026-10-01T00:00:00Z",
      assets: [{ name: "fork-release.json" }, { name: "SHA256SUMS" }],
    });
    const nightlies = Array.from({ length: 100 }, (_, index) =>
      release(`1.2.4-nightly.20261019.${100 - index}`),
    );
    const server = NodeHttp.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture");
      const body =
        url.pathname === "/repos/unn-corp/Arcwright-Code/releases/latest"
          ? release("1.2.3")
          : url.pathname === "/repos/unn-corp/Arcwright-Code/releases"
            ? { "1": nightlies, "2": [release(version), release("1.2.3")] }[
                url.searchParams.get("page") ?? ""
              ]
            : url.pathname === `/repos/unn-corp/Arcwright-Code/releases/tags/fork-v${version}`
              ? release(version)
              : undefined;
      if (body === undefined) response.statusCode = 404;
      // The API pretty-prints and the installer reads it line by line.
      response.end(JSON.stringify(body ?? [], null, 2));
    });
    try {
      // An existing completed install isolates release resolution from archive downloads.
      await NodeFSP.mkdir(target, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), `${version}\n`);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const origin = `http://127.0.0.1:${address.port}`;
      const source = await NodeFSP.readFile(
        NodePath.resolve(import.meta.dirname, "install.sh"),
        "utf8",
      );
      const installer = NodePath.join(root, "install.sh");
      await NodeFSP.writeFile(installer, source.replace(/https:\/\/(api\.)?github\.com/g, origin));
      const { code, output } = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const child = NodeChildProcess.spawn("sh", [installer], {
            env: {
              ...process.env,
              T3CODE_VERSION: "",
              T3CODE_CHANNEL: channel,
              T3CODE_HOME: NodePath.join(root, "home"),
              T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
              // A wrong version must fail here instead of downloading a real release.
              T3CODE_RELEASE_BASE_URL: origin,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, output }));
        },
      );
      expect(code, output).toBe(0);
      expect(output).toContain(`Installed Arcwright Code ${version}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

/** Runs an installer for a version that is already unpacked, so only the t3 command step runs. */
async function installOver(input: {
  readonly script: "install.sh" | "install.ps1";
  readonly home: string;
  readonly binDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}) {
  const target = NodePath.join(input.home, "runtime", "versions", "1.2.3");
  await NodeFSP.mkdir(target, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), "1.2.3\n");
  const server = NodeHttp.createServer((request, response) => {
    if (request.url === "/repos/unn-corp/Arcwright-Code/releases/tags/fork-v1.2.3") {
      response.end(
        JSON.stringify({
          tag_name: "fork-v1.2.3",
          draft: false,
          published_at: "2026-10-01T00:00:00Z",
          assets: [{ name: "fork-release.json" }, { name: "SHA256SUMS" }],
        }),
      );
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    const source = await NodeFSP.readFile(
      NodePath.resolve(import.meta.dirname, input.script),
      "utf8",
    );
    const installer = NodePath.join(input.home, input.script);
    await NodeFSP.writeFile(
      installer,
      source.replaceAll("https://api.github.com", `http://127.0.0.1:${address.port}`),
    );
    const [command, args] =
      input.script === "install.sh"
        ? ["sh", [installer]]
        : ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer]];
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = NodeChildProcess.spawn(command, args, {
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        env: {
          ...process.env,
          T3CODE_CHANNEL: "",
          T3CODE_VERSION: "1.2.3",
          T3CODE_HOME: input.home,
          T3CODE_INSTALL_BIN_DIR: input.binDir,
          T3CODE_RELEASE_BASE_URL: "http://127.0.0.1:9",
          ...input.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    });
    return { ...result, target };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("install.sh t3 command", () => {
  it("replaces only this home's own links and prints a PATH command", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-link-"));
    try {
      const home = NodePath.join(root, "home");
      const binDir = NodePath.join(root, "bin");
      const link = NodePath.join(binDir, "t3");
      await NodeFSP.mkdir(binDir, { recursive: true });

      await NodeFSP.writeFile(link, "#!/bin/sh\necho mine\n");
      const foreign = await installOver({ script: "install.sh", home, binDir });
      expect(foreign.code).not.toBe(0);
      expect(foreign.output).toContain(`another t3 is already at ${link}`);
      expect(await NodeFSP.readFile(link, "utf8")).toBe("#!/bin/sh\necho mine\n");
      // Not even from inside the versions folder, where `.` would resolve into it.
      const fromVersions = await installOver({
        script: "install.sh",
        home,
        binDir,
        cwd: foreign.target,
      });
      expect(fromVersions.code).not.toBe(0);
      expect(await NodeFSP.readFile(link, "utf8")).toBe("#!/bin/sh\necho mine\n");

      // A link that only looks like it points into versions (join() would normalize the ..).
      await NodeFSP.rm(link);
      await NodeFSP.mkdir(NodePath.join(home, "other"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(home, "other/t3"), "#!/bin/sh\n");
      await NodeFSP.symlink(`${home}/runtime/versions/../../other/t3`, link);
      const climbing = await installOver({ script: "install.sh", home, binDir });
      expect(climbing.code).not.toBe(0);
      expect(await NodeFSP.readlink(link)).toBe(`${home}/runtime/versions/../../other/t3`);

      // Only `<version>/t3` counts, not another program inside a version.
      await NodeFSP.rm(link);
      await NodeFSP.symlink(NodePath.join(home, "runtime/versions/1.0.0/helper"), link);
      const sibling = await installOver({ script: "install.sh", home, binDir });
      expect(sibling.code).not.toBe(0);
      expect(await NodeFSP.readlink(link)).toBe(
        NodePath.join(home, "runtime/versions/1.0.0/helper"),
      );

      // An upgrade over an older version's link, written through a symlinked T3 home.
      await NodeFSP.rm(link);
      await NodeFSP.symlink(NodePath.join(home, "runtime/versions/1.0.0/t3"), link);
      await NodeFSP.symlink(home, NodePath.join(root, "alias"));
      const upgrade = await installOver({
        script: "install.sh",
        home: NodePath.join(root, "alias"),
        binDir,
        env: { HOME: root, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      });
      expect(upgrade.code, upgrade.output).toBe(0);
      expect(await NodeFSP.readlink(link)).toBe(
        NodePath.join(root, "alias/runtime/versions/1.2.3/t3"),
      );
      expect(upgrade.output).toContain(
        `printf '\\n%s\\n' 'export PATH="$PATH:$HOME/bin"' >> ~/.zshrc`,
      );

      // Containers and CI often have no SHELL; `set -u` must not stop the installer there.
      const noShell = await installOver({
        script: "install.sh",
        home,
        binDir,
        env: { HOME: root, SHELL: "", PATH: "/usr/bin:/bin" },
      });
      expect(noShell.code, noShell.output).toBe(0);
      expect(noShell.output).toContain(`Add ${binDir} to your PATH`);

      // Its folder on PATH with a trailing slash is still this t3, not another one.
      const slashed = await installOver({
        script: "install.sh",
        home,
        binDir,
        env: { HOME: root, PATH: `${binDir}/:/usr/bin:/bin` },
      });
      expect(slashed.code, slashed.output).toBe(0);
      expect(slashed.output).toContain("Run t3 to use Arcwright Code here");

      // A relative folder is made absolute, so the PATH command never follows the working directory.
      const relative = await installOver({
        script: "install.sh",
        home,
        binDir: "bin",
        cwd: root,
        env: { HOME: root, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      });
      expect(relative.code, relative.output).toBe(0);
      expect(relative.output).toContain(`'export PATH="$PATH:$HOME/bin"'`);

      await NodeFSP.rm(link);
      await NodeFSP.symlink(NodePath.join(home, "bin/t3"), link);
      const overDesktop = await installOver({
        script: "install.sh",
        home: `${home}//`,
        binDir: `${binDir}/`,
      });
      expect(overDesktop.code, overDesktop.output).toBe(0);
      expect(await NodeFSP.readlink(link)).toBe(NodePath.join(home, "runtime/versions/1.2.3/t3"));
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")("install.ps1 t3 command", () => {
  it("replaces only its own t3.cmd, also in non-ASCII and bracketed paths", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-ps1-"));
    try {
      // Windows PowerShell 5.1 reads files as ANSI by default and expands wildcards in paths.
      const home = NodePath.join(root, "José", ".t3");
      const binDir = NodePath.join(root, "bin[t3]");
      const shim = NodePath.join(binDir, "t3.cmd");
      await NodeFSP.mkdir(binDir, { recursive: true });

      const desktopShim =
        '@echo off\r\n"C:\\Program Files\\Arcwright Code\\Arcwright Code.exe" "x" %*\r\n';
      await NodeFSP.writeFile(shim, desktopShim);
      const foreign = await installOver({ script: "install.ps1", home, binDir });
      expect(foreign.code).not.toBe(0);
      expect(foreign.output).toContain("another t3 is already at");
      expect(await NodeFSP.readFile(shim, "utf8")).toBe(desktopShim);

      // A hand-edited wrapper may set its own environment; replacing it would drop that.
      const edited = `@echo off\r\nset "T3CODE_HOME=D:\\other"\r\n"${NodePath.join(home, "runtime", "versions", "1.0.0", "t3.exe")}" %*`;
      await NodeFSP.writeFile(shim, edited, "utf8");
      const wrapper = await installOver({ script: "install.ps1", home, binDir });
      expect(wrapper.code).not.toBe(0);
      expect(await NodeFSP.readFile(shim, "utf8")).toBe(edited);

      const climbing = `@echo off\r\n"${NodePath.join(home, "runtime", "versions")}\\..\\other\\t3.exe" %*`;
      await NodeFSP.writeFile(shim, climbing, "utf8");
      const outside = await installOver({ script: "install.ps1", home, binDir });
      expect(outside.code).not.toBe(0);
      expect(await NodeFSP.readFile(shim, "utf8")).toBe(climbing);

      const older = NodePath.join(home, "runtime", "versions", "1.0.0", "t3.exe");
      await NodeFSP.writeFile(shim, `@echo off\r\n"${older}" %*`, "utf8");
      const upgrade = await installOver({ script: "install.ps1", home, binDir });
      expect(upgrade.code, upgrade.output).toBe(0);
      expect(await NodeFSP.readFile(shim, "utf8")).toContain(
        NodePath.join(upgrade.target, "t3.exe"),
      );

      const again = await installOver({ script: "install.ps1", home, binDir });
      expect(again.code, again.output).toBe(0);

      // Another t3 first on PATH still runs, so the installer names this one in full.
      const otherBin = NodePath.join(root, "other");
      await NodeFSP.mkdir(otherBin);
      await NodeFSP.writeFile(NodePath.join(otherBin, "t3.cmd"), "@echo off\r\n");
      // Windows spells it Path; a second PATH key would be ambiguous.
      const pathKey =
        Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
      const shadowed = await installOver({
        script: "install.ps1",
        home,
        binDir,
        env: { [pathKey]: `${otherBin};${process.env[pathKey] ?? ""}` },
      });
      expect(shadowed.code, shadowed.output).toBe(0);
      expect(shadowed.output).toContain(
        `Another t3 at ${NodePath.join(otherBin, "t3.cmd")} runs first`,
      );

      // Its own folder on PATH with a trailing separator is already on PATH.
      const slashed = await installOver({
        script: "install.ps1",
        home,
        binDir,
        env: { [pathKey]: `${binDir}\\;${process.env[pathKey] ?? ""}` },
      });
      expect(slashed.code, slashed.output).toBe(0);
      expect(slashed.output).toContain("to use Arcwright Code here");
      // The same when the install folder itself is given with a trailing separator.
      const bothSlashed = await installOver({
        script: "install.ps1",
        home,
        binDir: `${binDir}\\`,
        env: { [pathKey]: `${binDir}\\;${process.env[pathKey] ?? ""}` },
      });
      expect(bothSlashed.code, bothSlashed.output).toBe(0);
      expect(bothSlashed.output).toContain("to use Arcwright Code here");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer checksum", () => {
  it.each(
    ["home\\data", "home\ndata"].flatMap((homeName) =>
      [true, false].map((validChecksum) => ({ homeName, validChecksum })),
    ),
  )(
    "verifies home $homeName with valid checksum $validChecksum",
    async ({ homeName, validChecksum }) => {
      const availableTools = ["sha256sum", "shasum"].filter(
        (tool) =>
          NodeChildProcess.spawnSync("sh", ["-c", 'command -v "$1"', "sh", tool]).status === 0,
      );
      expect(availableTools.length).toBeGreaterThan(0);
      for (const checksumTool of availableTools) {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-checksum-"));
        const home = NodePath.join(root, homeName);
        const version = "1.2.3";
        const stem = `t3-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
        const archiveName = `${stem}.tar.gz`;
        const server = NodeHttp.createServer();
        try {
          const tools = NodePath.join(root, "tools");
          await NodeFSP.mkdir(tools);
          for (const command of [
            "sh",
            "uname",
            "tar",
            "gzip",
            "cut",
            "python3",
            "node",
            "grep",
            "mkdir",
            "mktemp",
            "rm",
            "mv",
            "ln",
            checksumTool,
          ]) {
            const executable = NodeChildProcess.execFileSync(
              "sh",
              ["-c", 'command -v "$1"', "sh", command],
              { encoding: "utf8" },
            ).trim();
            await NodeFSP.symlink(executable, NodePath.join(tools, command));
          }
          await NodeFSP.mkdir(NodePath.join(root, stem));
          await NodeFSP.writeFile(
            NodePath.join(root, stem, "t3"),
            "#!/bin/sh\necho 't3 v1.2.3'\n",
            { mode: 0o755 },
          );
          const archivePath = NodePath.join(root, archiveName);
          NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", root, stem]);
          const archive = await NodeFSP.readFile(archivePath);
          const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
          const baseDigest = validChecksum ? digest : "0".repeat(64);
          const asset = {
            name: archiveName,
            kind: "server",
            bytes: archive.length,
            sha256: baseDigest,
          };
          const manifest = {
            format: 1,
            repository: "unn-corp/Arcwright-Code",
            version,
            checks: { build: true, install: true, update: true, recovery: true },
            assets: [asset],
          };
          const release = {
            tag_name: `fork-v${version}`,
            draft: false,
            published_at: "2026-10-28T00:00:00Z",
            assets: [
              { name: archiveName, size: archive.length },
              { name: "fork-release.json", size: 1 },
              { name: "SHA256SUMS", size: 1 },
            ],
          };
          server.on("request", (request, response) => {
            if (request.url === "/release.json") {
              response.end(JSON.stringify(release));
              return;
            }
            if (request.url?.endsWith("/fork-release.json")) {
              response.end(JSON.stringify(manifest));
              return;
            }
            response.end(
              request.url?.endsWith("/SHA256SUMS")
                ? `${validChecksum ? digest : "0".repeat(64)}  ${archiveName}\n`
                : archive,
            );
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
          const realCurl = NodeChildProcess.execFileSync("sh", ["-c", "command -v curl"], {
            encoding: "utf8",
          }).trim();
          await NodeFSP.writeFile(
            NodePath.join(tools, "curl"),
            `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2).map(arg => arg.startsWith("https://api.github.com/") ? "http://127.0.0.1:${address.port}/release.json" : arg);
process.exit(spawnSync(${JSON.stringify(realCurl)}, args, { stdio: "inherit" }).status ?? 1);
`,
            { mode: 0o755 },
          );
          const { code, output } = await new Promise<{ code: number | null; output: string }>(
            (resolve, reject) => {
              const child = NodeChildProcess.spawn(
                "sh",
                [NodePath.resolve(import.meta.dirname, "install.sh")],
                {
                  env: {
                    ...process.env,
                    PATH: tools,
                    T3CODE_VERSION: version,
                    T3CODE_HOME: home,
                    T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
                    T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
                  },
                  stdio: ["ignore", "pipe", "pipe"],
                },
              );
              let output = "";
              child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
              child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
              child.on("error", reject);
              child.on("close", (code) => resolve({ code, output }));
            },
          );
          const versions = NodePath.join(home, "runtime/versions");
          if (validChecksum) {
            expect(code, `${checksumTool}: ${output}`).toBe(0);
            expect(
              await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
            ).toBe("1.2.3\n");
            expect(
              NodeChildProcess.execFileSync(NodePath.join(root, "bin/t3"), ["--version"], {
                encoding: "utf8",
              }).trim(),
            ).toBe("t3 v1.2.3");
          } else {
            expect(code).not.toBe(0);
            expect(output).toContain("checksum mismatch");
            expect(output).not.toContain("Installed Arcwright Code");
            expect(await NodeFSP.readdir(versions)).toEqual([]);
          }
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await NodeFSP.rm(root, { recursive: true, force: true });
        }
      }
    },
  );
});
