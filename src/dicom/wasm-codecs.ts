// Lazy wasm decoders for the encapsulated (compressed) transfer syntaxes that
// need a native decoder library: JPEG (libjpeg-turbo), JPEG-LS (CharLS), and
// JPEG 2000 (OpenJPEG). Each package is dynamically imported on first use so an
// uncompressed or RLE study never pays the (large) wasm download/parse cost.
//
// The three packages share one decode shape: allocate an input buffer, copy the
// encoded bytes in, decode, then read frame info and the decoded sample bytes.

/** Raw decoder output, before DICOM-side bit/signedness interpretation. */
export interface DecodedFrame {
  /** Decoded sample bytes, copied out of the wasm heap. */
  readonly bytes: Uint8Array;
  /** Bits per sample as reported by the decoder (8 or 16). */
  readonly bitsPerSample: number;
  /** Samples per pixel (1 for the grayscale images this viewer handles). */
  readonly componentCount: number;
}

/** A decoder package: how to load it and which embind class decodes a frame. */
interface CodecPackage {
  readonly load: () => Promise<CodecModuleFactory>;
  readonly decoderClass: string;
}

const LIBJPEG_TURBO: CodecPackage = {
  load: () => import('@cornerstonejs/codec-libjpeg-turbo-8bit').then((m) => m.default),
  decoderClass: 'JPEGDecoder',
};
const CHARLS: CodecPackage = {
  load: () => import('@cornerstonejs/codec-charls').then((m) => m.default),
  decoderClass: 'JpegLSDecoder',
};
const OPENJPEG: CodecPackage = {
  load: () => import('@cornerstonejs/codec-openjpeg').then((m) => m.default),
  decoderClass: 'J2KDecoder',
};

/**
 * Transfer syntaxes decodable by a bundled wasm codec. JPEG Lossless
 * (…4.57 / …4.70) is intentionally absent: libjpeg-turbo decodes only
 * DCT-based JPEG, so those would need a separate predictive-JPEG decoder.
 */
const PACKAGE_BY_SYNTAX: Record<string, CodecPackage> = {
  '1.2.840.10008.1.2.4.50': LIBJPEG_TURBO, // JPEG Baseline (Process 1)
  '1.2.840.10008.1.2.4.51': LIBJPEG_TURBO, // JPEG Extended (Process 2 & 4)
  '1.2.840.10008.1.2.4.80': CHARLS, // JPEG-LS Lossless
  '1.2.840.10008.1.2.4.81': CHARLS, // JPEG-LS Near-Lossless
  '1.2.840.10008.1.2.4.90': OPENJPEG, // JPEG 2000 (Lossless Only)
  '1.2.840.10008.1.2.4.91': OPENJPEG, // JPEG 2000
};

/** One ready module per package, shared across frames and files. */
const moduleCache = new Map<CodecPackage, Promise<CodecModule>>();

function moduleFor(pkg: CodecPackage): Promise<CodecModule> {
  let pending = moduleCache.get(pkg);
  if (!pending) {
    pending = pkg.load().then((factory) => factory());
    moduleCache.set(pkg, pending);
  }
  return pending;
}

/** True when {@link decodeWasmFrame} can handle this transfer syntax. */
export function isWasmTransferSyntax(transferSyntax: string): boolean {
  return transferSyntax in PACKAGE_BY_SYNTAX;
}

/**
 * Decode one encapsulated frame's bytes with the appropriate wasm codec. The
 * returned bytes are a private copy, safe to keep after the decoder is freed.
 */
export async function decodeWasmFrame(
  transferSyntax: string,
  encoded: Uint8Array,
): Promise<DecodedFrame> {
  const pkg = PACKAGE_BY_SYNTAX[transferSyntax];
  if (!pkg) throw new Error(`No wasm codec for transfer syntax ${transferSyntax}`);

  const module = await moduleFor(pkg);
  const decoder = new module[pkg.decoderClass]();
  try {
    decoder.getEncodedBuffer(encoded.length).set(encoded);
    decoder.decode();
    const info = decoder.getFrameInfo();
    return {
      bytes: decoder.getDecodedBuffer().slice(), // copy out of the wasm heap
      bitsPerSample: info.bitsPerSample,
      componentCount: info.componentCount,
    };
  } finally {
    decoder.delete();
  }
}
