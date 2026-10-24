"""Preserve fixture01 REDs; retry only AAC profile-alias errors with header integers."""
import importlib.util
import json
from pathlib import Path
import re
import time

SETUP=Path('/private/tmp/aurialis-private-decoder-setup')
OLD=Path('/private/tmp/aurialis-private-decoder-fixtures-01')
NEW=Path('/private/tmp/aurialis-private-decoder-fixtures-02')
spec=importlib.util.spec_from_file_location('fixture_generation',SETUP/'generate-fixtures.py')
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
g.ROOT=NEW;g.started=time.monotonic();g.events=[]
if NEW.exists():raise RuntimeError('New retry output required.')
NEW.mkdir(mode=0o700)
for name in ['logs','candidates']:(NEW/name).mkdir(mode=0o700)
old_bytes=sum(p.stat().st_size for p in OLD.rglob('*') if p.is_file())
g.MAX_RETAINED-=old_bytes
headers=Path('/opt/homebrew/Cellar/ffmpeg/8.1/include/libavcodec/defs.h')
text=headers.read_text()
profiles={}
for name,macro in [('aac_low','LOW'),('aac_he','HE'),('aac_he_v2','HE_V2')]:
 profiles[name]=int(re.search(r'^#define AV_PROFILE_AAC_'+macro+r'\s+(\d+)$',text,re.MULTILINE)[1])
assert profiles=={'aac_low':1,'aac_he':4,'aac_he_v2':28}
rows=json.loads((OLD/'candidate-results.json').read_text())
changes=[]
for item in rows:
 if item.get('status')=='encoder-RED-uncovered' and item['kind'] in ['aac','aac-m4a']:
  args=item['encodeEvent']['args'].copy();old=args[args.index('-profile:a')+1]
  args[args.index('-profile:a')+1]=str(profiles[old]);args[-1]=str(NEW/'candidates'/Path(item['path']).name)
  changes.append({'id':item['id'],'oldAlias':old,'numericProfile':profiles[old],'args':args,'sourceSHA256':item['source']['wavSHA256']})
if len(changes)!=8:raise RuntimeError('Unexpected AAC retry selection.')
(NEW/'preregistered-retry.json').write_text(json.dumps({'reason':'aac_at does not parse symbolic AAC aliases; no codec/profile tolerance change',
 'sourceSuite':str(OLD),'sourceSuiteResultSHA256':g.sha(OLD/'result.json'),'scriptSHA256':g.sha(Path(__file__)),
 'header':str(headers),'headerSHA256':g.sha(headers),'profiles':profiles,'preservedSuccesses':15,'retry':changes},indent=2)+'\n')
provenance=json.loads((OLD/'provenance.json').read_text())
if g.sha(g.FFPROBE)!=provenance['ffprobeSHA256']:raise RuntimeError('Fixture metadata tool changed.')
expected={'aac_low':'LC','aac_he':'HE-AAC','aac_he_v2':'HE-AACv2'}
for change in changes:
 row=next(x for x in rows if x['id']==change['id']);source=Path(row['source']['wav'])
 if g.sha(source)!=change['sourceSHA256']:raise RuntimeError('Generated source changed.')
 event=g.command(change['args'],'numeric-profile-'+row['id']);row['retryEvent']=event
 if event['exitCode']!=0:row['status']='numeric-profile-encoder-RED-uncovered';continue
 row['path']=change['args'][-1];path=Path(row['path'])
 if not 0<path.stat().st_size<=2*1024*1024:raise RuntimeError('Candidate byte bound failed.')
 row.update({'bytes':path.stat().st_size,'sha256':g.sha(path),'provisionalMetadata':g.probe(path,row['id']),'status':'generated-unqualified'})
 streams=row['provisionalMetadata'].get('streams',[])
 row['provisionalProfileMatches']=len(streams)==1 and streams[0].get('profile')==expected[row['profileRequested']]
 if not row['provisionalProfileMatches']:row['status']='generated-profile-mismatch-uncovered'
base=next(x for x in rows if x['id']=='adts-lc-1');row=next(x for x in rows if x['id']=='adts-valid-shorter')
if base.get('status')=='generated-unqualified':
 event=g.command([g.FFPROBE,'-v','error','-select_streams','a:0','-show_packets','-show_entries','packet=pos,size','-of','json',base['path']],'packet-boundaries-adts-valid-shorter')
 packets=json.loads(Path(event['stdout']).read_text()).get('packets',[]) if event['exitCode']==0 else []
 if len(packets)>=4:
  packet=packets[len(packets)//2-1];end=int(packet['pos'])+int(packet['size']);original=Path(base['path']).read_bytes()
  if not 0<end<len(original):raise RuntimeError('Invalid provisional prefix boundary.')
  path=NEW/'candidates/adts-valid-shorter.aac';path.write_bytes(original[:end]);path.chmod(0o600)
  row.update({'path':str(path),'status':'generated-unqualified','bytes':len(original[:end]),'sha256':g.sha(path),
   'mutation':{'cutAtByte':end,'originalBytes':len(original),'baseSHA256':base['sha256'],'boundarySource':'existing ffprobe8.1 provisional packet metadata'},
   'provisionalMetadata':g.probe(path,row['id'])})
# Keep the observed FLAC32 encoder quantization visible before oracle testing.
for row in rows:
 if row['id']=='flac-rate-88200':
  row['generatorQuantizationObservation']='requested/input32-bit; generator metadata reports encoded24-bit; no32-bitcoded coverage claim'
  row['losslessSourceComparisonEligible']=False
(NEW/'candidate-results.json').write_text(json.dumps(rows,indent=2)+'\n')
result={'status':'generated-candidates-only','uniquePlannedIDs':len(rows),'generated':sum(x.get('status')=='generated-unqualified' for x in rows),
 'uncovered':[x['id'] for x in rows if x.get('status')!='generated-unqualified'],'combinedRetainedBytes':old_bytes+g.usage(),
 'newNativeOrWasmDecode':False,'scriptSHA256':g.sha(Path(__file__))}
(NEW/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
