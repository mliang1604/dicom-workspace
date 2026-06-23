/**
 * A small DICOM data dictionary mapping tag ids to their human-readable names,
 * for the raw-tag inspector's label column. dicom-parser ships no dictionary, so
 * this is a curated subset of the standard's commonly-encountered tags (file
 * meta, patient/study/series, image pixel, CT/MR/PET acquisition, and the RT
 * dose/structure-set groups this viewer reads). Anything not listed falls back
 * to the generic rules in {@link tagName}.
 *
 * Keys are the lowercase `ggggeeee` hex form, matching dicom-parser's element
 * tags with the leading `x` stripped.
 */
const TAG_NAMES: Readonly<Record<string, string>> = {
  // File meta (0002)
  '00020001': 'File Meta Information Version',
  '00020002': 'Media Storage SOP Class UID',
  '00020003': 'Media Storage SOP Instance UID',
  '00020010': 'Transfer Syntax UID',
  '00020012': 'Implementation Class UID',
  '00020013': 'Implementation Version Name',
  '00020016': 'Source Application Entity Title',

  // Identifying / SOP common (0008)
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
  '00080064': 'Conversion Type',
  '00080070': 'Manufacturer',
  '00080080': 'Institution Name',
  '00080090': 'Referring Physician Name',
  '00081010': 'Station Name',
  '00081030': 'Study Description',
  '0008103e': 'Series Description',
  '00081040': 'Institutional Department Name',
  '00081050': 'Performing Physician Name',
  '00081060': 'Name of Physician(s) Reading Study',
  '00081070': 'Operators Name',
  '00081090': 'Manufacturer Model Name',

  // Patient (0010)
  '00100010': "Patient's Name",
  '00100020': 'Patient ID',
  '00100030': "Patient's Birth Date",
  '00100040': "Patient's Sex",
  '00101010': "Patient's Age",
  '00101020': "Patient's Size",
  '00101030': "Patient's Weight",
  '00102160': 'Ethnic Group',
  '00104000': 'Patient Comments',

  // Acquisition (0018)
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
  '00181000': 'Device Serial Number',
  '00181020': 'Software Versions',
  '00181030': 'Protocol Name',
  '00181100': 'Reconstruction Diameter',
  '00181110': 'Distance Source to Detector',
  '00181111': 'Distance Source to Patient',
  '00181120': 'Gantry/Detector Tilt',
  '00181130': 'Table Height',
  '00181140': 'Rotation Direction',
  '00181150': 'Exposure Time',
  '00181151': 'X-Ray Tube Current',
  '00181152': 'Exposure',
  '00181160': 'Filter Type',
  '00181170': 'Generator Power',
  '00181190': 'Focal Spot(s)',
  '00181210': 'Convolution Kernel',
  '00185100': 'Patient Position',

  // Relationship / image plane (0020)
  '0020000d': 'Study Instance UID',
  '0020000e': 'Series Instance UID',
  '00200010': 'Study ID',
  '00200011': 'Series Number',
  '00200012': 'Acquisition Number',
  '00200013': 'Instance Number',
  '00200020': 'Patient Orientation',
  '00200032': 'Image Position (Patient)',
  '00200037': 'Image Orientation (Patient)',
  '00200052': 'Frame of Reference UID',
  '00201040': 'Position Reference Indicator',
  '00201041': 'Slice Location',
  '00201002': 'Images in Acquisition',

  // Image pixel (0028)
  '00280002': 'Samples per Pixel',
  '00280004': 'Photometric Interpretation',
  '00280006': 'Planar Configuration',
  '00280008': 'Number of Frames',
  '00280010': 'Rows',
  '00280011': 'Columns',
  '00280030': 'Pixel Spacing',
  '00280034': 'Pixel Aspect Ratio',
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
  '00282110': 'Lossy Image Compression',

  // PET (0054)
  '00541001': 'Units',
  '00541002': 'Counts Source',
  '00541100': 'Primary (Prompts) Counts Accumulated',
  '00541300': 'Frame Reference Time',

  // RT dose (3004)
  '30040002': 'Dose Units',
  '30040004': 'Dose Type',
  '30040006': 'Dose Comment',
  '3004000a': 'Dose Summation Type',
  '3004000c': 'Grid Frame Offset Vector',
  '3004000e': 'Dose Grid Scaling',
  '30040014': 'Tissue Heterogeneity Correction',

  // RT structure set (3006)
  '30060002': 'Structure Set Label',
  '30060004': 'Structure Set Name',
  '30060008': 'Structure Set Date',
  '30060009': 'Structure Set Time',
  '30060010': 'Referenced Frame of Reference Sequence',
  '30060020': 'Structure Set ROI Sequence',
  '30060022': 'ROI Number',
  '30060024': 'Referenced Frame of Reference UID',
  '30060026': 'ROI Name',
  '3006002a': 'ROI Display Color',
  '30060028': 'ROI Description',
  '30060036': 'ROI Generation Algorithm',
  '30060039': 'ROI Contour Sequence',
  '30060040': 'Contour Sequence',
  '30060042': 'Contour Geometric Type',
  '30060046': 'Number of Contour Points',
  '30060048': 'Contour Number',
  '30060050': 'Contour Data',
  '30060080': 'RT ROI Observations Sequence',
  '30060082': 'Observation Number',
  '30060084': 'Referenced ROI Number',
  '300600a4': 'RT ROI Interpreted Type',

  // Pixel data (7fe0)
  '7fe00010': 'Pixel Data',
};

/**
 * Human-readable name for a DICOM tag, or `null` when unknown. Accepts the
 * `xggggeeee` element key, the bare `ggggeeee` hex, or the `(gggg,eeee)` display
 * form. Beyond the curated {@link TAG_NAMES} table it recognises the two generic
 * conventions: any `(gggg,0000)` element is the group's length, and any
 * `(ggg[13579],00xx)` element in an odd (private) group is a private creator.
 */
export function tagName(tag: string): string | null {
  const hex = normalizeTag(tag);
  if (hex === null) return null;

  const known = TAG_NAMES[hex];
  if (known) return known;

  const group = hex.slice(0, 4);
  const element = hex.slice(4, 8);
  if (element === '0000') return 'Group Length';

  // Odd-numbered groups are private; their (gggg,00xx) block names the creator.
  const isPrivateGroup = parseInt(group[3], 16) % 2 === 1;
  if (isPrivateGroup && element.startsWith('00') && element !== '0000') {
    return 'Private Creator';
  }

  return null;
}

/** Normalise any accepted tag spelling to lowercase `ggggeeee`, or null if malformed. */
function normalizeTag(tag: string): string | null {
  const hex = tag.toLowerCase().replace(/^x/, '').replace(/[(),]/g, '');
  return /^[0-9a-f]{8}$/.test(hex) ? hex : null;
}
