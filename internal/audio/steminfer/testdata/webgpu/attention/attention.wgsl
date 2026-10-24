// Aurialis private ABI1: post-RoPE single head, all keys, eight stored passes.
// Original arithmetic structure follows MIT ZFTurbo Attend; package NOTICE.
struct Parameters { m:u32, n:u32, dimension:u32, reserved:u32 }
@group(0) @binding(0) var<storage,read> left:array<f32>;
@group(0) @binding(1) var<storage,read> right:array<f32>;
@group(0) @binding(2) var<storage,read_write> destination:array<f32>;
@group(0) @binding(3) var<uniform> p:Parameters;
var<workgroup> reduction:array<f32,256>;
// Every storage allocation has one untouched canary at each end.
@compute @workgroup_size(64)
fn raw(@builtin(global_invocation_id) id:vec3<u32>) {
  let key=id.x;let row=id.y;
  if(row>=p.m || key>=p.n){return;}
  var value=0.0;
  for(var c=0u;c<64u;c++){value=value+left[1u+row*64u+c]*right[1u+key*64u+c];}
  destination[1u+row*p.n+key]=value;
}
@compute @workgroup_size(64)
fn scaled(@builtin(global_invocation_id) id:vec3<u32>) {
  if(id.y<p.m && id.x<p.n){let i=1u+id.y*p.n+id.x;destination[i]=left[i]*0.125;}
}
@compute @workgroup_size(256)
fn maximum(@builtin(local_invocation_id) id:vec3<u32>,@builtin(workgroup_id) group:vec3<u32>) {
  var value=-3.4028234663852886e38;
  for(var c=id.x;c<p.n;c+=256u){value=max(value,left[1u+group.x*p.n+c]);}
  reduction[id.x]=value;workgroupBarrier();
  for(var span=128u;span>0u;span/=2u){if(id.x<span){reduction[id.x]=max(reduction[id.x],reduction[id.x+span]);}workgroupBarrier();}
  if(id.x==0u){destination[1u+group.x]=reduction[0];}
}
@compute @workgroup_size(64)
fn shifted(@builtin(global_invocation_id) id:vec3<u32>) {
  if(id.y<p.m && id.x<p.n){let i=1u+id.y*p.n+id.x;destination[i]=left[i]-right[1u+id.y];}
}
@compute @workgroup_size(64)
fn exponential(@builtin(global_invocation_id) id:vec3<u32>) {
  if(id.y<p.m && id.x<p.n){let i=1u+id.y*p.n+id.x;destination[i]=exp(left[i]);}
}
@compute @workgroup_size(256)
fn denominator(@builtin(local_invocation_id) id:vec3<u32>,@builtin(workgroup_id) group:vec3<u32>) {
  var value=0.0;
  for(var c=id.x;c<p.n;c+=256u){value=value+left[1u+group.x*p.n+c];}
  reduction[id.x]=value;workgroupBarrier();
  for(var span=128u;span>0u;span/=2u){if(id.x<span){reduction[id.x]=reduction[id.x]+reduction[id.x+span];}workgroupBarrier();}
  if(id.x==0u){destination[1u+group.x]=reduction[0];}
}
@compute @workgroup_size(64)
fn probability(@builtin(global_invocation_id) id:vec3<u32>) {
  if(id.y<p.m && id.x<p.n){let i=1u+id.y*p.n+id.x;destination[i]=left[i]/right[1u+id.y];}
}
@compute @workgroup_size(64)
fn output(@builtin(global_invocation_id) id:vec3<u32>) {
  let channel=id.x;let row=id.y;if(channel>=64u || row>=p.m){return;}
  var value=0.0;
  for(var key=0u;key<p.n;key++){value=value+left[1u+row*p.n+key]*right[1u+key*64u+channel];}
  destination[1u+row*64u+channel]=value;
}
