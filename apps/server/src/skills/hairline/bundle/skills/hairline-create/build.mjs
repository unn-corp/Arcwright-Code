#!/usr/bin/env node
/**
 * Puts a figure on the bench: `node build.mjs <figure.js> [out.html]` writes
 * one self-contained page, bench.html with kernel.js and the figure in its two
 * slots and nothing else changed, and prints where it is. Without a path the
 * page is hairline-<name>.html in the working directory.
 */
import { readFileSync } from "node:fs";
import { artifactInput, artifactWrite, main } from "./paths.mjs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

/** The page for a figure's source. The replacements are functions so `$&` in the kernel or the figure is pasted as it is. */
export function assemble(figure) {
  const kernel = readFileSync(here("./kernel.js"), "utf8").replace(/\r\n/g, "\n").trimEnd();
  return readFileSync(here("./bench.html"), "utf8").replace(/\r\n/g, "\n")
    .replace("/*KERNEL*/", () => `\n${kernel}\n`)
    .replace("/*FIGURE*/", () => `\n${figure.replace(/\r\n/g, "\n").trim()}\n`);
}

/** The figure's name, read from its declaration: the last hairline({ … }) call, as validate.mjs reads it, so a `name:` earlier in the figure is not taken for it. */
export function nameOf(figure) {
  const call = [...figure.matchAll(/\bhairline\s*\(\s*\{/g)].at(-1);
  return call ? /\bname:\s*["'`]([a-z][a-z0-9-]*)["'`]/.exec(figure.slice(call.index))?.[1] ?? null : null;
}

/** Whether two resolved paths are one file. Windows paths ignore case, and the drive letter's case can differ between the two. */
export const same = (a, b, platform = process.platform) => platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

if (main(import.meta.url)) {
  try {
    const [run, src] = process.argv.slice(2);
    if (!run || !src || process.argv.length !== 4) throw new Error("usage: node build.mjs <run> <figure.js>");
    const figure = artifactInput(run, src);
    console.log(artifactWrite(run, "figure.html", assemble(figure)));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
