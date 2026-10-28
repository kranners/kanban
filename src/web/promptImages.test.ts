import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maxImageBytes, maxPromptImages } from "../shared/promptImages.ts";
import { admit } from "./promptImages.ts";

const png = (name: string) => ({ name, type: "image/png", size: 1024 });

describe("admit", () => {
	it("accepts supported images", () => {
		const files = [png("a.png"), { ...png("b.jpg"), type: "image/jpeg" }];
		assert.deepEqual(admit(0, files), { accepted: files, error: null });
	});

	it("skips every unsupported or oversized image and says why", () => {
		const tiff = { ...png("scan.tiff"), type: "image/tiff" };
		const heic = { ...png("photo.heic"), type: "image/heic" };
		const huge = { ...png("huge.png"), size: maxImageBytes + 1 };
		assert.deepEqual(admit(0, [tiff, png("ok.png"), heic]), {
			accepted: [png("ok.png")],
			error: "scan.tiff isn't a PNG, JPEG, GIF or WebP",
		});
		assert.deepEqual(admit(0, [huge]), {
			accepted: [],
			error: "huge.png is over 5 MB",
		});
	});

	it("stops at the image limit", () => {
		const files = [png("a.png"), png("b.png")];
		assert.deepEqual(admit(maxPromptImages - 1, files), {
			accepted: [files[0]],
			error: `Attach at most ${maxPromptImages} images`,
		});
	});
});
