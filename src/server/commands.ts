import type { Dirent } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

export type SlashCommand = {
	name: string;
	description: string;
	source: "built-in" | "user" | "project" | "skill";
};

export const builtInCommands: SlashCommand[] = [
	["add-dir", "Add a working directory"],
	["agents", "Manage agent configurations"],
	["bg", "Continue this conversation in the background"],
	["clear", "Clear the conversation and start fresh"],
	["compact", "Summarise the conversation to free up context"],
	["config", "Open settings"],
	["context", "Show how the context window is used"],
	["cost", "Show usage and cost"],
	["doctor", "Check the installation"],
	["effort", "Set the reasoning effort"],
	["export", "Export the conversation"],
	["help", "Show help"],
	["hooks", "Manage hooks"],
	["init", "Write a CLAUDE.md for this project"],
	["mcp", "Manage MCP servers"],
	["memory", "Edit memory files"],
	["model", "Choose the model"],
	["permissions", "Manage tool permissions"],
	["plugin", "Manage plugins"],
	["release-notes", "Show release notes"],
	["resume", "Resume another conversation"],
	["review", "Review a pull request"],
	["rewind", "Rewind the conversation or code"],
	["security-review", "Review pending changes for security issues"],
	["status", "Show version, model and account"],
	["todos", "Show the todo list"],
	["usage", "Show plan usage limits"],
].map(([name = "", description = ""]) => ({
	name,
	description,
	source: "built-in" as const,
}));

const headBytes = 4096;
const commandLimit = 300;

const head = async (path: string): Promise<string> => {
	const file = await open(path, "r");
	try {
		const buffer = Buffer.alloc(headBytes);
		const { bytesRead } = await file.read(buffer, 0, headBytes, 0);
		return buffer.toString("utf8", 0, bytesRead);
	} finally {
		await file.close();
	}
};

export const frontmatter = (text: string): Record<string, string> => {
	const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
	if (!block) return {};
	return Object.fromEntries(
		block.split(/\r?\n/).flatMap((line) => {
			const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
			return match?.[1]
				? [[match[1], (match[2] ?? "").replace(/^["']|["']$/g, "")]]
				: [];
		}),
	);
};

const describe = (text: string): string => {
	const fields = frontmatter(text);
	const body = text.replace(/^---[\s\S]*?\n---\r?\n?/, "");
	const fallback =
		body
			.split("\n")
			.map((line) => line.replace(/^#+\s*/, "").trim())
			.find((line) => line !== "") ?? "";
	const description = fields.description || fallback;
	return description.length > 160
		? `${description.slice(0, 159)}…`
		: description;
};

const list = async (dir: string): Promise<Dirent[]> => {
	try {
		return await readdir(dir, { withFileTypes: true, recursive: true });
	} catch {
		return [];
	}
};

const markdownCommands = async (
	dir: string,
	source: "user" | "project",
): Promise<SlashCommand[]> => {
	const commands: SlashCommand[] = [];
	for (const entry of await list(dir)) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const path = join(entry.parentPath, entry.name);
		const name = path
			.slice(dir.length + 1, -".md".length)
			.split("/")
			.join(":");
		try {
			commands.push({ name, description: describe(await head(path)), source });
		} catch {}
		if (commands.length >= commandLimit) break;
	}
	return commands;
};

const skills = async (dir: string): Promise<SlashCommand[]> => {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const found: SlashCommand[] = [];
	for (const entry of entries.slice(0, commandLimit)) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		try {
			const text = await head(join(dir, entry.name, "SKILL.md"));
			found.push({
				name: frontmatter(text).name || entry.name,
				description: describe(text),
				source: "skill",
			});
		} catch {}
	}
	return found;
};

export const listCommands = async (opts: {
	claudeHome: string;
	cwd: string;
}): Promise<SlashCommand[]> => {
	const project = join(opts.cwd, ".claude");
	const groups = await Promise.all([
		markdownCommands(join(project, "commands"), "project"),
		markdownCommands(join(opts.claudeHome, "commands"), "user"),
		skills(join(project, "skills")),
		skills(join(opts.claudeHome, "skills")),
	]);
	const seen = new Set<string>();
	return [...builtInCommands, ...groups.flat()].filter((command) => {
		if (command.name === "" || seen.has(command.name)) return false;
		seen.add(command.name);
		return true;
	});
};
