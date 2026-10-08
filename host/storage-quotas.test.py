"""Portable logic tests. Kernel enforcement is verified by quota-smoke.py on Linux."""
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import types
import unittest
import stat
from unittest.mock import patch

if sys.platform == 'win32':
    sys.modules['fcntl'] = types.SimpleNamespace(ioctl=lambda *_: None)


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


bridge = module('bridge', 'storage-quotas.py')
prepare = module('prepare', 'prepare-storage.py')


class Tests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='minipass-quota-host-test-'))
        self.apps = self.root / 'apps'
        self.apps.mkdir()
        (self.apps / '.trash').mkdir()
        self.mount = {'source': '/dev/test', 'target': '/', 'fstype': 'ext4', 'options': 'rw,prjquota'}
        self.blocks, self.projects = {}, {}
        self.stack = []
        if not hasattr(bridge.os, 'O_NOFOLLOW'):
            p = patch.object(bridge.os, 'O_NOFOLLOW', 0, create=True)
            p.start()
            self.stack.append(p)
        for key, value in {'APPS': self.apps, 'DATA': self.root, 'STATE': self.root / 'state.json', 'RESERVE': 100}.items():
            p = patch.object(bridge, key, value)
            p.start()
            self.stack.append(p)
        for key, value in {'quota': self.quota, 'project': self.project}.items():
            p = patch.object(bridge, key, side_effect=value)
            p.start()
            self.stack.append(p)
        stat = types.SimpleNamespace(f_bavail=1000000000, f_frsize=1)
        p = patch.object(bridge.os, 'statvfs', return_value=stat, create=True)
        p.start()
        self.stack.append(p)
        p = patch.object(bridge.os, 'sync', create=True)
        p.start()
        self.stack.append(p)

    def tearDown(self):
        for p in reversed(self.stack):
            p.stop()
        shutil.rmtree(self.root)

    def quota(self, device, number, limit=None):
        self.assertEqual(device, '/dev/test')
        block = self.blocks.setdefault(number, bridge.Dqblk())
        if limit is not None:
            block.bhard = (limit + 1023) // 1024
        return block

    def project(self, path, number=None):
        key = str(path)
        if number is not None:
            self.projects[key] = number
        return self.projects.get(key, 0)

    def test_allocate_capacity_and_retry(self):
        state = bridge.load()
        self.blocks[100000] = bridge.Dqblk()
        self.blocks[100000].space = 123  # unrelated administrator-owned project
        item = bridge.allocate('demo', 500000000, state, self.mount)
        self.assertEqual(item['projectId'], 100001)
        self.assertTrue(item['enforced'])
        self.assertEqual(bridge.capacity(state, '/dev/test'), 499999900)
        with self.assertRaisesRegex(bridge.QuotaError, 'Not enough'):
            bridge.allocate('too-big', 500000000, state, self.mount)
        self.assertEqual(bridge.allocate('demo', 500000000, bridge.load(), self.mount), item)
        with self.assertRaisesRegex(bridge.QuotaError, 'different allowance'):
            bridge.allocate('demo', 600000000, state, self.mount)
        self.blocks[100001].space = 10000000
        self.assertEqual(bridge.usage('demo', state, self.mount)['remainingBytes'], 490000000)
        self.blocks[100001].bhard = 0
        self.assertFalse(bridge.usage('demo', state, self.mount)['enforced'])

    def test_legacy_refusal_and_keys(self):
        state = bridge.load()
        directory = self.apps / 'legacy'
        directory.mkdir()
        (directory / 'docker-compose.yml').write_text('do not change')
        with self.assertRaisesRegex(bridge.QuotaError, 'Existing site data'):
            bridge.allocate('legacy', 100000000, state, self.mount)
        self.assertEqual((directory / 'docker-compose.yml').read_text(), 'do not change')
        directory = self.apps / 'keys'
        directory.mkdir()
        (directory / 'deploy-key').write_text('existing key')
        item = bridge.allocate('keys', 100000000, state, self.mount)
        self.assertEqual(self.projects[str(directory / 'deploy-key')], item['projectId'])
        self.assertEqual((directory / 'deploy-key').read_text(), 'existing key')

    def test_release_waits_for_trash_and_open_files(self):
        state = bridge.load()
        item = bridge.allocate('demo', 100000000, state, self.mount)
        directory = self.apps / 'demo'
        with self.assertRaisesRegex(bridge.QuotaError, 'still exist'):
            bridge.release('demo', state, self.mount)
        destination = self.apps / '.trash/demo'
        directory.rename(destination)
        with self.assertRaisesRegex(bridge.QuotaError, 'still exist'):
            bridge.release('demo', state, self.mount)
        destination.rmdir()
        (self.apps / '.trash/demonstration').mkdir()
        self.blocks[item['projectId']].space = 1
        with self.assertRaisesRegex(bridge.QuotaError, 'open files'):
            bridge.release('demo', state, self.mount)
        self.blocks[item['projectId']].space = 0
        self.assertTrue(bridge.release('demo', state, self.mount)['released'])
        self.assertEqual(bridge.load()['sites'], {})

    def test_mount_fail_closed_and_traversal(self):
        for name in ('../escape', 'minipass', '-bad', 'A'):
            with self.assertRaises(bridge.QuotaError):
                bridge.valid_site(name)
        with patch.object(bridge.subprocess, 'check_output', return_value=json.dumps({'filesystems': [{**self.mount, 'options': 'rw,relatime'}]}).encode()):
            with self.assertRaisesRegex(bridge.QuotaError, 'not active'):
                bridge.mount_info()
        with patch.object(bridge.subprocess, 'check_output', return_value=json.dumps({'filesystems': [self.mount]}).encode()):
            self.assertEqual(bridge.mount_info(), self.mount)

    def test_corrupt_state_cannot_target_system_project_zero(self):
        bridge.STATE.write_text(json.dumps({'sites': {'demo': {'projectId': 0, 'limitBytes': 100000000, 'assigned': True}}, 'nextProject': 100001}))
        with self.assertRaisesRegex(bridge.QuotaError, 'state is invalid'):
            bridge.load()

    def test_fstab_idempotent_and_preserves_other_mounts(self):
        text = '# keep\nUUID=root / ext4 defaults,errors=remount-ro 0 1 # root\nUUID=boot /boot ext4 defaults 0 2\n'
        updated, changed = prepare.fstab_with_quota(text, '/')
        self.assertTrue(changed)
        self.assertIn('defaults,errors=remount-ro,prjquota 0 1 # root', updated)
        self.assertIn('UUID=boot /boot ext4 defaults 0 2', updated)
        self.assertEqual(prepare.fstab_with_quota(updated, '/'), (updated, False))

    def test_installer_does_not_modify_mounted_feature_flags(self):
        def fake_run(args):
            if args[0] == 'findmnt':
                return json.dumps({'filesystems': [{**self.mount, 'target': '/', 'options': 'rw'}]})
            if args[0] == 'tune2fs':
                return 'Filesystem features: has_journal extent\n'
            if args[0] == 'vgs':
                return ''
            if args[0] == 'pvs':
                return ''
            if args[0] == 'lsblk':
                return json.dumps({'blockdevices': []})
            raise AssertionError('unexpected host command: ' + ' '.join(args))
        with patch.object(prepare, 'run', side_effect=fake_run) as run:
            item = prepare.setup(str(self.apps), str(self.root))
            self.assertFalse(item['ready'])
            self.assertIn('unallocated', item['message'])
            self.assertIn('unenforced', item['message'])
            self.assertFalse(any('-O' in call.args[0] for call in run.call_args_list))

    def test_provision_source_prefers_vg_free_then_spares(self):
        self.assertEqual(prepare.choose_source({'ubuntu-vg': 60000000000}, ['/dev/sdb']), ('vg', 'ubuntu-vg'))
        self.assertEqual(prepare.choose_source({}, ['/dev/sdb']), ('device', '/dev/sdb'))
        self.assertEqual(prepare.choose_source({'ubuntu-vg': 1000}, []), (None, None))

    def test_fstab_mount_entry_idempotent(self):
        text = 'UUID=root / ext4 defaults 0 1\n'
        updated, changed = prepare.fstab_set_mount(text, 'UUID=abc', '/srv/apps')
        self.assertTrue(changed)
        self.assertIn('UUID=abc /srv/apps ext4 defaults,prjquota 0 2', updated)
        self.assertEqual(prepare.fstab_set_mount(updated, 'UUID=abc', '/srv/apps'), (updated, False))
        replaced, changed = prepare.fstab_set_mount(updated, 'UUID=xyz', '/srv/apps')
        self.assertTrue(changed)
        self.assertIn('UUID=xyz /srv/apps', replaced)
        self.assertNotIn('UUID=abc /srv/apps', replaced)

    def test_unused_devices_skips_mounted_and_pv(self):
        listing = {'blockdevices': [
            {'name': 'sda', 'type': 'disk', 'fstype': None, 'mountpoint': None, 'size': 100000000000, 'children': [
                {'name': 'sda1', 'type': 'part', 'fstype': 'ext4', 'mountpoint': '/', 'size': 50000000000},
                {'name': 'sda2', 'type': 'part', 'fstype': None, 'mountpoint': None, 'size': 50000000000}]},
            {'name': 'sdb', 'type': 'disk', 'fstype': None, 'mountpoint': None, 'size': 20000000000, 'children': []}]}
        with patch.object(prepare, 'run', side_effect=[json.dumps(listing), '  /dev/sda1 ubuntu-vg\n']):
            spares = prepare.unused_devices()
        self.assertEqual(spares, ['/dev/sda2', '/dev/sdb'])

    def test_migration_gate_blocks_running_containers(self):
        (self.apps / 'site').mkdir()
        (self.apps / 'site' / 'code').mkdir()
        with patch.object(prepare.subprocess, 'check_output', return_value='abc123\n'):
            allowed, reason = prepare.migration_allowed(str(self.apps))
        self.assertFalse(allowed)
        self.assertIn('Stop', reason)

    def test_offline_setup_refuses_mounted_devices_before_commands(self):
        device = types.SimpleNamespace(st_mode=stat.S_IFBLK, st_rdev=2051)
        with patch.object(prepare.os, 'stat', return_value=device), patch.object(prepare.os, 'major', return_value=8, create=True), patch.object(prepare.os, 'minor', return_value=3, create=True), patch.object(prepare.Path, 'read_text', return_value='1 2 8:3 / / rw - ext4 /dev/test rw\n'), patch.object(prepare, 'run') as run:
            with self.assertRaisesRegex(SystemExit, 'Device is mounted'):
                prepare.offline('/dev/test')
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
