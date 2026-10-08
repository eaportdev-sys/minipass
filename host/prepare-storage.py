#!/usr/bin/env python3
"""Idempotent installer setup. NEVER changes feature flags on a mounted device."""
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys


def run(args):
    return subprocess.check_output(args, text=True, timeout=60)


def fstab_with_quota(text, target):
    rows, changed = [], False
    for line in text.splitlines(keepends=True):
        fields = line.split()
        if fields and not fields[0].startswith('#') and len(fields) >= 4 and fields[1] == target and fields[2] == 'ext4':
            if 'prjquota' not in fields[3].split(','):
                # Keep every option, other field and inline comment.
                pattern = r'^(\s*\S+\s+\S+\s+\S+\s+)(\S+)'
                line = re.sub(pattern, lambda m: m[1] + m[2] + ',prjquota', line)
                changed = True
        rows.append(line)
    return ''.join(rows), changed


def setup(apps='/srv/apps', data='/srv/panel-data'):
    info = json.loads(run(['findmnt', '-J', '-T', apps, '-o', 'TARGET,SOURCE,FSTYPE,OPTIONS']))['filesystems'][0]
    status = {'ready': False, 'filesystem': info['fstype'], 'message': ''}
    if info['fstype'] != 'ext4' or not info['source'].startswith('/dev/'):
        status['message'] = 'Automatic quota setup currently supports host ext4 storage only; no filesystem changes made.'
    else:
        header = run(['tune2fs', '-l', info['source']])
        features = re.search(r'^Filesystem features:\s*(.*)$', header, re.M).group(1).split()
        if not {'project', 'quota'}.issubset(features) or not re.search(r'^Project quota inode:\s*[1-9]', header, re.M):
            status['message'] = ('One-time offline setup required for ' + info['source'] + '. Back up first; from a rescue/live environment with this device UNMOUNTED run: sudo python3 host/prepare-storage.py --offline ' + info['source'] + '. Then boot normally and rerun sudo bash install-linux.sh. Installer/updates will not alter a mounted filesystem or reboot automatically.')
        elif 'prjquota' in info['options'].split(','):
            status.update(ready=True, message='ext4 project quotas are active.')
        else:
            file = Path('/etc/fstab')
            original = file.read_text()
            updated, changed = fstab_with_quota(original, info['target'])
            if changed:
                backup = Path('/etc/fstab.minipass-quota-backup')
                if not backup.exists():
                    shutil.copy2(file, backup)
                temp = Path('/etc/fstab.minipass-quota-tmp')
                temp.write_text(updated)
                shutil.copymode(file, temp)
                os.replace(temp, file)
            if changed or 'prjquota' in updated:
                status['message'] = 'Project quota mount option prepared in /etc/fstab. Reboot during maintenance, then rerun the installer. No live root remount attempted.'
            else:
                status['message'] = 'No matching ext4 mount entry found in /etc/fstab; quota setup needs administrator review. No filesystem changes made.'
    Path(data).mkdir(parents=True, exist_ok=True)
    Path(data, 'storage-quota-setup.json').write_text(json.dumps(status))
    print(status['message'])
    return status


def offline(device):
    device = os.path.realpath(device)
    metadata = os.stat(device)
    if not stat.S_ISBLK(metadata.st_mode):
        raise SystemExit('Expected an ext4 block device; nothing changed.')
    number = f'{os.major(metadata.st_rdev)}:{os.minor(metadata.st_rdev)}'
    mounts = Path('/proc/self/mountinfo').read_text().splitlines()
    if any(line.split()[2] == number for line in mounts):
        raise SystemExit('Device is mounted. Refusing feature changes; use a rescue/live environment.')
    if run(['blkid', '-s', 'TYPE', '-o', 'value', device]).strip() != 'ext4':
        raise SystemExit('Device is not ext4; nothing changed.')
    # A backup is required. Never format, partition, resize or force-check.
    for args in (['e2fsck', '-p', '-f', device], ['tune2fs', '-O', 'project,quota', '-Q', 'prjquota', device], ['e2fsck', '-p', '-f', device]):
        result = subprocess.run(args, check=False)
        accepted = (0, 1) if args[0] == 'e2fsck' else (0,)
        if result.returncode not in accepted:
            raise SystemExit('Offline setup stopped. Resolve filesystem check errors before mounting; no forced repair attempted.')
    print('Project quota features enabled. Boot normally and rerun the Minipass installer to prepare the mount option.')


if __name__ == '__main__':
    if os.geteuid() != 0:
        raise SystemExit('Run storage setup as root.')
    if len(sys.argv) == 3 and sys.argv[1] == '--offline':
        offline(sys.argv[2])
    elif len(sys.argv) == 1:
        setup()
    else:
        raise SystemExit('Usage: prepare-storage.py [--offline /dev/device]')
