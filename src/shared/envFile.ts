import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const kanbanEnvPath = (home = homedir()): string =>
	join(home, ".config", "kanban", "env");

// Parse `KEY=value` lines, as in ~/.config/kanban/env. Blank lines, comments
// and an optional `export ` prefix are allowed; matching quotes are stripped.
export const parseEnvFile = (text: string): Record<string, string> => {
	const env: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim().replace(/^export\s+/, "");
		if (line === "" || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		let value = line.slice(eq + 1).trim();
		const quote = value[0];
		if (
			value.length >= 2 &&
			(quote === '"' || quote === "'") &&
			value.endsWith(quote)
		) {
			value = value.slice(1, -1);
		}
		env[key] = value;
	}
	return env;
};

export const readKanbanEnv = (
	path = kanbanEnvPath(),
): Record<string, string> => {
	try {
		return parseEnvFile(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
};
