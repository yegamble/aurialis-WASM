"""Synthetic non-audio child: monitor failure must kill/reap the owned process."""
import importlib.util,json,os,sys,tempfile,unittest
from pathlib import Path
from unittest import mock
spec=importlib.util.spec_from_file_location('generation','/private/tmp/aurialis-private-decoder-setup/generate-fixtures.py')
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
class Supervisor(unittest.TestCase):
 def test_monitor_exception_preserves_primary_and_reaps_child(self):
  with tempfile.TemporaryDirectory(prefix='aurialis-generator-supervisor-') as directory:
   g.ROOT=Path(directory);(g.ROOT/'logs').mkdir();g.events=[]
   with mock.patch.object(g.subprocess,'run',side_effect=PermissionError('synthetic ps monitor denial')):
    with self.assertRaisesRegex(PermissionError,'synthetic ps monitor denial'):
     g.command([sys.executable,'-c','import time;time.sleep(60)'],'monitor-denial')
   event=json.loads((g.ROOT/'commands.json').read_text())[0]
   self.assertIn('PermissionError',event['primaryFailure']);self.assertIsNone(event['cleanupError']);self.assertEqual(event['exitCode'],-9)
   with self.assertRaises(ProcessLookupError):os.killpg(event['pid'],0)
if __name__=='__main__':unittest.main()
