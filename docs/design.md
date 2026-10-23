# Design

kanban is a board of the Claude Code sessions running on one Mac. Each card is a live session; cards are linked when one spawned, forked or delegated to another, and messages between them are drawn on the board. Clicking a background session opens its real TUI in the browser.

## Why build it

No existing tool covers the set (surveyed 2026-10-24):

| Tool                                                              | Gap                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| `claude agents` (agent view)                                      | TUI only, background sessions only, no graph or messages         |
| Remote Control / claude.ai/code                                   | Chat view, not the TUI; no board, graph or messages              |
| Vibe Kanban, Claude Squad, CCManager, Conductor, Nimbalyst, Happy | Only see sessions they launch; no relationship or message graph  |
| CloudCLI, claude-code-viewer, opcode, agentsview                  | Read transcripts; resume through the SDK instead of the live TUI |
| Hook-based observability dashboards                               | Only sessions with their hooks; no TUI                           |

kanban builds on Claude Code's own primitives instead: the session registry, background jobs, `claude attach`, and transcripts.

## Sources of truth

Everything about sessions is read from `~/.claude`; kanban keeps no database. The one thing it stores is where people put cards: `layout.json` in `KANBAN_STATE` (default `~/.local/state/kanban`), written atomically, with placements pruned a day after their node leaves the board.

| Need                                    | Source                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| Live sessions                           | `~/.claude/sessions/<pid>.json` (watched)                                                    |
| Background jobs, including stopped ones | `~/.claude/jobs/<short>/state.json`                                                          |
| What a background session is doing      | `state.json` `detail`, `needs`, `state`                                                      |
| What an interactive session is doing    | last `tool_use` in its transcript                                                            |
| Transcript path                         | `~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl`, falling back to a glob on the id         |
| Subagents                               | `<transcript dir>/<sessionId>/subagents/**/agent-<id>.meta.json`                             |
| Spawned by `claude --bg`                | `backgrounded · <short>` in a parent's Bash tool result                                      |
| Forked by `/bg`                         | `continued-in` record in the parent transcript                                               |
| Messages                                | `SendMessage` tool results (`msg_id`) matched to recipients' `origin.kind == "peer"` records |
| Card preview                            | last 12 transcript entries, rendered server-side when `updatedAt` changes                    |

Secrets that are never read or served: `sessions/*.key`, `daemon/control.key`, roster `ptyAuth`/`rvAuth`, `respawnFlags`, `providerEnv`.

## Data model

`src/shared/types.ts` is imported by server and page alike. A `Board` is `sessions`, `subagents`, `links` and `messages`. Links and messages point at `NodeRef`s, so subagents and sessions are both nodes. The model is derived, never stored, and rebuilt incrementally as files change.

`Activity` folds Claude Code's `status` (busy, idle, waiting, shell) and job `state` (working, blocked, done, failed, stopped) into six states, each a colour paired with a shape:

| Activity  | Shape       | Meaning                         |
| --------- | ----------- | ------------------------------- |
| working   | pulsing dot | mid-turn                        |
| needs-you | triangle    | blocked on a person             |
| idle      | ring        | waiting for a prompt            |
| done      | check       | background job finished         |
| failed    | cross       | background job failed           |
| stopped   | square      | process gone, can be reattached |

## Front end and back end

One Node 24 process on `127.0.0.1:7420` serves the built page and these endpoints:

| Endpoint                           | Purpose                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                            | the page                                                                                                                                |
| `WS /api/feed`                     | `BoardFeed` frames: a full `board` on every change (debounced), `layout` on connect and on change, `preview` frames for card thumbnails |
| `GET /api/sessions/:id/transcript` | recent `TranscriptEntry`s for read-only cards                                                                                           |
| `POST /api/sessions`               | `NewSessionRequest` → `claude --bg`; without `name` Claude Code names it, with `at` the card spawns there                               |
| `POST /api/sessions/:id/exit`      | `ExitRequest` → `ExitResult`: asks the session whether it is safe to exit (unless `force`), then ends it                                |
| `PUT /api/layout`                  | `LayoutUpdate` → 204: stores one node's placement and broadcasts the layout                                                             |
| `WS /api/attach/:short`            | a `claude attach` pty: binary output down, `AttachClientFrame`s up                                                                      |
| `GET /healthz`                     | liveness                                                                                                                                |

One attach per session: a second attach takes over and the first gets `taken-over`, because Claude Code redraws a shared session at the last attacher's size. Closing the socket kills the attach process, which detaches without stopping the session. If the attach drops into Claude's agent view (← on an empty prompt, recognised by its `claude agents` window title), kanban sends Enter to return, and Escape for a workspace trust dialog there. This guard is a convenience against stray keys, not a security boundary: whoever passes Cloudflare Access can already drive any background session, so Access is the boundary.

The server calls the real `claude` binary, not a terminal's shim, so `--bg` sessions resume as themselves.

Exiting asks the agent itself without touching the real session: `claude -p --resume <id> --fork-session --session-id <fork> --no-session-persistence --tools "" --output-format json --json-schema {ready, reason}` answers from a throwaway fork that cannot run tools and leaves no transcript. The fork registers in `~/.claude/sessions` while it runs, so ingest ignores its id. A ready (or forced) background session gets `claude stop` then `claude rm`, never with `--discard-unpushed` or `--force-remove-worktree`, so `rm` refusing leaves it stopped and says why. An interactive session gets SIGTERM, only while its pid is still that session's live registry entry. Every exit is audited.

## User flows

1. **Scan.** Open the board. Cards group into families (a session and everything it spawned), newest first by when they started, so cards stay put while sessions work. Each card shows its name and what it is doing above a live preview, with a state badge.
2. **Follow messages.** A message animates along a dashed arc from sender to recipient; the messages rail lists them newest first, and selecting one highlights both ends.
3. **Focus.** Click a background card. It expands into a full-window terminal attached to the session, with focus in the prompt; type to send. Close returns to the board, and the session keeps running.
4. **Read.** Click an interactive card (started in a terminal). It opens a live transcript, read-only, with a note that sessions started from the board are the ones you can drive.
5. **Start.** New session: pick a directory (recent ones suggested), name it, give a first prompt. It appears on the board and opens focused.

## Infrastructure

pilot runs two launchd user agents, declared in jimbo's pilot host module:
- `kanban`: `node src/server/main.ts` from the checkout.
- `kanban-tunnel`: `cloudflared tunnel run` for the `kanban` tunnel.

`kanban.cute.engineer` routes through the tunnel and is gated by Cloudflare Access (team `frappuccino-pages`), allowing one identity. Defence in depth: cloudflared requires the Access token before proxying, the server verifies `Cf-Access-Jwt-Assertion` against the team's keys and audience, and WebSocket upgrades must come from the board's own origin. Local development runs with `KANBAN_AUTH=off`, which binds to localhost only.

`scripts/cloudflare-setup.ts` creates the tunnel, its DNS record and the Access application from an API token, idempotently, and writes the tunnel token and audience to `~/.config/kanban/`.

A web app instead of a desktop wrapper: the server must run as a long-lived local service anyway, and a PWA manifest makes it installable.

## Visual design

Flat and quiet: a warm off-white canvas, white cards with hairline borders, no shadows except on the focused card, one accent colour. Inter for the interface, JetBrains Mono for terminals and previews, Lucide icons. Light and dark follow the system, with a toggle. State is always colour plus shape.
