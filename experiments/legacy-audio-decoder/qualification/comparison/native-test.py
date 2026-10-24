"""Synthetic trace/owned-child tests only; never FFmpeg parsing or decoding."""
import importlib.util,json,os,struct,sys,tempfile,unittest
from pathlib import Path
from unittest import mock
spec=importlib.util.spec_from_file_location('batch',Path(__file__).with_name('native-batch.py'));b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
class Native(unittest.TestCase):
 def trace_case(self,directory,codec=86028,header_rate=0,frame_rate=48000,later_rate=48000):
  root=Path(directory);b.ROOT=root
  pcm=root/'out.f32le';pcm.write_bytes(struct.pack('<ff',.5,-.5));trace=root/'out.jsonl'
  records=[{'kind':'stream','codecID':codec,'headerRate':header_rate,'headerChannels':0},{'kind':'frame','index':1,'offset':0,'frames':1,'rate':frame_rate,'channels':1,'layout':'mono','profile':-99,'flags':0,'decodeErrorFlags':0},{'kind':'frame','index':2,'offset':1,'frames':1,'rate':later_rate,'channels':1,'layout':'mono','profile':-99,'flags':0,'decodeErrorFlags':0},{'kind':'complete','frames':2,'rate':frame_rate,'channels':1,'outputBytes':8}]
  trace.write_text(''.join(json.dumps(r)+'\n' for r in records))
  row={'id':'synthetic','expected':{'codecID':86028,'rate':48000,'channels':1,'profile':None,'lengthPolicy':'exact-source','sourceFrames':2,'losslessSource':None}}
  return row,pcm,trace
 def test_actual_first_frame_not_untrusted_header_establishes_geometry(self):
  with tempfile.TemporaryDirectory() as d:
   row,pcm,trace=self.trace_case(d,header_rate=0)
   self.assertEqual(b.inspect_case(row,pcm,trace)['policyErrors'],[])
 def test_wrong_codec_is_red_even_when_pcm_matches(self):
  with tempfile.TemporaryDirectory() as d:
   row,pcm,trace=self.trace_case(d,codec=86076)
   self.assertEqual(b.inspect_case(row,pcm,trace)['policyErrors'],['expected-codec-not-observed'])
 def test_later_geometry_change_fails(self):
  with tempfile.TemporaryDirectory() as d:
   row,pcm,trace=self.trace_case(d,later_rate=44100)
   with self.assertRaisesRegex(RuntimeError,'geometry'):b.inspect_case(row,pcm,trace)
 def test_closed_reference_rejects_absolute_and_parent_paths(self):
  with tempfile.TemporaryDirectory() as d:
   row,pcm,trace=self.trace_case(d)
   for name in ('/tmp/elsewhere','references/../elsewhere','references/other.f32le'):
    row['expected']['losslessSource']={'file':name,'sha256':'0'*64}
    with self.assertRaisesRegex(RuntimeError,'Closed'):b.inspect_case(row,pcm,trace)
 def test_native_monitor_exception_kills_reaps_and_preserves_primary(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d)
   with mock.patch.object(b,'usage',side_effect=PermissionError('synthetic monitor failure')):
    result=b.run_case([sys.executable,'-c','import time;time.sleep(60)'],root/'stdout',root/'stderr')
   self.assertIn('PermissionError',result['primaryFailure']);self.assertIsNone(result['cleanupError']);self.assertEqual(result['exitCode'],-9)
   with self.assertRaises(ProcessLookupError):os.killpg(result['pid'],0)
if __name__=='__main__':unittest.main()
