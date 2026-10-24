"""Finite same-ID96kbps generator alternative; profile remains unqualified until exact9."""
import importlib.util,json
from pathlib import Path
SETUP=Path('/private/tmp/aurialis-private-decoder-setup');NEW=Path('/private/tmp/aurialis-private-decoder-fixtures-06')
spec=importlib.util.spec_from_file_location('generation',SETUP/'generate-fixtures.py');g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
if NEW.exists():raise RuntimeError('Fresh finite alternative output required.')
NEW.mkdir(mode=0o700)
for name in ('logs','sources','candidates'):(NEW/name).mkdir(mode=0o700)
g.ROOT=NEW;g.events=[]
baseline_dirs=[Path('/private/tmp/aurialis-private-decoder-fixtures-0'+str(i)) for i in range(1,6)]+[Path('/private/tmp/aurialis-private-decoder-comparison-fixtures-01'),Path('/private/tmp/aurialis-private-decoder-native-results-01'),Path('/private/tmp/aurialis-private-decoder-wasm-results-01'),Path('/private/tmp/aurialis-private-decoder-wasm-results-01-supervisor')]
g.MAX_RETAINED-=sum(p.stat().st_size for d in baseline_dirs for p in d.rglob('*') if p.is_file())
matrix=json.loads(Path('/private/tmp/aurialis-private-decoder-comparison-fixtures-01/matrix.json').read_text());old=next(r for r in matrix['candidates'] if r['id']=='adts-he-1');source=old['sourceProvenance'];input_file=Path(source['wav'])
native=json.loads(Path('/private/tmp/aurialis-private-decoder-native-results-01/native-results.json').read_text());observation=next(r for r in native['cases'] if r['id']=='adts-he-1')['firstActualFrame']
if (observation['profile'],observation['channels'])!=(28,2):raise RuntimeError('Conditional root authorization is not met.')
if g.sha(input_file)!=source['wavSHA256']:raise RuntimeError('Original mono generated source changed.')
inventory=json.loads((SETUP/'existing-fixture-tools.json').read_text())
for item in inventory['paths']+inventory['libavIdentity']:
 if item.get('sha256') and g.sha(Path(item.get('resolved',item['path'])))!=item['sha256']:raise RuntimeError('Existing fixture tools changed.')
output=NEW/'candidates/adts-he-1-96kbps.aac'
args=[g.FFMPEG,'-v','error','-nostdin','-n','-threads','1','-filter_threads','1','-filter_complex_threads','1','-i',input_file,'-map','0:a:0','-map_metadata','-1','-vn','-sn','-dn','-c:a','aac_at','-sample_fmt','s16','-profile:a','4','-b:a','96k','-f','adts','-threads:a','1',output]
plan={'sameCandidateID':'adts-he-1','alternative':'96kbps;64kbps original retained, not repeated','expectedProfile':4,'expectedRate':48000,'expectedChannels':1,'sourceUnchanged':source,'oldExact9FirstFrame':observation,'command':[str(a) for a in args],'generatorSHA256':g.sha(g.FFMPEG),'supervisorSourceSHA256':g.sha(SETUP/'generate-fixtures.py'),'sourceSHA256':g.sha(Path(__file__)),'limits':'same30s/15min/512MiB total retained/6GiB reserve; no SRC/downmix/LC fallback'}
(NEW/'preregistered-he-mono.json').write_text(json.dumps(plan,indent=2)+'\n')
event=g.command(args,'encode-he-mono96-existing-generator')
result={'status':'encoder-RED-uncovered','sameCandidateID':'adts-he-1','event':event,'newNativeOrWasmDecode':False}
if event['exitCode']==0:
 if not 0<output.stat().st_size<=2*1024**2:raise RuntimeError('Generated alternative byte cap.')
 result.update({'status':'generated-unqualified','path':str(output),'bytes':output.stat().st_size,'sha256':g.sha(output),'provisionalMetadata':g.probe(output,'he-mono96'),'note':'Requested args and old-generator metadata never establish HE geometry; exact9 remains authority.'})
(NEW/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
