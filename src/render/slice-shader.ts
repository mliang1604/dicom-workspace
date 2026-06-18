/**
 * WGSL for rendering a single planar slice out of a 3D volume texture, with a
 * DICOM window/level transform. The same shader serves axial, coronal and
 * sagittal views by swapping which volume axis the slice index walks.
 *
 * Kept as a string constant (rather than a `.wgsl` asset) because Angular's
 * esbuild-based builder has no `?raw` text loader. The `language=wgsl` hint
 * lets editors syntax-highlight the literal.
 */
// language=wgsl
export const SLICE_SHADER = /* wgsl */ `
struct Params {
  windowCenter : f32,
  windowWidth : f32,
  orientation : u32,   // 0 axial, 1 coronal, 2 sagittal
  slicePos : f32,      // normalized position along the slicing axis, 0..1
  scale : vec2<f32>,   // aspect-fit: centered uv is multiplied by this
  pan : vec2<f32>,     // screen-uv translation of the slice (drag-to-pan)
  flipX : u32,         // non-zero mirrors the in-plane horizontal axis
  _pad : f32,
};

@group(0) @binding(0) var volTex : texture_3d<f32>;
@group(0) @binding(1) var volSamp : sampler;
@group(0) @binding(2) var<uniform> P : Params;

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
  let px = select(plane.x, 1.0 - plane.x, P.flipX != 0u);

  var coord : vec3<f32>;
  switch (P.orientation) {
    case 0u: { // Axial: screen x->X, screen y->Y, slice walks Z.
      coord = vec3<f32>(px, plane.y, P.slicePos);
    }
    case 1u: { // Coronal: screen x->X, screen y->Z (flipped: superior up), slice walks Y.
      coord = vec3<f32>(px, P.slicePos, 1.0 - plane.y);
    }
    default: { // Sagittal: screen x->Y, screen y->Z (flipped: superior up), slice walks X.
      coord = vec3<f32>(P.slicePos, px, 1.0 - plane.y);
    }
  }

  let raw = textureSampleLevel(volTex, volSamp, coord, 0.0).r;

  // DICOM windowing (PS3.3 C.11.2.1.2 linear form).
  let lo = P.windowCenter - 0.5 - (P.windowWidth - 1.0) * 0.5;
  let g = clamp((raw - lo) / max(P.windowWidth - 1.0, 1.0), 0.0, 1.0);
  return vec4<f32>(g, g, g, 1.0);
}
`;
