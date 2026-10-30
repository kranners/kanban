export type ScrollBox = {
	scrollTop: number;
	scrollLeft: number;
	scrollHeight: number;
	scrollWidth: number;
	clientHeight: number;
	clientWidth: number;
	overflowX: string;
	overflowY: string;
};

const scrolls = (overflow: string) =>
	overflow === "auto" || overflow === "scroll";

function room(
	delta: number,
	position: number,
	size: number,
	view: number,
): boolean {
	if (delta > 0) return position + view < size - 1;
	if (delta < 0) return position > 0;
	return false;
}

export function hasRoom(box: ScrollBox, dx: number, dy: number): boolean {
	return (
		(scrolls(box.overflowX) &&
			room(dx, box.scrollLeft, box.scrollWidth, box.clientWidth)) ||
		(scrolls(box.overflowY) &&
			room(dy, box.scrollTop, box.scrollHeight, box.clientHeight))
	);
}

function boxOf(element: Element): ScrollBox {
	const style = getComputedStyle(element);
	return {
		scrollTop: element.scrollTop,
		scrollLeft: element.scrollLeft,
		scrollHeight: element.scrollHeight,
		scrollWidth: element.scrollWidth,
		clientHeight: element.clientHeight,
		clientWidth: element.clientWidth,
		overflowX: style.overflowX,
		overflowY: style.overflowY,
	};
}

export function scrollsFurther(
	from: Element,
	root: Element,
	dx: number,
	dy: number,
): boolean {
	for (
		let element: Element | null = from;
		element && root.contains(element);
		element = element.parentElement
	) {
		if (hasRoom(boxOf(element), dx, dy)) return true;
	}
	return false;
}
