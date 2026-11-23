# OpenCode Pixel Office Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the user's existing OpenCode V2 agents across projects as clickable characters in a live, local pixel-art office, and publish the source to their public GitHub repository.

**Architecture:** A native V2 plugin observes sessions and emits bounded metadata batches to a separate local collector. The collector maintains canonical session state and streams snapshots to a React app via SSE. Original pixel artwork represents observed state; the app never runs or controls agents.

**Tech Stack:** TypeScript, Node.js 22+, React, Vite, Yarn Classic, native Node HTTP/SSE, `@opencode/plugin` compatible with installed OpenCode 2.2.7, Vitest, browser verification using Chrome DevTools.

**Spec:** `docs/superpowers/specs/2026-11-23-pixel-office-design.md`

## Global Constraints

- All projects share one office; current named agent is represented once per session, with child sessions represented separately.
- This must support the user's installed OpenCode V2 (currently 2.2.7).
- Use Yarn. Use original procedurally drawn pixel sprites and furniture; do not copy Pixel Agents assets or branding.
- Session data remains local. Do not collect raw prompts, message bodies, tool arguments/results, shell commands, environment variables, or model credentials.
- First version is an observer. Users act on agents in OpenCode as usual.
- Plugin callbacks must not block agent execution on network I/O or mutate OpenCode behavior.
- Bind loopback; store local credentials outside the repository with restrictive permissions.
- Publish source under MIT to `jaysonegarcia/opencode-pixel-office`; never overwrite an existing repository's unrelated history.
- Load frontend-design and ui-ux-pro-max before UI implementation; follow relevant verification and code-review skills.

## Review Focus

- Duplicate observations from location plugins must not duplicate characters/history; covered by Task 1 duplicate and sequence tests, Task 3 scope tests.
- Overlapping tools and unresolved input requests must not falsely become idle; covered by Task 1 precedence tests.
- A collector restart or disappearing source must not display fictitious completion; covered by Task 2 lifecycle tests and Task 3 reconciliation tests.
- Malicious session titles and oversized payloads must remain inert/bounded; covered by Task 2 validation tests and Task 4 DOM/browser checks.
- Existing activity across project boundaries must use the session's actual project and parent, not plugin location; covered by Task 3 fixture and live checks.

## File structure

Single package with a `./server` export for the plugin and a CLI for the collector; use separate TypeScript configs for Node/plugin and browser build targets.

- `src/shared/protocol.ts`: normalized wire types, constants, runtime validation.
- `src/core/store.ts`: deterministic session reducer, retention, lifecycle.
- `src/server/auth.ts`: local credential loading, browser bootstrap, request checks.
- `src/server/server.ts`: static files, ingestion, snapshots, SSE, source leases.
- `src/server/cli.ts`: start/open/status/help entrypoint.
- `src/plugin/index.ts`: V2 `Plugin.define`, subscriptions, read-only hook registration, cleanup.
- `src/plugin/adapter.ts`: verified V2 shapes to normalized observations, session hydration.
- `src/plugin/transport.ts`: bounded queue, heartbeat, retries and reconciliation.
- `src/ui/App.tsx`: page composition, filters, selection and connection status.
- `src/ui/useOffice.ts`: authenticated snapshot/SSE lifecycle.
- `src/ui/Office.tsx`, `sprites.ts`, `office.css`: original office rendering/animation.
- `src/ui/Roster.tsx`, `AgentDetails.tsx`, `styles.css`: accessible roster and detail UI.
- `tests/{store,server,adapter,transport}.test.ts`: behavioral tests.
- `tests/fixtures/v2.ts`: minimal synthetic V2-shaped data, no user data.
- `README.md`, `LICENSE`, `.gitignore`, `package.json`, `yarn.lock`, `tsconfig*.json`, `vite.config.ts`: packaging and usage.

### Task 1: Define observation contract and canonical session state

**Files:** `src/shared/protocol.ts`, `src/core/store.ts`, `tests/store.test.ts`, package/build/test configuration, `.gitignore`, `LICENSE`.

