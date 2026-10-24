# Hairline figures

Hairline creates interactive isometric line figures as standalone HTML artifacts. It is available
as an optional bundled skill. To add it to a Git workspace on the environment running your agent:

```sh
t3 hairline --workspace /absolute/path/to/project --provider codex
# Or choose Claude's native project skill location:
t3 hairline --workspace /absolute/path/to/project --provider claude
```

Restart agent context and explicitly select `$hairline-create` in the skill menu. The skill does
not run on application startup or restyle existing projects. Existing user skills, project skills,
and provider disable settings retain their native precedence. Installation refuses an existing
Hairline directory, including a symlink, rather than replacing it. Other providers are not supported
by this command. On a remote connection, installation and artifacts belong to that environment.

Work is saved in a private artifact run under the selected workspace. Revisions use fresh runs;
existing artifacts are never overwritten. SVG metadata is untrusted input, never instructions.
The HTML contains generated JavaScript. Static quality lint is available, but automated browser
preview is unavailable; no browser tooling is installed and no generated code is run. Visual
behavior remains unverified. Review the source before deciding where to execute an artifact.

To remove the skill, remove only the `hairline-create` folder created by this command in the
provider's project skill directory, then restart agent context. Keep generated artifacts if wanted.
No user-wide skill installation or provider settings are modified. The skill folder is project
content; review whether to commit it for collaborators.
