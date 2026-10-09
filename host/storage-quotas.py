#!/usr/bin/env python3
"""Root-only host bridge for ext4 project quotas; no content reads or usage history.

Only new sites are assigned. Existing database volumes are not migrated. Linux
quotactl/ioctl enforce the limit for root-owned files and database containers too.
"""
import ctypes
import fcntl
import http.server
import json
import os
import re
import socket
import socketserver
import struct
import subprocess
import sys
from pathlib import Path

APPS = Path(os.environ.get('APPS_DIR', '/srv/apps'))
DATA = Path(os.environ.get('QUOTA_DATA_DIR', '/srv/panel-data'))
STATE = DATA / 'storage-quota-state.json'
SOCKET = DATA / 'storage-quotas.sock'
RESERVE = 2 * 1024 ** 3  # host builds/OS need separate headroom; not a site charge
FIRST_PROJECT = 100000
FSGETXATTR, FSSETXATTR, PROJINHERIT = 0x801c581f, 0x401c5820, 0x200
Q_GETQUOTA, Q_SETQUOTA, PRJQUOTA = 0x800007, 0x800008, 2


class QuotaError(Exception):
    def __init__(self, message, status=503):
        super().__init__(message)
        self.status = status


class Dqblk(ctypes.Structure):
    _fields_ = [(key, ctypes.c_uint64) for key in ('bhard', 'bsoft', 'space', 'ihard', 'isoft', 'inodes', 'btime', 'itime')] + [('valid', ctypes.c_uint32)]


def mount_info():
    raw = subprocess.check_output(['findmnt', '-J', '-T', str(APPS), '-o', 'TARGET,SOURCE,FSTYPE,OPTIONS'], timeout=10)
    mount = json.loads(raw)['filesystems'][0]
    if mount['fstype'] != 'ext4' or 'prjquota' not in mount['options'].split(','):
        raise QuotaError('Quota enforcement is not active on /srv/apps. Open Storage for the installer status and exact next step.')
    if not str(mount['source']).startswith('/dev/'):
        raise QuotaError('Site storage must use a host ext4 block device with project quotas.')
    return mount


def quota(device, project, limit=None):
    libc = ctypes.CDLL(None, use_errno=True)
    libc.quotactl.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p]
    block = Dqblk()
    op = Q_GETQUOTA
    if limit is not None:
        op = Q_SETQUOTA
        block.bhard = (limit + 1023) // 1024
        block.valid = 1  # QIF_BLIMITS: hard/soft BLOCK limits only, no inode limits
    if libc.quotactl((op << 8) | PRJQUOTA, os.fsencode(device), project, ctypes.byref(block)) != 0:
        raise QuotaError('Kernel project quota operation failed; check host quota setup.')
    return block


