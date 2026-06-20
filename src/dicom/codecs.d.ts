// Ambient declarations for the @cornerstonejs/codec-* wasm packages, which ship
// no TypeScript types. Each is an Emscripten MODULARIZE build whose default
// export is a factory returning a ready module with embind-bound decoder
// classes. We type only the decoder surface this project uses.

/** Frame geometry reported by a decoder after {@link CodecDecoder.decode}. */
interface CodecFrameInfo {
  readonly width: number;
  readonly height: number;
  readonly bitsPerSample: number;
  readonly componentCount: number;
}

/** A single-frame decoder instance (JPEG / JPEG-LS / JPEG 2000). */
interface CodecDecoder {
  /** Allocate `size` bytes in the wasm heap and return a view to fill. */
  getEncodedBuffer(size: number): Uint8Array;
  /** The decoded raw samples (view into the wasm heap; copy before reuse). */
  getDecodedBuffer(): Uint8Array;
  getFrameInfo(): CodecFrameInfo;
  decode(): void;
  delete(): void;
}

/** The ready Emscripten module, keyed by embind class name. */
interface CodecModule {
  readonly [decoderClass: string]: new () => CodecDecoder;
}

/** Emscripten MODULARIZE factory. */
type CodecModuleFactory = (moduleArg?: Record<string, unknown>) => Promise<CodecModule>;

declare module '@cornerstonejs/codec-libjpeg-turbo-8bit' {
  const factory: CodecModuleFactory;
  export default factory;
}

declare module '@cornerstonejs/codec-charls' {
  const factory: CodecModuleFactory;
  export default factory;
}

declare module '@cornerstonejs/codec-openjpeg' {
  const factory: CodecModuleFactory;
  export default factory;
}
