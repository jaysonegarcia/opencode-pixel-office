# OpenCode Pixel Office — design

Status: approved by the user on 2026-11-23, including the proposed MIT license.

## Purpose and agreed requirements

The user wants to see what their existing OpenCode agents are currently doing in a 2D pixel-art office similar to Pixel Agents. All projects share one office. Clicking a character reveals its session, agent name, current tool, status, and recent actions. Main agents and subagents are represented. This must support the user's installed OpenCode V2 (currently 2.2.7).

The user authorized creating the public GitHub repository `jaysonegarcia/opencode-pixel-office`, committing the implementation, and pushing it. Publishing the app source is distinct from publishing runtime session data: session data remains local.

## First-version experience

- A local browser page opens onto a cozy top-down pixel office: desks, monitors, plants, a lounge, and original pixel characters.
- Each session has one character showing its current named agent. A child session has its own character and its parent is identified in the details panel. A session switching agent updates that character rather than leaving a duplicate behind.
- Characters sit/work when active; reading, editing, running tools, and generating responses have distinguishable labels and small animations. Waiting requests show a clear speech bubble. Completion is a brief indication followed by idle. Disconnection is shown explicitly rather than pretending work finished.
- Clicking a character or its accessible roster button opens a details panel: session title, agent name, project, parent session if any, status, current tool, last update, and a bounded recent activity list with timestamps.
- The session title provides task context; the application does not invent task summaries or claim access to private reasoning. “Generating response” describes observable activity, not the model's internal thoughts.
- Header displays connection health and counts of working/waiting/idle characters. A project filter and roster search make a shared office manageable.
- Idle sessions observed during this run remain available until dismissed or the server stops. A visibility cap/pagination or room expansion keeps large numbers usable; the builder chooses the simplest reliable implementation.
- Empty state explains how to enable the plugin and start working. Reconnecting and disconnected states are explicit. Demo data, if provided, is a clearly labeled separate mode and never substitutes for live verification.

## Architecture (proposed builder choices)

Use TypeScript with a native OpenCode V2 plugin, a local Node.js service, and a React/Vite browser app. Use Yarn. Use original procedurally drawn pixel sprites and furniture; do not copy Pixel Agents assets or branding. The repository uses an MIT license (proposed default).

1. **Native plugin:** default-export `Plugin.define` from `@opencode/plugin`. Observe the V2 public event stream and, where necessary, read-only tool/session hooks. Read session metadata through V2 APIs. Do not mutate prompts, tools, permissions, or agent behavior.
2. **Local collector:** a separately started process serves the browser assets, accepts normalized observation batches from plugin instances, and streams snapshots/updates to browsers. Default address is loopback on a documented configurable port. One collector combines observations from all enabled projects on the local OpenCode server; the same-user standalone processes may connect too.
3. **Browser:** render the original 2D pixel office and an accessible HTML roster/detail panel. The display is a projection of normalized state, not a second agent runner.

The plugin must never start a second OpenCode server, depend on V1 compatibility shims, or use a private database directly. Installation is global to observe project sessions after their plugins activate. Configuration changes are applied using the supported V2 reload mechanism. The user continues working in their existing OpenCode UI.

## Existing sessions and coverage

On plugin activation, enumerate accessible sessions using the public paginated V2 API. Query current activity and pending requests where supported. Initially include sessions known to be active/waiting, then add any session that emits activity. Do not fill the office with the entire historical session archive. Sessions already idle before installation need not appear until they become active.

Resolve project/directory from the actual session metadata, not merely the plugin's load location. Resolve child-parent relationships from session metadata. Deduplicate global event subscriptions across plugin instances using stable session and event identity; character identity must not depend on a random per-plugin instance ID.

Verify the V2 SDK's concrete event envelopes and session/activity fields before implementing the adapter. If the public API cannot recover an in-flight tool at connection time, show active/unknown tool until the next event rather than guessing. The README must describe this initial-observation limitation. Current and newly active sessions must be visible without launching replacement workers.

