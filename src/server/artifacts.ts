import type { Artifact } from "../shared/types.ts";
import { asString, type Json, truncate } from "./ingest/json.ts";

const artifactUrl = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+$/;
const titleLength = 120;

export function publishedArtifact(
	input: Json,
	result: Json | null,
	at: number,
): Artifact | null {
	const action = asString(input.action) ?? "publish";
	if (action !== "publish" || input.asset === true) return null;
	const url = asString(result?.url);
	if (!url || !artifactUrl.test(url)) return null;
	const title =
		asString(result?.title)?.trim() || asString(input.title)?.trim();
	return {
		url,
		title: truncate(title || "Artifact", titleLength),
		at,
	};
}
