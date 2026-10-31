export type Axis = "x" | "y";

export type ScrollBox = {
	scrollHeight: number;
	scrollWidth: number;
	clientHeight: number;
	clientWidth: number;
	overflowX: string;
	overflowY: string;
};

/**
 * Who takes each axis of a wheel gesture: a scroller, or null for the board.
 * "native" leaves the whole gesture to the browser (UI outside the world).
 */
export type WheelRoute<T> = { x: T | null; y: T | null } | "native";

export type WheelLatch<T> = { route: WheelRoute<T>; until: number };

export const latchMs = 250;

export const boardRoute = { x: null, y: null } as const;

const scrolls = (overflow: string) =>
	overflow === "auto" || overflow === "scroll";

export function overflowsAlong(box: ScrollBox, axis: Axis): boolean {
	return axis === "x"
		? scrolls(box.overflowX) && box.scrollWidth > box.clientWidth + 1
		: scrolls(box.overflowY) && box.scrollHeight > box.clientHeight + 1;
}

/** A gesture keeps the route it started with until the wheel pauses. */
export function nextLatch<T>(
	latch: WheelLatch<T> | null,
	at: number,
	fresh: () => WheelRoute<T>,
): WheelLatch<T> {
	const route = latch && at < latch.until ? latch.route : fresh();
	return { route, until: at + latchMs };
}

export type Split<T> = {
	board: { dx: number; dy: number };
	scroll: { x: T | null; dx: number; y: T | null; dy: number };
};

/** Each axis goes to its scroller if it has one, otherwise to the board. */
export function splitWheel<T>(
	route: { x: T | null; y: T | null },
	dx: number,
	dy: number,
): Split<T> {
	return {
		board: { dx: route.x ? 0 : dx, dy: route.y ? 0 : dy },
		scroll: {
			x: route.x,
			dx: route.x ? dx : 0,
			y: route.y,
			dy: route.y ? dy : 0,
		},
	};
}

function boxOf(element: Element): ScrollBox {
	const style = getComputedStyle(element);
	return {
		scrollHeight: element.scrollHeight,
		scrollWidth: element.scrollWidth,
		clientHeight: element.clientHeight,
		clientWidth: element.clientWidth,
		overflowX: style.overflowX,
		overflowY: style.overflowY,
	};
}

/** The innermost element between `from` and `root` that scrolls along `axis`. */
export function scrollerAlong(
	from: Element,
	root: Element,
	axis: Axis,
): Element | null {
	for (
		let element: Element | null = from;
		element && root.contains(element);
		element = element.parentElement
	) {
		if (overflowsAlong(boxOf(element), axis)) return element;
	}
	return null;
}
