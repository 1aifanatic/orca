"""Compare first-pair extracted payloads, ignoring archive timestamps."""
import gzip
import hashlib
from email.utils import parsedate_to_datetime
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess

root = Path(os.environ["RUNNER_TEMP"]) / "linux-compression-benchmark"


def manifest(directory):
    result = {}
    for path in sorted(directory.rglob("*")):
        info = path.lstat()
        name = path.relative_to(directory).as_posix()
        mode = stat.S_IMODE(info.st_mode)
        if path.is_symlink():
            result[name] = ["symlink", mode, os.readlink(path)]
        elif path.is_file():
            if name == "usr/share/doc/orca-ide/changelog.gz":
                lines = gzip.decompress(path.read_bytes()).decode().splitlines()
                dates = 0
                for index, line in enumerate(lines):
                    if line.startswith(" -- "):
                        author, date = line.rsplit("  ", 1)
                        parsedate_to_datetime(date)
                        lines[index] = author + "  <generated build date>"
                        dates += 1
                if dates != 1:
                    raise RuntimeError("Expected one generated Debian changelog date")
                result[name] = ["generated changelog", mode, lines]
                print("Comparing generated Debian changelog after normalizing its build timestamp")
            else:
                with path.open("rb") as file:
                    result[name] = ["file", mode, hashlib.file_digest(file, "sha256").hexdigest()]
        elif path.is_dir():
            result[name] = ["directory", mode]
        else:
            raise RuntimeError(f"Unexpected payload type: {path}")
    return result


for extension in ["deb", "rpm", "AppImage"]:
    manifests = []
    for variant in ["baseline", "level1"]:
        package, = (root / f"1-{variant}").glob(f"*.{extension}")
        destination = root / "extracted"
        destination.mkdir()
        if extension == "deb":
            subprocess.run(["dpkg-deb", "--extract", str(package), str(destination)], check=True)
        elif extension == "rpm":
            with subprocess.Popen(["rpm2cpio", str(package)], stdout=subprocess.PIPE) as source:
                subprocess.run(["cpio", "--quiet", "-id"], stdin=source.stdout, cwd=destination, check=True)
                source.stdout.close()
                if source.wait() != 0:
                    raise RuntimeError("rpm2cpio failed")
        else:
            subprocess.run([str(package), "--appimage-extract"], cwd=destination, check=True, stdout=subprocess.DEVNULL)
        manifests.append(manifest(destination))
        shutil.rmtree(destination)
    if manifests[0] != manifests[1]:
        changed = [key for key in manifests[0].keys() | manifests[1].keys()
                   if manifests[0].get(key) != manifests[1].get(key)]
        raise RuntimeError(f"{extension} payload mismatch: {changed[:20]}")
    print(f"{extension}: matching payload bytes, paths, modes and symlinks (generated changelog date normalized) for {len(manifests[0])} entries")
