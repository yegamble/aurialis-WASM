"""Private generated-fixture oracle runner; only runs inside reviewed offline container."""
import hashlib,json,math,os,resource,signal,struct,subprocess,time
from pathlib import Path
ROOT=Path('/fixtures');OUT=Path('/output');ORACLE=Path('/oracle/native-oracle')
START=time.monotonic();MAX_FRAMES=384001;OUTPUT_MAX=192*1024**2;events=[]
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def regular(path,maximum):
 if path.is_symlink() or not path.is_file() or not 0<path.stat().st_size<=maximum:raise RuntimeError('Invalid bounded regular file: '+str(path))
def safe(value):
 import re
 if not isinstance(value,str) or not re.fullmatch(r'[a-z0-9-]{1,64}',value):raise RuntimeError('Unsafe fixture identifier.')
 return value
def limits():
 resource.setrlimit(resource.RLIMIT_CPU,(30,30));resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_FSIZE,(16*1024**2,16*1024**2))
def usage():return sum(p.stat().st_size for p in OUT.rglob('*') if p.is_file())
def inspect_case(row,pcm,trace):
 regular(trace,8*1024**2);lines=trace.read_text().splitlines()
 if len(lines)>32772:raise RuntimeError('Trace object bound exceeded.')
 records=[json.loads(line) for line in lines]
 streams=[x for x in records if x.get('kind')=='stream'];frames=[x for x in records if x.get('kind')=='frame'];ends=[x for x in records if x.get('kind')=='complete']
 if len(streams)!=1 or not frames or len(ends)!=1 or records[-1]!=ends[0] or any(x.get('kind')=='failure' for x in records):raise RuntimeError('Missing complete native trace.')
 first=frames[0];rate=first['rate'];channels=first['channels'];layout=first['layout'];profile=first['profile'];total=0
 if not isinstance(rate,int) or not 8000<=rate<=192000 or channels not in (1,2):raise RuntimeError('Invalid first actual frame geometry.')
 for index,frame in enumerate(frames,1):
  if frame['index']!=index or frame['offset']!=total or not isinstance(frame['frames'],int) or frame['frames']<1 or frame['frames']>MAX_FRAMES-total or (frame['rate'],frame['channels'],frame['layout'])!=(rate,channels,layout) or frame['flags']&1 or frame['decodeErrorFlags']:raise RuntimeError('Native frame trace geometry/error mismatch.')
  total+=frame['frames']
 end=ends[0]
 if (end['frames'],end['rate'],end['channels'],end['outputBytes'])!=(total,rate,channels,total*channels*4):raise RuntimeError('Native actual-frame totals mismatch.')
 regular(pcm,MAX_FRAMES*8)
 data=pcm.read_bytes()
 if len(data)!=total*channels*4 or any(not math.isfinite(v[0]) for v in struct.iter_unpack('<f',data)):raise RuntimeError('Native PCM size/finite mismatch.')
 expected=row['expected'];policy_errors=[]
 if streams[0]['codecID']!=expected['codecID']:policy_errors.append('expected-codec-not-observed')
 if (rate,channels)!=(expected['rate'],expected['channels']):policy_errors.append('expected-geometry-not-observed')
 if expected['profile'] is not None and (profile!=expected['profile'] or any(f['profile']!=expected['profile'] for f in frames)):policy_errors.append('expected-profile-not-observed')
 if expected['lengthPolicy']=='exact-source' and total!=expected['sourceFrames']:policy_errors.append('exact-source-length-not-observed')
 source_check=None
 if expected['losslessSource']:
  
  if expected['losslessSource']['file']!='references/'+row['id']+'.f32le':raise RuntimeError('Closed source reference path required.')
  reference=ROOT/expected['losslessSource']['file'];regular(reference,MAX_FRAMES*8)
  if sha(reference)!=expected['losslessSource']['sha256']:raise RuntimeError('Source reference changed.')
  source_check={'rule':'bit-exact independent integer-to-binary32 expectation','pass':data==reference.read_bytes()}
  if not source_check['pass']:policy_errors.append('lossless-source-pcm-mismatch')
 return {'firstActualFrame':first,'complete':end,'stream':streams[0],'packetSkipDiscard':[{'index':x['index'],'skip':x['skip'],'discard':x['discard']} for x in records if x.get('kind')=='packet' and (x['skip'] or x['discard'])],
         'pcm':{'file':pcm.name,'bytes':len(data),'sha256':sha(pcm)},'trace':{'file':trace.name,'bytes':trace.stat().st_size,'sha256':sha(trace)},'policyErrors':policy_errors,'losslessSource':source_check}
