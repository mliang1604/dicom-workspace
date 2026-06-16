// Minimal ambient types for the untyped `dicom-parser` package — only the
// surface this project actually uses. See https://github.com/cornerstonejs/dicomParser.
declare module 'dicom-parser' {
  /** A single parsed data element (tag) within a data set. */
  export interface DicomElement {
    /** Byte offset of the element's value within the source byte array. */
    readonly dataOffset: number;
    /** Length of the element's value in bytes. */
    readonly length: number;
  }

  /** A parsed DICOM data set, queried by lowercase `xGGGGEEEE` tag keys. */
  export interface DataSet {
    readonly elements: Record<string, DicomElement | undefined>;
    uint16(tag: string, index?: number): number | undefined;
    floatString(tag: string, index?: number): number | undefined;
    string(tag: string, index?: number): string | undefined;
  }

  export function parseDicom(byteArray: Uint8Array): DataSet;
}
