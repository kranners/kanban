# kanban

The live board runs from the main checkout on `main`. Land every change on `main`: branch or worktree for the work, run `npm run check`, merge into `main` and push `origin main`. Rebase or merge onto the latest `origin/main` first, since other sessions push there too.

A job is done only once it is live. After pushing, update the main checkout with `git pull --ff-only` and `npm run build` there (a worktree session leaves its worktree first, keeping it), check the change on the live board, then finish. `node --watch` restarts the server on its own; the page needs the build. Browsers cache `app.js` and `app.css` for an hour, so check with a hard reload.