def run_case(args,stdout,stderr):
 begin=time.monotonic();guard=None;proc=None;primary=None;cleanup=None
 try:
  with stdout.open('xb') as out,stderr.open('xb') as err:
   proc=subprocess.Popen(args,stdout=out,stderr=err,start_new_session=True,preexec_fn=limits)
   while proc.poll() is None:
    if time.monotonic()-begin>30:guard='case-wall'
    elif stdout.stat().st_size+stderr.stat().st_size>256*1024:guard='case-log-bytes'
    elif usage()>OUTPUT_MAX or time.monotonic()-START>900:guard='suite-resource'
    if guard:os.killpg(proc.pid,signal.SIGKILL);break
    time.sleep(.025)
   proc.wait(timeout=5)
 except BaseException as error:primary=type(error).__name__+': '+str(error);guard=guard or 'supervisor-error'
 finally:
  if proc is not None:
   try:
    if proc.poll() is None:os.killpg(proc.pid,signal.SIGKILL)
    proc.wait(timeout=5)
   except BaseException as error:cleanup=type(error).__name__+': '+str(error)
 return {'args':args,'pid':proc.pid if proc else None,'exitCode':proc.returncode if proc else None,'guardFailure':guard,'primaryFailure':primary,'cleanupError':cleanup,'elapsedSeconds':round(time.monotonic()-begin,3),'status':'red'}
def main():
 manifest=ROOT/'matrix.json';regular(manifest,256*1024)
 matrix=json.loads(manifest.read_text())
 if matrix['schema']!='aurialis-private-decoder-matrix-v1' or len(matrix['candidates'])!=24 or len({r['id'] for r in matrix['candidates']})!=24:raise RuntimeError('Wrong frozen matrix.')
 regular(ORACLE,2*1024**2)
 if sha(ORACLE)!=matrix['native']['sha256']:raise RuntimeError('Native oracle changed.')
 for row in matrix['candidates']:
  identity=safe(row['id'])
  import re
  if not re.fullmatch(r'inputs/'+identity+r'\.(mp3|flac|ogg|aac|m4a)',row['file']):raise RuntimeError('Closed source path required.')
  source=ROOT/row['file'];regular(source,2*1024**2)
  if source.stat().st_size!=row['bytes'] or sha(source)!=row['sha256']:raise RuntimeError('Fixture changed before decode.')
  if time.monotonic()-START>900 or usage()>OUTPUT_MAX:raise RuntimeError('Native suite resource guard.')
  pcm=OUT/(identity+'.f32le');trace=OUT/(identity+'.jsonl');stdout=OUT/(identity+'.stdout');stderr=OUT/(identity+'.stderr')
  if any(x.exists() for x in (pcm,trace,stdout,stderr)):raise RuntimeError('Fresh case outputs required.')
  args=[str(ORACLE),row['format'],str(source),str(pcm),str(trace)]
  event={'id':identity,'coverage':row['coverage'],**run_case(args,stdout,stderr)}
  guard=event['guardFailure'] or event['cleanupError']
  if not guard and event['exitCode']==0:
   try:
    event.update(inspect_case(row,pcm,trace));event['status']='pass' if not event['policyErrors'] and row['coverage']=='positive' else 'diagnostic-uncovered' if row['coverage']=='diagnostic' else 'red'
   except Exception as error:event['validationError']=str(error)
  elif pcm.exists():event['failureRetainedPCM']=True
  if sha(source)!=row['sha256']:raise RuntimeError('Fixture changed after decode.')
  events.append(event);(OUT/'native-results.json').write_text(json.dumps({'tier':'exact-native9-generated-fixture-oracle','matrixSHA256':sha(manifest),'oracleSHA256':sha(ORACLE),'cases':events,'actualParsing':True,'distributionApproved':False},indent=2)+'\n')
  if guard:raise RuntimeError('Native case guard failure retained.')
 result={'tier':'exact-native9-generated-fixture-oracle','matrixSHA256':sha(manifest),'oracleSHA256':sha(ORACLE),'cases':events,'actualParsing':True,'distributionApproved':False,'elapsedSeconds':round(time.monotonic()-START,3),'status':'pass' if all(x['status']=='pass' for x in events if x['coverage']=='positive') else 'red','uncovered':[x['id'] for x in events if x['coverage']=='diagnostic']}
 (OUT/'native-results.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'cases':len(events),'uncovered':result['uncovered']}))
 return 0 if result['status']=='pass' else 1
if __name__=='__main__':raise SystemExit(main())
