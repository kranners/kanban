import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { FolderBrowse, FolderListing } from "../shared/types.ts";
import { browseFolder, expandHome, maxFolders } from "./browse.ts";

const listed = (found: FolderBrowse): FolderListing => {
	if (!found.ok) assert.fail(found.error);
	return found.listing;
};

const refused = (found: FolderBrowse): string => {
	if (found.ok) assert.fail(`expected a refusal, got ${found.listing.path}`);
	return found.error;
};

// A pretend disk: the given folders exist, each listing its given names.
const fakeDisk = (folders: Record<string, string[]>) => ({
	isDirectory: async (path: string) => path in folders,
	list: async (path: string) => {
		const names = folders[path];
		if (!names) throw Object.assign(new Error("gone"), { code: "ENOENT" });
		return [...names];
	},
});

describe("expandHome", () => {
	it("expands ~ and ~/x and leaves everything else alone", () => {
		assert.equal(expandHome("~", "/home/aaron"), "/home/aaron");
		assert.equal(expandHome("~/code/x", "/home/aaron"), "/home/aaron/code/x");
		assert.equal(expandHome("/srv/x", "/home/aaron"), "/srv/x");
		assert.equal(expandHome("~bob/x", "/home/aaron"), "~bob/x");
	});
});

describe("browseFolder on a real disk", () => {
	let home = "";

	before(async () => {
		home = await mkdtemp(join(tmpdir(), "kanban-browse-"));
		await mkdir(join(home, "workspace", "acme"), { recursive: true });
		await mkdir(join(home, "workspace", "beta"));
		await mkdir(join(home, "workspace", ".hidden"));
		await writeFile(join(home, "workspace", "notes.txt"), "not a folder");
		await mkdir(join(home, "elsewhere"));
		await symlink(join(home, "elsewhere"), join(home, "workspace", "linked"));
		await symlink(
			join(home, "workspace", "notes.txt"),
			join(home, "workspace", "file-link"),
		);
	});
	after(() => rm(home, { recursive: true, force: true }));

	it("starts in ~/workspace when there is one", async () => {
		const listing = listed(
			await browseFolder(null, { machine: "jimbo", home }),
		);
		assert.equal(listing.path, join(home, "workspace"));
		assert.equal(listing.machine, "jimbo");
		assert.equal(listing.home, home);
		assert.equal(listing.parent, home);
		// Hidden folders and files are left out; a link to a folder is in.
		assert.deepEqual(listing.folders, ["acme", "beta", "linked"]);
		assert.equal(listing.truncated, false);
		assert.deepEqual(
			listed(await browseFolder("", { machine: "jimbo", home })).path,
			join(home, "workspace"),
		);
	});

	it("starts in the home folder when there is no workspace", async () => {
		const bare = join(home, "elsewhere");
		const listing = listed(
			await browseFolder("  ", { machine: "jimbo", home: bare }),
		);
		assert.equal(listing.path, bare);
		assert.deepEqual(listing.folders, []);
	});

	it("expands ~ on this machine and drops a trailing slash", async () => {
		assert.equal(
			listed(await browseFolder("~", { machine: "jimbo", home })).path,
			home,
		);
		assert.equal(
			listed(await browseFolder("~/workspace/acme", { machine: "jimbo", home }))
				.path,
			join(home, "workspace", "acme"),
		);
		assert.equal(
			listed(
				await browseFolder(`${join(home, "workspace")}/`, {
					machine: "jimbo",
					home,
				}),
			).path,
			join(home, "workspace"),
		);
	});

	it("names the machine when a path isn't a folder there", async () => {
		const file = join(home, "workspace", "notes.txt");
		assert.equal(
			refused(await browseFolder(file, { machine: "jimbo", home })),
			`${file} isn't a folder on jimbo`,
		);
		assert.equal(
			refused(await browseFolder("~/nope", { machine: "jimbo", home })),
			"~/nope isn't a folder on jimbo",
		);
	});
});

