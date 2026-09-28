"""Validate MSI Media associations before admitting any cabinet to the cache."""
from pathlib import PurePosixPath


def validate(plan, receipt):
    if receipt.get('complete') is not True:
        raise ValueError('Incomplete Media query')
    if receipt.get('readOnly') is not True or receipt.get('productInstalled') is not False:
        raise ValueError('Read-only receipt required')
    if receipt.get('catalogSha256') != plan['catalogSha256']:
        raise ValueError('Catalog mismatch')
    inputs = {p['sha256']: p for p in plan['primaryInputs']}
    databases = receipt.get('databases', [])
    if len(databases) != len(inputs) or {d['sha256'] for d in databases} != set(inputs):
        raise ValueError('Incomplete or duplicate MSI receipt')
    aliases = receipt.get('cabinetAliases', [])
    if not aliases or len(aliases) > 300:
        raise ValueError('Cabinet alias budget exceeded or empty')
    raw_rows = receipt.get('mediaRows', [])
    if not raw_rows or len(raw_rows) > 300 * len(inputs):
        raise ValueError('Missing or excessive raw Media rows')
    expected = []
    row_counts = {}
    for row in raw_rows:
        item = inputs.get(row['msiSha256'])
        if item is None or not isinstance(row['cabinet'], str):
            raise ValueError('Invalid raw Media identity')
        row_counts[item['sha256']] = row_counts.get(item['sha256'], 0) + 1
        if row['cabinet']:
            expected.append((item['sha256'], row['lastSequence'], row['cabinet']))
    actual = [(a['msiSha256'], a['lastSequence'], PurePosixPath(a['cachePath']).name) for a in aliases]
    if sorted(actual) != sorted(expected):
        raise ValueError('Cabinet aliases do not cover raw Media rows')
    paths = set()
    unique = {}
    counts = {}
    for alias in aliases:
        item = inputs.get(alias['msiSha256'])
        if item is None:
            raise ValueError('Unknown MSI')
        path = PurePosixPath(alias['cachePath'])
        if path.is_absolute() or '..' in path.parts or '\\' in str(path) or ':' in str(path):
            raise ValueError('Unsafe alias')
        if str(path) != alias['cachePath'] or path.parent != PurePosixPath(item['cachePath']).with_suffix(''):
            raise ValueError('Wrong MSI cache association')
        key = str(path).casefold()
        if key in paths:
            raise ValueError('Duplicate or case-colliding alias')
        paths.add(key)
        candidates = [c for c in plan['cabCandidates'] if c['package'] == item['package'] and PurePosixPath(c['fileName'].replace('\\', '/')).name == path.name]
        if len(candidates) != 1:
            raise ValueError('Missing or ambiguous cabinet package')
        candidate = candidates[0]
        if (alias['sha256'], alias['bytes'], alias['layoutPath']) != (candidate['sha256'], candidate['retainedBytes'], candidate['layoutPath']):
            raise ValueError('Cabinet identity mismatch')
        if type(alias['lastSequence']) is not int or alias['lastSequence'] < 0:
            raise ValueError('Invalid sequence')
        counts[item['sha256']] = counts.get(item['sha256'], 0) + 1
        unique[alias['sha256']] = alias['bytes']
    for database in databases:
        item = inputs[database['sha256']]
        if database['cachePath'] != item['cachePath'] or database['cabinets'] != counts.get(database['sha256'], 0):
            raise ValueError('Database receipt mismatch')
        if database['mediaRows'] != row_counts.get(database['sha256'], 0):
            raise ValueError('Raw Media row count mismatch')
        if not 0 <= database['cabinets'] <= database['mediaRows'] <= 300:
            raise ValueError('Invalid Media counts')
    if sum(unique.values()) > 1024 ** 3 or receipt['uniqueCabinetBytes'] != sum(unique.values()):
        raise ValueError('Cabinet byte budget or receipt mismatch')
    return aliases
