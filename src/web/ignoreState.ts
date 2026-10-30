import { computed, signal } from "@preact/signals";
import type { ProjectIgnores } from "../shared/ignores.ts";
import type { Point } from "../shared/types.ts";
import { ignoredSessionIds, ignoreOf } from "./ignores.ts";
import { board, now } from "./state.ts";

export type IgnoreMenu = { cwd: string; project: string; at: Point };

const savedIgnores = signal<ProjectIgnores>({});
const chosenIgnores = signal<ReadonlyMap<string, number | null>>(new Map());
export const ignoreMenu = signal<IgnoreMenu | null>(null);

const ignores = computed(() => {
	const shown: ProjectIgnores = { ...savedIgnores.value };
	for (const [cwd, until] of chosenIgnores.value) {
		if (until === null) delete shown[cwd];
		else shown[cwd] = until;
	}
	return shown;
});

export const ignoredSessions = computed(() =>
	ignoredSessionIds(ignores.value, board.value?.sessions ?? [], now.value),
);

export function ignoreFor(cwd: string) {
	return ignoreOf(ignores.value, cwd, now.value);
}

function choose(cwd: string, until: number | null | undefined): void {
	const next = new Map(chosenIgnores.peek());
	if (until === undefined) next.delete(cwd);
	else next.set(cwd, until);
	chosenIgnores.value = next;
}

export function receiveIgnores(next: ProjectIgnores): void {
	savedIgnores.value = next;
	for (const [cwd, until] of chosenIgnores.peek()) {
		if ((next[cwd] ?? null) === until) choose(cwd, undefined);
	}
}

async function setIgnore(cwd: string, until: number | null): Promise<void> {
	choose(cwd, until);
	try {
		const response = await fetch("/api/ignores", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd, until }),
		});
		if (!response.ok) throw new Error(`ignores ${response.status}`);
	} catch {
		if (chosenIgnores.peek().get(cwd) === until) choose(cwd, undefined);
	}
}

export function ignoreProject(cwd: string, ms: number): Promise<void> {
	ignoreMenu.value = null;
	return setIgnore(cwd, Date.now() + ms);
}

export function stopIgnoring(cwd: string): Promise<void> {
	return setIgnore(cwd, null);
}
