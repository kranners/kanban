// iOS keeps the layout viewport full height when the on-screen keyboard
// opens, so a full-height board leaves a focused input under the keyboard.
// On touch screens the app takes the visual viewport's height instead, which
// shrinks above the keyboard, and the page is held at the top.
const visual = window.visualViewport;
const coarse = window.matchMedia("(pointer: coarse)");

const fit = () => {
	const root = document.documentElement;
	if (!visual || !coarse.matches || visual.scale > 1.01) {
		root.style.removeProperty("--app-height");
		return;
	}
	root.style.setProperty("--app-height", `${Math.round(visual.height)}px`);
	if (window.scrollY !== 0) window.scrollTo(0, 0);
};

if (visual) {
	visual.addEventListener("resize", fit);
	visual.addEventListener("scroll", fit);
	coarse.addEventListener("change", fit);
	fit();
}