## State and lifecycle rules

Normalize observations into session identity, project, agent, parent, event identity, timestamp, and kind. Track concurrent tool calls by call ID; finishing one tool must not erase another active call. Waiting permission/question requests outrank ordinary work while unresolved. Only actual settlement ends a turn; tool completion alone does not mark a session done. Handle tool errors, interruption, request resolution, session removal, and agent switches explicitly.

Use bounded queues and bounded per-session history. Observer callbacks enqueue synchronously and do not block agent execution on network I/O. Network failures are isolated from the agent, with backoff and reconnect snapshots. Plugin cleanup aborts subscriptions, disposes hooks, clears timers, and reports disconnect when possible. Heartbeats distinguish loss of a source from a genuinely idle session. Replayed events and repeated snapshots must be idempotent.

A collector restart triggers metadata/state reconciliation. Preserve only the UI preferences needed for convenience; observation history can be in memory for version one. Do not persist full conversation histories.

## Local data and public repository

Only normalized metadata is sent to the local collector: session title, agent/project identifiers, tool name, status, and timestamps. Do not collect raw prompts, message bodies, tool arguments/results, shell commands, environment variables, or model credentials. Session titles and project labels are still local data and must not be embedded in committed screenshots or fixtures.

Use a same-user local authentication secret for ingestion and browser session access, stored outside the repository, with restrictive file permissions. Bind loopback, reject unexpected origins/hosts, bound request sizes, and escape all labels as text. The builder chooses a straightforward browser bootstrap mechanism without placing credentials in logs or committed files. No cloud service or new AI subscription is required.

## Visual and interaction direction

Pixel Agents is a genre/reference, not an asset source. Use warm wood, muted green plants, dark monitor accents, readable status labels, and varied character colors. Keep the app chrome restrained so the office is the focus. Follow frontend-design and ui-ux-pro-max guidance during implementation.

Support keyboard selection via the roster, visible focus, status text in addition to colors, reduced-motion preference, and a detail-panel layout that works on narrow screens. Use a crisp nearest-neighbor rendering scale for pixel artwork. Implementation choice of canvas versus layered DOM is left to the builder based on reliable selection and accessibility.

## Scope boundary

First version is an observer. Agent launching, prompting, permission approval, terminal embedding, multiuser collaboration, cloud hosting, office editing, and model hosting are outside this first version. Users act on agents in OpenCode as usual.

## Verification and delivery

- Meaningful reducer tests cover concurrent tool calls, permission/question precedence, settlement/error/interruption, duplicate/out-of-order observations, multiple projects, parent-child relationships, and reconnect reconciliation.
- Adapter tests use verified V2 shapes, not V1 mocks. Confirm the installed plugin appears in the active plugin list and exercise live events in OpenCode 2.2.7.
- Start the collector and inspect the real browser interface. Verify selection, details, filtering, narrow layout, disconnected/empty states, and reduced motion. Clearly distinguish live verification from synthetic test fixtures.
- Exercise live observations from the current session and a second project/child session if permitted. Do not create paid AI calls merely to populate a demo without a task-based reason; record any unverified live scenario honestly.
- Run type checking, relevant tests, and production build. Inspect the staged files before publishing; include only source, original assets, synthetic fixtures, docs, and lockfiles.
- Deliver a README with install, global plugin setup/reload, launch URL, shutdown, troubleshooting, supported versions, and uninstall instructions. Provide a convenient local launch command and verify it.
- Commit the design with the implementation after approval, create the authorized public repository if the name is available, and push. If that repository already exists, inspect it before adding a remote or pushing; never overwrite unrelated history.

## Remaining builder discretion

Precise package layout, renderer, local transport (SSE/WebSocket), sprite shapes, default port, UI preference format, visibility cap, and detailed test tooling are implementation choices. Prefer the smallest maintainable solution that satisfies the behaviors above.
