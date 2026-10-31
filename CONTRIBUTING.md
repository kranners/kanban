# Contributing

You need macOS, Node 24 or newer and Claude Code.

```sh
npm install
npm run dev
```

`npm run dev` builds the page and runs the server on <http://127.0.0.1:7420> with `KANBAN_AUTH=off`, restarting on change. Port 7420 belongs to the live board. In a worktree, run `KANBAN_PORT=7430 npm run dev`; its state goes to `kanban-7430`.

## Landing a change

Changes land directly on `main`; there are no pull requests. Commit, then run:

```sh
npm run land
```

It rebases onto `origin/main`, runs `npm run check` (`tsc`, Biome and the tests; must pass), pushes `HEAD:main` and retries if `main` moved. It refuses untracked files, since the check would see them and `main` would not. The owner's Mac picks it up within a minute through `kanban-sync`. Never force-push `main`. `npx biome check --write .` fixes formatting.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(web): ...`, `fix(server): ...`, `docs: ...`, one change each, with a body that says why. Each commit lands on `main` as is, so each must build and pass on its own.

`npm run demo` builds the static demo and serves it on <http://127.0.0.1:7421/demo/> with a fictional board (add `?scenario=headline&play` for the large scripted one), for screenshots and for working on the page without real sessions. Demo data, test fixtures and screenshots must be fictional: `acme-*` projects, `/Users/me` paths and `example.com` addresses, never real sessions, transcripts, people or hosts.

Security problems go through [SECURITY.md](SECURITY.md), not issues.
