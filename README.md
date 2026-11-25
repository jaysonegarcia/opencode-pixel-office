# OpenCode Pixel Office

A little pixel-art office for your existing **OpenCode V2** agents. Watch them read, edit, run commands, wait for input, and finish their work. Select a desk for the session's current tools and recent activity.

One shared room, all loaded project locations. Main agents and subagents have their own desks. Search and filter the roster; the room displays up to 40 agents per page.

## Start your office

Requires **Node.js 22+, Yarn Classic 1.22, and OpenCode V2**. Developed and live-tested with **OpenCode 2.2.7**; V1 is not supported.

```sh
git clone https://github.com/jaysonegarcia/opencode-pixel-office.git
cd opencode-pixel-office
yarn install --frozen-lockfile
yarn build
yarn observer:install
yarn start
```

Keep that terminal open. In another terminal in the same directory:

```sh
yarn office:open
```

The office is at **http://127.0.0.1:4780**. `office:open` opens a short-lived sign-in link; opening the bare URL before signing in shows instructions. The browser never receives the long-lived collector credential. Press Ctrl+C in the collector terminal to stop it.

The installer creates one native V2 entry in `~/.config/opencode/plugins/pixel-office.js` (honoring `XDG_CONFIG_HOME` and `OPENCODE_CONFIG_DIR`). It preserves existing files rather than overwriting them. The entry imports the build from your checkout, so keep that checkout in place.

Verify registration with `opencode plugin list`. OpenCode watches plugin files; if the observer is absent, finish/save ongoing work and restart OpenCode. No changes to your configured agents or prompts are needed. This is an observer: use OpenCode itself to answer questions, approve tools, or send prompts.

### Another port

```sh
yarn start --port 4781
yarn office:open --port 4781
```

Then replace the installer-created entry with:

```js
import { Plugin } from '@opencode/plugin';
import { startObserver } from 'file:///absolute/path/to/opencode-pixel-office/dist/plugin/index.js';
export default Plugin.define({
  id: 'opencode-pixel-office',
  setup: context => startObserver(context, { url: 'http://127.0.0.1:4781' }),
});
```

OpenCode resolves its native `@opencode/plugin` runtime. Use your actual checkout path. Only loopback HTTP collectors are accepted.

## What the office knows

- Native V2 execution, tool, permission and question events drive the desk state.
- Each loaded OpenCode location observes its own sessions; the collector combines locations into one room.
- On first connection, running sessions are found through paginated session metadata (`time.busy > time.idle`). OpenCode 2.2.7's plugin context does not expose `session.active` directly. Already-idle historical sessions are not imported.
- Tool names can be **unknown tool** when the upstream event omits the name. Starting halfway through a tool cannot reconstruct that tool's name.
- A permission already pending at bootstrap is restored. A question that was already open before the observer loaded cannot be recovered through this plugin context; newly observed questions work normally.
- Completion becomes idle after 15 seconds. A missing observer lease becomes disconnected after 30 seconds. The observer maintains a local snapshot and rebuilds the collector after reconnects, including when no new tool events arrive.
- After a collector restart, run `yarn office:open` again: browser authentication is intentionally in-memory. The UI labels retained data stale when authentication expires.
- Up to 500 session records and 50 recent actions per session are kept in memory. Restarting the collector clears retained history. Live child-session/permission flows are covered by synthetic fixtures; not every scenario has been exercised with a real agent.

## Local data

The UI has no analytics, remote fonts or network artwork. The collector binds to loopback. Ingestion requires a local bearer credential; browser access uses a one-use exchange code and an HttpOnly, SameSite cookie. Requests check their Host and Origin.

Session titles, project names, directories, agent names and tool names are visible locally. **Prompts, tool arguments, tool outputs, answers and raw error text are not forwarded.** Do not publish screenshots containing private session titles or directory names.

The credential lives at `$XDG_STATE_HOME/opencode-pixel-office/credential`, defaulting to `~/.local/state/opencode-pixel-office/credential`, with mode `0600`. It is outside the repository. No session history is persisted by this app.

## Develop

```sh
yarn test
yarn typecheck
yarn build
```

`yarn dev` starts Vite for UI development. For authenticated browsing, use the built collector URL; its origin checks intentionally reject a separate development port.

The source has three small layers:

- `src/plugin/`: native V2 observer, sanitized event adapter and bounded transport.
- `src/core/` and `src/server/`: state reducer, authenticated HTTP collector and SSE.
- `src/ui/`: original SVG pixel characters, CSS room and accessible React controls.

All artwork is original code-drawn SVG/CSS. No Pixel Agents assets or branding are included. Inspired by the idea of seeing coding agents inhabit a tiny office; not affiliated with OpenCode or Pixel Agents.

## Remove

Stop the collector, remove the single `pixel-office.js` entry from your OpenCode plugins directory, and reload OpenCode. You can then remove the checkout and, optionally, `~/.local/state/opencode-pixel-office/`. Leave other plugin entries and configuration intact.

## License

MIT. See [LICENSE](LICENSE).
