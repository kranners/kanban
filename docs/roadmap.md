# Roadmap

The MVP is the board, relationships, messages, focused TUI for background sessions, and starting new sessions. Planned after it, roughly in order:

## Session control

- **Stop** a session (`claude stop`), keeping its conversation.
- **Delete** a session and its worktree (`claude rm`).
- **Ask to exit when finished**: send a session a peer message asking it to wrap up, and stop it once its job reports `done`.
- **Ask all finished to exit**: the same across every session whose job is `done` or idle past a threshold.
- **Respawn** stale sessions on the current Claude Code version (`claude respawn`).
- **Audit log** of every mutating action, with a step-up confirmation for bulk actions.

## Messaging

- **Nudge**: post to a session's peer inbox from the board without attaching. It arrives as a peer message, so it can't approve permissions.
- **Wake** a stopped session with a prompt (`claude --bg --resume <id> "<prompt>"`).
- Message threads per pair of sessions.

## Interactive sessions

- ~~Mirror cmux panes (`cmux read-screen`) and send to them (`cmux paste --submit`).~~ Done; a server started outside cmux still needs cmux's socket in password mode.
- One-click "hand to board" guidance for `/bg`.

## Tickets and async work

- Tickets as an append-only event log: each ticket's state (ready, blocked, claimed, waiting, scheduled, review, done) is derived from its events, `needs` and `after` edges order the work, requests go to an owner, and a session claims a ticket with heartbeats so a dead claim lapses.
- A session card gains its ticket and claim.
- Columns by ticket state, with session cards living under their ticket.

## Platform

- Several hosts on one board.
- Passkey step-up on top of Cloudflare Access for destructive actions.
- xterm.js 6.1 with the kitty keyboard protocol, so Shift+Enter is distinct.
