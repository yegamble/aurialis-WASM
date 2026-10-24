/** Private directed/FTZ stage enclosures. No GPU APIs or saved-reference budgets. */
import { MIN_NORMAL, subnormal, directedFloat32Interval, dotDiagnostic, validateFixture, dyadicQuantum, MIN_SUBNORMAL, expReferenceInterval, ulp32Upper } from './contract.mjs';
export const STAGES = Object.freeze(['raw', 'scaled', 'maximum', 'shifted', 'exponential', 'denominator', 'probability', 'output']);
const bits = new DataView(new ArrayBuffer(8));
const adjacent = (x, positive) => {
  if (!Number.isFinite(x)) throw new Error('Nonfinite propagated bound');
  if (x === 0) return positive ? Number.MIN_VALUE : -Number.MIN_VALUE;
  bits.setFloat64(0, x); let b = bits.getBigUint64(0); b += (x > 0) === positive ? 1n : -1n; bits.setBigUint64(0, b); return bits.getFloat64(0);
};
const down = (x) => adjacent(x, false), up = (x) => adjacent(x, true);
const mightUnderflow = ([l, h]) => l < MIN_NORMAL && h > 0 || l < 0 && h > -MIN_NORMAL;
function flushed(interval, reasons, label, quantum = -149) {
  if (quantum < -126 && mightUnderflow(interval)) { reasons.add(label); return [Math.min(0, interval[0]), Math.max(0, interval[1])]; }
  return interval;
}
const source = (x) => subnormal(x) ? [Math.min(0, x), Math.max(0, x)] : [x, x];
const round = ([l,h], reasons, label, quantum) => flushed([directedFloat32Interval(l)[0], directedFloat32Interval(h)[1]], reasons, label, quantum);
const rangeQuantum = ([l,h]) => {
  if(l===0&&h===0)return 32767;
  if(l<=0&&h>=0)return -149;
  const smallest=directedFloat32Interval(Math.min(Math.abs(l),Math.abs(h)))[0];
  bits.setFloat32(0,smallest);const exponent=(bits.getUint32(0)>>>23)&255;
  return exponent===0?-149:exponent-127-23;
};
export function expSpan(l,h) {
  if(!Number.isFinite(l)||!Number.isFinite(h)||l>h||h>MIN_NORMAL||l < -8192)throw new Error('Propagated exp argument outside proved domain');
  // exp(-4096)<2^-149; below that, use an explicit outward underflow envelope,
  // never clamp a nonzero lower reference up to another argument's value.
  const reference=x=>x < -4096?[0,MIN_SUBNORMAL]:x>0?[1,up(1)]:expReferenceInterval(x);
  const low=reference(l),high=l===h?low:reference(h),error=up((4+2*Math.max(Math.abs(l),Math.abs(h)))*ulp32Upper(high[1]));
  const limited=low[0]<MIN_NORMAL&&high[1]>0||subnormal(l)||subnormal(h);
  return {lower:limited?0:Math.max(0,down(low[0]-error)),upper:up(high[1]+error),underflowLimited:limited};
}
export function probabilitySpan(nl,nh,dl,dh) {
  if(![nl,nh,dl,dh].every(Number.isFinite)||nl<0||nl>nh||dl<MIN_NORMAL||dl>dh||dh>2**126)throw new Error('Propagated division domain');
  const low=nl===0?0:down(nl/dh),high=up(nh/dl),error=up(2.5*ulp32Upper(high));
  const limited=mightUnderflow([nl,nh])||mightUnderflow([low,high]);
  return {lower:limited?0:Math.max(0,down(low-error)),upper:up(high+error),underflowLimited:limited};
}
const contains = (x, [l,h], label) => { if (!Number.isFinite(x) || x < l || x > h) throw new Error('Attention ' + label + ' outside independent enclosure'); };
function dot(left, right, count, leftOffset, rightOffset, rightStride, intervals, reasons) {
  let lower = 0, upper = 0, absolute = 0, quantum = 32767;
  // One term traversal obtains compensated diagnostics AND uncertain input sums.
  // Extra corner arithmetic does not mean a second admitted product traversal.
  const diagnostic = dotDiagnostic(left, right, count, leftOffset, rightOffset, rightStride, (a,b,_,i) => {
    const al=intervals?intervals[2*i]:subnormal(a)?Math.min(0,a):a, ah=intervals?intervals[2*i+1]:subnormal(a)?Math.max(0,a):a;
    const bl=subnormal(b)?Math.min(0,b):b,bh=subnormal(b)?Math.max(0,b):b;
    const zero=(al===0&&ah===0)||b===0;
    const termLow=zero?0:down(Math.min(al*bl,al*bh,ah*bl,ah*bh)),termHigh=zero?0:up(Math.max(al*bl,al*bh,ah*bl,ah*bh));
    if(!zero)quantum=Math.min(quantum,(intervals?rangeQuantum([al,ah]):dyadicQuantum(a))+dyadicQuantum(b));
    lower=termLow===0?lower:down(lower+termLow);upper=termHigh===0?upper:up(upper+termHigh);
    if(!zero)absolute=up(absolute+Math.max(Math.abs(termLow),Math.abs(termHigh)));
  });
  const limited = diagnostic.underflowLimited || quantum < -126;
  if (limited) reasons.add('dot-intermediate-underflow');
  const u = 2**-23, gamma = 2*count*u/(1-2*count*u);
  // All possible intermediate FTZ losses (including fused/reassociated sums)
  // receive an absolute floor. This never grants ordinary applicability.
  const error = absolute === 0 ? 0 : up(gamma*absolute + diagnostic.referenceError + (limited ? 35*count*MIN_NORMAL : 0));
  const propagated = absolute === 0 ? [0,0] : flushed([down(lower-error), up(upper+error)], reasons, 'propagated-dot-underflow', quantum);
  const localError = diagnostic.underflowLimited ? diagnostic.ftzError : diagnostic.arithmeticError;
  return { propagated, quantum, local: [down(diagnostic.value-localError),up(diagnostic.value+localError)], diagnostic };
}
export function resultLayout(plan, buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== plan.stageBytes) throw new Error('Attention result geometry changed');
  let offset = 0; const arrays = {};
  for (const name of STAGES) { const count = name === 'maximum' || name === 'denominator' ? plan.m : name === 'output' ? plan.output : plan.cells; arrays[name] = new Float32Array(buffer,offset,count); offset += count*4; }
  if (offset !== buffer.byteLength) throw new Error('Attention stage layout invariant');
  for (const values of Object.values(arrays)) for (const value of values) if (!Number.isFinite(value)) throw new Error('Nonfinite/unwritten attention stage');
  return arrays;
}
export function analyzeStages(fixture, result) {
  validateFixture(fixture);
  const p = fixture.plan, a = fixture.arrays, observed = resultLayout(p, result), reasons = new Set();
  for (const name of ['q','k','v']) if (a[name].some(subnormal)) reasons.add('source-underflow');
  const bounds = Object.fromEntries(STAGES.map(name => [name, new Float64Array(observed[name].length*2)]));
  const grids = Object.fromEntries(STAGES.map(name => [name,new Int16Array(observed[name].length)]));
  const write = (name,index,value,quantum=rangeQuantum(value)) => { grids[name][index]=quantum; if(observed[name][index]!==0 && dyadicQuantum(observed[name][index])<quantum)throw new Error('Attention '+name+' dyadic grid changed'); bounds[name].set(value,2*index); contains(observed[name][index],value,name+' propagated'); };
  const read = (name,index) => [bounds[name][2*index],bounds[name][2*index+1]];
  let termVisits = 0, maximumOutputIntervalWidth = 0;
  for (let row=0;row<p.m;row++) {
    let maxLow=-Infinity,maxHigh=-Infinity,localMaximumLow=-Infinity,localMaximumHigh=-Infinity,maxQuantum=32767;
    for (let column=0;column<p.n;column++) {
      const i=row*p.n+column, d=dot(a.q,a.k,64,row*64,column*64,1,null,reasons); termVisits+=64;
      for (const reference of ['goRaw','torchRaw']) contains(a[reference][i],d.local,reference);
      contains(observed.raw[i],d.local,'raw local'); write('raw',i,d.propagated,d.quantum);
      const raw=flushed(d.propagated,reasons,'raw-input-underflow',d.quantum);
      const scaleQuantum=d.quantum===32767?32767:d.quantum-3;
      const scale=raw[0]===0&&raw[1]===0?[0,0]:round([down(raw[0]*.125),up(raw[1]*.125)],reasons,'scaled-underflow',scaleQuantum); write('scaled',i,scale,scaleQuantum);maxQuantum=Math.min(maxQuantum,scaleQuantum);
      const actual=source(observed.raw[i]), local=round([actual[0]*.125,actual[1]*.125],reasons,'local-scale-underflow'); contains(observed.scaled[i],local,'scale local');
      maxLow=Math.max(maxLow,scale[0]);maxHigh=Math.max(maxHigh,scale[1]);
      const actualScale=source(observed.scaled[i]);localMaximumLow=Math.max(localMaximumLow,actualScale[0]);localMaximumHigh=Math.max(localMaximumHigh,actualScale[1]);
    }
    write('maximum',row,[maxLow,maxHigh],maxQuantum);contains(observed.maximum[row],[localMaximumLow,localMaximumHigh],'maximum local');
    let sumLow=0,sumHigh=0,localSumLow=0,localSumHigh=0;
    for (let column=0;column<p.n;column++) {
      const i=row*p.n+column, quantum=Math.min(grids.scaled[i],maxQuantum), scaled=flushed(read('scaled',i),reasons,'shift-input-underflow',grids.scaled[i]), maximum=flushed(read('maximum',row),reasons,'maximum-input-underflow',maxQuantum);
      const shifted=quantum===32767?[0,0]:round([down(scaled[0]-maximum[1]),Math.min(quantum>=-126?0:MIN_NORMAL,up(scaled[1]-maximum[0]))],reasons,'shift-underflow',quantum);write('shifted',i,shifted,quantum);
      const s=source(observed.scaled[i]),m=source(observed.maximum[row]);contains(observed.shifted[i],round([down(s[0]-m[1]),up(s[1]-m[0])],reasons,'local-shift-underflow',Math.min(dyadicQuantum(observed.scaled[i]),dyadicQuantum(observed.maximum[row]))),'shift local');
      const exponentInput=flushed(shifted,reasons,'exp-input-underflow',quantum);
      const propagatedExp=expSpan(exponentInput[0],exponentInput[1]);
      if (propagatedExp.underflowLimited) reasons.add('propagated-exponential-underflow');
      const exponential=flushed([propagatedExp.lower,propagatedExp.upper],reasons,'propagated-exponential-underflow');write('exponential',i,exponential);
      const local=expSpan(observed.shifted[i],observed.shifted[i]);contains(observed.exponential[i],[local.lower,local.upper],'exponential local');if(local.underflowLimited)reasons.add('local-exponential-underflow');
      sumLow=down(sumLow+exponential[0]);sumHigh=up(sumHigh+exponential[1]);
      const e=source(observed.exponential[i]);localSumLow=down(localSumLow+e[0]);localSumHigh=up(localSumHigh+e[1]);
    }
    const gamma=2*p.n*2**-23/(1-2*p.n*2**-23), floor=p.n*MIN_NORMAL;
    // A stored maximum is one of the input scores; absent FTZ the matching
    // shifted value is exactly zero. FTZ can change it by at most2*MIN_NORMAL,
    // whose exp remains>1/2. Thus every true positive sum is normal (>1/2).
    const positiveSum=(l,h)=>[Math.max(.5,down(l-up(gamma*h+floor))),up(h+up(gamma*h+floor))];
    const denominator=positiveSum(sumLow,sumHigh);write('denominator',row,denominator);contains(observed.denominator[row],positiveSum(localSumLow,localSumHigh),'denominator local');
    for (let column=0;column<p.n;column++) {
      const i=row*p.n+column, e=read('exponential',i), d=read('denominator',row), propagatedProbability=probabilitySpan(e[0],e[1],d[0],d[1]);
      if(propagatedProbability.underflowLimited || mightUnderflow(e))reasons.add('propagated-probability-underflow');
      const probability=flushed([propagatedProbability.lower,propagatedProbability.upper],reasons,'propagated-probability-underflow');write('probability',i,probability);
      const local=probabilitySpan(observed.exponential[i],observed.exponential[i],observed.denominator[row],observed.denominator[row]);contains(observed.probability[i],[local.lower,local.upper],'probability local');if(local.underflowLimited)reasons.add('local-probability-underflow');
    }
    const probabilityBounds=bounds.probability.subarray(2*row*p.n,2*(row+1)*p.n);
    for (let column=0;column<64;column++) {
      const d=dot(observed.probability,a.v,p.n,row*p.n,column,64,probabilityBounds,reasons);termVisits+=p.n;
      contains(observed.output[row*64+column],d.local,'PV local');write('output',row*64+column,d.propagated);maximumOutputIntervalWidth=Math.max(maximumOutputIntervalWidth,d.propagated[1]-d.propagated[0]);
    }
  }
  if(termVisits!==2*p.m*p.n*64 || termVisits>p.referenceWork)throw new Error('Attention reference traversal admission changed');
  return Object.freeze({ classification:reasons.size?'underflow-limited':'ordinary-input-diagnostic', reasons:[...reasons], bounds, grids,
    termVisits, referenceCoarseUnits:p.referenceWork, validationFloatVisits:p.fixtureCells+p.stageCells+p.inputs, additionalArithmetic:'per term: compensated sums, interval corners and absolute-sum accumulation; per score: up to three18-term exp enclosures; these are NOT machine-instruction units',
    maximumOutputIntervalWidth, savedEndpoints:'native Go float64 denominator, actual original math, actual CPU SDPA and unfused probe are distinct diagnostics; none supplies a tolerance',
    scope:'directed/FTZ stage and propagated source enclosure; CPU/source only until actual hardware review' });
}
