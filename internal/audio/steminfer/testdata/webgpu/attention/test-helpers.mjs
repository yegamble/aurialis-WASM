/** Synthetic source-unit stages, never labeled actual hardware/original traces. */
import { shapePlan,parseFixture } from './contract.mjs';
import { STAGES } from './propagated.mjs';
export function synthetic(m=1,n=2,kind='zero'){
 const p=shapePlan(m,n),buffer=new ArrayBuffer(p.fixtureBytes),view=new DataView(buffer);new Uint8Array(buffer,0,8).set(new TextEncoder().encode('AURATT01'));for(const [offset,value]of [[8,m],[12,n],[16,64]])view.setUint32(offset,value,true);
 const f=parseFixture(buffer),a=f.arrays;
 if(kind==='tie'){a.q.fill(.5);a.k.fill(.25);a.v.fill(.125);}
 if(kind==='normal'){a.q.fill(.5);for(let key=0;key<n;key++){a.k.fill((key%3-1)*.25,key*64,(key+1)*64);a.v.fill((key%5-2)*.125,key*64,(key+1)*64);}}
 if(kind==='resurrection'){if(n<2)throw new Error('Need two keys');for(let i=0;i<4;i++){a.q[i]=16;a.k[(n-1)*64+i]=-10.9375;}a.v.fill(32,(n-1)*64);}
 for(let row=0;row<m;row++){
  for(let key=0;key<n;key++){let sum=0;for(let c=0;c<64;c++)sum=Math.fround(sum+Math.fround(a.q[row*64+c]*a.k[key*64+c]));a.raw[row*n+key]=sum;a.scaled[row*n+key]=Math.fround(sum*.125);}
  a.maximum[row]=Math.max(...a.scaled.subarray(row*n,(row+1)*n));
  let sum=0;for(let key=0;key<n;key++){const i=row*n+key;a.shifted[i]=Math.fround(a.scaled[i]-a.maximum[row]);a.exponential[i]=Math.fround(Math.exp(a.shifted[i]));sum=Math.fround(sum+a.exponential[i]);}a.denominator[row]=sum;
  for(let key=0;key<n;key++){const i=row*n+key;a.probability[i]=Math.fround(a.exponential[i]/sum);}
  for(let c=0;c<64;c++){let out=0;for(let key=0;key<n;key++)out=Math.fround(out+Math.fround(a.probability[row*n+key]*a.v[key*64+c]));a.output[row*64+c]=out;}
 }
 for(const name of ['goRaw','torchRaw'])a[name].set(a.raw);for(const name of ['goOutput','torchOutput','sdpaOutput'])a[name].set(a.output);a.goProbability.set(a.probability);a.torchProbability.set(a.probability);return f;
}
export function packed(f){const result=new Float32Array(f.plan.stageCells);let offset=0;for(const name of STAGES){result.set(f.arrays[name],offset);offset+=f.arrays[name].length;}return result.buffer;}
