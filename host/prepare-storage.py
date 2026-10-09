#!/usr/bin/env python3
"""Idempotent installer setup. NEVER changes feature flags on a mounted device.

Provisioning model (single-disk friendly):
- Quota features can only be enabled on an UNMOUNTED ext4 filesystem. Root is
  always mounted, so a root filesystem can never be fixed live.
- A separate /srv/apps volume CAN be fixed live: new volumes get quota
  features baked in at mkfs time, and an existing separate mount can be
  briefly unmounted for tune2fs.
- Fresh-install recipe: give root a fixed LV (e.g. 50GB of a 100GB disk) and
  leave the rest unallocated in the VG. This script turns the free extents
  (or a spare partition/whole disk) into the mounted, quota-ready /srv/apps.
- If no free space exists, nothing is changed: the panel keeps working with
  honestly-unenforced allowances until space is provided.
"""
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

MIN_STORAGE_BYTES = 5 * 1000 ** 3  # below this, provisioning is not worthwhile
STORAGE_LABEL = 'minipass-apps'
STORAGE_LV = 'minipass-apps'


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


def fstab_set_mount(text, device, target, options='defaults,prjquota'):
    """Ensure exactly one ext4 entry mounts device at target. Idempotent."""
    entry = f'{device} {target} ext4 {options} 0 2\n'
    rows, changed, seen = [], False, False
    for line in text.splitlines(keepends=True):
        fields = line.split()
        if fields and not fields[0].startswith('#') and len(fields) >= 4 and fields[1] == target:
            if line == entry:
                seen = True
            else:
                line, seen, changed = entry, True, True
        rows.append(line)
    if not seen:
        if rows and not rows[-1].endswith('\n'):
            rows[-1] += '\n'
        rows.append(entry)
        changed = True
    return ''.join(rows), changed


def write_fstab(updated):
    file = Path('/etc/fstab')
    backup = Path('/etc/fstab.minipass-quota-backup')
    if not backup.exists():
        shutil.copy2(file, backup)
    temp = Path('/etc/fstab.minipass-quota-tmp')
    temp.write_text(updated)
    shutil.copymode(file, temp)
    os.replace(temp, file)


def mount_info(apps):
    return json.loads(run(['findmnt', '-J', '-T', apps, '-o', 'TARGET,SOURCE,FSTYPE,OPTIONS']))['filesystems'][0]


def fs_features(device):
    header = run(['tune2fs', '-l', device])
    features = re.search(r'^Filesystem features:\s*(.*)$', header, re.M).group(1).split()
    quota_inode = bool(re.search(r'^Project quota inode:\s*[1-9]', header, re.M))
    return {'project', 'quota'}.issubset(features) and quota_inode


def vg_free_bytes():
    """{vg_name: free_bytes} for all volume groups. Empty when LVM is absent."""
    try:
        out = run(['vgs', '--units', 'b', '--nosuffix', '--noheadings', '-o', 'vg_name,vg_free'])
    except (subprocess.CalledProcessError, FileNotFoundError):
        return {}
    result = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].isdigit():
            result[parts[0]] = int(parts[1])
    return result


def pv_vgs():
    """{pv_device: vg_name} for physical volumes."""
    try:
        out = run(['pvs', '--noheadings', '-o', 'pv_name,vg_name'])
    except (subprocess.CalledProcessError, FileNotFoundError):
        return {}
    result = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2:
            result[parts[0]] = parts[1]
    return result


def unused_devices():
    """Spare partitions/whole disks: unmounted, no filesystem, not an LVM PV."""
    try:
        info = json.loads(run(['lsblk', '-J', '-b', '-o', 'NAME,TYPE,FSTYPE,MOUNTPOINT,SIZE']))
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    pvs = pv_vgs()
    dev = lambda n: '/dev/' + n  # noqa: E731
    spares = []

    def mounted(node):
        if node.get('mountpoint'):
            return True
        return any(mounted(c) for c in node.get('children', []))

    def walk(node):
        if node.get('type') in ('part', 'disk') and not node.get('fstype') and not mounted(node):
            path = dev(node['name'])
            if path not in pvs and (node.get('size') or 0) >= MIN_STORAGE_BYTES:
                # Whole disks only count when they carry no partition table use.
                if node.get('type') == 'disk' and node.get('children'):
                    pass
                else:
                    spares.append(path)
        for child in node.get('children', []):
            walk(child)

    for node in info.get('blockdevices', []):
        walk(node)
    return spares