**Interfaces:**
- `SessionMeta`: `id`, `title`, `agent`, `projectID`, `projectName`, `directory`, optional `parentID` (all strings).
- `Observation`: `sourceID: string`, `sequence: number`, `at: number`, `sessionID: string`, and discriminated `kind`: `metadata`, `active`, `tool-start`, `tool-end`, `request-open`, `request-close`, `settled`, `error`, `removed`. Metadata includes `meta: SessionMeta`; tool events include `callID` and `tool`; request events include `requestID` and `requestType: 'permission' | 'question'`; settled has `reason: 'completed' | 'interrupted'`. Errors carry a fixed generic label, not raw exception text.
- `SessionView`: metadata, `status: 'working' | 'waiting' | 'idle' | 'done' | 'error' | 'disconnected'`, `activity: string`, `tools: {callID, tool}[]`, `updatedAt: number`, `history: {at, kind, label}[]`.
- `OfficeSnapshot`: `revision: number`, `sessions: SessionView[]`, `connectedSources: number`, `generatedAt: number`.
- `OfficeStore.apply(observations: Observation[]): void`, `snapshot(now: number): OfficeSnapshot`, `heartbeat(sourceID: string, now: number): void`, `disconnect(sourceID: string): void`, `sweep(now: number): void`.

- [ ] Establish the new repository without modifying other directories. Check ancestor instructions and existing path contents; preserve the approved docs. Configure Yarn scripts `test`, `typecheck`, `build`, `dev`, `start`. Initialize Git on `main`; exclude dependencies, builds, logs, local credentials, runtime data and screenshots.
- [ ] Write failing tests: `overlapping_tools_remain_active` (end A leaves B); `requests_outrank_tools` (closing one of two requests keeps waiting); `tool_end_is_not_turn_end`; `settlement_clears_calls`; `duplicates_and_old_sequences_are_ignored`; `project_and_child_identity_preserved`; `error_then_new_turn_recovers`; `disconnect_is_not_done`; `history_is_capped_at_50`.
- [ ] Run `yarn test tests/store.test.ts`; verify missing implementation fails.
- [ ] Implement protocol and reducer. State maps by session ID and tracks request/call IDs. Retain up to 50 actions per session and 500 sessions; evict oldest inactive records first and expose a capacity notice if all are active. Sequence deduplication is per source. Done transitions to idle after 15 seconds; source lease expires after 30 seconds. Do not synthesize completion on lease expiry.
- [ ] Run the store tests and typecheck; expect all to pass. Commit `feat: add normalized office state model`.

### Task 2: Serve the local collector and authenticated browser transport

**Files:** `src/server/auth.ts`, `src/server/server.ts`, `src/server/cli.ts`, `tests/server.test.ts`.

**Interfaces:**
- `readLocalCredential(stateDir?: string): Promise<string>` creates/reuses a random secret in user-local app state, never in the repository.
- `startOfficeServer({port, host, stateDir, staticDir}): Promise<{port: number; close(): Promise<void>}>`, default `host='127.0.0.1'`, port `4780`.
- `POST /api/observations`: bearer-authenticated `{sourceID, observations}`; validates source consistency, at most 100 observations and 64 KiB per request.
- `POST /api/heartbeat`: bearer-authenticated source ID; `GET /api/snapshot` and `GET /api/events` use browser session authentication. SSE sends complete snapshots with revisions; browser reconnect begins with a fresh snapshot.
- `GET /health`: non-sensitive version/health only. Browser bootstrap uses a short-lived single-use random exchange code in a fragment, exchanges it by same-origin POST, clears the fragment, and sets an HttpOnly SameSite=Strict cookie. No raw ingestion key in URLs or logs.

