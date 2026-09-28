"""Acquire only pinned diagnostic inputs; execute nothing before validation."""
from pathlib import Path
import hashlib, json, sys, time, urllib.parse, urllib.request

HOSTS = {'pub-5e11e972747a44bf9aaf9394f185a982.r2.dev', 'nodejs.org',
         'static.rust-lang.org', 'github.com', 'codeload.github.com',
         'release-assets.githubusercontent.com'}

def check_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in HOSTS or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('Unexpected download origin')

class Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        check_url(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)

def retain(response, output, expected_bytes, expected_hash):
    declared = response.headers.get('Content-Length')
    if declared and int(declared) != expected_bytes:
        raise ValueError('Unexpected declared payload size')
    count = 0
    digest = hashlib.sha256()
    started = time.monotonic()
    with output.open('xb') as destination:
        while chunk := response.read(1024 * 1024):
            count += len(chunk)
            if count > expected_bytes:
                raise ValueError('Oversized payload')
            if time.monotonic() - started > 600:
                raise TimeoutError('Payload deadline expired')
            digest.update(chunk)
            destination.write(chunk)
    if count != expected_bytes or digest.hexdigest() != expected_hash:
        raise ValueError('Payload hash or size mismatch')

def main(destination):
    plan = json.loads(Path(__file__).with_name('inputs.json').read_text())
    assets = plan['tools'] + plan['nativePathDependencies']
    if len(assets) != 10 or sum(a.get('size', a.get('bytes')) for a in assets) > 300 * 1024 * 1024:
        raise ValueError('Unexpected acquisition envelope')
    destination.mkdir()
    opener = urllib.request.build_opener(Redirects())
    receipts = []
    for asset in assets:
        name = asset.get('filename', asset.get('cacheKey'))
        check_url(asset['url'])
        partial = destination / (name + '.partial')
        request = urllib.request.Request(asset['url'], headers={'User-Agent': 'orca-bun-diagnostic/1.0'})
        with opener.open(request, timeout=30) as response:
            check_url(response.url)
            retain(response, partial, asset.get('size', asset.get('bytes')), asset['sha256'])
            final_url = response.url
        partial.rename(destination / name)
        receipts.append({'name': name, 'sha256': asset['sha256'], 'bytes': asset.get('size', asset.get('bytes')), 'url': final_url})
        (destination / 'acquisition.json').write_text(json.dumps(receipts, indent=2) + '\n')

if __name__ == '__main__':
    main(Path(sys.argv[1]))
