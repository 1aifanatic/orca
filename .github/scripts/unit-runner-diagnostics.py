#!/usr/bin/env python3
"""Opt-in Linux resource and signal evidence without changing test process groups."""

import json
from itertools import islice
import os
from pathlib import Path
import re
import secrets
import selectors
import signal
import subprocess
import sys
import threading
import time

PREFIX = "[unit-runner-diag] "
SIGNALS = (1, 2, 3, 9, 15)
TRACE_ROOTS = (Path("/sys/kernel/tracing/instances"), Path("/sys/kernel/debug/tracing/instances"))


def emit(kind, **fields):
    try:
        os.write(sys.stdout.fileno(), (PREFIX + json.dumps({"kind": kind, "time": time.time(), **fields}) + "\n").encode())
    except (OSError, ValueError):
        pass


def read_text(path):
    try:
        with Path(path).open() as file:
            return file.read(65536)
    except (OSError, UnicodeError):
        return ""


def process_stat(text):
    prefix, rest = text.split("(", 1)
    comm, fields = rest.rsplit(")", 1)
    values = fields.split()
    return {"pid": int(prefix), "ppid": int(values[1]), "pgid": int(values[2]),
            "session": int(values[3]), "rss_kib": int(values[21]) * os.sysconf("SC_PAGE_SIZE") // 1024,
            "comm": comm}


def resource_snapshot(child_pid):
    processes = {}
    entries = list(islice(Path("/proc").iterdir(), 8193))
    for entry in entries[:8192]:
        if entry.name.isdigit():
            try:
                row = process_stat(read_text(entry / "stat"))
                processes[row["pid"]] = row
            except (ValueError, IndexError):
                pass
    owned = {os.getpid(), child_pid}
    for _ in range(32):
        additions = {pid for pid, row in processes.items() if row["ppid"] in owned}
        if additions <= owned:
            break
        owned |= additions
    important = owned | {pid for pid, row in processes.items() if row["comm"].startswith("Runner.")}
    ancestor = os.getpid()
    for _ in range(32):
        important.add(ancestor)
        ancestor = processes.get(ancestor, {}).get("ppid", 0)
        if not ancestor:
            break
    ranked = sorted(processes.values(), key=lambda row: (row["pid"] not in important, -row["rss_kib"]))
    memory = read_text("/proc/meminfo")
    available = re.search(r"^MemAvailable:\s+(\d+)", memory, re.M)
    total = re.search(r"^MemTotal:\s+(\d+)", memory, re.M)
    oom = re.search(r"^oom_kill\s+(\d+)", read_text("/proc/vmstat"), re.M)
    cgroup = next((line[3:] for line in read_text("/proc/self/cgroup").splitlines() if line.startswith("0::")), "/")
    if ".." in Path(cgroup).parts:
        cgroup = "/"
    cgroup_path = Path("/sys/fs/cgroup") / cgroup.lstrip("/")
    return {"mem_available_kib": int(available[1]) if available else None,
            "mem_total_kib": int(total[1]) if total else None,
            "kernel_oom_kill": int(oom[1]) if oom else None,
            "cgroup_memory_events": read_text(cgroup_path / "memory.events").strip(),
            "cgroup_memory": {key: read_text(cgroup_path / f"memory.{key}").strip() for key in ("current", "max", "peak")},
            "sampled_process_count": len(processes), "process_scan_truncated": len(entries) > 8192,
            "omitted_processes": max(0, len(ranked) - 160), "owned_ids_truncated": len(owned) > 256,
            "owned_child_ids": sorted(owned)[:256], "processes": ranked[:160]}


def trace_path(name):
    if not re.fullmatch(r"orca-unit-\d+-[0-9a-f]{16}", name):
        raise ValueError("Invalid private trace instance")
    root = next((root for root in TRACE_ROOTS if root.is_dir()), None)
    if root is None:
        raise OSError("tracefs unavailable")
    return root / name


def cleanup_instance(path):
    for file in (path / "tracing_on", path / "events/signal/signal_generate/enable"):
        if file.exists():
            file.write_text("0")
    if path.exists():
        path.rmdir()


