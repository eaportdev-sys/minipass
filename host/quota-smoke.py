#!/usr/bin/env python3
"""Explicit Ubuntu verification: synthetic data only; never run automatically.

Requires active quotas, 0.1 GB unallocated capacity and cached redis:7-alpine.
Proves root/database-container writes fail at the SAME project quota, verifies
Trash retention, then destroys only this temporary site and releases its budget.
"""
import errno
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess


class Client(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(20)
        self.sock.connect('/srv/panel-data/storage-quotas.sock')


def request(method, route, body=None):
    client = Client('localhost')
    client.request(method, route, json.dumps(body) if body else None, {'Content-Type': 'application/json'})
    response = client.getresponse()
    result = json.loads(response.read())
    client.close()
    if response.status >= 400:
        raise RuntimeError(result.get('error'))
    return result


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run as root on the Ubuntu host.')
    subprocess.run(['docker', 'image', 'inspect', 'redis:7-alpine'], check=True, stdout=subprocess.DEVNULL)
    assert request('GET', '/status')['ready']
    name = 'quota-smoke-' + str(os.getpid())
    directory = Path('/srv/apps', name)
    trashed = Path('/srv/apps/.trash', name)
    if directory.exists() or trashed.exists():
        raise SystemExit('Temporary site path already exists; nothing changed.')
    try:
        item = request('POST', '/sites/' + name, {'limitBytes': 100000000})
        assert item['enforced']
        database = directory / '.dbdata/probe'
        database.mkdir(parents=True)
        # First fill about half the allowance as source/upload data.
        with (directory / 'synthetic-source').open('wb', buffering=0) as stream:
            block = bytes(1024 * 1024)
            for _ in range(45):
                stream.write(block)
        result = subprocess.run(['docker', 'run', '--rm', '--pull=never', '--name', name, '--mount', f'type=bind,src={database},dst=/data', 'redis:7-alpine', 'sh', '-c', 'dd if=/dev/zero of=/data/synthetic-db bs=1M count=200'], text=True, capture_output=True, timeout=60)
        assert result.returncode != 0 and 'quota' in result.stderr.lower(), 'Database-container writes must fail specifically with a quota error: ' + result.stderr
        before = request('GET', '/sites/' + name)
        assert before['enforced'] and before['usedBytes'] <= 100000000 + 4096
        # Ordinary root writes must fail too, not bypass a database-only limit.
        hit = False
        try:
            with (directory / 'synthetic-root').open('wb', buffering=0) as stream:
                for _ in range(200):
                    stream.write(block)
        except OSError as error:
            hit = error.errno == errno.EDQUOT
        assert hit, 'Root-owned site file writes must hit EDQUOT'
        directory.rename(trashed)
        held = request('GET', '/sites/' + name)
        assert held['usedBytes'] >= before['usedBytes'] and held['enforced']
        print('PASS: shared files/database hard limit, root enforcement and 48-hour Trash assignment preservation.')
    finally:
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for target in (directory, trashed):
            if target.exists():
                shutil.rmtree(target)
        request('DELETE', '/sites/' + name)
        print('Temporary quota site removed; allowance released.')


if __name__ == '__main__':
    main()
