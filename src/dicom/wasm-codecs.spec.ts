// @vitest-environment node
//
// The @cornerstonejs/codec-* packages are Emscripten builds; run them under the
// Node environment so the module picks a deterministic runtime (jsdom confuses
// its web-vs-node detection).

import { decodeWasmFrame, isWasmTransferSyntax } from './wasm-codecs';

describe('isWasmTransferSyntax', () => {
  it('recognizes the JPEG / JPEG-LS / JPEG 2000 syntaxes it can decode', () => {
    for (const uid of [
      '1.2.840.10008.1.2.4.50', // JPEG Baseline
      '1.2.840.10008.1.2.4.51', // JPEG Extended
      '1.2.840.10008.1.2.4.80', // JPEG-LS Lossless
      '1.2.840.10008.1.2.4.81', // JPEG-LS Near-Lossless
      '1.2.840.10008.1.2.4.90', // JPEG 2000 Lossless
      '1.2.840.10008.1.2.4.91', // JPEG 2000
    ]) {
      expect(isWasmTransferSyntax(uid)).toBe(true);
    }
  });

  it('rejects uncompressed, RLE, and lossless-JPEG (no DCT decoder) syntaxes', () => {
    for (const uid of [
      '1.2.840.10008.1.2', // Implicit VR LE
      '1.2.840.10008.1.2.1', // Explicit VR LE
      '1.2.840.10008.1.2.5', // RLE Lossless
      '1.2.840.10008.1.2.4.57', // JPEG Lossless (predictive, unsupported)
      '1.2.840.10008.1.2.4.70', // JPEG Lossless SV1 (unsupported)
    ]) {
      expect(isWasmTransferSyntax(uid)).toBe(false);
    }
  });
});

describe('decodeWasmFrame', () => {
  // A 4x2, 8-bit grayscale image with samples [10,20,30,40,50,60,70,80],
  // encoded as a single JPEG-LS (lossless) frame by CharLS.
  const JPEG_LS_FRAME = Uint8Array.from([
    255, 216, 255, 247, 0, 11, 8, 0, 2, 0, 4, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 0, 0, 7, 14,
    72, 112, 0, 0, 128, 133, 2, 0, 255, 217,
  ]);

  it('decodes a known JPEG-LS frame to its exact samples', async () => {
    const decoded = await decodeWasmFrame('1.2.840.10008.1.2.4.80', JPEG_LS_FRAME);

    expect(decoded.bitsPerSample).toBe(8);
    expect(decoded.componentCount).toBe(1);
    expect(Array.from(decoded.bytes)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });
});
