import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Session } from "../shared/types.ts";
import { exitToast } from "./exitToast.ts";

const cloud = (name: string) =>
	({ name, cloud: { url: `https://claude.ai/code/${name}` } }) as Session;
const local = (name: string) => ({ name }) as Session;

describe("exitToast", () => {
	it("says archived for cloud sessions claude.ai archived", () => {
		assert.equal(
			exitToast([{ session: cloud("Probe"), boardOnly: false }]),
			"Archived “Probe”",
		);
	});

	it("says a card only left the board when claude.ai couldn't archive it", () => {
		assert.equal(
			exitToast([{ session: cloud("Money explorer"), boardOnly: true }]),
			"Removed “Money explorer” from the board only; it wasn't ended on claude.ai",
		);
	});

	it("tells archived and board-only apart in one batch", () => {
		assert.equal(
			exitToast([
				{ session: cloud("A"), boardOnly: false },
				{ session: cloud("B"), boardOnly: true },
				{ session: cloud("C"), boardOnly: true },
				{ session: local("D"), boardOnly: false },
			]),
			"Archived “A”. Removed 2 cloud sessions from the board only; they weren't ended on claude.ai",
		);
	});

	it("offers nothing for local sessions", () => {
		assert.equal(exitToast([{ session: local("D"), boardOnly: false }]), null);
	});
});
