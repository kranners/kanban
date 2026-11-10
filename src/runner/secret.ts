// This runner's own secret, made on this machine and kept in a file only its
// user can read. The hub learns only its hash, when the runner enrols.
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const secretPattern = /^[A-Za-z0-9_-]{32,128}$/;

export const secretPath = (home: string = homedir()) =>
	join(home, ".config", "kanban", "runner-secret");

export const secretHash = (secret: string) =>
	createHash("sha256").update(secret).digest("hex");

/** Reads this runner's secret, making one the first time. */
export const ownSecret = async (
	file: string = secretPath(),
): Promise<string> => {
	try {
		const held = (await readFile(file, "utf8")).trim();
		if (secretPattern.test(held)) {
			await chmod(file, 0o600);
			return held;
		}
	} catch {}
	const made = randomBytes(32).toString("base64url");
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	await writeFile(file, `${made}\n`, { mode: 0o600, flag: "w" });
	await chmod(file, 0o600);
	return made;
};
