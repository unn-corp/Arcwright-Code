import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_BYTES = 1024 * 1024;
export const main = (url) => process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url);

// Excludes concurrent hostile processes running as the same OS user. These
// helpers cannot defend an agent's arbitrary shell writes or a compromised host.
export function directory(target, create = false) {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Symlink or non-directory path refused");
  }
  return absolute;
}
function root() {
  directory(process.cwd());
  let target;
  for (const relative of [".arcwright-artifacts", ".arcwright-artifacts/hairline"]) {
    target = directory(path.join(process.cwd(), relative), true);
    const info = fs.statSync(target);
    if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("Artifact roots must be private and owned");
  }
  return target;
}
function runPath(run) {
  if (!/^run-[a-zA-Z0-9]{6}$/.test(run ?? "")) throw new Error("Invalid run name");
  const target = directory(path.join(root(), run));
  const info = fs.statSync(target);
  if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("Run must be private and owned by this user");
  return target;
}
function fileName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name ?? "") || name.includes("..")) throw new Error("Invalid artifact filename");
  return name;
}
export function artifactInput(run, name) {
  const target = path.join(runPath(run), fileName(name));
  const before = fs.lstatSync(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Symlink or non-regular input refused");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.nlink !== 1 || info.size > MAX_BYTES) throw new Error("Input must be a bounded regular file with no hard links");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > MAX_BYTES) throw new Error("Input too large");
    return buffer.subarray(0, count).toString("utf8");
  } finally { fs.closeSync(fd); }
}
export function artifactWrite(run, name, contents) {
  if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error("Output too large");
  const target = path.join(runPath(run), fileName(name));
  fs.writeFileSync(target, contents, { flag: "wx", mode: 0o600 });
  return target;
}
if (main(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("usage: node paths.mjs (from workspace)");
    console.log(fs.mkdtempSync(path.join(root(), "run-")));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
