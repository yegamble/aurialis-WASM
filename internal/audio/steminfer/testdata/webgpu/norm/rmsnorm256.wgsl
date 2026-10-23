// Private two-pass original L2*sqrt256 fixture, raw gamma/epsilon preserved.
// Reduction layout derives from Lloyd Chan's stemyla (MIT2026), exact source
// fa41c9fd18cbc0d26b31e4f7fdad7bafd0a4e96a. See ../LICENSE and ../NOTICE.
// The original single-pass/pre-scaled-gamma shader stays unchanged in upstream/.
struct Params { rows: u32, groups_x: u32, reserved0: u32, reserved1: u32 };
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> gamma: array<f32>;
@group(0) @binding(2) var<storage, read_write> quotient: array<f32>;
@group(0) @binding(3) var<storage, read_write> denominator: array<f32>;
@group(0) @binding(4) var<storage, read_write> output: array<f32>;
@group(0) @binding(5) var<uniform> p: Params;
var<workgroup> red: array<f32, 256>;
var<workgroup> divisor: f32;

@compute @workgroup_size(256, 1, 1)
fn normalize(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let row = wg.y * p.groups_x + wg.x;
  if (row >= p.rows) { return; }
  let t = lid.x;
  let v = x[1u + row * 256u + t];
  red[t] = v * v;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (t < s) { red[t] = red[t] + red[t + s]; }
    workgroupBarrier();
  }
  if (t == 0u) {
    divisor = max(sqrt(red[0]), 1e-12);
    denominator[1u + row] = divisor;
  }
  workgroupBarrier();
  quotient[1u + row * 256u + t] = v / divisor;
}

// Separate dispatch: stored F32 quotient is observable and read back. No claim
// that WGSL prevents every legal multiplication association within this pass.
@compute @workgroup_size(256, 1, 1)
fn scale(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let row = wg.y * p.groups_x + wg.x;
  if (row >= p.rows) { return; }
  let t = lid.x;
  let index = 1u + row * 256u + t;
  output[index] = (quotient[index] * 16.0) * gamma[1u + t];
}
