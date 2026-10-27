import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { listFiles, scoreFile } from "./files.ts";

const root = mkdtempSync(join(tmpdir(), "kanban-files-"));
after(() => rmSync(root, { recursive: true, force: true }));

const touch = (path: string) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "x");
};

const claudeHome = join(root, "home", ".claude");
touch(join(claudeHome, "sessions", "1.key"));

describe("listing a session's files", () => {
	it("lists a repository's tracked and untracked files but not ignored ones", async () => {
		const repo = join(root, "repo");
		touch(join(repo, "src", "app.ts"));
		touch(join(repo, "src", "widget.ts"));
		touch(join(repo, "notes.md"));
		touch(join(repo, "debug.log"));
		writeFileSync(join(repo, ".gitignore"), "*.log\n");
		execFileSync("git", ["init", "-q"], { cwd: repo });
		const listing = await listFiles({ cwd: repo, query: "", claudeHome });
		assert.equal(listing.ok, true);
		if (!listing.ok) return;
		assert.deepEqual([...listing.files].sort(), [
			".gitignore",
			"notes.md",
			"src/",
			"src/app.ts",
			"src/widget.ts",
		]);
	});

	it("filters by query, best matches first, within a limit", async () => {
		const repo = join(root, "repo");
		const listing = await listFiles({ cwd: repo, query: "wid", claudeHome });
		assert.deepEqual(listing, { ok: true, files: ["src/widget.ts"] });
		const limited = await listFiles({
			cwd: repo,
			query: "",
			claudeHome,
			limit: 2,
		});
		assert.equal(limited.ok && limited.files.length, 2);
	});

	it("walks a plain directory without hidden or dependency folders", async () => {
		const plain = join(root, "plain");
		touch(join(plain, "a.txt"));
		touch(join(plain, "deep", "b.txt"));
		touch(join(plain, "node_modules", "pkg", "index.js"));
		touch(join(plain, ".cache", "c.txt"));
		const listing = await listFiles({ cwd: plain, query: "", claudeHome });
		assert.deepEqual(listing.ok && [...listing.files].sort(), [
			"a.txt",
			"deep/",
			"deep/b.txt",
		]);
	});

	it("stops scanning at the scan limit and depth limit", async () => {
		const wide = join(root, "wide");
		for (let n = 0; n < 30; n++) touch(join(wide, `f${n}.txt`));
		touch(join(wide, "a", "b", "c", "deep.txt"));
		const listing = await listFiles({
			cwd: wide,
			query: "",
			claudeHome,
			scanLimit: 10,
			limit: 100,
		});
		assert.equal(listing.ok && listing.files.length, 10);
		const shallow = await listFiles({
			cwd: wide,
			query: "deep",
			claudeHome,
			depthLimit: 1,
		});
		assert.deepEqual(shallow, { ok: true, files: [] });
	});

	it("never lists Claude Code's own directory", async () => {
		const home = join(root, "home");
		touch(join(home, "project.txt"));
		const listing = await listFiles({ cwd: home, query: "", claudeHome });
		assert.deepEqual(listing, { ok: true, files: ["project.txt"] });
		const inside = await listFiles({ cwd: claudeHome, query: "", claudeHome });
		assert.equal(inside.ok, false);
		const project = join(root, "with-links");
		touch(join(project, "kept.txt"));
		mkdirSync(join(project, "sub"), { recursive: true });
		symlinkSync(claudeHome, join(project, "claude-home-link"));
		symlinkSync(
			join(claudeHome, "sessions"),
			join(project, "sub", "sessions-link"),
		);
		assert.deepEqual(await listFiles({ cwd: project, query: "", claudeHome }), {
			ok: true,
			files: ["sub/", "kept.txt"],
		});
		const linked = join(root, "linked");
		symlinkSync(claudeHome, linked);
		assert.equal(
			(await listFiles({ cwd: linked, query: "", claudeHome })).ok,
			false,
		);
	});

	it("refuses relative or missing directories", async () => {
		assert.equal(
			(await listFiles({ cwd: "repo", query: "", claudeHome })).ok,
			false,
		);
		assert.equal(
			(await listFiles({ cwd: join(root, "gone"), query: "", claudeHome })).ok,
			false,
		);
	});

	it("scores name prefixes above substrings and subsequences", () => {
		assert.equal(scoreFile("src/widget.ts", "wid"), 0);
		assert.equal(scoreFile("src/my-widget.ts", "wid"), 1);
		assert.equal(scoreFile("widgets/a.ts", "dgets/"), 2);
		assert.equal(scoreFile("src/widget.ts", "swt"), 3);
		assert.equal(scoreFile("src/widget.ts", "zz"), null);
	});
});
