export type Axis = "x" | "y";

export type ScrollBox = {
	scrollHeight: number;
	scrollWidth: number;
	clientHeight: number;
	clientWidth: number;
	overflowX: string;
	overflowY: string;
};

export type WheelMode = "scroll" | "board";

export type WheelLatch = { mode: WheelMode; until: number };

export const latchMs = 250;

export function axisOf(dx: number, dy: number): Axis {
	return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

const scrolls = (overflow: string) =>
	overflow === "auto" || overflow === "scroll";

export function overflowsAlong(box: ScrollBox, axis: Axis): boolean {
	return axis === "x"
		? scrolls(box.overflowX) && box.scrollWidth > box.clientWidth + 1
		: scrolls(box.overflowY) && box.scrollHeight > box.clientHeight + 1;
}

export function nextLatch(
	latch: WheelLatch | null,
	at: number,
	fresh: () => WheelMode,
): WheelLatch {
	const mode = latch && at < latch.until ? latch.mode : fresh();
	return { mode, until: at + latchMs };
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

export function scrollsAlong(
	from: Element,
	root: Element,
	axis: Axis,
): boolean {
	for (
		let element: Element | null = from;
		element && root.contains(element);
		element = element.parentElement
	) {
		if (overflowsAlong(boxOf(element), axis)) return true;
	}
	return false;
}
