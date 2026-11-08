// Keeps an open board page in step with the server behind it. The build
// stamps the page with its id and the server reports the id of the page it
// serves, in the feed's hello and on every API reply. When they differ the
// page is older than the server, so it reloads itself at a safe moment, never
// while Aaron types, drags, holds Approve or waits on a press, and keeps the
// viewport, the open card and the open panels across the reload. It reloads
// once per server build, so a page that still differs afterwards never loops.

declare const __KANBAN_BUILD__: string | undefined;

/** This page's build, stamped by the build; null in tests and the demo's fakes. */
export const pageBuild: string | null =
	typeof __KANBAN_BUILD__ === "string" ? __KANBAN_BUILD__ : null;

export type ReloaderDeps = {
	page: string | null;
	/** Whether reloading now would lose something Aaron is in the middle of. */
	busy: () => boolean;
	/** The server build this tab last reloaded for, which it never reloads for twice. */
	reloadedFor: () => string | null;
	reload: (server: string) => void;
};

export type Reloader = {
	/** Takes the server's build; true when the page is now waiting to reload. */
	noteServer(build: string | null | undefined): boolean;
	/** Reloads when one is waiting and nothing is in progress; true when it did. */
	tick(): boolean;
	pending(): string | null;
};

export function createReloader(deps: ReloaderDeps): Reloader {
	let pending: string | null = null;
	let done = false;
	return {
		noteServer(build) {
			if (done || !build || !deps.page || build === deps.page) {
				if (build === deps.page) pending = null;
				return false;
			}
			if (deps.reloadedFor() === build) return false;
			pending = build;
			return true;
		},
		tick() {
			if (done || pending === null || deps.busy()) return false;
			const build = pending;
			pending = null;
			done = true;
			deps.reload(build);
			return true;
		},
		pending: () => pending,
	};
}

// What holds a reload off: holds Aaron is making, writes still in flight.
let holds = 0;
let writes = 0;

/** Holds off any reload until the returned release is called, once. */
export function holdReload(): () => void {
	holds += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		holds -= 1;
	};
}

/** Counts a write to the server in flight, which a reload would cut off. */
export function writeStarted(): () => void {
	writes += 1;
	let finished = false;
	return () => {
		if (finished) return;
		finished = true;
		writes -= 1;
	};
}

const reloadedKey = "kanban-reloaded-for";
const keptKey = "kanban-kept-page";

type Kept = { get(): unknown; set(value: unknown): void };
const kept = new Map<string, Kept>();
let keptView: unknown;

/** Keeps a signal's value across a reload for a new build. */
export function keepAcrossReload(name: string, box: { value: unknown }): void {
	kept.set(name, {
		get: () => box.value,
		set: (value) => {
			box.value = value;
		},
	});
}

const storage = (): Storage | null => {
	try {
		return typeof sessionStorage === "undefined" ? null : sessionStorage;
	} catch {
		return null;
	}
};

/** Puts back what the last reload for a new build kept, once. */
export function restoreKept(): void {
	const store = storage();
	const raw = store?.getItem(keptKey);
	if (!raw) return;
	store?.removeItem(keptKey);
	try {
		const values = JSON.parse(raw) as Record<string, unknown>;
		for (const [name, value] of Object.entries(values)) {
			if (name === "view") keptView = value;
			else kept.get(name)?.set(value);
		}
	} catch {}
}

/** The viewport the reload kept, for the canvas's first fit to use instead, once. */
export function takeKeptView<T>(): T | undefined {
	const view = keptView as T | undefined;
	keptView = undefined;
	return view;
}

const typing = (): boolean => {
	const active = document.activeElement;
	if (
		active instanceof HTMLElement &&
		(active.isContentEditable ||
			active instanceof HTMLTextAreaElement ||
			(active instanceof HTMLInputElement &&
				!["button", "checkbox", "radio", "range", "submit"].includes(
					active.type,
				)))
	)
		return true;
	for (const area of document.querySelectorAll("textarea")) {
		if (area.value.trim() !== "") return true;
	}
	return false;
};

const pointers = new Set<number>();

const keepAndReload = () => {
	const values: Record<string, unknown> = {};
	for (const [name, box] of kept) values[name] = box.get();
	storage()?.setItem(keptKey, JSON.stringify(values));
	location.reload();
};

/** Reloads the page at Aaron's press, keeping the viewport and open panels. */
export const reloadPage = (): void => keepAndReload();

const reloader = createReloader({
	page: pageBuild,
	busy: () => holds > 0 || writes > 0 || pointers.size > 0 || typing(),
	reloadedFor: () => storage()?.getItem(reloadedKey) ?? null,
	reload: (server) => {
		storage()?.setItem(reloadedKey, server);
		keepAndReload();
	},
});

/** Takes the build the server reported, from the feed's hello or a reply's header. */
export function noteServerBuild(build: string | null | undefined): void {
	if (reloader.noteServer(build)) reloader.tick();
}

/** Watches for the safe moment to reload once the server's build has moved on. */
export function startPageBuildWatch(): void {
	window.addEventListener(
		"pointerdown",
		(event) => pointers.add(event.pointerId),
		true,
	);
	for (const type of ["pointerup", "pointercancel"] as const) {
		window.addEventListener(
			type,
			(event) => pointers.delete(event.pointerId),
			true,
		);
	}
	window.addEventListener("blur", () => pointers.clear());
	setInterval(() => reloader.tick(), 1000);
}