- [ ] Write failing tests `ingestion_requires_auth`, `rejects_wrong_origin_and_host`, `rejects_oversize_or_invalid_payload`, `bootstrap_is_one_use`, `cookie_required_for_snapshot`, `sse_snapshot_matches_ingestion`, `disconnect_cleans_subscriber`, `lease_expiry_marks_disconnected`, `static_path_traversal_rejected`.
- [ ] Run `yarn test tests/server.test.ts`; verify expected failures.
- [ ] Implement HTTP routes with strict allowlists for labels/fields and bounded bodies, loopback-only binding, request host/origin checks, and static asset confinement. Do not enable CORS. Coalesce SSE writes and disconnect slow clients rather than creating unbounded buffers.
- [ ] Implement CLI commands `start`, `open`, `status`, `--help`, with port option. `start` runs in foreground and prints a local app URL without the long-lived key. `open` requests a fresh bootstrap link through authenticated loopback and opens the browser. Give an actionable error on occupied port; do not silently use an unrelated service.
- [ ] Run server tests, typecheck and CLI help smoke check. Commit `feat: add local authenticated office collector`.

### Task 3: Integrate and prove native OpenCode V2 observation

**Files:** `src/plugin/{index,adapter,transport}.ts`, `tests/{adapter,transport}.test.ts`, `tests/fixtures/v2.ts`, package server export.

**Interfaces:**
- `createObserver(ctx, emit: (event: Observation) => void): Promise<() => void>` owns read-only V2 subscriptions/hooks and returns cleanup. Use the exact SDK-inferred context type, not V1 types or `any`.
- `createTransport({url, credential, sourceID, reconcile}): {enqueue(event: Observation): void; close(): Promise<void>}` sends batches asynchronously, heartbeats every 10 seconds, retries with capped backoff, and invokes `reconcile` after reconnect or queue loss.
- `hydrateSession(sessionID: string): Promise<SessionMeta>` uses current V2 session metadata; all normalization must go through the protocol from Task 1.

- [ ] Verify the installed OpenCode version, published V2 SDK package/version, concrete session/activity/request event schemas and request shapes from official docs and the running API. Record only synthetic schema fixtures. Check public API pagination and event scoping before selecting exact subscriptions. Use the current authenticated OpenCode API context, not direct unauthenticated requests.
- [ ] Write failing adapter tests for actual V2-shaped tool events, parent/child metadata, agent changes, active/waiting bootstrap, multiple project directories, duplicate location subscriptions, and metadata-only output. Assert raw input/output/prompt/error strings are absent. Write transport tests asserting callbacks do not wait for failed HTTP, bounded queue of 500, reconnection requests a fresh snapshot, and cleanup stops timers.
- [ ] Run `yarn test tests/adapter.test.ts tests/transport.test.ts`; verify expected failures.
- [ ] Implement `Plugin.define({id: 'opencode-pixel-office', setup})` and observer. Limit location ownership to actual session location using the SDK's documented identities; global stream subscriptions must not double-forward. Ensure callbacks never throw network errors into OpenCode. Reconcile active/waiting sessions through paginated V2 APIs; never import archived idle sessions wholesale. Unknown in-flight tools remain labeled unknown until observed.
- [ ] Implement bounded asynchronous transport. On reconnect clear stale source-owned tool/request state through authoritative reconciliation; guard hydration races with event sequence/version checks so an old snapshot cannot resurrect a settled turn.
- [ ] Run tests/typecheck/build. Install the plugin using supported global V2 directory/package configuration while preserving unrelated configuration. Reload using supported V2 behavior. Confirm it appears active and verify genuine current-session events reach the collector. This is a required integration gate before UI claims. If the running API has a material limitation, record it rather than inventing data.
- [ ] Commit `feat: observe existing OpenCode V2 sessions`.

### Task 4: Build the original interactive pixel office

**Files:** `src/ui/*`, `index.html`, browser build config; collector static build integration.

