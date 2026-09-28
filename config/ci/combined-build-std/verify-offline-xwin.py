"""Verify the exact diagnostic inputs before any downloaded executable runs."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import stat
import sys

PINS = Path(__file__).with_name('offline-xwin-input-pins.json')


def checked_path(root, relative):
    if root.is_symlink():
        raise ValueError(f'symlink input root: {root}')
    path = PurePosixPath(relative)
    if path.is_absolute() or '..' in path.parts or str(path) != relative:
        raise ValueError(f'unsafe input path: {relative}')
    current = root
    for part in path.parts:
        current /= part
        if current.is_symlink():
            raise ValueError(f'symlink input: {relative}')
    return current


def verify_file(path, expected):
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError(f'not a regular file: {path}')
    if path.stat().st_size != expected['bytes']:
        raise ValueError(f'input size mismatch: {path}')
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != expected['sha256']:
        raise ValueError(f'input hash mismatch: {path}')


def verify_tree(root, expected):
    if root.is_symlink() or not root.is_dir():
        raise ValueError(f'input directory missing or symlink: {root}')
    actual = set()
    for path in root.rglob('*'):
        if path.is_symlink():
            raise ValueError(f'symlink input: {path}')
        if path.is_dir():
            continue
        actual.add(path.relative_to(root).as_posix())
    if actual != set(expected):
        raise ValueError(f'input layout mismatch: missing={sorted(set(expected)-actual)}, unexpected={sorted(actual-set(expected))}')
    for relative, pin in expected.items():
        verify_file(checked_path(root, relative), pin)


def verify_inputs(root, pins):
    if root.is_symlink():
        raise ValueError('symlink workspace')
    verify_tree(root / 'cache', pins['cache'])
    verify_tree(root / 'manifest', {'channel.json': pins['channel']})
    verify_tree(root / 'tool', {'xwin': pins['tool']})
    channel = json.loads((root / 'manifest/channel.json').read_text())
    manifests = [item for item in channel['channelItems'] if item['type'] == 'Manifest' and item.get('payloads')]
    payloads = manifests[0]['payloads']
    if len(payloads) != 1 or payloads[0]['sha256'] != pins['catalogTrust']['channelAdvertisedSha256']:
        raise ValueError('channel/catalog cache alias mismatch')
    return {'inputsVerified': True, 'cacheFiles': len(pins['cache']),
            'cacheBytes': sum(x['bytes'] for x in pins['cache'].values()),
            'catalogTrust': pins['catalogTrust'], 'tool': pins['tool'],
            'channel': pins['channel'], 'networkDisabledRequired': True, 'xwinExecuted': False}


if __name__ == '__main__':
    root = Path(sys.argv[1])
    receipt = verify_inputs(root, json.loads(PINS.read_text()))
    destination = checked_path(root, 'receipt')
    destination.mkdir(exist_ok=True)
    (destination / 'input-verification.json').write_text(json.dumps(receipt, indent=2) + '\n')