def signal_record(line):
    event = re.search(r"signal_generate: sig=(\d+).*?comm=(.*?) pid=(\d+)", line)
    sender = re.search(r"^\s*(.*?)\s*-(\d+)(?:\s+\([^)]*\))?\s+\[", line)
    stamp = re.search(r"\s(\d+\.\d+):\s+signal_generate:", line)
    if not event or not sender or int(event[1]) not in SIGNALS:
        return None
    def owner(tid):
        match = re.search(r"^Tgid:\s+(\d+)", read_text(f"/proc/{tid}/status"), re.M)
        return int(match[1]) if match else None
    sender_tid, target_tid = int(sender[2]), int(event[3])
    details = {key: int(value) for key, value in re.findall(r"\b(errno|code|grp|res)=(-?\d+)", line)}
    return {"signal": int(event[1]), "sender_tid": sender_tid, "sender_pid": owner(sender_tid),
            "sender_comm": sender[1].strip(), "target_tid": target_tid, "target_pid": owner(target_tid),
            "target_comm": event[2], "kernel_time": stamp[1] if stamp else None, **details}


def complete_lines(data, carry):
    lines = (carry + data).split(b"\n")
    return [line.decode("utf-8", "replace") for line in lines[:-1]], lines[-1][-4096:]


def trace_helper(name):
    path, created, stopped, selector = None, False, False, None
    descriptors = []
    carries = {}
    def stop(_signum, _frame):
        nonlocal stopped
        stopped = True
    for signum in SIGNALS:
        if signum != 9:
            signal.signal(signum, stop)
    try:
        path = trace_path(name)
        path.mkdir()
        created = True
        emit("trace_created", instance=name, helper_pid=os.getpid())
        event = path / "events/signal/signal_generate"
        (event / "filter").write_text(" || ".join(f"sig == {int(sig)}" for sig in SIGNALS))
        (event / "enable").write_text("1")
        (path / "tracing_on").write_text("1")
        trace = os.open(path / "trace_pipe", os.O_RDONLY | os.O_NONBLOCK)
        descriptors.append(trace)
        selector = selectors.DefaultSelector()
        selector.register(trace, selectors.EVENT_READ, "signal")
        selector.register(sys.stdin, selectors.EVENT_READ, "control")
        try:
            kernel = os.open("/dev/kmsg", os.O_RDONLY | os.O_NONBLOCK)
            descriptors.append(kernel)
            os.lseek(kernel, 0, os.SEEK_END)
            selector.register(kernel, selectors.EVENT_READ, "oom")
        except OSError:
            emit("kernel_log_unavailable", counters_available=True)
        emit("trace_ready", instance=name)
        while not stopped:
            for key, _ in selector.select(1):
                if key.data == "control":
                    stopped = True
                    break
                try:
                    data = os.read(key.fd, 16384)
                except BlockingIOError:
                    continue
                lines, carries[key.fd] = complete_lines(data, carries.get(key.fd, b""))
                for line in lines:
                    record = signal_record(line) if key.data == "signal" else None
                    if record:
                        emit("signal", **record)
                    elif key.data == "oom" and re.search(r"oom-kill:|Out of memory:|Killed process", line):
                        victim = re.search(r"Killed process (\d+) \(([^)]*)\)", line)
                        emit("kernel_oom", target_pid=int(victim[1]) if victim else None,
                             comm=victim[2] if victim else None)
        # Drain the signal that stopped this helper before disabling its instance.
        try:
            lines, _ = complete_lines(os.read(trace, 16384), carries.get(trace, b""))
            for line in lines:
                record = signal_record(line)
                if record:
                    emit("signal", **record)
        except BlockingIOError:
            pass
    except Exception as error:
        emit("trace_unavailable", error=type(error).__name__, mode="resource_only")
    finally:
        if selector is not None:
            try:
                selector.close()
            except Exception:
                pass
        for fd in descriptors:
            try:
                os.close(fd)
            except OSError:
                pass
        if created:
            try:
                cleanup_instance(path)
                emit("trace_cleaned", instance=name)
            except Exception as error:
                emit("trace_cleanup_unavailable", error=type(error).__name__)


