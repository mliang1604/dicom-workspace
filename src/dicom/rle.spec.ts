import { decodeRleFrame } from './rle';

// --- RLE frame builders -----------------------------------------------------
//
// PS3.5 Annex G: a 64-byte header (uint32 segment count + up to 15 offsets)
// followed by PackBits-compressed byte-plane segments.

/** A PackBits literal run: control byte `len-1`, then the bytes verbatim. */
function literal(bytes: number[]): number[] {
  return [bytes.length - 1, ...bytes];
}

/** A PackBits replicate run: control byte `257-len`, then the repeated byte. */
function replicate(value: number, len: number): number[] {
  return [257 - len, value];
}

/** Assemble an RLE frame from already-PackBits-encoded segments. */
function rleFrame(segments: number[][]): Uint8Array {
  const header = new Uint8Array(64);
  const view = new DataView(header.buffer);
  view.setUint32(0, segments.length, true);

  let offset = 64;
  const body: number[] = [];
  segments.forEach((seg, i) => {
    view.setUint32((i + 1) * 4, offset, true);
    body.push(...seg);
    offset += seg.length;
  });

  const out = new Uint8Array(64 + body.length);
  out.set(header, 0);
  out.set(body, 64);
  return out;
}

describe('decodeRleFrame', () => {
  it('decodes a 16-bit unsigned frame (high byte then low byte)', () => {
    // Pixels 0x0102, 0x0304, 0x0506, 0x0708.
    const high = literal([0x01, 0x03, 0x05, 0x07]);
    const low = literal([0x02, 0x04, 0x06, 0x08]);
    const out = decodeRleFrame(rleFrame([high, low]), 4, 16, 0);

    expect(out).toBeInstanceOf(Uint16Array);
    expect(Array.from(out)).toEqual([0x0102, 0x0304, 0x0506, 0x0708]);
  });

  it('reconstructs negative values for signed 16-bit pixels', () => {
    // 0xFFFF -> -1, 0x8000 -> -32768, 0x7FFF -> 32767, 0x0000 -> 0.
    const high = literal([0xff, 0x80, 0x7f, 0x00]);
    const low = literal([0xff, 0x00, 0xff, 0x00]);
    const out = decodeRleFrame(rleFrame([high, low]), 4, 16, 1);

    expect(out).toBeInstanceOf(Int16Array);
    expect(Array.from(out)).toEqual([-1, -32768, 32767, 0]);
  });

  it('expands PackBits replicate runs', () => {
    // Every pixel 0xAB12: high byte 0xAB x4, low byte 0x12 x4.
    const out = decodeRleFrame(rleFrame([replicate(0xab, 4), replicate(0x12, 4)]), 4, 16, 0);
    expect(Array.from(out)).toEqual([0xab12, 0xab12, 0xab12, 0xab12]);
  });

  it('decodes an 8-bit frame as a single segment', () => {
    const out = decodeRleFrame(rleFrame([literal([10, 20, 30, 40])]), 4, 8, 0);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([10, 20, 30, 40]);
  });

  it('handles a mix of literal and replicate runs within a segment', () => {
    // Decoded plane: [1, 2, 9, 9, 9, 3]  -> literal[1,2] + replicate(9,3) + literal[3].
    const plane = [...literal([1, 2]), ...replicate(9, 3), ...literal([3])];
    const out = decodeRleFrame(rleFrame([plane]), 6, 8, 0);
    expect(Array.from(out)).toEqual([1, 2, 9, 9, 9, 3]);
  });
});