def choose_source(vg_free, spares):
    """Prefer free VG extents (the documented fresh-install recipe), then spares."""
    roomy = sorted(((free, vg) for vg, free in vg_free.items() if free >= MIN_STORAGE_BYTES), reverse=True)
    if roomy:
        return ('vg', roomy[0][1])
    if spares:
        return ('device', spares[0])
    return (None, None)


def free_regions():
    """Unpartitioned free space on partitioned disks: [(disk, startB, endB)].

    Uses parted's machine output. Only ADDING a partition in reported-free
    space is ever attempted; existing partitions are never touched.
    """
    try:
        info = json.loads(run(['lsblk', '-J', '-b', '-d', '-o', 'NAME,TYPE,SIZE']))
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    regions = []
    for node in info.get('blockdevices', []):
        if node.get('type') != 'disk' or (node.get('size') or 0) < MIN_STORAGE_BYTES:
            continue
        disk = '/dev/' + node['name']
        try:
            out = run(['parted', '-m', disk, 'unit', 'B', 'print', 'free'])
        except (subprocess.CalledProcessError, FileNotFoundError):
            continue
        for line in out.splitlines():
            m = re.match(r'^(\d+):(\d+)B:(\d+)B:(\d+)B:([^:]*):([^:]*):', line)
            if m and m.group(6) == 'Free Space':
                regions.append((disk, int(m.group(2)), int(m.group(3))))
    return regions


def biggest_region(regions):
    roomy = [(end - start, disk, start, end) for disk, start, end in regions if end - start >= MIN_STORAGE_BYTES]
    if not roomy:
        return None
    roomy.sort(reverse=True)
    return roomy[0][1], roomy[0][2], roomy[0][3]


