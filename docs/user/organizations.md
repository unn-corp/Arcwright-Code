# Organizations

Organizations keep a mission, team structure, workflows, decisions, and evidence together. They can exist without a Project. Link a Project from **Governance** when you want the Organization to refer to it.

## Build your team

Open an Organization and choose **Designer**. The team graph is the main workspace. Select an employee for quick actions, double-click to edit, or open **Team list** to find employees without navigating the canvas. Drag an employee by its handle to move it. Use the zoom controls and **Fit**, or drag empty space with a mouse to pan. Arrow keys pan the focused canvas; employee move handles also support arrow keys.

Choose **Add employee**, or right-click empty canvas and choose **Add employee here**. Guided setup walks through the employee’s name and kind, responsibilities, profile, AI provider and model, and a final review. Write a personality to describe how the employee communicates and approaches work, an area of focus to set priorities, and skills to provide working instructions. These fields support 2,000, 2,000, and 4,000 characters respectively. Skills do not install tools or grant access. Double-click an employee to revisit any setup step. Older environments show profiles as read-only until updated. You can leave the AI assignment for later. Assignments are saved with the local draft and retained when other details change. An unavailable assignment stays visible until you choose a replacement. These are employee preferences; the existing Project work activation flow still selects the model used for execution.

To build a relationship, select an employee and choose **Connect**, then select another employee. You can also right-click an employee and choose **Connect to another employee**, or open **Relationships** from the toolbar. Choose the direction and relationship using the plain-language descriptions. The relationship dialog lists current connections and lets you remove them. Relationships describe responsibility and do not grant permissions. Built-in Director and Architect employees cannot be removed. Other employee removal asks for confirmation and also removes that employee’s connections.

**Undo** and **Redo** support employee creation and edits, canvas moves, and relationship changes. Employee deletion cannot be undone. If another editor or the Architect changes the draft, the next manual edit starts a new undo history. Older environments need an update before they can save employee AI assignments or the chosen creation position.

## Design with AI

Open **Architect** from the Designer toolbar when you want help. The optional panel and canvas share the same draft. Choose a provider and model in the composer, then use **Guide me through setup** or describe the team you want. Press Enter to send or Shift+Enter for a new line. Replies support Markdown, and you can write your next message while Architect responds. **Focus chat** gives the conversation more room; **Show graph** returns to the canvas without losing your draft. The Architect asks focused questions about the mission, responsibilities, relationships, workflows, resources, and authority. The saved Architect employee assignment is its preferred conversation model when available.

Review each suggested change. **Apply all to draft** commits the suggestions from one reply together, so related employees, connections, and workflow definitions arrive in one revision. You can also apply a single suggestion or edit the graph yourself. An older suggestion cannot overwrite a newer draft, and AI suggestions do not replace your employee AI assignments. Invalid responses are rejected without changing the draft. The Architect cannot link Projects, configure Sources or budgets, publish, grant work authority, or connect GitHub for you. Complete those steps in their respective views. **Publish** in Governance captures a validated configuration version; it does not start workers.

Architect can suggest employee profiles, with changes held for your review. It receives bounded, redacted profile excerpts for context. Very long suggestions may need to be split into smaller changes; manual editing supports the full field limits.

## Share through GitHub

Choose **Repository** within an Organization to inspect the share preview, create or link a dedicated GitHub repository, and save and sync. New repositories default to private. The repository holds portable configuration history, conversations, memory, sanitized observations, findings, work records, and audit history. The shared archive shows incoming records and conflicts by category. Choose a conflict result explicitly; a remote record remains attributed reference material until you review it locally. You can save an Organization-scoped shared memory record as a local memory reference after reviewing it.

On another installation, choose **Import from GitHub** from the Organizations page and enter `OWNER/REPO`. T3 opens it as a local draft with the shared archive available. Reconnect local Projects, accounts, budgets, and permissions before publishing. Employee provider/model assignments, source secrets, tokens, local paths, live processes, resource permits, and machine-specific access are kept local.

The Repository view shows pending local records, incoming records, conflicts, and the last accepted commit. **Sync automatically** is selected by default when linking or loading. T3 checks linked repositories in the background about every two minutes, and retries temporary failures with a delay. You can choose manual sync and use **Save and sync** whenever you want to send or receive changes. If a push races with another user, the pending records remain local so you can sync again and resolve any same-record conflict.

## Operating state

Live Operations and the Director report saved evidence and work state. On a Linux host with the scoped worker available, publish a workflow with work, independent QA, approval, and integration steps. Link a Project with write access, then open a current work intent and choose **Prepare one file for Project work**. Select a flat `.mjs` file in the Project root, a Git branch at the current HEAD that is not checked out in any worktree, a configured Codex or Claude model, and one to eight JSON examples for QA. **Start reviewed work** queues the change; review the proposed patch before approving Git integration. The worker checks runtime recovery before accepting work and retains uncertain launches for inspection.

Worker instructions use the profile from the published configuration pinned to the work item. Editing a draft does not change instructions for existing work. When all published work steps refer to one employee, that employee’s profile is applied. Workflows with multiple distinct work employees keep the existing execution behavior without an employee profile, because this execution path cannot identify which employee owns the current step. The Director remains an evidence summary and does not use a personalized AI response.

This first Project execution path changes one explicitly selected file per work intent. For an enabled, Project-scoped HTTP source, choose **Automatically start matching Project work** while preparing an intent to authorize a bounded number of future matching intents. The grant fixes the Project, source, file, branch, workflow, model, task, and QA examples, expires within 30 days, and can be revoked in Governance. Each Git integration still asks for your approval. Pause is available after active worker phases settle and stops new scheduling. **Drain and pause** finishes admitted work phases without starting another, then pauses the Organization. Resume rechecks runtime readiness. Cancel acts on one selected work item and may require a worker scope to be verified stopped first. **Request emergency stop** blocks new work and interrupts admitted work; Governance shows outstanding process verification instead of claiming an immediate completed stop. Drain and stop status stays current across connected devices while Governance is open. If a crash leaves a provider launch unverified, new Project work stays blocked. Restarting the host clears an unresolved launch from a previous boot; work does not resume automatically while its process identity remains uncertain. Set the host, Organization, and Project provider ceilings before starting; zero blocks provider dispatch.

### Host provider ceiling

An administrator of the machine running Arcwright Code can inspect and set the shared Organization provider ceiling from that machine's CLI. Use the same absolute data directory passed to the server as `--base-dir`. The database must already exist; these commands do not create an installation.

```sh
t3 organization-budget show --base-dir /absolute/path/to/t3-data
t3 organization-budget set --base-dir /absolute/path/to/t3-data \
  --expected-revision 1970-01-01T00:00:00.000Z \
  --max-concurrent 2 --max-daily-calls 5 --max-daily-estimated-tokens 700000
```

Copy `revision` from the `show` output into `set`. A stale revision fails so another administrator's change is not overwritten. The example permits at most five single-file proposals at the current conservative reservation of 140,000 estimated tokens each; actual provider usage may differ. The limits are shared across Organizations; Organization and Project ceilings must also be configured before provider calls can run. A limit of zero blocks that dimension. Only someone with local access to the server's data directory should run this command.
