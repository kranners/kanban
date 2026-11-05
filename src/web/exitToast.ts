import type { Session } from "../shared/types.ts";
import { removalText } from "./undo.ts";

export type Left = { session: Session; boardOnly: boolean };

/**
 * Cloud sessions come back by unarchiving them, so their exit offers undo;
 * local exits end the process. One claude.ai could not archive only left
 * the board, and the toast says so for that one alone.
 */
export function exitToast(left: readonly Left[]): string | null {
	const cloud = left.filter(({ session }) => session.cloud);
	const names = (boardOnly: boolean) =>
		cloud
			.filter((item) => item.boardOnly === boardOnly)
			.map(({ session }) => session.name || null);
	const noun: [string, string] = ["cloud session", "cloud sessions"];
	const archived = names(false);
	const removed = names(true);
	const parts = [
		...(archived.length > 0 ? [removalText("Archived", noun, archived)] : []),
		...(removed.length > 0
			? [
					`${removalText("Removed", noun, removed)} from the board only; ${
						removed.length === 1 ? "it wasn't" : "they weren't"
					} ended on claude.ai`,
				]
			: []),
	];
	return parts.length > 0 ? parts.join(". ") : null;
}