def partition_region(disk, start, end):
    """Carve one partition from free space. Returns the new /dev path or None."""
    mib = 1024 * 1024
    aligned = ((start + mib - 1) // mib) * mib
    bounded = end - mib  # keep clear of the GPT backup table
    if bounded - aligned < MIN_STORAGE_BYTES:
        return None
    try:
        before = {p['name'] for p in json.loads(run(['lsblk', '-J', '-o', 'NAME,TYPE', disk]))['blockdevices'][0].get('children', [])}
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    if shell(['parted', '-s', '-m', disk, 'unit', 'B', 'mkpart', 'primary', 'ext4', str(aligned), str(bounded)]) != 0:
        return None
    shell(['partprobe', disk])
    try:
        after = {p['name'] for p in json.loads(run(['lsblk', '-J', '-o', 'NAME,TYPE', disk]))['blockdevices'][0].get('children', [])}
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    fresh = after - before
    if len(fresh) != 1:
        return None
    return '/dev/' + fresh.pop()


def migration_allowed(apps):
    """Only migrate /srv/apps content when nothing can hold it open."""
    try:
        children = list(Path(apps).iterdir())
    except FileNotFoundError:
        return (True, '')
    if not children:
        return (True, '')
    try:
        running = subprocess.check_output(['docker', 'ps', '-q'], text=True, timeout=15).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        running = ''
    if running:
        return (False, 'Site files exist and containers are running. Stop the panel and sites, then rerun the installer so content can move to the new volume.')
    return (True, '')


def shell(args):
    try:
        return subprocess.run(args, check=False).returncode
    except OSError:
        return 127


def make_ready_storage(device, apps):
    """Format (features baked in at mkfs), register in fstab, mount, migrate."""
    allowed, reason = migration_allowed(apps)
    if not allowed:
        return {'ready': False, 'message': reason + ' No storage changes made.'}
    Path(apps).mkdir(parents=True, exist_ok=True)
    existing = []
    try:
        existing = list(Path(apps).iterdir())
    except FileNotFoundError:
        pass
    if shell(['mkfs.ext4', '-L', STORAGE_LABEL, '-O', 'project,quota', device]) != 0:
        return {'ready': False, 'message': 'Could not format the storage volume; no changes made to existing files.'}
    # Quota inodes exist from mkfs; select project accounting while unmounted.
    if shell(['tune2fs', '-Q', 'prjquota', device]) != 0:
        return {'ready': False, 'message': 'Storage format succeeded but quota selection failed; rerun the installer.'}
    uuid = run(['blkid', '-s', 'UUID', '-o', 'value', device]).strip()
    if not uuid:
        return {'ready': False, 'message': 'Storage volume has no UUID; rerun the installer.'}
    updated, _ = fstab_set_mount(Path('/etc/fstab').read_text(), 'UUID=' + uuid, apps)
    write_fstab(updated)
    if shell(['mount', apps]) != 0:
        return {'ready': False, 'message': 'Storage volume is formatted and registered in /etc/fstab but did not mount; run: mount /srv/apps.'}
    if existing:
        for child in existing:
            dest = Path(apps) / child.name
            if dest.exists():
                continue
            if child.is_dir() and not child.is_symlink():
                shutil.copytree(child, dest, symlinks=True)
                shutil.rmtree(child)
            else:
                shutil.move(str(child), str(dest))
    return {'ready': True, 'message': ''}


def confirm_active(apps):
    """Ask the quota bridge's own checks whether enforcement is live."""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from importlib import import_module
        bridge = import_module('storage-quotas')
        mount = bridge.mount_info()
        bridge.quota(mount['source'], 0)
        return True
    except Exception:
        return False
    finally:
        try:
            sys.path.remove(os.path.dirname(os.path.abspath(__file__)))
        except ValueError:
            pass


def finish_provision(result, success):
    if result['ready'] and confirm_active(''):
        return (True, success)
    return (False, result['message'] or 'Storage volume created; rerun the installer to finish activation.')


APPROVAL_HINT = 'Approve with: sudo MINIPASS_USE_FREE_SPACE=1 bash install-linux.sh (or: python3 host/prepare-storage.py --use-free-space).'


def approved_use(description, approve):
    """Destructive-adjacent provisioning needs a yes. TTY gets asked, automation
    passes approval explicitly; anything else only reports what was found."""
    if approve:
        return True
    try:
        if sys.stdin.isatty():
            answer = input(description + ' Use it for site storage? [y/N] ').strip().lower()
            return answer in ('y', 'yes')
    except (OSError, EOFError):
        pass
    return False


def setup(apps='/srv/apps', data='/srv/panel-data', approve=False):
    info = mount_info(apps)
    status = {'ready': False, 'filesystem': info['fstype'], 'message': ''}
    own_mount = info['target'] == apps
    block_device = info['fstype'] == 'ext4' and info['source'].startswith('/dev/')
    supported = info['fstype'] == 'ext4' and info['source'].startswith('/dev/')

    if own_mount and supported:
        if 'prjquota' in info['options'].split(','):
            if confirm_active(apps):
                status.update(ready=True, message='ext4 project quotas are active.')
            else:
                status['message'] = 'Storage volume is mounted with prjquota but the kernel rejected quota operations; check dmesg and rerun the installer.'
        elif fs_features(info['source']):
            # Features present, only the mount option is missing: fix fstab and
            # remount live (safe: this is a data mount, never root).
            file = Path('/etc/fstab')
            updated, changed = fstab_with_quota(file.read_text(), apps)
            if changed:
                write_fstab(updated)
            if shell(['mount', '-o', 'remount,prjquota', apps]) == 0 and confirm_active(apps):
                status.update(ready=True, message='ext4 project quotas are active.')
            else:
                status['message'] = 'Project quota mount option prepared in /etc/fstab. Reboot during maintenance, then rerun the installer.'
        else:
            allowed, reason = migration_allowed(apps)
            if not allowed:
                status['message'] = reason + ' Then the installer can enable quota features with a brief unmount.'
            else:
                if shell(['umount', apps]) != 0:
                    status['message'] = 'Could not briefly unmount /srv/apps; stop containers using it and rerun the installer.'
                elif shell(['e2fsck', '-p', '-f', info['source']]) not in (0, 1) or shell(['tune2fs', '-O', 'project,quota', '-Q', 'prjquota', info['source']]) != 0 or shell(['e2fsck', '-p', '-f', info['source']]) not in (0, 1):
                    status['message'] = 'Quota feature setup on the storage volume failed; check filesystem errors, then rerun the installer.'
                else:
                    file = Path('/etc/fstab')
                    updated, changed = fstab_with_quota(file.read_text(), apps)
                    if changed or 'prjquota' not in file.read_text():
                        if not changed:
                            updated, _ = fstab_set_mount(file.read_text(), info['source'], apps)
                        write_fstab(updated)
                    if shell(['mount', apps]) == 0 and confirm_active(apps):
                        status.update(ready=True, message='ext4 project quotas are active.')
                    else:
                        status['message'] = 'Quota features enabled; mount /srv/apps (or reboot) and rerun the installer.'
    elif not own_mount and supported:
        features = fs_features(info['source'])
        if features and 'prjquota' not in info['options'].split(','):
            # Root-style layout that already has quota features only needs the
            # mount option: safe to prepare, needs a reboot, never tunes live.
            file = Path('/etc/fstab')
            updated, changed = fstab_with_quota(file.read_text(), info['target'])
            if changed:
                write_fstab(updated)
            status['message'] = 'Project quota mount option prepared in /etc/fstab. Reboot during maintenance, then rerun the installer. No live root remount attempted.'
        elif not features:
            kind, source = choose_source(vg_free_bytes(), unused_devices())
            if kind is None:
                region = biggest_region(free_regions())
                if region is None:
                    status['message'] = ('Site storage still lives on the system disk without quota support, and no free space was found. '
                                         'Fresh-install recipe: give root a fixed LV (e.g. 50GB of 100GB) and leave the rest unallocated, or attach a spare disk/partition, then rerun the installer. '
                                         'Last resort on a single fully-allocated disk: enable quota features from a rescue environment with host/prepare-storage.py --offline. '
                                         'Sites keep working; allowances stay honestly unenforced until then.')
                else:
                    allowed, reason = migration_allowed(apps)
                    if not allowed:
                        status['message'] = reason + ' Then rerun the installer to carve site storage from the free disk space.'
                    elif not approved_use(f'Found {int((region[2] - region[1]) / 1000000000)} GB of free space on {region[0]}. Carving only adds a partition; existing data is untouched.', approve):
                        status['message'] = f'Found free disk space on {region[0]} but carving was not approved. {APPROVAL_HINT} Sites keep working unenforced.'
                    else:
                        newpart = partition_region(*region)
                        if not newpart:
                            status['message'] = ('Free disk space exists but partitioning it failed (parted/partprobe unavailable, or the kernel would not re-read the table - reboot and rerun). '
                                                 'No existing partitions were touched; sites keep working unenforced.')
                        else:
                            ok, message = finish_provision(make_ready_storage(newpart, apps),
                                'Site storage carved from free disk space; ext4 project quotas are active.')
                            if ok:
                                status.update(ready=True, message=message)
                            else:
                                status['message'] = message
            else:
                if kind == 'vg':
                    if not approved_use(f'Found free VG space in {source} for a {STORAGE_LABEL} volume.', approve):
                        status['message'] = f'Found free VG space in {source} but it was not approved for use. {APPROVAL_HINT} Sites keep working unenforced.'
                    elif shell(['lvcreate', '-n', STORAGE_LV, '-l', '100%FREE', source]) != 0:
                        status['message'] = 'Could not create the storage volume from free VG space; rerun the installer.'
                    else:
                        ok, message = finish_provision(make_ready_storage('/dev/' + source + '/' + STORAGE_LV, apps),
                            'Site storage provisioned from free VG space; ext4 project quotas are active.')
                        if ok:
                            status.update(ready=True, message=message)
                        else:
                            status['message'] = message
                else:
                    if not approved_use(f'Found spare disk/partition {source}. Formatting destroys anything on it.', approve):
                        status['message'] = f'Found spare disk/partition {source} but it was not approved for use. {APPROVAL_HINT} Sites keep working unenforced.'
                    else:
                        ok, message = finish_provision(make_ready_storage(source, apps),
                            'Site storage provisioned on the spare disk/partition; ext4 project quotas are active.')
                        if ok:
                            status.update(ready=True, message=message)
                        else:
                            status['message'] = message
        else:
            status.update(ready=True, message='ext4 project quotas are active.')
    else:
        status['message'] = 'Automatic quota setup currently supports host ext4 storage only; no filesystem changes made.'
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
    flag = '--use-free-space' in sys.argv or os.environ.get('MINIPASS_USE_FREE_SPACE', '').lower() in ('1', 'yes', 'true')
    args = [a for a in sys.argv[1:] if a != '--use-free-space']
    if len(args) == 2 and args[0] == '--offline':
        offline(args[1])
    elif not args:
        setup(approve=flag)
    else:
        raise SystemExit('Usage: prepare-storage.py [--use-free-space] [--offline /dev/device]')
