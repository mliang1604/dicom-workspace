/**
 * WGSL for rendering a single planar slice out of a 3D volume texture, with a
 * DICOM window/level transform. The same shader serves axial, coronal and
 * sagittal views: a per-pane `planeToTex` affine (built in `reslice.ts` from the
 * volume's patient-space geometry) maps the pane's (u, v, slicePos) to texture
 * coordinates, so the anatomical plane is correct regardless of how the series
 * was acquired (axial, sagittal, coronal, or oblique/gantry-tilted).
 *
 * Kept as a string constant (rather than a `.wgsl` asset) because Angular's
 * esbuild-based builder has no `?raw` text loader. The `language=wgsl` hint
 * lets editors syntax-highlight the literal.
 */
// language=wgsl
export const SLICE_SHADER = /* wgsl */ `
struct Params {
  planeToTex : mat4x4<f32>, // (u, v, slicePos, 1) -> texture coord, patient-aware
  scale : vec2<f32>,        // aspect-fit: centered uv is multiplied by this
  pan : vec2<f32>,          // screen-uv translation of the slice (drag-to-pan)
  windowCenter : f32,
  windowWidth : f32,
  slicePos : f32,           // normalized position along the slicing axis, 0..1
  flipX : u32,              // non-zero mirrors the in-plane horizontal axis
  invert : u32,             // non-zero inverts the windowed gray (display inversion)
  // Fusion overlay: a second volume sharing the patient frame but its own grid.
  // overlayToTex maps the SAME pane (u, v, slicePos) into the overlay's texture
  // coords; the overlay is windowed and composited over the base by overlayOpacity
  // (0 = no overlay). mat4x4 alignment lands this block at byte 112.
  overlayToTex : mat4x4<f32>,
  overlayWindowCenter : f32,
  overlayWindowWidth : f32,
  overlayOpacity : f32,
  overlayColormap : u32,    // non-zero: map the windowed overlay through overlayLut
};

@group(0) @binding(0) var volTex : texture_3d<f32>;
@group(0) @binding(1) var volSamp : sampler;
@group(0) @binding(2) var<uniform> P : Params;
@group(0) @binding(3) var overlayTex : texture_3d<f32>;
@group(0) @binding(4) var overlayLut : texture_1d<f32>; // RGBA colormap ramp

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  // Oversized fullscreen triangle.
  var corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  let xy = corners[vi];
  var out : VSOut;
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  // uv in [0,1], with v = 0 at the top of the canvas.
  out.uv = vec2<f32>((xy.x + 1.0) * 0.5, (1.0 - xy.y) * 0.5);
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  // Pan shifts the slice within the pane (screen-uv), then letterbox to
  // preserve the slice's physical aspect ratio.
  let plane = (in.uv - vec2<f32>(0.5) - P.pan) * P.scale + vec2<f32>(0.5);
  if (plane.x < 0.0 || plane.x > 1.0 || plane.y < 0.0 || plane.y > 1.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  // Optionally mirror the in-plane horizontal axis (e.g. flip sagittal L/R).
  let u = select(plane.x, 1.0 - plane.x, P.flipX != 0u);

  // Reslice: pane plane -> patient plane -> texture coord, via the affine.
  let coord = (P.planeToTex * vec4<f32>(u, plane.y, P.slicePos, 1.0)).xyz;
  // Outside the (possibly rotated) volume the plane has no data: paint black.
  if (any(coord < vec3<f32>(0.0)) || any(coord > vec3<f32>(1.0))) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let raw = textureSampleLevel(volTex, volSamp, coord, 0.0).r;

  // DICOM windowing (PS3.3 C.11.2.1.2 linear form).
  let lo = P.windowCenter - 0.5 - (P.windowWidth - 1.0) * 0.5;
  let g = clamp((raw - lo) / max(P.windowWidth - 1.0, 1.0), 0.0, 1.0);
  let shade = select(g, 1.0 - g, P.invert != 0u);
  var rgb = vec3<f32>(shade, shade, shade);

  // Fusion overlay: sample the second volume at the same pane point via its own
  // affine, window it, and blend over the base. A colormap overlay (e.g. a dose
  // wash) maps the windowed value through overlayLut to colour; a grayscale one
  // uses the value directly. Outside the overlay's grid (or opacity 0) the base
  // shows through unchanged.
  if (P.overlayOpacity > 0.0) {
    let ocoord = (P.overlayToTex * vec4<f32>(u, plane.y, P.slicePos, 1.0)).xyz;
    if (all(ocoord >= vec3<f32>(0.0)) && all(ocoord <= vec3<f32>(1.0))) {
      let oraw = textureSampleLevel(overlayTex, volSamp, ocoord, 0.0).r;
      let olo = P.overlayWindowCenter - 0.5 - (P.overlayWindowWidth - 1.0) * 0.5;
      let og = clamp((oraw - olo) / max(P.overlayWindowWidth - 1.0, 1.0), 0.0, 1.0);
      var orgb = vec3<f32>(og, og, og);
      if (P.overlayColormap != 0u) {
        orgb = textureSampleLevel(overlayLut, volSamp, og, 0.0).rgb;
      }
      rgb = mix(rgb, orgb, P.overlayOpacity);
    }
  }
  return vec4<f32>(rgb, 1.0);
}
`;
