import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type StateFile<T> = {
	write(value: T): void;
	saved(): Promise<void>;
};

export const readState = async <T>(
	file: string,
	parse: (value: unknown) => T,
): Promise<T> => {
	try {
		return parse(JSON.parse(await readFile(file, "utf8")));
	} catch {
		return parse(null);
	}
};

// Writes through a temporary file and a rename, and rejects when either fails.
export const writeAtomically = async (file: string, text: string) => {
	await mkdir(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, text);
	await rename(temporary, file);
};

export const createStateFile = <T>(file: string): StateFile<T> => {
	let latest: T;
	let writing: Promise<void> = Promise.resolve();
	let dirty = false;
	return {
		write(value) {
			latest = value;
			if (dirty) return;
			dirty = true;
			writing = writing
				.then(() => {
					dirty = false;
					return writeAtomically(file, `${JSON.stringify(latest)}\n`);
				})
				.catch((error: unknown) =>
					console.error(`${file} write failed`, error),
				);
		},
		saved: () => writing,
	};
};

/** Sets a retired feature's state file aside as `<file>.retired`, once, keeping what it held. */
export const retireFile = async (file: string): Promise<boolean> => {
	try {
		await rename(file, `${file}.retired`);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
};
