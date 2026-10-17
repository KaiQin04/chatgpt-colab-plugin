import assert from "node:assert/strict";
import { test } from "node:test";
import { base64PngWithinLimits, pngHeaderWithinLimits } from "../lib/notebook/png.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function header(width = 1, height = 1): Uint8Array {
  const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}

test("PNG header bounds accept a normal image and the exact pixel and side limits", () => {
  assert.equal(base64PngWithinLimits(png), true);
  assert.equal(base64PngWithinLimits(png.match(/.{1,10}/g)!.join("\r\n")), true);
  assert.equal(pngHeaderWithinLimits(header(2000, 2000)), true);
  assert.equal(pngHeaderWithinLimits(header(4096, 1)), true);
  const padded = new Uint8Array(100); padded.set(header(), 7);
  assert.equal(pngHeaderWithinLimits(padded.subarray(7)), true);
});

test("PNG header bounds reject oversized, zero, truncated and malformed headers", () => {
  for (const [width, height] of [[0, 1], [1, 0], [4097, 1], [1, 4097], [4096, 4096], [20000, 20000]]) {
    assert.equal(pngHeaderWithinLimits(header(width, height)), false);
  }
  assert.equal(pngHeaderWithinLimits(header().subarray(0, 23)), false);
  for (const offset of [0, 8, 12]) {
    const bytes = header(); bytes[offset] ^= 1;
    assert.equal(pngHeaderWithinLimits(bytes), false);
  }
  for (const value of ["", "not-base64!", "iVBORw0KGgo", "iVBORw0KGgo="]) {
    assert.equal(base64PngWithinLimits(value), false);
  }
});
