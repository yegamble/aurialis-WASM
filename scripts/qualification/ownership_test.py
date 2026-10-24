"""Synthetic detached Python children only; no browser/codec runs."""
import json,os,secrets,signal,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from unittest import mock
from owned_groups import OwnedGroups,RefusedMembership,snapshot
CHILD='import time;time.sleep(60)'
class Ownership(unittest.TestCase):
 def virtual(self):
  leader={'pid':10,'ppid':2,'pgid':10,'start':'exact leader','rssBytes':10,'state':'S','commandSHA256':'same-command'}
  owned=OwnedGroups.__new__(OwnedGroups);owned.node_pid=10;owned.token='known';owned.leaders={'node':leader};owned.known={10:leader};owned.events=[];owned.admissions=[]
  return owned,leader
 def test_live_exact_leader_admits_reparented_group_member(self):
  owned,leader=self.virtual();orphan={'pid':11,'ppid':1,'pgid':10,'start':'new sibling orphan','rssBytes':20,'state':'S'}
  with mock.patch('owned_groups.command_hash',return_value='same-command'):
   result=owned.observe({10:leader,11:orphan})
  self.assertEqual(result['rssBytes'],30);self.assertEqual(result['newAdmissions'][0]['ground'],'live-exact-admitted-group-leader')
 def test_known_live_anchor_preserves_continuity_after_leader_exit(self):
  owned,_leader=self.virtual();anchor={'pid':11,'ppid':1,'pgid':10,'start':'known exact child','rssBytes':20,'state':'S'};owned.known[11]=anchor
  new={'pid':12,'ppid':1,'pgid':10,'start':'new member','rssBytes':30,'state':'S'};result=owned.observe({11:anchor,12:new})
  self.assertEqual(result['rssBytes'],50);self.assertEqual(result['newAdmissions'][0]['ground'],'known-live-exact-member-continuity')
 def test_no_live_anchor_refuses_unseen_orphan_with_details_and_no_signal(self):
  owned,_leader=self.virtual();orphan={'pid':12,'ppid':1,'pgid':10,'start':'unseen orphan','rssBytes':30,'state':'S'}
  with mock.patch('owned_groups.snapshot',return_value={12:orphan}),mock.patch('owned_groups.os.killpg') as kill:
   with self.assertRaises(RefusedMembership) as result:owned.cleanup()
   self.assertEqual(result.exception.details['refusedRows'],[orphan]);kill.assert_not_called()
 def make(self,root):
  path=root/'candidate.json';token=secrets.token_hex(16)
  code="import json,os,pathlib,subprocess,sys,time;p=subprocess.Popen([sys.executable,'-c',"+repr(CHILD)+"],start_new_session=True);pathlib.Path(sys.argv[1]).write_text(json.dumps({'nodePID':os.getpid(),'browserPID':p.pid,'token':sys.argv[2]}));time.sleep(60)"
  node=subprocess.Popen([sys.executable,'-c',code,str(path),token],start_new_session=True)
  owned=OwnedGroups(node.pid,os.getpid(),token)
  until=time.monotonic()+3
  while not path.exists():
   if time.monotonic()>until:raise RuntimeError('Synthetic child handshake timeout.')
   time.sleep(.01)
  candidate=json.loads(path.read_text());owned.admit_browser(candidate)
  return node,owned,candidate
 def test_detached_child_survives_node_crash_then_both_groups_clean(self):
  with tempfile.TemporaryDirectory() as d:
   node,owned,candidate=self.make(Path(d))
   try:
    before=owned.observe();self.assertEqual(len(before['groups']),2);self.assertEqual(len({r['pid'] for r in before['members']}),len(before['members']))
    os.killpg(node.pid,signal.SIGKILL);node.wait(timeout=3)
    live=snapshot()[candidate['browserPID']];self.assertNotEqual(live['ppid'],node.pid)
    self.assertIn(candidate['browserPID'],[r['pid'] for r in owned.observe()['liveMembers']])
    self.assertEqual(owned.cleanup()['liveMembers'],[])
   finally:
    owned.cleanup();node.wait(timeout=3)
 def test_monitor_exception_keeps_primary_and_stops_both_owned_groups(self):
  with tempfile.TemporaryDirectory() as d:
   node,owned,_candidate=self.make(Path(d));primary=None;cleanup=None
   try:
    try:raise PermissionError('synthetic monitor denial')
    except PermissionError as error:primary=str(error)
    finally:
     try:owned.cleanup()
     except Exception as error:cleanup=str(error)
    self.assertEqual(primary,'synthetic monitor denial');self.assertIsNone(cleanup);self.assertEqual(owned.observe()['liveMembers'],[])
   finally:owned.cleanup();node.wait(timeout=3)
 def test_token_and_changed_identity_never_authorize_signals(self):
  with tempfile.TemporaryDirectory() as d:
   node,owned,candidate=self.make(Path(d))
   try:
    with self.assertRaisesRegex(RuntimeError,'token'):owned.admit_browser({**candidate,'token':'unowned'})
    observed=snapshot();expected=owned.leaders['browser'];observed[expected['pid']]={**observed[expected['pid']],'start':'different start identity'}
    with mock.patch('owned_groups.snapshot',return_value=observed),mock.patch('owned_groups.os.killpg') as kill:
     with self.assertRaisesRegex(RuntimeError,'identity changed'):owned.cleanup()
     kill.assert_not_called()
   finally:owned.cleanup();node.wait(timeout=3)
if __name__=='__main__':unittest.main()
