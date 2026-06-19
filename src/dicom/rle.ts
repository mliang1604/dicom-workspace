// RLE Lossless (transfer syntax 1.2.840.10008.1.2.5) frame decoder.
//
// DICOM PS3.5 Annex G: each encapsulated frame begins with a 64-byte RLE header
// of sixteen little-endian uint32s — the first is the segment count, the rest
// are byte offsets (from the frame start) of each segment. Every segment is a
// byte-plane PackBits-compressed to `rows * columns` bytes. For a grayscale
// image there is one segment per byte of the sample, ordered most-significant
// byte first (so a 16-bit pixel is `segment0 << 8 | segment1`).

const RLE_HEADER_BYTES = 64;

/**
 * Decode one RLE frame into raw samples, matching the typed-array shapes the
 * loader's uncompressed path produces: `Uint8Array` for 8-bit, and
 * `Int16Array` / `Uint16Array` for signed / unsigned 16-bit.
 */
export function decodeRleFrame(
  frame: Uint8Array,
  count: number,
  bitsAllocated: number,
  pixelRepresentation: number,
): Int16Array | Uint16Array | Uint8Array {
  const header = new DataView(frame.buffer, frame.byteOffset, RLE_HEADER_BYTES);
  const segments = header.getUint32(0, true);
  const offsets: number[] = [];
  for (let i = 0; i < segments; i++) offsets.push(header.getUint32((i + 1) * 4, true));

  // End of segment i is the next segment's offset, or the end of the frame.
  const segmentEnd = (i: number): number => (i + 1 < segments ? offsets[i + 1] : frame.length);

  if (bitsAllocated <= 8) {
    return unpackBits(frame, offsets[0], segmentEnd(0), count);
  }

  // 16-bit: segment 0 holds the high byte, segment 1 the low byte.
  const high = unpackBits(frame, offsets[0], segmentEnd(0), count);
  const low = unpackBits(frame, offsets[1], segmentEnd(1), count);

  if (pixelRepresentation === 1) {
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      const v = (high[i] << 8) | low[i];
      out[i] = v > 0x7fff ? v - 0x10000 : v;
    }
    return out;
  }
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) out[i] = (high[i] << 8) | low[i];
  return out;
}

/**
 * Decode one PackBits (Annex G) segment of `src[start, end)` into `count`
 * bytes. A control byte `n`: 0–127 copies the next `n + 1` literal bytes;
 * 129–255 repeats the next byte `257 - n` times; 128 is a no-op.
 */
function unpackBits(src: Uint8Array, start: number, end: number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  let pos = start;
  let o = 0;
  while (o < count && pos < end) {
    const control = src[pos++];
    if (control < 128) {
      for (let run = control + 1; run > 0 && o < count && pos < end; run--) out[o++] = src[pos++];
    } else if (control > 128) {
      const value = src[pos++];
      for (let run = 257 - control; run > 0 && o < count; run--) out[o++] = value;
    }
  }
  return out;
}
