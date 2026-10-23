export type View = { x: number; y: number; k: number };

export const minZoom = 0.15;
export const maxZoom = 2;

export function clampZoom(k: number): number {
	return Math.min(maxZoom, Math.max(minZoom, k));
}

export function zoomAround(
	view: View,
	k: number,
	px: number,
	py: number,
): View {
	const next = clampZoom(k);
	const ratio = next / view.k;
	return {
		k: next,
		x: px - (px - view.x) * ratio,
		y: py - (py - view.y) * ratio,
	};
}

export type Rect = { x: number; y: number; w: number; h: number };

const legibleZoom = 0.45;

export function initialView(
	content: { width: number; height: number },
	box: { width: number; height: number },
	anchor: Rect | null,
): View {
	const whole = fitView(content, box);
	if (whole.k >= legibleZoom || !anchor) return whole;
	const k = clampZoom(Math.min(1, (box.width - 48) / anchor.w));
	return {
		k,
		x: box.width / 2 - (anchor.x + anchor.w / 2) * k,
		y: 24 - anchor.y * k,
	};
}

export function fitView(
	content: { width: number; height: number },
	box: { width: number; height: number },
	padding = 48,
): View {
	const availableW = Math.max(1, box.width - padding * 2);
	const availableH = Math.max(1, box.height - padding * 2);
	const k = clampZoom(
		Math.min(
			1,
			availableW / Math.max(1, content.width),
			availableH / Math.max(1, content.height),
		),
	);
	return {
		k,
		x: (box.width - content.width * k) / 2,
		y: Math.max(padding, (box.height - content.height * k) / 2),
	};
}