def project(path, value=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        raw = fcntl.ioctl(fd, FSGETXATTR, bytes(28))
        fields = list(struct.unpack('=IIIII8s', raw))
        if value is not None:
            fields[3] = value
            if path.is_dir():
                fields[0] |= PROJINHERIT
            fcntl.ioctl(fd, FSSETXATTR, struct.pack('=IIIII8s', *fields))
        return fields[3]
    finally:
        os.close(fd)


def load():
    if not STATE.exists():
        return {'sites': {}, 'nextProject': FIRST_PROJECT}
    state = json.loads(STATE.read_text())
    if not isinstance(state.get('sites'), dict) or type(state.get('nextProject')) is not int or not FIRST_PROJECT <= state['nextProject'] < 2000000000:
        raise QuotaError('Host quota state is invalid; restore its backup before creating sites.')
    for name, site in state['sites'].items():
        valid_site(name)
        if not isinstance(site, dict) or type(site.get('projectId')) is not int or not FIRST_PROJECT <= site['projectId'] < 2000000000 or type(site.get('limitBytes')) is not int or not 100000000 <= site['limitBytes'] <= 1000000000000000 or type(site.get('assigned')) is not bool:
            raise QuotaError('Host quota state is invalid; restore its backup before changing limits.')
    return state


def save(state):
    temp = STATE.with_suffix('.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(state, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, STATE)


def valid_site(name):
    if name == 'minipass' or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,31}', name):
        raise QuotaError('Invalid site id.', 400)
    return name


def capacity(state, device):
    stat = os.statvfs(APPS)
    free = stat.f_bavail * stat.f_frsize
    outstanding = sum(max(0, site['limitBytes'] - quota(device, site['projectId']).space) for site in state['sites'].values())
    return max(0, free - outstanding - RESERVE)


def usage(name, state, mount):
    site = state['sites'].get(name)
    if not site:
        raise QuotaError('No enforced allowance exists for this site.', 404)
    block = quota(mount['source'], site['projectId'])
    enforced = block.bhard == (site['limitBytes'] + 1023) // 1024 and site.get('assigned', False)
    # Renames into Trash retain the inode's project id. Check the active path
    # when present; destroyed sites may have only still-open charged inodes.
    directory = APPS / name
    if directory.exists():
        enforced = enforced and not directory.is_symlink() and project(directory) == site['projectId']
    return {**site, 'enforced': enforced, 'usedBytes': block.space, 'remainingBytes': max(0, site['limitBytes'] - block.space), 'scope': 'site files and managed database data'}


def allocate(name, limit, state, mount):
    if isinstance(limit, bool) or not isinstance(limit, int) or not 100000000 <= limit <= 1000000000000000:
        raise QuotaError('Invalid storage allowance.', 400)
    directory = APPS / name
    old = state['sites'].get(name)
    if old:
        if old['limitBytes'] != limit:
            raise QuotaError('Pending site uses a different allowance. Cancel creation before changing it.', 409)
        # Clone failures/cancellation may leave an empty directory, but cannot
        # drop the reservation or project limit behind the host bridge's back.
        if not old.get('assigned'):
            children = list(directory.iterdir()) if directory.exists() else []
            if directory.is_symlink() or any(p.name not in ('deploy-key', 'deploy-key.pub') or p.is_symlink() or not p.is_file() for p in children):
                raise QuotaError('Partial allocation needs host repair; reservation kept.')
            quota(mount['source'], old['projectId'], limit)
            directory.mkdir(exist_ok=True)
            project(directory, old['projectId'])
            for child in children:
                project(child, old['projectId'])
            old['assigned'] = True
            save(state)
        elif not directory.exists():
            directory.mkdir()
            project(directory, old['projectId'])
        elif directory.is_symlink() or project(directory) != old['projectId']:
            raise QuotaError('Site directory has lost its project assignment; host repair is required.')
        return usage(name, state, mount)
    if directory.is_symlink():
        raise QuotaError('Site directory cannot be a symlink.', 409)
    # Only pre-create SSH keys may predate allocation. Never silently reassign
    # a legacy checkout, live directory, or database's existing data.
    children = list(directory.iterdir()) if directory.exists() else []
    if any(p.name not in ('deploy-key', 'deploy-key.pub') or p.is_symlink() or not p.is_file() for p in children):
        raise QuotaError('Existing site data is not quota-managed. Cancel the unfinished checkout or migrate it explicitly.', 409)
    if limit > capacity(state, mount['source']):
        raise QuotaError('Not enough unallocated disk space for this allowance (existing sites, Trash and host headroom are reserved). Expand storage or choose a smaller size.', 409)
    number = max(FIRST_PROJECT, state['nextProject'])
    # Do not collide with quotas assigned by other host administrators.
    while True:
        block = quota(mount['source'], number)
        if not any((block.space, block.inodes, block.bhard, block.bsoft, block.ihard, block.isoft)):
            break
        number += 1
        if number >= 2000000000:
            raise QuotaError('No free project quota id is available.')
    state['sites'][name] = {'projectId': number, 'limitBytes': limit, 'assigned': False}
    state['nextProject'] = number + 1
    save(state)  # retain reservation for a partial failure/retry
    quota(mount['source'], number, limit)
    directory.mkdir(exist_ok=True)
    project(directory, number)
    for child in children:
        project(child, number)
    state['sites'][name]['assigned'] = True
    save(state)
    return usage(name, state, mount)


def release(name, state, mount):
    site = state['sites'].get(name)
    if not site:
        return {'ok': True, 'released': False}
    trash = APPS / '.trash'
    retained = trash.exists() and any(re.fullmatch(re.escape(name) + r'(?:-\d+-\d+)?', p.name) for p in trash.iterdir())
    if (APPS / name).exists() or retained:
        raise QuotaError('Site or Trash files still exist; quota reservation retained.', 409)
    os.sync()
    block = quota(mount['source'], site['projectId'])
    if block.space or block.inodes:
        raise QuotaError('Site data is still held by open files or volumes; close its containers and retry cleanup.', 409)
    quota(mount['source'], site['projectId'], 0)
    del state['sites'][name]
    save(state)
    return {'ok': True, 'released': True}


def discovery_report(state, mount):
    """Read-only host inventory. No formatting, partitioning or mounting."""
    report = {'mount': mount, 'state': {'sites': len(state.get('sites', {})), 'nextProject': state.get('nextProject')},
              'appsFreeBytes': None, 'appsTotalBytes': None, 'vgFree': {}, 'spares': [], 'freeRegions': []}
    try:
        stat = os.statvfs(str(APPS))
        report['appsFreeBytes'] = stat.f_bavail * stat.f_frsize
        report['appsTotalBytes'] = stat.f_blocks * stat.f_frsize
    except OSError:
        pass
    try:
        import importlib.util as _ilu
        _spec = _ilu.spec_from_file_location('minipass_prepare_storage', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'prepare-storage.py'))
        prepare = _ilu.module_from_spec(_spec)
        _spec.loader.exec_module(prepare)
        report['vgFree'] = prepare.vg_free_bytes()
        report['spares'] = prepare.unused_devices()
        report['freeRegions'] = [{'disk': d, 'start': s, 'end': e, 'bytes': e - s} for d, s, e in prepare.free_regions()]
    except Exception:
        pass
    # Bounds: never return unbounded host device lists.
    report['spares'] = report['spares'][:20]
    report['freeRegions'] = report['freeRegions'][:20]
    return report


