import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { discoverClaudeSkills } from "../../provider/Drivers/ClaudeSkills.ts";
import { installHairline } from "./install.ts";

it.layer(NodeServices.layer)("Hairline native Claude discovery", (it) => {
  it.effect("discovers explicit-only skill, honors off and preserves user precedence", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hairline-discovery-" });
      const project = path.join(root, "project");
      const home = path.join(root, "provider-home");
      yield* fs.makeDirectory(path.join(project, ".git"), { recursive: true });
      yield* fs.makeDirectory(home);
      const installed = installHairline(project, "claude");
      const skills = yield* discoverClaudeSkills({ homePath: home }, project, {});
      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.path, path.join(installed, "SKILL.md"));
      assert.equal(skills[0]?.enabled, true);
      assert.equal(skills[0]?.userInvocationOnly, true);
      yield* fs.writeFileString(
        path.join(home, "settings.json"),
        '{"skillOverrides":{"hairline-create":"off"}}',
      );
      assert.equal(
        (yield* discoverClaudeSkills({ homePath: home }, project, {}))[0]?.enabled,
        false,
      );
      const userSkill = path.join(home, "skills", "hairline-create", "SKILL.md");
      yield* fs.makeDirectory(path.dirname(userSkill), { recursive: true });
      yield* fs.writeFileString(userSkill, "---\ndescription: Existing user version\n---\n");
      const userSkills = yield* discoverClaudeSkills({ homePath: home }, project, {});
      assert.equal(userSkills[0]?.path, userSkill);
      assert.equal(userSkills[0]?.description, "Existing user version");
      assert.equal(userSkills[0]?.enabled, false);
    }),
  );
});
