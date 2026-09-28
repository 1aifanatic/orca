"""Safely unpack the retained-input release asset into a fresh directory."""
from pathlib import Path
import hashlib, json, sys, tarfile

archive, destination, expected_sha256 = map(Path, sys.argv[1:])
if len(sys.argv) != 4:
    raise SystemExit("usage: unpack-inputs.py ARCHIVE DESTINATION SHA256")
if hashlib.sha256(archive.read_bytes()).hexdigest() != str(expected_sha256):
    raise ValueError("retained-input archive hash mismatch")
if destination.exists():
    raise ValueError("destination must not exist")
destination.mkdir(parents=True)
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    allowed = {member.name for member in members}
    if any(member.name.startswith("/") or ".." in Path(member.name).parts for member in members):
        raise ValueError("archive contains unsafe path")
    if any(not member.isfile() for member in members):
        raise ValueError("archive must contain regular files only")
    bundle.extractall(destination, filter="data")
    files = {path.name for path in destination.iterdir()}
if "inputs.json" not in files:
    raise ValueError("archive omitted inputs.json")
plan = json.loads((destination / "inputs.json").read_text())
expected = {asset["filename"] for asset in plan["tools"]}
expected.update(asset["cacheKey"] for asset in plan["nativePathDependencies"])
expected.add("inputs.json")
if files != expected:
    raise ValueError(f"unexpected retained inputs: {sorted(files ^ expected)}")
