#!/usr/bin/env python3
"""Local, nonpublishing actual-kernel qualification; requires a Linux QEMU host."""
import argparse, hashlib, json, os, pathlib, platform, shlex, shutil, signal, subprocess, time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PINS = json.loads((HERE / 'inputs.json').read_text())


def run(args, timeout=60, **kwargs):
    return subprocess.run(args, check=True, timeout=timeout, **kwargs)


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def fetch(pin, directory):
    target = directory / pin['name']
    if target.exists() and digest(target) == pin['sha256']:
        return target
    temporary = target.with_suffix(target.suffix + '.partial')
    try:
        run(['curl', '--fail', '--location', '--proto', '=https', '--connect-timeout', '20',
             '--max-time', '600', '--max-filesize', str(pin['maxBytes']),
             '--output', str(temporary), pin['url']], timeout=610)
        if digest(temporary) != pin['sha256']:
            raise RuntimeError('Pinned Ubuntu image checksum mismatch: ' + pin['name'])
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def guest_script():
    return '''#!/bin/bash
set -euo pipefail
export ORCA_BACKGROUND_LAUNCH=1 ELECTRON_RUN_AS_NODE=1 DEBIAN_FRONTEND=noninteractive
trap 'rc=$?; echo ORCA_LINUX54_EXIT=$rc; sync; poweroff -f' EXIT
uname -a
getconf GNU_LIBC_VERSION
test "$(uname -r)" = "5.4.0-216-generic"
test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.31"
# Required filesystem transports must load from this exact kernel's module tree.
grep -E 'CONFIG_(9P_FS|NET_9P|NET_9P_VIRTIO)=' /boot/config-$(uname -r)
modprobe 9pnet_virtio
modprobe 9p
grep -w 9p /proc/filesystems
mkdir -p /artifact /qualification
mount -t 9p -o trans=virtio,version=9p2000.L,ro artifact /artifact
mount -t 9p -o trans=virtio,version=9p2000.L,ro qualification /qualification
dpkg-query -W -f='${Package} ${Version}\\n' | sort > /root/packages-before.txt
# No upgrade: preserve the pinned kernel and glibc packages.
timeout 180 apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=20 update -qq
timeout 300 apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=20 install -y -qq --no-install-recommends ca-certificates libasound2 libatspi2.0-0 libdrm2 libgbm1 libgtk-3-0 libnss3 libx11-xcb1 libxkbcommon0 libxss1
dpkg-query -W -f='${Package} ${Version}\\n' | sort > /root/packages-after.txt
echo ORCA_GUEST_PACKAGE_CHANGES_BEGIN
diff -u /root/packages-before.txt /root/packages-after.txt || test $? = 1
echo ORCA_GUEST_PACKAGE_CHANGES_END
uname -a
test "$(uname -r)" = "5.4.0-216-generic"
test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.31"
sha256sum /artifact/orca-ide /artifact/resources/cli-runtime/bun-runtime /artifact/resources/terminal-daemon/daemon-entry.js
/ artifact-placeholder
'''.replace('/ artifact-placeholder', '''timeout 240 /artifact/orca-ide -e 'require(process.argv[1]).qualifyPackagedTerminal(process.argv[2]).then(report=>console.log(JSON.stringify(report)),error=>{console.error(error);process.exitCode=1})' /qualification/packaged-terminal-floor.cjs /artifact/resources
printf 'ORCA_LINUX54_SUCCESS\\n' ''')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', type=pathlib.Path, default=ROOT)
    parser.add_argument('--expected-source')
    parser.add_argument('--arch', choices=['amd64', 'arm64'], required=True)
    parser.add_argument('--app-dir', type=pathlib.Path, required=True)
    parser.add_argument('--work-dir', type=pathlib.Path, required=True)
    parser.add_argument('--artifact-source-file', type=pathlib.Path)
    parser.add_argument('--artifact-manifest', type=pathlib.Path)
    parser.add_argument('--accel', choices=['auto', 'kvm', 'tcg'], default='auto')
    parser.add_argument('--plan-only', action='store_true')
    args = parser.parse_args()
    root = args.source_root.resolve()
    app = args.app_dir.resolve()
    work = args.work_dir.resolve()
    if ',' in str(app) or ',' in str(work):
        raise ValueError('QEMU paths must not contain commas')
    native = {'x86_64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
    kvm = native == args.arch and os.access('/dev/kvm', os.R_OK | os.W_OK)
    accel = ('kvm' if kvm else 'tcg') if args.accel == 'auto' else args.accel
    if accel == 'kvm' and not kvm:
        raise RuntimeError('KVM requested but matching-architecture /dev/kvm unavailable')
    report = {'architecture': args.arch, 'acceleration': accel, 'memoryMiB': 3072,
              'cpus': 2, 'vmDeadlineSeconds': 900 if accel == 'kvm' else 1500,
              'rootfs': PINS['images'][args.arch], 'status': 'prepared-not-run'}
    if args.plan_only:
        print(json.dumps(report, indent=2))
        return
    if work.exists():
        raise RuntimeError('Use a fresh work directory; preserve each previous receipt')
    work.mkdir(parents=True)
    try:
        if platform.system() != 'Linux':
            raise RuntimeError('Use a Linux qualification host; this harness starts no local Mac apps')
        emulator = 'qemu-system-x86_64' if args.arch == 'amd64' else 'qemu-system-aarch64'
        for binary in [emulator, 'qemu-img', 'cloud-localds', 'curl', 'gpgv', 'node']:
            if not shutil.which(binary):
                raise RuntimeError('Missing prerequisite: ' + binary)
        # The runner must supply its trusted Ubuntu cloud-image keyring, never a key downloaded here.
        keyring = pathlib.Path('/usr/share/keyrings/ubuntu-cloudimage-keyring.gpg')
        if not keyring.exists():
            raise RuntimeError('Install ubuntu-cloudimage-keyring before running')
        report['sourceCommit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
        if not args.expected_source or len(args.expected_source) != 40 or any(c not in '0123456789abcdef' for c in args.expected_source):
            raise RuntimeError('Expected production source must be an explicit full commit hash')
        if report['sourceCommit'] != args.expected_source:
            raise RuntimeError('Qualification checkout differs from requested production source')
        report['requestedProductionSource'] = args.expected_source
        if not args.artifact_source_file or not args.artifact_manifest:
            raise RuntimeError('Supply CI source-commit.txt and payload-sha256.txt with final artifact')
        artifact_source = args.artifact_source_file.read_text().strip()
        if artifact_source != report['sourceCommit']:
            raise RuntimeError('Artifact source and qualification checkout differ')
        report['artifactSource'] = artifact_source
        report['payloadManifestSha256'] = digest(args.artifact_manifest)
        manifest = args.artifact_manifest.resolve()
        for line in manifest.read_text().splitlines():
            name = line.split(maxsplit=1)[1].lstrip('*')
            if pathlib.PurePosixPath(name).is_absolute() or '..' in pathlib.PurePosixPath(name).parts:
                raise RuntimeError('Unsafe artifact manifest path')
        run(['sha256sum', '--quiet', '--check', str(manifest)], cwd=app, timeout=180)
        report['artifacts'] = {}
        for relative in ['orca-ide', 'resources/cli-runtime/bun-runtime', 'resources/terminal-daemon/daemon-entry.js']:
            report['artifacts'][relative] = digest(app / relative)
        if shutil.disk_usage(work).free < 16 * 1024**3:
            raise RuntimeError('At least 16 GiB free disk required')
        # Authenticate checksum files with distro-provided trust, then require the frozen hashes.
        for prefix in ['', '/unpacked']:
            name = 'root' if not prefix else 'unpacked'
            sums, signature = work / (name + '.sums'), work / (name + '.gpg')
            for target, suffix in [(sums, 'SHA256SUMS'), (signature, 'SHA256SUMS.gpg')]:
                run(['curl', '-fL', '--proto', '=https', '--max-time', '30', '--max-filesize', '100000',
                     PINS['source'] + prefix + '/' + suffix, '-o', str(target)], timeout=35)
            run(['gpgv', '--keyring', str(keyring), str(signature), str(sums)])
            contents = dict((line.split()[1].lstrip('*'), line.split()[0]) for line in sums.read_text().splitlines())
            for kind, pin in PINS['images'][args.arch].items():
                if (kind == 'disk') == (prefix == '') and contents.get(pin['name']) != pin['sha256']:
                    raise RuntimeError('Signed manifest disagrees with frozen input pin')
        downloaded = {kind: fetch(pin, work) for kind, pin in PINS['images'][args.arch].items()}
        overlay = work / 'guest.qcow2'
        run(['qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b', str(downloaded['disk']), str(overlay)])
        run(['qemu-img', 'resize', str(overlay), '12G'])
        fixture = work / 'fixture'
        fixture.mkdir()
        module = (root / 'config/scripts/run-linux-packaged-terminal-floor-smoke.mjs').as_uri()
        run(['node', '--input-type=module', '-e', f'import {{buildPackagedTerminalFloorFixture}} from {json.dumps(module)}; await buildPackagedTerminalFloorFixture(process.argv[1]);', str(fixture)], timeout=90, cwd=root)
        report['fixtureSha256'] = digest(fixture / 'packaged-terminal-floor.cjs')
        script = guest_script()
        user = work / 'user-data'
        user.write_text('#cloud-config\npackage_update: false\npackage_upgrade: false\nwrite_files:\n  - path: /root/qualify.sh\n    permissions: "0700"\n    content: |\n' + ''.join('      ' + line + '\n' for line in script.splitlines()) + 'runcmd:\n  - [bash, -c, "bash /root/qualify.sh > /dev/console 2>&1"]\n')
        (work / 'meta-data').write_text('instance-id: orca-linux54\nlocal-hostname: orca-linux54\n')
        seed = work / 'seed.img'
        run(['cloud-localds', str(seed), str(user), str(work / 'meta-data')])
        machine = ['-machine', 'q35'] if args.arch == 'amd64' else ['-machine', 'virt']
        cpu = 'host' if accel == 'kvm' else ('max' if args.arch == 'amd64' else 'cortex-a72')
        console = 'ttyS0' if args.arch == 'amd64' else 'ttyAMA0'
        command = [emulator, *machine, '-accel', accel, '-cpu', cpu, '-smp', '2', '-m', '3072',
                   '-display', 'none', '-monitor', 'none', '-serial', 'stdio', '-no-reboot',
                   '-kernel', str(downloaded['kernel']), '-initrd', str(downloaded['initrd']),
                   '-append', f'root=LABEL=cloudimg-rootfs rw console={console} ds=nocloud',
                   '-drive', f'file={overlay},format=qcow2,if=virtio',
                   '-drive', f'file={seed},format=raw,if=virtio,readonly=on',
                   '-netdev', 'user,id=net', '-device', 'virtio-net-pci,netdev=net',
                   '-virtfs', f'local,path={app},mount_tag=artifact,security_model=none,readonly=on',
                   '-virtfs', f'local,path={fixture},mount_tag=qualification,security_model=none,readonly=on']
        report['command'] = command
        log_path = work / 'serial.log'
        with log_path.open('wb') as log:
            child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + report['vmDeadlineSeconds']
            try:
                while child.poll() is None:
                    if time.monotonic() > deadline or log_path.stat().st_size > 16 * 1024**2:
                        raise RuntimeError('Guest exceeded wall-clock/log bound')
                    time.sleep(1)
                if child.returncode != 0:
                    raise RuntimeError('QEMU exited nonzero: ' + str(child.returncode))
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=5)
                report['qemuExitCode'] = child.returncode
        output = log_path.read_text(errors='replace')
        if '\nORCA_LINUX54_SUCCESS' not in output or 'ORCA_LINUX54_EXIT=0' not in output:
            raise RuntimeError('No completed guest qualification receipt; inspect serial.log')
        for relative, expected in report['artifacts'].items():
            if digest(app / relative) != expected:
                raise RuntimeError('Artifact changed during qualification: ' + relative)
        run(['sha256sum', '--quiet', '--check', str(manifest)], cwd=app, timeout=180)
        report['status'] = 'passed'
    except BaseException as error:
        report['status'] = 'failed'
        report['error'] = str(error)
        raise
    finally:
        if 'downloaded' in locals():
            report['baseImagesUnchanged'] = all(digest(file) == PINS['images'][args.arch][kind]['sha256'] for kind, file in downloaded.items())
            if not report['baseImagesUnchanged']:
                report['status'] = 'failed'
                report['error'] = 'Immutable base image bytes changed'
        (work / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
        if report.get('baseImagesUnchanged') is False:
            raise RuntimeError('Immutable base image bytes changed')


if __name__ == '__main__':
    def terminate(signum, frame):
        # Let the owned-process cleanup and receipt finally blocks run on CI cancellation.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise RuntimeError('Qualification harness received SIGTERM')
    signal.signal(signal.SIGTERM, terminate)
    main()