describe("browseFolder", () => {
	const home = "/home/aaron";

	it("refuses a relative path, naming the machine", async () => {
		const error = refused(
			await browseFolder("code/acme", {
				machine: "spike",
				home,
				...fakeDisk({ [home]: [] }),
			}),
		);
		assert.match(error, /full path on spike/);
		assert.match(error, /~/);
	});

	it("refuses an overlong path", async () => {
		assert.equal(
			refused(
				await browseFolder(`/${"x".repeat(5000)}`, {
					machine: "spike",
					home,
					...fakeDisk({}),
				}),
			),
			"That path is too long",
		);
	});

	it("maps the hub's home folder onto this one", async () => {
		const listing = listed(
			await browseFolder("/Users/aaron/code/acme", {
				machine: "jimbo",
				home,
				hubHome: "/Users/aaron",
				...fakeDisk({ "/home/aaron/code/acme": ["src"] }),
			}),
		);
		assert.equal(listing.path, "/home/aaron/code/acme");
		assert.deepEqual(listing.folders, ["src"]);
	});

	it("maps a --paths prefix before the home swap", async () => {
		const listing = listed(
			await browseFolder("/Users/aaron/code/acme", {
				machine: "jimbo",
				home,
				hubHome: "/Users/aaron",
				paths: [["/Users/aaron/code", "/srv/code"]],
				...fakeDisk({
					"/srv/code/acme": ["lib"],
					"/home/aaron/code/acme": ["src"],
				}),
			}),
		);
		assert.equal(listing.path, "/srv/code/acme");
	});

	it("uses a path as is when it exists here", async () => {
		const listing = listed(
			await browseFolder("/Users/aaron/code", {
				machine: "jimbo",
				home,
				hubHome: "/Users/aaron",
				...fakeDisk({ "/Users/aaron/code": ["a"], "/home/aaron/code": ["b"] }),
			}),
		);
		assert.equal(listing.path, "/Users/aaron/code");
	});

	it("refuses a hub path with no twin here", async () => {
		assert.equal(
			refused(
				await browseFolder("/Users/aaron/code/gone", {
					machine: "jimbo",
					home,
					hubHome: "/Users/aaron",
					...fakeDisk({ "/home/aaron/code": [] }),
				}),
			),
			"/Users/aaron/code/gone isn't a folder on jimbo",
		);
	});

	it("sorts folders without regard to case", async () => {
		const listing = listed(
			await browseFolder("/srv", {
				machine: "spike",
				home,
				...fakeDisk({ "/srv": ["beta", "Alpha", "gamma", "Delta"] }),
			}),
		);
		assert.deepEqual(listing.folders, ["Alpha", "beta", "Delta", "gamma"]);
	});

	it("cuts a huge folder off and says so", async () => {
		const names = Array.from(
			{ length: maxFolders + 5 },
			(_, i) => `f${String(i).padStart(5, "0")}`,
		);
		const listing = listed(
			await browseFolder("/big", {
				machine: "spike",
				home,
				...fakeDisk({ "/big": names }),
			}),
		);
		assert.equal(listing.folders.length, maxFolders);
		assert.equal(listing.folders[0], "f00000");
		assert.equal(listing.truncated, true);
		const exact = listed(
			await browseFolder("/big", {
				machine: "spike",
				home,
				...fakeDisk({ "/big": names.slice(0, maxFolders) }),
			}),
		);
		assert.equal(exact.truncated, false);
	});

	it("has no parent at the root", async () => {
		const listing = listed(
			await browseFolder("/", {
				machine: "spike",
				home,
				...fakeDisk({ "/": ["home", "srv"] }),
			}),
		);
		assert.equal(listing.path, "/");
		assert.equal(listing.parent, null);
		assert.equal(
			listed(
				await browseFolder("/srv", {
					machine: "spike",
					home,
					...fakeDisk({ "/srv": [] }),
				}),
			).parent,
			"/",
		);
	});

	it("says why a folder couldn't be read", async () => {
		assert.equal(
			refused(
				await browseFolder("/locked", {
					machine: "spike",
					home,
					isDirectory: async () => true,
					list: async () => {
						throw Object.assign(new Error("denied"), { code: "EACCES" });
					},
				}),
			),
			"Couldn't read /locked on spike: EACCES",
		);
	});
	it("maps a hub path onto a Windows runner's home", async () => {
		const found = await browseFolder("/Users/aaron/code", {
			machine: "jimbo",
			home: "C:\\Users\\aaron",
			hubHome: "/Users/aaron",
			separator: "\\",
			...fakeDisk({ "C:\\Users\\aaron\\code": ["acme"] }),
		});
		assert.equal(listed(found).path, "C:\\Users\\aaron\\code");
	});
});
