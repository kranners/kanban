import { signal } from "@preact/signals";
import {
	type Digests,
	noDigests,
	type Session,
	type SessionDigest,
} from "../shared/types.ts";

export const digests = signal<Digests>(noDigests);

export function stuckOf(
	session: Session,
	digest: SessionDigest | undefined,
): string | null {
	return session.activity === "working" ? (digest?.stuck ?? null) : null;
}
