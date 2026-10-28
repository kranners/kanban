import { execFile } from "node:child_process";
import type { FolderPick } from "../shared/types.ts";

export type FolderPicker = () => Promise<FolderPick>;

const chooseFolder = [
	'tell application "System Events"',
	"activate",
	'set chosen to choose folder with prompt "Choose a project folder"',
	"end tell",
	"POSIX path of chosen",
];
const userCancelled = "(-128)";

export const withoutTrailingSlash = (path: string): string =>
	path.length > 1 ? path.replace(/\/+$/, "") : path;

export const folderPickOf = (
	error: Error | null,
	stdout: string,
	stderr: string,
): FolderPick => {
	if (!error) return { ok: true, path: withoutTrailingSlash(stdout.trim()) };
	if (stderr.includes(userCancelled)) return { ok: false, cancelled: true };
	return {
		ok: false,
		error:
			stderr.trim() || `Couldn't open the folder picker (${error.message})`,
	};
};

export const osascriptFolderPicker = (): FolderPicker => {
	let open: Promise<FolderPick> | null = null;
	const pick = (): Promise<FolderPick> =>
		new Promise((resolve) => {
			execFile(
				"osascript",
				chooseFolder.flatMap((line) => ["-e", line]),
				(error, stdout, stderr) => resolve(folderPickOf(error, stdout, stderr)),
			);
		});
	return () => {
		open ??= pick().finally(() => {
			open = null;
		});
		return open;
	};
};
