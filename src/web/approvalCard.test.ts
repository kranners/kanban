import assert from "node:assert/strict";
import { test } from "node:test";
import { parseApprovalBody, plain } from "./approvalCard.ts";

test("reads an approval card's sections as Discord shows them", () => {
	const body = [
		"**Goal:** Pay the dentist for \\*today\\*",
		"### 🔴 Needs your approval",
		"- `$` **Make payments**",
		"-# to the dentist, at most $200",
		"- `➜` **Send messages or email**",
		"-# to sam@example.com",
		"### Also included",
		"- Use the screen and shell on piggys-MBP",
		"### Limits",
		"- Lasts 24 hours",
		"- Logged to audit/shell",
	].join("\n");
	assert.deepEqual(parseApprovalBody(body), {
		goal: "Pay the dentist for *today*",
		critical: [
			{
				glyph: "$",
				capability: "Make payments",
				touches: "to the dentist, at most $200",
			},
			{
				glyph: "➜",
				capability: "Send messages or email",
				touches: "to sam@example.com",
			},
		],
		noCritical: false,
		included: ["Use the screen and shell on piggys-MBP"],
		limits: ["Lasts 24 hours", "Logged to audit/shell"],
		other: [],
	});
});

test("says when a card has no critical permission, and keeps a plain prompt's words", () => {
	const safe = parseApprovalBody(
		"**Goal:** Tidy\n### ⚪ Needs your approval\nNo critical permissions\n### Limits\n- 24 hours",
	);
	assert.equal(safe.noCritical, true);
	assert.deepEqual(safe.critical, []);
	assert.deepEqual(parseApprovalBody("Send this to Sam?").other, [
		"Send this to Sam?",
	]);
	assert.deepEqual(parseApprovalBody(undefined).other, []);
	assert.equal(plain("**bold** `code` \\_x\\_"), "bold code _x_");
});
