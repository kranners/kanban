import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session, SessionDigest } from "../shared/types.ts";
import { stuckOf } from "./digests.ts";

const digest: SessionDigest = {
	at: 0,
	now: "Running the tests",
	progress: "Two of four tasks done",
	stuck: "The same test keeps failing",
};

const sessionThat = (activity: Session["activity"]) =>
	({ activity }) as Session;

test("a digest's stuck reason shows only while the session is working", () => {
	assert.equal(stuckOf(sessionThat("working"), digest), digest.stuck);
	for (const activity of ["needs-you", "idle", "done", "failed"] as const)
		assert.equal(stuckOf(sessionThat(activity), digest), null);
});

test("a working session without a digest, or one not stuck, is not stuck", () => {
	assert.equal(stuckOf(sessionThat("working"), undefined), null);
	assert.equal(
		stuckOf(sessionThat("working"), { ...digest, stuck: null }),
		null,
	);
});
