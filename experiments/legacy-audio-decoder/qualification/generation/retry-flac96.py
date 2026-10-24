"""Preregister/encode same flac-2 ID at96k; no decoder or source overwrite."""
import importlib.util,json
from pathlib import Path
SETUP=Path('/private/tmp/aurialis-private-decoder-setup')
OLD=Path('/private/tmp/aurialis-private-decoder-fixtures-03')
NEW=Path('/private/tmp/aurialis-private-decoder-fixtures-04')
spec=importlib.util.spec_from_file_location('generation',SETUP/'generate-fixtures.py');g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
if NEW.exists():raise RuntimeError('Fresh generation directory required.')
NEW.mkdir(mode=0o700)
for name in ['logs','sources','candidates']:(NEW/name).mkdir(mode=0o700)
baseline=sum(p.stat().st_size for d in [Path('/private/tmp/aurialis-private-decoder-fixtures-0'+str(n)) for n in range(1,4)] for p in d.rglob('*') if p.is_file())
g.ROOT=NEW;g.events=[];g.MAX_RETAINED-=baseline
rows=json.loads((OLD/'candidate-results.json').read_text());row=next(x for x in rows if x['id']=='flac-2')
source=g.waveform(96000,2,16);output=NEW/'candidates/flac-2.flac'
inventory=json.loads((SETUP/'existing-fixture-tools.json').read_text())
for item in inventory['paths']+inventory['libavIdentity']:
 if item.get('sha256') and g.sha(Path(item.get('resolved',item['path'])))!=item['sha256']:raise RuntimeError('Existing fixture tool changed.')
args=[g.FFMPEG,'-v','error','-nostdin','-n','-threads','1','-filter_threads','1','-filter_complex_threads','1','-i',source['wav'],'-map','0:a:0','-map_metadata','-1','-vn','-sn','-dn','-c:a','flac','-sample_fmt','s16','-bits_per_raw_sample','16','-f','flac','-threads:a','1',output]
plan={'sameCandidateID':'flac-2','historicalCandidate':row,'newSelection':{'source':source,'path':str(output)},'reason':'finite matrix adds96k stereo coverage while mono base remains48k; historical48k file retained','command':[str(a) for a in args],'toolInventorySHA256':g.sha(SETUP/'existing-fixture-tools.json'),'scriptSHA256':g.sha(Path(__file__))}
(NEW/'preregistered-flac96.json').write_text(json.dumps(plan,indent=2)+'\n')
event=g.command(args,'encode-flac96-existing-generator')
if event['exitCode']!=0:raise RuntimeError('FLAC96 generation RED; preserve before any correction.')
data=output.read_bytes()
if not 42<=len(data)<=2*1024*1024 or data[:4]!=b'fLaC' or data[4]&127 or int.from_bytes(data[5:8],'big')!=34:raise RuntimeError('Unexpected STREAMINFO layout.')
packed=int.from_bytes(data[18:26],'big');info={'sampleRate':packed>>44,'channels':((packed>>41)&7)+1,'bitsPerSample':((packed>>36)&31)+1,'totalSamples':packed&((1<<36)-1)}
if info!={'sampleRate':96000,'channels':2,'bitsPerSample':16,'totalSamples':96049}:raise RuntimeError('FLAC96 STREAMINFO mismatch.')
row.update({'source':source,'path':str(output),'bytes':len(data),'sha256':g.sha(output),'streamInfo':info,'status':'generated-unqualified','historical48kCandidateRetained':True,'newEncodeEvent':event})
(NEW/'candidate-results.json').write_text(json.dumps(rows,indent=2)+'\n')
result={'status':'generated-candidates-only','uniqueCandidateIDs':len(rows),'generated':sum(x['status']=='generated-unqualified' for x in rows),'uncovered':[x['id'] for x in rows if x['status']!='generated-unqualified'],'streamInfo96':info,'combinedRetainedBytes':baseline+g.usage(),'nativeOrWasmDecode':False}
(NEW/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
