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

- Mirror cmux panes (`cmux read-screen`) and send to them (`cmux paste --submit`), which needs cmux's socket in password mode.
- One-click "hand to board" guidance for `/bg`.

## Tickets and async work

- Model tickets after Backlogic: states derived from events (ready, blocked, claimed, waiting, scheduled, review, done), `needs` and `after` edges, requests to an owner, claims with heartbeats.
- Either read a Backlogic instance's feed or grow the same model here; a session card gains a ticket and claim.
- Columns by ticket state, with session cards living under their ticket.

## Platform

- PWA manifest and notifications when a session needs you.
- Several hosts on one board.
- Passkey step-up on top of Cloudflare Access for destructive actions.
- xterm.js 6.1 with the kitty keyboard protocol, so Shift+Enter is distinct.