def dispatch(method, route, body):
    if method == 'GET' and route == '/discovery':
        try:
            mount = mount_info()
        except QuotaError as e:
            mount = {'error': str(e)}
        try:
            state = load()
        except QuotaError as e:
            state = {'sites': {}, 'error': str(e)}
        return discovery_report(state, mount if isinstance(mount, dict) and 'source' in mount else {'source': None, 'target': None, 'fstype': None, 'options': '', **({'error': mount.get('error')} if isinstance(mount, dict) else {})})
    mount = mount_info()
    state = load()
    if method == 'GET' and route == '/status':
        quota(mount['source'], 0)  # fail closed if the kernel rejects quotas
        return {'ready': True, 'availableBytes': capacity(state, mount['source']), 'hostReserveBytes': RESERVE, 'scope': 'site files and managed database data'}
    if method == 'GET' and route == '/discovery':
        return discovery_report(state, mount)
    match = re.fullmatch(r'/sites/([a-z0-9-]+)', route)
    if not match:
        raise QuotaError('Unknown quota operation.', 404)
    name = valid_site(match[1])
    if method == 'GET':
        return usage(name, state, mount)
    if method == 'POST':
        return allocate(name, body.get('limitBytes'), state, mount)
    if method == 'DELETE':
        return release(name, state, mount)
    raise QuotaError('Unknown quota operation.', 405)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # no activity/usage history

    def handle_request(self):
        self.connection.settimeout(10)
        try:
            _, uid, _ = struct.unpack('3i', self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != 0:
                raise QuotaError('Root-only storage bridge.', 403)
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 <= length <= 4096:
                raise QuotaError('Request too large.', 400)
            body = json.loads(self.rfile.read(length)) if length else {}
            if not isinstance(body, dict):
                raise QuotaError('Invalid request.', 400)
            result, status = dispatch(self.command, self.path, body), 200
        except QuotaError as error:
            result, status = {'error': str(error)}, error.status
        except Exception:
            result, status = {'error': 'Host quota setup or state is unavailable; inspect the Linux installer output.'}, 503
        payload = json.dumps(result).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = do_POST = do_DELETE = handle_request


def serve():
    if os.geteuid() != 0:
        raise SystemExit('Storage bridge must run as root.')
    APPS.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)
    lock = os.open(DATA / 'storage-quota.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)  # one bridge owns state/socket
    if SOCKET.exists():
        if not SOCKET.is_socket():
            raise SystemExit('Refusing to overwrite a non-socket quota path.')
        SOCKET.unlink()
    # Single-threaded operations serialize reservations, allocation and cleanup.
    with socketserver.UnixStreamServer(str(SOCKET), Handler) as server:
        os.chmod(SOCKET, 0o600)
        server.serve_forever()


if __name__ == '__main__':
    serve()
