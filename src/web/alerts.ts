export {
	type AlertKind,
	alertBody,
	alertKind,
	alertTitle,
	finished,
	type SeenActivities,
	seenActivities,
	summoned,
} from "../shared/notifications.ts";

export function titleFor(count: number): string {
	return count > 0 ? `(${count}) kanban` : "kanban";
}

const mark =
	'<rect width="32" height="32" rx="8" fill="#b5502f"/><rect x="7" y="8" width="7.5" height="16" rx="2" fill="#fff"/><rect x="17.5" y="8" width="7.5" height="7" rx="2" fill="#fff"/><rect x="17.5" y="17.5" width="7.5" height="6.5" rx="2" fill="#fff" fill-opacity=".6"/>';

export const plainFavicon = "favicon.svg";

export function badgeLabel(count: number): string {
	if (count <= 0) return "";
	return count > 9 ? "9+" : String(count);
}

// A red badge with a white ring, so it reads on light and dark tab strips.
export function faviconFor(count: number): string {
	const label = badgeLabel(count);
	if (!label) return plainFavicon;
	const size = label.length > 1 ? 13 : 18;
	const badge = `<circle cx="20.5" cy="11.5" r="10.5" fill="#e5221b" stroke="#fff" stroke-width="2"/><text x="20.5" y="11.5" dy=".36em" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,Arial,sans-serif" font-size="${size}" font-weight="800" fill="#fff">${label}</text>`;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${mark}${badge}</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// Shows the badged icon only once the browser has drawn it, and the plain
// icon whenever it cannot, so the tab never shows a broken image.
export function favicon(
	link: { setAttribute(name: string, value: string): void },
	decodes: (src: string) => Promise<unknown>,
): (count: number) => Promise<void> {
	let latest = 0;
	return async (count) => {
		const asked = ++latest;
		const src = faviconFor(count);
		if (src !== plainFavicon)
			try {
				await decodes(src);
			} catch {
				if (asked === latest) link.setAttribute("href", plainFavicon);
				return;
			}
		if (asked === latest) link.setAttribute("href", src);
	};
}