def start_trace():
    name = f"orca-unit-{os.getpid()}-{secrets.token_hex(8)}"
    created = threading.Event()
    outcome = threading.Event()
    ready = threading.Event()
    identity = {}
    helper = subprocess.Popen(["sudo", "-n", sys.executable, str(Path(__file__).resolve()), "--trace-helper", name],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    def relay():
        try:
            for raw in helper.stdout:
                line = raw.decode("utf-8", "replace")
                if line.startswith(PREFIX):
                    try:
                        message = json.loads(line[len(PREFIX):])
                        if message.get("kind") == "trace_created" and message.get("instance") == name:
                            identity["helper_pid"] = message.get("helper_pid")
                            created.set()
                        if message.get("kind") == "trace_cleaned" and message.get("instance") == name:
                            identity["cleaned"] = True
                        if message.get("kind") == "trace_ready" and message.get("instance") == name:
                            ready.set()
                            outcome.set()
                        if message.get("kind") == "trace_unavailable":
                            outcome.set()
                    except ValueError:
                        continue
                    try:
                        os.write(sys.stdout.fileno(), raw)
                    except (OSError, ValueError):
                        pass
                else:
                    emit("trace_unavailable", mode="resource_only", error="sudo_or_helper_error")
                    outcome.set()
        except Exception as error:
            emit("trace_unavailable", mode="resource_only", error=type(error).__name__)
        finally:
            outcome.set()
    thread = threading.Thread(target=relay, daemon=True)
    state = helper, thread, created, name, identity
    try:
        thread.start()
        outcome.wait(timeout=3)
    except Exception as error:
        emit("trace_unavailable", mode="resource_only", error=type(error).__name__)
    if not ready.is_set():
        emit("trace_unavailable", mode="resource_only", error="trace_not_ready")
        stop_trace(state)
        return None
    return state


def stop_trace(state):
    if state is None:
        return
    helper, thread, created, name, identity = state
    try:
        try:
            helper.stdin.close()
        except (OSError, ValueError):
            pass
        for signum in (None, 15, 9):
            if signum is not None and helper.poll() is None and helper.pid > 0:
                try:
                    os.kill(helper.pid, signum)
                except PermissionError:
                    # An unreaped owned sudo PID cannot be reused by another process.
                    result = subprocess.run(["sudo", "-n", "kill", f"-{signum}", str(helper.pid)],
                                            timeout=3, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                    if result.returncode:
                        emit("trace_cleanup_unavailable", code=result.returncode, helper_pid=helper.pid)
            try:
                helper.wait(timeout=3)
                break
            except subprocess.TimeoutExpired:
                if signum == 9:
                    emit("trace_cleanup_unavailable", error="helper_still_running", helper_pid=helper.pid)
        thread.join(timeout=1)
        if helper.returncode:
            emit("trace_unavailable", mode="resource_only", code=helper.returncode)
    except Exception as error:
        emit("trace_cleanup_unavailable", error=type(error).__name__)
    finally:
        if thread.is_alive() or (created.is_set() and not identity.get("cleaned")):
            emit("trace_teardown_unverified", helper_pid=identity.get("helper_pid"))
        if created.is_set():
            try:
                cleanup = subprocess.run(["sudo", "-n", sys.executable, str(Path(__file__).resolve()), "--trace-cleanup", name],
                                         timeout=3, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                emit("trace_instance_cleanup", verified=cleanup.returncode == 0, code=cleanup.returncode)
                if cleanup.returncode:
                    emit("trace_cleanup_unavailable", code=cleanup.returncode)
            except Exception as error:
                emit("trace_cleanup_unavailable", error=type(error).__name__)


def monitor(command):
    trace, child = None, None
    previous = {}
    interrupted = 0
    def forward(signum, _frame):
        nonlocal interrupted
        interrupted = signum
        emit("monitor_signal", signal=signum, child_pid=child.pid if child else None)
        if child is not None and child.pid > 0 and child.poll() is None:
            try:
                os.kill(child.pid, signum)
            except OSError:
                pass
    try:
        for signum in SIGNALS:
            if signum != 9:
                previous[signum] = signal.signal(signum, forward)
        try:
            trace = start_trace()
        except Exception as error:
            emit("trace_unavailable", error=type(error).__name__, mode="resource_only")
        if interrupted:
            return 128 + interrupted
        child = subprocess.Popen(command)
        if interrupted:
            forward(interrupted, None)
        next_sample = 0
        while child.poll() is None:
            if time.monotonic() >= next_sample:
                try:
                    emit("resources", **resource_snapshot(child.pid))
                except Exception as error:
                    emit("resources_unavailable", error=type(error).__name__)
                next_sample = time.monotonic() + 5
            time.sleep(0.2)
        return child.returncode if child.returncode >= 0 else 128 - child.returncode
    finally:
        try:
            stop_trace(trace)
        except Exception as error:
            emit("trace_cleanup_unavailable", error=type(error).__name__)
        finally:
            for signum, handler in previous.items():
                signal.signal(signum, handler)


def main(argv):
    if len(argv) == 2 and argv[0] == "--trace-helper":
        trace_helper(argv[1])
        return 0
    if len(argv) == 2 and argv[0] == "--trace-cleanup":
        try:
            cleanup_instance(trace_path(argv[1]))
        except (OSError, ValueError):
            return 1
        return 0
    command = argv[1:] if argv[:1] == ["--"] else argv
    if not command:
        raise SystemExit("Expected a command")
    if sys.platform != "linux" or os.environ.get("ORCA_UNIT_RUNNER_DIAGNOSTICS") != "1":
        os.execvp(command[0], command)
    return monitor(command)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
