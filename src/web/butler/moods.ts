import type { ButlerMood } from "../../shared/types.ts";
import alarmed from "./moods/alarmed.webp";
import amused from "./moods/amused.webp";
import apologetic from "./moods/apologetic.webp";
import concerned from "./moods/concerned.webp";
import content from "./moods/content.webp";
import curious from "./moods/curious.webp";
import delighted from "./moods/delighted.webp";
import diligent from "./moods/diligent.webp";
import fixed from "./moods/fixed.webp";
import pondering from "./moods/pondering.webp";
import proud from "./moods/proud.webp";
import puzzled from "./moods/puzzled.webp";
import weary from "./moods/weary.webp";

// Butler's face in each mood the daemon reads in his replies, cropped to
// 160px squares, bundled by esbuild as hashed files.
export const moodFaces: Record<ButlerMood, string> = {
	alarmed,
	amused,
	apologetic,
	concerned,
	content,
	curious,
	delighted,
	diligent,
	fixed,
	pondering,
	proud,
	puzzled,
	weary,
};
