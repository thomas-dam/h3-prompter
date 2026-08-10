import { test } from "node:test";
import assert from "node:assert/strict";
import { MODE_LIMITS, validateCapacity, MediaError, mediaType } from "../src/lib/media.js";

test("T2VA accepts no media types", () => {
  assert.throws(
    () => validateCapacity("T2VA", [], "image"),
    (err) => err instanceof MediaError && err.code === "UNSUPPORTED_MEDIA",
  );
});

test("I2VA accepts up to 1 image", () => {
  assert.doesNotThrow(() => validateCapacity("I2VA", [], "image"));
  assert.throws(
    () => validateCapacity("I2VA", [{ mode: "I2VA", type: "image" }], "image"),
    (err) => err instanceof MediaError && err.code === "MEDIA_LIMIT_REACHED",
  );
});

test("FL2VA accepts up to 2 images", () => {
  assert.doesNotThrow(() => validateCapacity("FL2VA", [{ mode: "FL2VA", type: "image" }], "image"));
  assert.throws(
    () => validateCapacity("FL2VA", [{ mode: "FL2VA", type: "image" }, { mode: "FL2VA", type: "image" }], "image"),
    (err) => err instanceof MediaError && err.code === "MEDIA_LIMIT_REACHED",
  );
});

test("Reference enforces total 12 file limit", () => {
  const assets = [
    ...Array.from({ length: 9 }, () => ({ mode: "Reference", type: "image" })),
    ...Array.from({ length: 2 }, () => ({ mode: "Reference", type: "video" })),
    { mode: "Reference", type: "audio" },
  ];
  assert.equal(assets.length, 12);
  assert.throws(
    () => validateCapacity("Reference", assets, "audio"),
    (err) => err instanceof MediaError && err.code === "MEDIA_LIMIT_REACHED",
  );
});

test("Reference enforces per-type limits", () => {
  const videos = Array.from({ length: 2 }, () => ({ mode: "Reference", type: "video" }));
  assert.doesNotThrow(() => validateCapacity("Reference", videos, "video"));
  assert.throws(
    () => validateCapacity("Reference", [...videos, { mode: "Reference", type: "video" }], "video"),
    (err) => err instanceof MediaError && err.code === "MEDIA_LIMIT_REACHED",
  );
});

test("mediaType detects by extension", () => {
  assert.equal(mediaType("photo.jpg"), "image");
  assert.equal(mediaType("clip.mp4"), "video");
  assert.equal(mediaType("song.mp3"), "audio");
  assert.equal(mediaType("data.xyz"), null);
  assert.equal(mediaType("unknown", "image/png"), "image");
});

test("L2VA accepts up to 1 image", () => {
  assert.doesNotThrow(() => validateCapacity("L2VA", [], "image"));
  assert.throws(
    () => validateCapacity("L2VA", [{ mode: "L2VA", type: "image" }], "image"),
    (err) => err instanceof MediaError && err.code === "MEDIA_LIMIT_REACHED",
  );
});