/**
 * WGSL for the translucent RTSTRUCT ROI surface pass over the 3D pane.
 *
 * The vertex stage reproduces the orthographic forward map of
 * `projectToPane` / `cameraBasis` (src/render/camera.ts) directly in clip space:
 * `ndc = dot(point - eye, axis) / dot(axis, axis)`, with the image-plane axes
 * (`axisU`, `axisV`) and their squared lengths (`uu`, `vv`) supplied per frame in
 * the camera uniform. WebGPU clip +Y is up, matching the pane's top-up `ndcY`, so
 * the surface lines up pixel-for-pixel with the raycast volume behind it.
 *
 * The fragment stage is a cheap head-light shade so the translucent shell reads
 * as a solid: `0.45 + 0.55·|n·light|`, with `light` the view forward direction.
 *
 * IMPORTANT: the vertex stage must *read* the camera uniform, otherwise
 * `layout: 'auto'` strips binding 0 from the group-0 layout and the bind group
 * becomes invalid (dropping the draw). Keep the projection here, not on the CPU.
 */
export const SURFACE_SHADER = /* wgsl */ `
struct Camera {
  eye: vec3<f32>, pad0: f32,
  axisU: vec3<f32>, uu: f32,
  axisV: vec3<f32>, vv: f32,
  light: vec3<f32>, pad1: f32,
};
@group(0) @binding(0) var<uniform> cam: Camera;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) normal: vec3<f32>,
};

@vertex
fn vs(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec4<f32>,
) -> VSOut {
  var out: VSOut;
  let rel = position - cam.eye;
  let ndcX = dot(rel, cam.axisU) / cam.uu;
  let ndcY = dot(rel, cam.axisV) / cam.vv;
  out.pos = vec4<f32>(ndcX, ndcY, 0.5, 1.0);
  out.color = color;
  out.normal = normal;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let shade = 0.45 + 0.55 * abs(dot(n, cam.light));
  return vec4<f32>(in.color.rgb * shade, in.color.a);
}
`;
