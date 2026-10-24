# Project UX guidance

Project settings include **Project UX guidance** on web, desktop and mobile.

- **Automatic** enables guidance when the project's current fetch origin is an exact public GitHub repository owned by `unn-corp`.
- **On** explicitly includes a client repository or a project without Git.
- **Off** opts the project out. Choose Automatic to restore origin-based selection.

The choice belongs to the project on its connected environment. Grouped checkouts can have different choices; changing the choice updates the selected checkouts. It takes effect on the next turn.

Guidance currently works with Codex and Claude. Other providers do not receive it. It applies to UX design, implementation and review; backend-only tasks gain no UX requirements. User direction, project constraints, local components, accessibility and security remain authoritative.

The bundled guidance is proposed UNNDEV UI Standards Core v1.2 from UNNui draft PR #18. Its 19 principles are bounded review prompts, not universal numerical rules or permission to redesign. For relevant UX work, connect applicable principles to decisions, evidence and tradeoffs. Installation does not certify existing interfaces.

Automatic selection uses origin, including in worktrees. An unrelated origin with an UNN upstream stays excluded; a fork owned outside UNN needs On. Missing, ambiguous or unrecognized origins stay excluded. The application checks local Git configuration each turn and uses bundled guidance, without fetching instructions from the network.
