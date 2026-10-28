import { computed, effect, signal } from "@preact/signals";
import type {
	Point,
	Region,
	RegionDraft,
	RegionPatch,
} from "../shared/types.ts";
import type { Rect } from "./placement.ts";

export type RegionDialog =
	| { mode: "create"; at: Point }
	| { mode: "rename"; region: Region };

export type RegionMenu = {
	key: string;
	cwd: string;
	project: string;
	at: Point;
	board?: Point;
	region?: Region;
};

const echoMs = 3000;

export const regions = signal<readonly Region[]>([]);
export const regionOverrides = signal<ReadonlyMap<string, Rect>>(new Map());
export const regionDialog = signal<RegionDialog | null>(null);
export const regionMenu = signal<RegionMenu | null>(null);
export const frontGroup = signal<string | null>(null);

export const shownRegions = computed(() => {
	const local = regionOverrides.value;
	return local.size === 0
		? regions.value
		: regions.value.map((region) => {
				const rect = local.get(region.id);
				return rect ? { ...region, ...rect } : region;
			});
});

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

async function request<T>(
	method: string,
	path: string,
	body?: unknown,
): Promise<Outcome<T>> {
	try {
		const response = await fetch(path, {
			method,
			...(body === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					}),
		});
		if (response.status === 204) return { ok: true, value: undefined as T };
		const parsed = (await response.json().catch(() => null)) as
			| (T & { error?: string })
			| null;
		if (response.ok && parsed) return { ok: true, value: parsed };
		return {
			ok: false,
			error:
				parsed?.error ?? `The board server answered HTTP ${response.status}`,
		};
	} catch (caught) {
		return { ok: false, error: `Couldn't reach the board server (${caught})` };
	}
}

export function createRegion(draft: RegionDraft): Promise<Outcome<Region>> {
	return request<Region>("POST", "/api/regions", draft);
}

export function renameRegion(
	id: string,
	name: string,
): Promise<Outcome<Region>> {
	const patch: RegionPatch = { name: name.trim() || null };
	return request<Region>(
		"PATCH",
		`/api/regions/${encodeURIComponent(id)}`,
		patch,
	);
}

export function deleteRegion(id: string): Promise<Outcome<void>> {
	return request<void>("DELETE", `/api/regions/${encodeURIComponent(id)}`);
}

function sameRect(a: Rect, b: Rect): boolean {
	return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function forget(id: string, rect: Rect): void {
	if (regionOverrides.peek().get(id) !== rect) return;
	const next = new Map(regionOverrides.peek());
	next.delete(id);
	regionOverrides.value = next;
}

effect(() => {
	const stored = new Map(regions.value.map((region) => [region.id, region]));
	for (const [id, rect] of regionOverrides.peek()) {
		const region = stored.get(id);
		if (!region || sameRect(region, rect)) forget(id, rect);
	}
});

effect(() => {
	const stored = new Set(regions.value.map((region) => region.id));
	const dialog = regionDialog.peek();
	if (dialog?.mode === "rename" && !stored.has(dialog.region.id))
		regionDialog.value = null;
	const menu = regionMenu.peek();
	if (menu?.region && !stored.has(menu.region.id)) regionMenu.value = null;
});

export function previewRegion(id: string, rect: Rect): void {
	regionOverrides.value = new Map(regionOverrides.peek()).set(id, rect);
}

export function cancelRegion(id: string): void {
	const rect = regionOverrides.peek().get(id);
	if (rect) forget(id, rect);
}

export async function commitRegion(id: string, rect: Rect): Promise<void> {
	previewRegion(id, rect);
	const result = await request<Region>(
		"PATCH",
		`/api/regions/${encodeURIComponent(id)}`,
		rect,
	);
	if (!result.ok) forget(id, rect);
	else setTimeout(() => forget(id, rect), echoMs);
}
