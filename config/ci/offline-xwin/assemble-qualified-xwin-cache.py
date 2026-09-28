"""Assemble all pinned xwin inputs, without executing the tool or installing SDKs."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import stat
import tarfile
import zipfile

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('verify_xwin', BASE / 'verify-offline-xwin.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


def assemble(output, archive, ucrt, channel, tool_archive, pins):
    if output.exists() or output.is_symlink():
        raise ValueError('output must be a fresh directory')
    if len(pins['cache']) > 300 or sum(x['bytes'] for x in pins['cache'].values()) > 1024**3:
        raise ValueError('cache exceeds 300 files / 1 GiB bound')
    for path, pin in ((archive, pins['sourceArchive']), (channel, pins['channel']),
                      (tool_archive, pins['toolArchive'])):
        if path.is_symlink():
            raise ValueError(f'symlink source: {path}')
        verify.verify_file(path, pin)
    output.mkdir(parents=True)
    with zipfile.ZipFile(archive) as bundle:
        names = {}
        for entry in bundle.infolist():
            if entry.filename in names:
                raise ValueError(f'duplicate archive path: {entry.filename}')
            names[entry.filename] = entry
        for relative, pin in pins['cache'].items():
            destination = verify.checked_path(output / 'cache', relative)
            destination.parent.mkdir(parents=True, exist_ok=True)
            source = pin['source']
            entry = names.get(source)
            if entry is not None:
                mode = entry.external_attr >> 16
                if entry.is_dir() or stat.S_ISLNK(mode) or entry.file_size != pin['bytes']:
                    raise ValueError(f'unsafe archive member: {source}')
                with bundle.open(entry) as reader, destination.open('xb') as writer:
                    shutil.copyfileobj(reader, writer, 1024 * 1024)
            else:
                retained = verify.checked_path(ucrt, Path(source).name)
                verify.verify_file(retained, pin)
                with retained.open('rb') as reader, destination.open('xb') as writer:
                    shutil.copyfileobj(reader, writer, 1024 * 1024)
            verify.verify_file(destination, pin)
    (output / 'manifest').mkdir()
    shutil.copyfile(channel, output / 'manifest/channel.json')
    (output / 'tool').mkdir()
    with tarfile.open(tool_archive) as bundle:
        members = [item for item in bundle.getmembers() if item.name == pins['toolArchive']['member']]
        if len(members) != 1 or not members[0].isfile() or members[0].size != pins['tool']['bytes']:
            raise ValueError('invalid xwin archive member')
        with bundle.extractfile(members[0]) as reader, (output / 'tool/xwin').open('xb') as writer:
            shutil.copyfileobj(reader, writer)
    receipt = verify.verify_inputs(output, pins)
    (output / 'receipt').mkdir()
    (output / 'receipt/input-verification.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--archive', type=Path, default=BASE.parent / 'offline-sdk-metadata-probe/sdk-layout-retained-inputs-36476269793.zip')
    parser.add_argument('--ucrt', type=Path, default=BASE / 'historical-ucrt-retained')
    parser.add_argument('--channel', type=Path, default=BASE.parent / 'offline-sdk-metadata-probe/channel.json')
    parser.add_argument('--tool-archive', type=Path, default=BASE.parent / 'verified-toolchain-context-offline-rust/downloads/xwin-x86_64-xwin-0.9.0-x86_64-unknown-linux-musl.tar.gz')
    args = parser.parse_args()
    result = assemble(args.output, args.archive, args.ucrt, args.channel, args.tool_archive,
                      json.loads((BASE / 'offline-xwin-input-pins.json').read_text()))
    print(json.dumps(result, indent=2))
