import type { FolderBrowse, RunsOn } from "../shared/types.ts";
import { isRunnerTarget } from "../shared/types.ts";
import { foldersUrl } from "./focus/paths.ts";

/**
 * Whose disk a folder is read from: a runner's own, else the board's, since
 * cloud and remote-host sessions read the folder on the board.
 */
export const browseTarget = (runsOn: RunsOn): "local" | `runner_${string}` =>
	isRunnerTarget(runsOn) ? runsOn : "local";

/** Whether a folder is worth checking up front: it must exist on that disk. */
export const checksFolder = (runsOn: RunsOn): boolean =>
	runsOn === "local" || isRunnerTarget(runsOn);

/** A subfolder's path, with the folder's own separator (a Windows runner uses \). */
export const childPath = (folder: string, name: string): string => {
	const separator = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
	return folder.endsWith(separator)
		? `${folder}${name}`
		: `${folder}${separator}${name}`;
};

/** Reads the board's answer, which is JSON for 200 and 422 alike. */
export const readBrowse = async (response: Response): Promise<FolderBrowse> => {
	const body = (await response.json().catch(() => null)) as FolderBrowse | null;
	if (body && typeof body === "object" && "ok" in body) {
		if (body.ok && body.listing) return body;
		if (!body.ok && typeof body.error === "string") return body;
	}
	return {
		ok: false,
		error:
			response.status === 404
				? "This board can't list folders yet; restart it on the latest version"
				: `The board server answered HTTP ${response.status}`,
	};
};

export async function fetchFolders(
	runsOn: string,
	path: string | null,
	signal?: AbortSignal,
): Promise<FolderBrowse> {
	try {
		return await readBrowse(await fetch(foldersUrl(runsOn, path), { signal }));
	} catch (caught) {
		if (signal?.aborted) throw caught;
		return { ok: false, error: `Couldn't reach the board server (${caught})` };
	}
}
