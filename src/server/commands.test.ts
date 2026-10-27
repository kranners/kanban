import assert from "node:assert/strict";
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
import { builtInCommands, frontmatter, listCommands } from "./commands.ts";

const root = mkdtempSync(join(tmpdir(), "kanban-commands-"));
after(() => rmSync(root, { recursive: true, force: true }));

const write = (path: string, text: string) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
};

describe("slash commands", () => {
	it("reads frontmatter fields", () => {
		assert.deepEqual(
			frontmatter('---\nname: tidy\ndescription: "Tidy the repo"\n---\n# Body'),
			{ name: "tidy", description: "Tidy the repo" },
		);
		assert.deepEqual(frontmatter("# No frontmatter"), {});
	});

	it("lists built-ins, user and project commands and skills by name and description", async () => {
		const home = join(root, "home");
		const project = join(root, "project");
		write(
			join(home, "commands", "standup.md"),
			"---\ndescription: Write a standup\n---\nBody",
		);
		write(join(home, "commands", "git", "tidy.md"), "# Tidy branches\n\nSteps");
		write(join(project, ".claude", "commands", "release.md"), "Cut a release");
		write(
			join(home, "skills", "notes", "SKILL.md"),
			"---\nname: notes\ndescription: Keep notes\n---\n",
		);
		write(
			join(project, ".claude", "skills", "deploy", "SKILL.md"),
			"# Deploy the site",
		);
		const commands = await listCommands({ claudeHome: home, cwd: project });
		const custom = commands.filter((command) => command.source !== "built-in");
		assert.deepEqual(
			custom.sort((a, b) => a.name.localeCompare(b.name)),
			[
				{ name: "deploy", description: "Deploy the site", source: "skill" },
				{ name: "git:tidy", description: "Tidy branches", source: "user" },
				{ name: "notes", description: "Keep notes", source: "skill" },
				{ name: "release", description: "Cut a release", source: "project" },
				{ name: "standup", description: "Write a standup", source: "user" },
			],
		);
		assert.equal(commands.length, builtInCommands.length + custom.length);
	});

	it("never reads a project command or skill that links out of the project", async () => {
		const home = join(root, "linked-home");
		const project = join(root, "linked-project");
		write(join(home, "CLAUDE.md"), "Private instructions");
		write(join(root, "elsewhere.md"), "Somewhere else");
		write(join(project, "shared", "SKILL.md"), "# Shared in the repo");
		mkdirSync(join(project, ".claude", "skills", "leak"), { recursive: true });
		mkdirSync(join(project, ".claude", "commands"), { recursive: true });
		symlinkSync(
			join(home, "CLAUDE.md"),
			join(project, ".claude", "skills", "leak", "SKILL.md"),
		);
		symlinkSync(
			join(root, "elsewhere.md"),
			join(project, ".claude", "commands", "out.md"),
		);
		symlinkSync(
			join(project, "shared"),
			join(project, ".claude", "skills", "shared"),
		);
		const commands = await listCommands({ claudeHome: home, cwd: project });
		assert.deepEqual(
			commands.filter((command) => command.source !== "built-in"),
			[{ name: "shared", description: "Shared in the repo", source: "skill" }],
		);
	});

	it("still lists the built-ins when no directories exist", async () => {
		const commands = await listCommands({
			claudeHome: join(root, "missing"),
			cwd: join(root, "missing-project"),
		});
		assert.deepEqual(commands, builtInCommands);
	});
});
