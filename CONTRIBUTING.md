# Contributing

You need macOS, Node 24 or newer and Claude Code.

```sh
npm install
npm run dev
```

`npm run dev` builds the page and runs the server on <http://127.0.0.1:7420> with `KANBAN_AUTH=off`, restarting on change. Before sending a pull request, run:

```sh
npm run check
```

It runs `tsc`, Biome and the tests, and must pass. `npx biome check --write .` fixes formatting.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(web): ...`, `fix(server): ...`, `docs: ...`, one change each, with a body that says why.

`npm run build && node scripts/demo-server.ts` serves the page on <http://127.0.0.1:7421> with a fictional board, for screenshots and for working on the page without real sessions. Demo data, test fixtures and screenshots must be fictional: `acme-*` projects, `/Users/me` paths and `example.com` addresses, never real sessions, transcripts, people or hosts.

Security problems go through [SECURITY.md](SECURITY.md), not issues.
