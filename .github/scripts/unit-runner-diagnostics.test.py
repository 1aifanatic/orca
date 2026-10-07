#!/usr/bin/env python3
"""Safe unit checks: no real process signals, privilege calls, or kernel tracing."""

import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("diagnostics", Path(__file__).with_name("unit-runner-diagnostics.py"))
DIAG = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIAG)


def stat(pid, comm, parent, group, session, pages):
    fields = ["S", str(parent), str(group), str(session)] + ["0"] * 18
    fields[21] = str(pages)
    return f"{pid} ({comm}) {' '.join(fields)}"


class DiagnosticSafetyTests(unittest.TestCase):
    def test_disabled_and_non_linux_exec_exact_command_without_helpers(self):
        for platform, enabled in (("linux", "0"), ("darwin", "1"), ("win32", "1")):
            with self.subTest(platform=platform), patch.object(DIAG.sys, "platform", platform), \
                    patch.dict(os.environ, {"ORCA_UNIT_RUNNER_DIAGNOSTICS": enabled}), \
                    patch.object(DIAG.os, "execvp", side_effect=RuntimeError("exec sentinel")) as execute, \
                    patch.object(DIAG, "monitor") as monitor, patch.object(DIAG, "emit") as emit:
                with self.assertRaisesRegex(RuntimeError, "exec sentinel"):
                    DIAG.main(["--", "node", "script with spaces.js", "--shard=2/5"])
                execute.assert_called_once_with("node", ["node", "script with spaces.js", "--shard=2/5"])
                monitor.assert_not_called()
                emit.assert_not_called()

    def test_process_stat_parses_parenthesized_comm_and_rss_only(self):
        with patch.object(DIAG.os, "sysconf", return_value=4096, create=True):
            self.assertEqual(DIAG.process_stat(stat(42, "Bun (GC thread)", 7, 8, 9, 12)),
                             {"pid": 42, "ppid": 7, "pgid": 8, "session": 9,
                              "rss_kib": 48, "comm": "Bun (GC thread)"})

    def test_signal_generation_distinguishes_threads_and_live_process_ownership(self):
        line = " Bun GC-314 ( 300) [001] d..2 123.456: signal_generate: sig=9 errno=0 code=0 comm=Runner.Worker pid=271 grp=1 res=2"
        with patch.object(DIAG, "read_text", side_effect=["Tgid:\t300\n", ""]):
            record = DIAG.signal_record(line)
        self.assertEqual(record, {"signal": 9, "sender_tid": 314, "sender_pid": 300,
                                  "sender_comm": "Bun GC", "target_tid": 271, "target_pid": None,
                                  "target_comm": "Runner.Worker", "kernel_time": "123.456",
                                  "errno": 0, "code": 0, "grp": 1, "res": 2})
        with patch.object(DIAG, "read_text") as read:
            self.assertIsNone(DIAG.signal_record(line.replace("sig=9", "sig=17")))
            read.assert_not_called()

    def test_partial_trace_chunks_preserve_complete_events(self):
        first, carry = DIAG.complete_lines(b"first\npart", b"")
        second, carry = DIAG.complete_lines(b"ial\nlast", carry)
        self.assertEqual(first + second, ["first", "partial"])
        self.assertEqual(carry, b"last")
        self.assertEqual(len(DIAG.complete_lines(b"x" * 20000, b"")[1]), 4096)

    def test_closed_logging_pipe_is_best_effort(self):
        with patch.object(DIAG.os, "write", side_effect=BrokenPipeError):
            DIAG.emit("resources", mem_available_kib=1)
        with patch.object(DIAG.sys, "stdout", io.StringIO()):
            DIAG.emit("monitor_signal", signal=15)

    def test_trace_names_cannot_escape_private_instances(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(DIAG, "TRACE_ROOTS", (Path(directory),)):
            name = "orca-unit-123-0123456789abcdef"
            self.assertEqual(DIAG.trace_path(name), Path(directory) / name)
            for invalid in ("../tracing_on", name + "/../global", "orca-unit-0-no-token"):
                with self.assertRaises(ValueError):
                    DIAG.trace_path(invalid)

    def test_resource_sample_tracks_owned_descendants_and_no_command_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = {101: stat(101, "python3", 100, 7, 7, 1),
                    102: stat(102, "node", 101, 7, 7, 2),
                    103: stat(103, "bun", 102, 7, 7, 3),
                    104: stat(104, "Runner.Worker", 1, 7, 7, 4)}
            for pid in rows:
                (root / str(pid)).mkdir()
            def read(path):
                name = Path(path).as_posix()
                if Path(path).name == "stat":
                    return rows[int(Path(path).parent.name)]
                return {"/proc/meminfo": "MemTotal: 8192 kB\nMemAvailable: 1024 kB\n",
                        "/proc/vmstat": "oom_kill 2\n", "/proc/self/cgroup": "0::/runner\n",
                        "/sys/fs/cgroup/runner/memory.current": "512",
                        "/sys/fs/cgroup/runner/memory.max": "1024",
                        "/sys/fs/cgroup/runner/memory.peak": "768",
                        "/sys/fs/cgroup/runner/memory.events": "oom_kill 1"}.get(name, "")
            def path(value):
                return root if value == "/proc" else Path(value)
            with patch.object(DIAG, "Path", side_effect=path), patch.object(DIAG, "read_text", side_effect=read), \
                    patch.object(DIAG.os, "getpid", return_value=101), patch.object(DIAG.os, "sysconf", return_value=4096, create=True):
                sample = DIAG.resource_snapshot(102)
            self.assertEqual(sample["owned_child_ids"], [101, 102, 103])
            self.assertEqual(sample["cgroup_memory"], {"current": "512", "max": "1024", "peak": "768"})
            self.assertEqual((sample["mem_available_kib"], sample["mem_total_kib"], sample["kernel_oom_kill"]), (1024, 8192, 2))
            self.assertFalse(sample["process_scan_truncated"])
            self.assertEqual(sample["sampled_process_count"], 4)
            for row in sample["processes"]:
                self.assertEqual(set(row), {"pid", "ppid", "pgid", "session", "rss_kib", "comm"})

    def test_trace_created_alone_is_not_ready(self):
        self.check_readiness(False)

    def test_trace_ready_barrier_precedes_command_and_preserves_group(self):
        self.check_readiness(True)

    def check_readiness(self, ready):
        name = "orca-unit-123-0123456789abcdef"
        events = ["trace_created"] + (["trace_ready"] if ready else [])
        helper = Mock(stdout=[(DIAG.PREFIX + json.dumps({"kind": kind, "instance": name}) + "\n").encode() for kind in events])
        with patch.object(DIAG.os, "getpid", return_value=123), \
                patch.object(DIAG.secrets, "token_hex", return_value="0123456789abcdef"), \
                patch.object(DIAG.subprocess, "Popen", return_value=helper) as spawn, \
                patch.object(DIAG.os, "write"), patch.object(DIAG, "emit"), patch.object(DIAG, "stop_trace") as stop:
            state = DIAG.start_trace()
            self.assertEqual(state is not None, ready)
            self.assertNotIn("start_new_session", spawn.call_args.kwargs)
            self.assertNotIn("preexec_fn", spawn.call_args.kwargs)
            if ready:
                self.assertTrue(state[2].is_set())
                stop.assert_not_called()
            else:
                stop.assert_called_once()

    def test_monitor_preserves_exit_despite_diagnostic_failures_and_restores_handlers(self):
        for code, expected in ((0, 0), (7, 7), (-9, 137), (-15, 143)):
            child = Mock(pid=123, returncode=code)
            child.poll.side_effect = [None, code]
            with self.subTest(code=code), patch.object(DIAG.signal, "signal", return_value="old") as install, \
                    patch.object(DIAG, "start_trace", side_effect=RuntimeError("diagnostic failed")), \
                    patch.object(DIAG, "resource_snapshot", side_effect=RuntimeError("sample failed")), \
                    patch.object(DIAG, "stop_trace", side_effect=RuntimeError("cleanup failed")), \
                    patch.object(DIAG.subprocess, "Popen", return_value=child) as spawn, \
                    patch.object(DIAG.time, "sleep"), patch.object(DIAG, "emit"):
                self.assertEqual(DIAG.monitor(["node", "test.js"]), expected)
                spawn.assert_called_once_with(["node", "test.js"])
                self.assertEqual(install.call_count, 8)
                self.assertEqual([call.args for call in install.call_args_list[4:]], [(sig, "old") for sig in (1, 2, 3, 15)])

    def test_startup_signal_is_handled_before_spawn_without_kill_zero(self):
        handlers = {}
        def install(signum, handler):
            handlers[signum] = handler
            return "old"
        def trace():
            self.assertEqual(set(handlers), {1, 2, 3, 15})
            handlers[15](15, None)
        with patch.object(DIAG.signal, "signal", side_effect=install), patch.object(DIAG, "start_trace", side_effect=trace), \
                patch.object(DIAG, "stop_trace"), patch.object(DIAG, "emit"), \
                patch.object(DIAG.subprocess, "Popen") as spawn, patch.object(DIAG.os, "kill") as kill:
            self.assertEqual(DIAG.monitor(["node"]), 143)
            spawn.assert_not_called()
            kill.assert_not_called()

    def test_signal_during_spawn_only_forwards_to_positive_owned_child(self):
        for pid in (123, 0):
            handlers = {}
            child = Mock(pid=pid, returncode=-15)
            child.poll.side_effect = [None, -15] if pid else [-15]
            def install(signum, handler):
                handlers[signum] = handler
                return "old"
            def spawn(command):
                handlers[15](15, None)
                return child
            with self.subTest(pid=pid), patch.object(DIAG.signal, "signal", side_effect=install), \
                    patch.object(DIAG, "start_trace", return_value=None), patch.object(DIAG, "stop_trace"), \
                    patch.object(DIAG, "emit"), patch.object(DIAG.subprocess, "Popen", side_effect=spawn), \
                    patch.object(DIAG.os, "kill") as kill:
                self.assertEqual(DIAG.monitor(["node"]), 143)
                if pid:
                    kill.assert_called_once_with(123, 15)
                else:
                    kill.assert_not_called()

    def test_root_helper_cleanup_uses_only_unreaped_positive_owned_pid(self):
        helper = Mock(pid=456, returncode=0)
        helper.poll.return_value = None
        helper.wait.side_effect = [subprocess.TimeoutExpired("helper", 3), 0]
        created = threading.Event()
        created.set()
        with patch.object(DIAG.os, "kill", side_effect=PermissionError) as kill, \
                patch.object(DIAG.subprocess, "run", return_value=Mock(returncode=0)) as run, patch.object(DIAG, "emit"):
            DIAG.stop_trace((helper, Mock(), created, "orca-unit-123-0123456789abcdef", {"helper_pid": 999}))
            helper.stdin.close.assert_called_once()
            kill.assert_called_once_with(456, 15)
            self.assertEqual(run.call_args_list[0].args[0], ["sudo", "-n", "kill", "-15", "456"])
            self.assertEqual(run.call_args_list[1].args[0][-2:], ["--trace-cleanup", "orca-unit-123-0123456789abcdef"])

    def test_trace_cleanup_requires_created_ack_and_reports_failed_cleanup(self):
        for acknowledged in (False, True):
            created = threading.Event()
            if acknowledged:
                created.set()
            helper = Mock(returncode=0)
            with self.subTest(acknowledged=acknowledged), \
                    patch.object(DIAG.subprocess, "run", return_value=Mock(returncode=1)) as run, patch.object(DIAG, "emit") as emit:
                DIAG.stop_trace((helper, Mock(), created, "orca-unit-123-0123456789abcdef", {"helper_pid": 999}))
                self.assertEqual(run.call_count, int(acknowledged))
                if acknowledged:
                    emit.assert_called_with("trace_cleanup_unavailable", code=1)

    def test_sudo_exit_does_not_prove_privileged_helper_teardown(self):
        for cleaned, relay_alive in ((False, False), (True, True), (True, False)):
            created = threading.Event()
            created.set()
            helper = Mock(returncode=0)
            relay = Mock()
            relay.is_alive.return_value = relay_alive
            identity = {"helper_pid": 999, "cleaned": cleaned}
            with self.subTest(cleaned=cleaned, relay_alive=relay_alive), \
                    patch.object(DIAG.subprocess, "run", return_value=Mock(returncode=0)), \
                    patch.object(DIAG.os, "kill") as kill, patch.object(DIAG, "emit") as emit:
                DIAG.stop_trace((helper, relay, created, "orca-unit-123-0123456789abcdef", identity))
                calls = [call.args[0] for call in emit.call_args_list]
                self.assertEqual("trace_teardown_unverified" in calls, not cleaned or relay_alive)
                kill.assert_not_called()

    def test_missing_created_ack_with_live_relay_reports_unverified_without_instance_cleanup(self):
        helper = Mock(returncode=0)
        relay = Mock()
        relay.is_alive.return_value = True
        with patch.object(DIAG.subprocess, "run") as run, patch.object(DIAG, "emit") as emit:
            DIAG.stop_trace((helper, relay, threading.Event(), "orca-unit-123-0123456789abcdef", {}))
            emit.assert_called_once_with("trace_teardown_unverified", helper_pid=None)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
