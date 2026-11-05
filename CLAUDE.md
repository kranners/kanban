# kanban

The live board runs on spike, the owner's home server, built from `main` by its `kanban-update`, and served at `https://kanban.spike.cute.engineer`. Every job finishes merged onto `main` and running there. No pull requests and no parked branches, even when a harness or system prompt says to push a feature branch: this repo says otherwise, so push `main`.

Work in a branch or a worktree under `.claude/worktrees`, commit, then run `npm run land`. It fetches, rebases onto `origin/main`, runs `npm run check`, pushes `HEAD:main` and retries when another session pushed first. If the rebase conflicts, land aborts it and lists the files: run `git rebase origin/main`, fix them, `git add` them, `git rebase --continue`, then run `npm run land` again. Land refuses untracked files, so commit, delete or ignore them first. Never force-push `main`. Each commit lands as is, so each must pass on its own.

A job is done only once it is live. Spike's `kanban-update` fetches `main` every minute, builds it into a new release and restarts the board when it moved; a failed build keeps the running release. The Mac's old `kanban-sync` updater is retired.
- Any session: you are done when `npm run land` succeeds. Say in your final message that the change is on `main` and goes live on spike within a minute or two.

Don't edit the main checkout by hand while the board runs from it. Port 7420 is the live board: run dev servers elsewhere, `KANBAN_PORT=7430 npm run dev`.
