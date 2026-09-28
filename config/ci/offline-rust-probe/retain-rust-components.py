"""Retain the five exact historical x64-host Rust inputs, bounded and never executed."""
from pathlib import Path
import hashlib
import json
import re
import sys
import urllib.request

MANIFEST_SHA256 = '1bf70a4f1406732dd79957ccc0d0afc78bdc69cdfa3b5f57857ab56727e05d56'
SOURCE_COMMIT = '9f36de775bc636c8e88c31a173c2bcb6995956a0'
MAX_TOTAL = 192 * 1024 * 1024
MAX_ASSET = 96 * 1024 * 1024
TARGETS = [('rustc', 'x86_64-unknown-linux-gnu'),
           ('cargo', 'x86_64-unknown-linux-gnu'),
           ('rust-std', 'x86_64-unknown-linux-gnu'),
           ('rust-std', 'x86_64-pc-windows-msvc'),
           ('rust-std', 'aarch64-pc-windows-msvc')]


def select(manifest):
    if hashlib.sha256(manifest).hexdigest() != MANIFEST_SHA256:
        raise ValueError('Rust manifest checksum mismatch')
    text = manifest.decode()
    if 'date = "2026-07-20"' not in text or SOURCE_COMMIT not in text:
        raise ValueError('Unexpected nightly identity')
    assets = []
    for package, target in TARGETS:
        section = text.split('[pkg.' + package + '.target.' + target + ']\n', 1)[1].split('\n[', 1)[0]
        url = re.search(r'^xz_url = "([^"]+)"$', section, re.M)[1]
        digest = re.search(r'^xz_hash = "([a-f0-9]{64})"$', section, re.M)[1]
        filename = package + '-nightly-' + target + '.tar.xz'
        if 'available = true' not in section or url != 'https://static.rust-lang.org/dist/2026-07-20/' + filename:
            raise ValueError('Unexpected component URL or availability')
        assets.append({'package': package, 'target': target, 'url': url, 'filename': filename, 'sha256': digest})
    return assets


def retain_asset(asset, destination, expected_size):
    if not 0 < expected_size <= MAX_ASSET:
        raise ValueError('Rust component exceeds size budget')
    path = Path(destination) / asset['filename']
    if path.exists():
        if path.stat().st_size != expected_size or hashlib.sha256(path.read_bytes()).hexdigest() != asset['sha256']:
            raise ValueError('Existing Rust component mismatch')
        return
    partial = path.with_suffix(path.suffix + '.partial')
    digest = hashlib.sha256()
    size = 0
    created = False
    try:
        with urllib.request.urlopen(asset['url'], timeout=45) as response, partial.open('xb') as output:
            created = True
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > expected_size:
                    raise ValueError('Rust download exceeded declared size')
                output.write(chunk)
                digest.update(chunk)
        if size != expected_size or digest.hexdigest() != asset['sha256']:
            raise ValueError('Rust component checksum or size mismatch')
        partial.rename(path)
    except BaseException:
        if created:
            partial.unlink(missing_ok=True)
        raise


def retain(directory):
    directory = Path(directory)
    assets = select((directory / 'channel-rust-nightly.toml').read_bytes())
    for asset in assets:
        with urllib.request.urlopen(urllib.request.Request(asset['url'], method='HEAD'), timeout=30) as response:
            asset['size'] = int(response.headers['Content-Length'])
    if sum(a['size'] for a in assets) > MAX_TOTAL:
        raise ValueError('Rust inputs exceed total download budget')
    if any(not 0 < a['size'] <= MAX_ASSET for a in assets):
        raise ValueError('Rust input exceeds per-asset budget')
    for asset in assets:
        retain_asset(asset, directory, asset['size'])
    with (directory / 'verified-components.json').open('x') as output:
        json.dump({'manifestSha256': MANIFEST_SHA256, 'sourceCommit': SOURCE_COMMIT,
                   'components': assets, 'executed': False, 'signatureVerified': False}, output, indent=2)
        output.write('\n')


if __name__ == '__main__':
    retain(sys.argv[1])
