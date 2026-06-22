/**
 * A small DICOM data dictionary mapping element tags to their human-readable
 * names, used to label rows in the raw-tag inspector. This is not the full
 * standard dictionary — it covers the file-meta, identifying, and acquisition
 * elements commonly seen in the series this viewer loads — but unknown tags
 * fall back gracefully (see {@link tagLabel}).
 *
 * Keys are the lowercase `ggggeeee` hex form (no `x` prefix), matching how
 * dicom-parser names elements once the prefix is stripped.
 */
const TAG_NAMES: Readonly<Record<string, string>> = {
  // File Meta Information (group 0002)
  '00020001': 'File Meta Information Version',
  '00020002': 'Media Storage SOP Class UID',
  '00020003': 'Media Storage SOP Instance UID',
  '00020010': 'Transfer Syntax UID',
  '00020012': 'Implementation Class UID',
  '00020013': 'Implementation Version Name',
  '00020016': 'Source Application Entity Title',

  // SOP Common & instance identification (group 0008)
  '00080005': 'Specific Character Set',
  '00080008': 'Image Type',
  '00080012': 'Instance Creation Date',
  '00080013': 'Instance Creation Time',
  '00080016': 'SOP Class UID',
  '00080018': 'SOP Instance UID',
  '00080020': 'Study Date',
  '00080021': 'Series Date',
  '00080022': 'Acquisition Date',
  '00080023': 'Content Date',
  '0008002a': 'Acquisition DateTime',
  '00080030': 'Study Time',
  '00080031': 'Series Time',
  '00080032': 'Acquisition Time',
  '00080033': 'Content Time',
  '00080050': 'Accession Number',
  '00080060': 'Modality',
  '00080070': 'Manufacturer',
  '00080080': 'Institution Name',
  '00080081': 'Institution Address',
  '00080090': 'Referring Physician Name',
  '00081010': 'Station Name',
  '00081030': 'Study Description',
  '0008103e': 'Series Description',
  '00081050': 'Performing Physician Name',
  '00081060': 'Name of Physician(s) Reading Study',
  '00081070': 'Operators Name',
  '00081090': 'Manufacturer Model Name',

  // Patient (group 0010)
  '00100010': 'Patient Name',
  '00100020': 'Patient ID',
  '00100030': 'Patient Birth Date',
  '00100040': 'Patient Sex',
  '00101010': 'Patient Age',
  '00101020': 'Patient Size',
  '00101030': 'Patient Weight',
  '00104000': 'Patient Comments',

  // Acquisition / device (group 0018)
  '00180015': 'Body Part Examined',
  '00180020': 'Scanning Sequence',
  '00180021': 'Sequence Variant',
  '00180022': 'Scan Options',
  '00180023': 'MR Acquisition Type',
  '00180050': 'Slice Thickness',
  '00180060': 'KVP',
  '00180080': 'Repetition Time',
  '00180081': 'Echo Time',
  '00180087': 'Magnetic Field Strength',
  '00180088': 'Spacing Between Slices',
  '00180090': 'Data Collection Diameter',
  '00181020': 'Software Versions',
  '00181030': 'Protocol Name',
  '00181100': 'Reconstruction Diameter',
  '00181110': 'Distance Source to Detector',
  '00181111': 'Distance Source to Patient',
  '00181120': 'Gantry/Detector Tilt',
  '00181130': 'Table Height',
  '00181151': 'X-Ray Tube Current',
  '00181152': 'Exposure',
  '00181210': 'Convolution Kernel',
  '00185100': 'Patient Position',

  // Relationship / identifiers (group 0020)
  '0020000d': 'Study Instance UID',
  '0020000e': 'Series Instance UID',
  '00200010': 'Study ID',
  '00200011': 'Series Number',
  '00200012': 'Acquisition Number',
  '00200013': 'Instance Number',
  '00200032': 'Image Position (Patient)',
  '00200037': 'Image Orientation (Patient)',
  '00200052': 'Frame of Reference UID',
  '00201040': 'Position Reference Indicator',
  '00201041': 'Slice Location',
  '00201002': 'Images in Acquisition',

  // Image presentation (group 0028)
  '00280002': 'Samples per Pixel',
  '00280004': 'Photometric Interpretation',
  '00280008': 'Number of Frames',
  '00280010': 'Rows',
  '00280011': 'Columns',
  '00280030': 'Pixel Spacing',
  '00280100': 'Bits Allocated',
  '00280101': 'Bits Stored',
  '00280102': 'High Bit',
  '00280103': 'Pixel Representation',
  '00280106': 'Smallest Image Pixel Value',
  '00280107': 'Largest Image Pixel Value',
  '00281050': 'Window Center',
  '00281051': 'Window Width',
  '00281052': 'Rescale Intercept',
  '00281053': 'Rescale Slope',
  '00281054': 'Rescale Type',

  // RT (groups 3004 / 3006)
  '30040002': 'Dose Units',
  '30040004': 'Dose Type',
  '3004000a': 'Dose Summation Type',
  '3004000c': 'Grid Frame Offset Vector',
  '3004000e': 'Dose Grid Scaling',
  '30060002': 'Structure Set Label',
  '30060008': 'Structure Set Date',
  '30060020': 'Structure Set ROI Sequence',
  '30060026': 'ROI Name',

  // Pixel data (group 7fe0)
  '7fe00010': 'Pixel Data',
};

/** Strip the `x` prefix dicom-parser uses and lowercase, yielding `ggggeeee`. */
function normalize(tag: string): string {
  const lower = tag.toLowerCase();
  return lower.startsWith('x') ? lower.slice(1) : lower;
}

/**
 * The human-readable name for an element tag, given either a `xggggeeee` key
 * or a bare `ggggeeee` hex string. Falls back to "Group Length" for the
 * `(gggg,0000)` length elements, "Private Tag" for odd (private) groups, and
 * null when the tag is simply not in the dictionary.
 */
export function tagLabel(tag: string): string | null {
  const hex = normalize(tag);
  if (hex.length !== 8) return null;

  const known = TAG_NAMES[hex];
  if (known) return known;

  if (hex.slice(4) === '0000') return 'Group Length';

  // Private elements live in odd-numbered groups.
  const group = parseInt(hex.slice(0, 4), 16);
  if (Number.isInteger(group) && group % 2 === 1) return 'Private Tag';

  return null;
}
