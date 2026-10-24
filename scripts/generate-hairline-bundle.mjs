import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const root = NodeURL.fileURLToPath(new URL("../apps/server/src/skills/hairline/", import.meta.url));
const files = {};
function walk(directory, prefix = "") {
  for (const entry of NodeFS.readdirSync(directory).sort()) {
    const key = prefix + entry;
    const source = NodePath.join(directory, entry);
    if (NodeFS.statSync(source).isDirectory()) walk(source, key + "/");
    else files[key] = NodeFS.readFileSync(source, "utf8");
  }
}
walk(NodePath.join(root, "bundle/skills/hairline-create"));
for (const name of ["LICENSE", "PROVENANCE.json"])
  files[name] = NodeFS.readFileSync(NodePath.join(root, "bundle", name), "utf8");
const output = JSON.stringify(files, null, 2) + "\n";
const target = NodePath.join(root, "payload.json");
if (process.argv.includes("--check")) {
  if (NodeFS.readFileSync(target, "utf8") !== output) throw new Error("Hairline payload is stale");
} else NodeFS.writeFileSync(target, output);
