"""Compose verified root/std Cargo directory sources; no build qualification claim."""
from pathlib import Path
import hashlib, json, shutil, sys
try:
    import tomllib
except ImportError:
    from pip._vendor import tomli as tomllib


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def locked_packages(paths):
    packages = {}
    for path in paths:
        for package in tomllib.loads(path.read_text())['package']:
            source = package.get('source', '')
            if not source:
                continue
            if source != 'registry+https://github.com/rust-lang/crates.io-index':
                raise ValueError('Unsupported registry source: ' + source)
            identity = (package['name'], package['version'])
            checksum = package['checksum']
            if identity in packages and packages[identity] != checksum:
                raise ValueError('Conflicting locked package: ' + str(identity))
            packages[identity] = checksum
    return packages


def verify_crate(path, packages):
    if path.is_symlink() or not path.is_dir():
        raise ValueError('Crate must be a regular directory')
    metadata = tomllib.loads((path / 'Cargo.toml').read_text())['package']
    identity = (metadata['name'], metadata['version'])
    expected = packages.get(identity)
    if expected is None:
        raise ValueError('Unlisted crate: ' + str(identity))
    checksums = json.loads((path / '.cargo-checksum.json').read_text())
    if checksums['package'] != expected:
        raise ValueError('Package checksum mismatch: ' + str(identity))
    actual = set()
    for entry in path.rglob('*'):
        if entry.is_symlink():
            raise ValueError('Unexpected vendor symlink')
        if entry.is_file():
            actual.add(entry.relative_to(path).as_posix())
        elif not entry.is_dir():
            raise ValueError('Unexpected vendor file type')
    if actual != set(checksums['files']) | {'.cargo-checksum.json'}:
        raise ValueError('Unexpected vendor file membership: ' + str(identity))
    for filename, expected_hash in checksums['files'].items():
        relative = Path(filename)
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Unsafe checksum path')
        if digest(path / relative) != expected_hash:
            raise ValueError('Crate file checksum mismatch: ' + str(identity) + '/' + filename)
    return identity, checksums


def compose(root_vendor, std_vendor, root_lock, std_lock, destination):
    if destination.exists():
        raise ValueError('Destination must be fresh')
    packages = locked_packages([root_lock, std_lock])
    selected = {}
    duplicates = []
    for source in [root_vendor, std_vendor]:
        for path in sorted(source.iterdir()):
            identity, checksums = verify_crate(path, packages)
            if identity in selected:
                if selected[identity][1] != checksums:
                    raise ValueError('Conflicting same-identity vendor files: ' + str(identity))
                duplicates.append({'name': identity[0], 'version': identity[1]})
            else:
                selected[identity] = (path, checksums)
    if selected.keys() != packages.keys():
        raise ValueError('Incomplete locked package closure')
    destination.mkdir()
    vendor = destination / 'vendor'
    vendor.mkdir()
    records = []
    for identity, (path, checksums) in sorted(selected.items()):
        name = '-'.join(identity)
        if Path(name).name != name or name in ('.', '..'):
            raise ValueError('Unsafe crate identity')
        shutil.copytree(path, vendor / name)
        records.append({'name': identity[0], 'version': identity[1], 'packageChecksum': packages[identity], 'files': len(checksums['files'])})
    (destination / 'config.toml').write_text('[source.crates-io]\nreplace-with = "orca-combined-vendor"\n\n[source.orca-combined-vendor]\ndirectory = ' + json.dumps(str(vendor.resolve())) + '\n')
    (destination / 'receipt.json').write_text(json.dumps({'registryPackages': len(records), 'duplicates': duplicates, 'records': records, 'rootLockSha256': digest(root_lock), 'stdLockSha256': digest(std_lock), 'offlineBuildStdQualified': False}, indent=2) + '\n')
    return records


if __name__ == '__main__':
    compose(*map(Path, sys.argv[1:]))
