# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting: open [a new advisory](https://github.com/kranners/kanban/security/advisories/new) from the repository's Security tab. Do not open a public issue or pull request for a security problem.

Include what an attacker can reach, the steps to reproduce it and the commit you tested. Replies come on the advisory, and its details are published once a fix is out.

## Threat model

kanban is a remote terminal into every background Claude Code session and every session in a cmux pane on the machine it runs on. Whoever gets past its authentication can type into those sessions, answer their permission prompts and start new ones, with the user's full reach. Everything is designed around keeping that door shut:
- The server binds to `127.0.0.1` by default. `KANBAN_AUTH=off` is refused on any address that is not loopback.
- Remote access goes through a Cloudflare Tunnel gated by Cloudflare Access, which admits one identity; cloudflared rejects requests without a valid Access token.
- The server verifies `Cf-Access-Jwt-Assertion` against the Access team's signing keys and the application audience on every request but the health check.
- WebSocket upgrades must come from the board's own origin.
- Session keys, the daemon control key and the other secrets under `~/.claude` are never read or served.
- The board agent runs headless Claude Code with only the board's own tools: no shell, no file access and no forced exits. Its tool endpoint takes a per-run token from loopback only and refuses requests that came through the tunnel.
- The session doc tool endpoint (`POST /api/docs/tools/:tool`), which the `kanban` MCP server of each session the board starts calls, answers only loopback requests with no browser `Origin` and refuses any that came through the tunnel. It trusts the session id the local process names, the same trust as the peer hook, and acts only on doc stores linked to that session at that moment; it grants nothing a local process couldn't already do by writing to the board's state directory.
- Doc store files are written by sessions, so they are served with a content type from their extension, `nosniff`, `no-cache` and a sandboxed content security policy that runs no scripts and loads nothing from elsewhere.
- Exits, new sessions, a person's sends and every change the board agent makes are written to an audit log (`KANBAN_AUDIT_LOG`, default `~/Library/Logs/kanban/audit.jsonl`); a person's sends are logged by length, never by text.

In scope: anything that lets a request reach a session, a terminal, a file or a secret without passing these checks, or lets the board agent exceed its tools. Out of scope: an attacker who already runs code as the user on the machine, and the security of Claude Code, cmux or Cloudflare themselves.
