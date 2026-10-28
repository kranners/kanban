import { effect, signal } from "@preact/signals";
import type {
	NewSessionRequest,
	NewSessionResult,
	Point,
	PromptImage,
} from "../shared/types.ts";
import { cwdChoices, freeSpotNear } from "./actions.ts";
import {
	arrangement,
	groups,
	previewPlacement,
	reserved,
} from "./arrangement.ts";
import { gridSize } from "./grid.ts";
import type { Group } from "./groups.ts";
import { groupAt } from "./groups.ts";
import { nodeKey } from "./layout.ts";
import { belongsTo, housedBy, near, sessionSize } from "./placement.ts";
import { commitRegion, shownRegions } from "./regionState.ts";
import {
	regionHolding,
	spotBelowRegion,
	spotInRegion,
	storableRegion,
} from "./regions.ts";
import { annotations, board, knownCwds } from "./state.ts";

export type BoardMenu = { client: Point; board: Point; group: Group | null };
export type QuickPrompt = {
	at: Point;
	cwd: string;
	cwds: string[];
	region?: string;
};
export type Ghost = { short: string; at: Point; prompt: string };

const ghostMs = 5 * 60_000;
const restartRetryDelaysMs = [500, 1000, 2000, 4000];

export const boardMenu = signal<BoardMenu | null>(null);
export const quickPrompt = signal<QuickPrompt | null>(null);
export const ghosts = signal<readonly Ghost[]>([]);

export async function createSession(
	request: NewSessionRequest,
): Promise<NewSessionResult> {
	try {
		const response = await postSurvivingRestart(JSON.stringify(request));
		const text = await response.text();
		try {
			return JSON.parse(text) as NewSessionResult;
		} catch {
			return {
				ok: false,
				error: `The board server answered HTTP ${response.status}`,
			};
		}
	} catch (caught) {
		return { ok: false, error: `Couldn't reach the board server (${caught})` };
	}
}

async function postSurvivingRestart(body: string): Promise<Response> {
	for (const delayMs of restartRetryDelaysMs) {
		try {
			return await postSession(body);
		} catch {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return postSession(body);
}

function postSession(body: string): Promise<Response> {
	return fetch("/api/sessions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});
}

export function openBoardMenu(client: Point, point: Point): void {
	boardMenu.value = {
		client,
		board: point,
		group: groupAt(groups.peek(), point),
	};
}

export function openQuickPrompt(point: Point): boolean {
	const group = groupAt(groups.peek(), point);
	const cwds = cwdChoices(group?.cwd ?? null, knownCwds.peek());
	const cwd = cwds[0];
	if (!cwd) return false;
	const taken = [
		...(arrangement.peek()?.nodes.values() ?? []),
		...ghosts.peek().map((g) => ({ ...g.at, ...sessionSize })),
		...Object.values(annotations.peek()),
	];
	const region = group?.region;
	const at = region
		? (spotInRegion(point, region, taken) ??
			spotBelowRegion(point, region, taken))
		: freeSpotNear(point, taken);
	boardMenu.value = null;
	quickPrompt.value = {
		at,
		cwd,
		cwds,
		...(region ? { region: region.id } : {}),
	};
	return true;
}

function growToHold(id: string, cwd: string, at: Point): void {
	const region = shownRegions.peek().find((shown) => shown.id === id);
	const card = { ...at, ...sessionSize };
	if (
		!region ||
		!belongsTo(region, cwd) ||
		housedBy(region, cwd, card) ||
		!near(region, card, gridSize)
	)
		return;
	void commitRegion(id, storableRegion(regionHolding(region, card)));
}

function dropGhost(ghost: Ghost): void {
	ghosts.value = ghosts.peek().filter((g) => g !== ghost);
}

function land(ghost: Ghost): boolean {
	const arrived = board.peek()?.sessions.find((s) => s.short === ghost.short);
	if (!arrived) return false;
	previewPlacement(nodeKey({ kind: "session", id: arrived.id }), ghost.at);
	dropGhost(ghost);
	return true;
}

export async function spawnFromPrompt(
	prompt: string,
	images: PromptImage[],
): Promise<string | null> {
	const open = quickPrompt.peek();
	if (!open) return null;
	const result = await createSession({
		cwd: open.cwd,
		prompt,
		...(images.length ? { images } : {}),
		at: open.at,
	});
	if (!result.ok) return result.error;
	if (open.region) growToHold(open.region, open.cwd, open.at);
	const ghost = { short: result.short, at: open.at, prompt };
	ghosts.value = [...ghosts.peek(), ghost];
	if (quickPrompt.peek() === open) quickPrompt.value = null;
	if (!land(ghost)) setTimeout(() => dropGhost(ghost), ghostMs);
	return null;
}

effect(() => {
	if (!board.value) return;
	for (const ghost of ghosts.peek()) land(ghost);
});

effect(() => {
	const open = quickPrompt.value;
	reserved.value = [
		...ghosts.value.map((g) => ({ ...g.at, ...sessionSize })),
		...(open ? [{ ...open.at, ...sessionSize }] : []),
	];
});