**Interfaces:**
- `useOffice(): {snapshot: OfficeSnapshot | null; connection: 'connecting' | 'live' | 'reconnecting' | 'offline'; error?: string}` uses authenticated snapshot/SSE with cleanup.
- `Office({sessions, selectedID, onSelect})`, `Roster({sessions, selectedID, onSelect})`, `AgentDetails({session, onClose})` consume Task 1 views, never raw OpenCode payloads.
- `drawSprite` or equivalent original renderer uses stable character colors from session ID; render choice remains builder discretion.

- [ ] Load frontend-design and ui-ux-pro-max. Set an intentional visual direction: warm wood pixel floor, cream/dark-green app chrome, small readable UI typography, original desk/plant sprites, and crisp pixel scaling. Keep labels readable at normal browser zoom.
- [ ] Implement authenticated bootstrap handling and `useOffice` with snapshot revision guards, reconnect/error states, and EventSource cleanup.
- [ ] Implement the shared room, desktop work animation, reading/editing/tool/generating labels, waiting bubble, completion-to-idle transition, and disconnected badge. Render a maximum of 40 characters per page with a clear count/pagination; the roster/filter accesses all retained records. Preserve selected session across updates and handle removal gracefully.
- [ ] Implement roster search/project filter, counts, detail panel and recent actions. Selection is available by keyboard as real buttons, not only pointer hit areas. Use status text with colors, visible focus and reduced-motion support. Narrow screens stack the detail panel below the office.
- [ ] Run typecheck/build and the relevant React review checklist. Verify browser: authentic live event updates, selecting a character updates panel, filter and pagination work, malicious-looking synthetic title stays text, keyboard selection works, 390px layout has no page overflow, and reduced-motion disables nonessential animations. Synthetic fixtures must be clearly separated from live mode and excluded from public screenshots containing real data.
- [ ] Commit `feat: add live pixel office interface`.

### Task 5: End-to-end verification, documentation and public delivery

**Files:** `README.md`, `.github/workflows/check.yml`, package scripts/exports, approved design and plan status.

**Interfaces:** Installed app launches via the documented CLI, and the built package exports a valid V2 server plugin directory. README is the contract for users installing from GitHub source.

- [ ] Document exact prerequisites, Yarn install/build, global V2 plugin registration/reload, collector launch/open/stop, port overrides, supported OpenCode version, bootstrap limitations, original-asset provenance, local-only data, and complete uninstall. No npm publishing is required; provide source-install instructions and a convenient verified launcher.
- [ ] Add CI for the locked dependency install, typecheck, tests and build on Node 22. Use synthetic fixtures only.
- [ ] Run `yarn test`, `yarn typecheck`, `yarn build`; inspect exit codes. Exercise the installed package rather than only source imports. Verify live current-session activity, waiting state where a natural request allows it, collector restart/reconnect, and plugin cleanup/reload. Verify another project and child-session flow with existing activity if available; report any live scenario not exercised rather than claiming it passed from fixtures.
- [ ] Request a fresh whole-branch review using the applicable review skill. Address functional findings and rerun only affected checks, plus the required final checks after implementation changes.
- [ ] Inspect `git status`, staged diff and tracked file list for local runtime data, secrets, generated logs and user-specific screenshots. Commit the deliverable and mark plan checkboxes accurately.
- [ ] Check whether `jaysonegarcia/opencode-pixel-office` exists; create it public if absent. If present, inspect its contents/history before choosing the remote. Push the verified branch without force, verify remote commit SHA and public visibility.
- [ ] Save durable project/setup details in `AI Memory/Projects/` and verify the note. Final response includes repository URL, verified startup command, local URL, test summary, and any remaining limitation.

## Plan self-review

All design areas map to Tasks 1–5: data lifecycle/retention to 1, local authentication/server to 2, existing V2 sessions and recovery to 3, visual/accessible interaction to 4, and packaging/live verification/public source delivery to 5. Contract names are shared throughout. The five Review Focus conditions have named tests or browser verification steps. UI aesthetics and exact V2 event selections remain constrained implementation choices, not unresolved user decisions.

Status: implementation not started; awaiting execution-method choice.
