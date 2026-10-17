/** Bound decoded PNG dimensions without decompressing untrusted image data. */
export const MAX_PNG_SIDE = 4096;
export const MAX_PNG_PIXELS = 4_000_000;

export function pngHeaderWithinLimits(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 24 ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return false;
  const width = view.getUint32(16), height = view.getUint32(20);
  return width > 0 && height > 0 && width <= MAX_PNG_SIDE && height <= MAX_PNG_SIDE &&
    width * height <= MAX_PNG_PIXELS;
}

export function base64PngWithinLimits(value: string): boolean {
  try {
    const header = atob(value.replace(/[\r\n]/g, "").slice(0, 32));
    return pngHeaderWithinLimits(Uint8Array.from(header, (char) => char.charCodeAt(0)));
  } catch {
    return false;
  }
}
