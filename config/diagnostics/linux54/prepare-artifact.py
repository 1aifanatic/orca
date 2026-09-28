#!/usr/bin/env python3
"""Reject incomplete/wrong-source CI packages before any image download or guest boot."""
import argparse, json, pathlib, subprocess, tarfile
p=argparse.ArgumentParser()
p.add_argument('--directory',type=pathlib.Path,required=True)
p.add_argument('--output',type=pathlib.Path,required=True)
p.add_argument('--sha',required=True)
p.add_argument('--arch',choices=['x64','arm64'],required=True)
a=p.parse_args()
archives=list(a.directory.rglob('unpacked-'+a.arch+'.tar.gz'))
assert len(archives)==1, 'Expected exactly one completed unpacked archive'
archive=archives[0];evidence=archive.parent
assert (evidence/'source-commit.txt').read_text().strip()==a.sha,'Artifact source mismatch'
for name in ['payload-sha256.txt','archive-sha256.txt','floor-smoke.log']:
 assert (evidence/name).is_file(),'Missing package evidence: '+name
rows=(evidence/'archive-sha256.txt').read_text().splitlines()
assert len(rows)==1 and rows[0].split()[1].lstrip('*')==archive.name,'Unexpected archive manifest'
subprocess.run(['sha256sum','--quiet','--check','archive-sha256.txt'],cwd=evidence,check=True,timeout=120)
reports=[]
for line in (evidence/'floor-smoke.log').read_text().splitlines():
 try: reports.append(json.loads(line))
 except ValueError: pass
assert any(isinstance(x,dict) and x.get('passed') is True and x.get('arch')==a.arch for x in reports),'Package userspace smoke did not complete successfully'
assert not a.output.exists(),'Use a fresh extraction directory'
a.output.mkdir(parents=True)
with tarfile.open(archive,'r:gz') as tar:
 members=tar.getmembers()
 assert len(members)<100000,'Too many archive entries'
 assert sum(m.size for m in members)<8*1024**3,'Archive exceeds 8GiB expanded limit'
 for member in members:
  parts=pathlib.PurePosixPath(member.name)
  assert not parts.is_absolute() and '..' not in parts.parts,'Unsafe archive path'
 tar.extractall(a.output,members=members,filter='data')
print(json.dumps({'archive':str(archive.resolve()),'evidence':str(evidence.resolve()),'app':str(a.output.resolve())}))
