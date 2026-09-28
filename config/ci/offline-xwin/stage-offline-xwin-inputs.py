"""Connected CI preparation; fetched bytes are pinned before offline qualification."""
import argparse
import importlib.util
import json
from pathlib import Path
import time
import urllib.request
import zipfile

BASE = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, BASE / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


assembler = module('assemble', 'assemble-qualified-xwin-cache.py')
ucrt = module('ucrt', 'acquire-historical-ucrt.py')
XWIN_URL = 'https://github.com/Jake-Shadle/xwin/releases/download/0.9.0/xwin-0.9.0-x86_64-unknown-linux-musl.tar.gz'


def stage(archive, destination):
    pins = json.loads((BASE / 'offline-xwin-input-pins.json').read_text())
    assembler.verify.verify_file(archive, pins['sourceArchive'])
    destination.mkdir(parents=True, exist_ok=False)
    with zipfile.ZipFile(archive) as bundle:
        catalog = bundle.read('Catalog.json')
        channel = bundle.read('ChannelManifest.json')
    # select verifies the authenticated catalog digest before reading any download URLs.
    payloads = ucrt.select(catalog)
    channel_path = destination / 'channel.json'
    channel_path.write_bytes(channel)
    assembler.verify.verify_file(channel_path, pins['channel'])
    retained = destination / 'ucrt'
    retained.mkdir()
    opener = urllib.request.build_opener(ucrt.Redirect())
    deadline = time.monotonic() + 900
    for payload in payloads:
        with opener.open(payload['url'], timeout=30) as response:
            ucrt.validate_url(response.geturl())
            ucrt.retain(response, retained / payload['fileName'], payload, deadline)
    tool = destination / 'xwin.tar.gz'
    tool_pin = pins['toolArchive']
    with urllib.request.urlopen(XWIN_URL, timeout=30) as response:
        ucrt.retain(response, tool, {'size': tool_pin['bytes'], 'sha256': tool_pin['sha256']}, deadline)
    return assembler.assemble(destination / 'inputs', archive, retained, channel_path, tool, pins)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--layout-archive', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(stage(args.layout_archive, args.destination), indent=2))
