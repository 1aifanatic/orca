# Native Windows Bun qualification next step

Use only after the current full-build x64 and ARM64 artifacts have hash-verified receipts. This fixture is local/diagnostic and does not install or promote anything.

1. Copy the verified Bun runtime, daemon bundle, and the architecture-matched `conpty.dll` plus `OpenConsole.exe` into an isolated temporary directory. Validate both files with `resolveWindowsConptyProvider`; a DLL-only directory is invalid.
2. Set `ORCA_BACKGROUND_LAUNCH=1` and `BUN_EXECUTABLE` to the copied runtime. Run provider identity and `daemon-bun-pty-artifact.integration.test.ts` first.
3. Run Bun PTY, process-group/job-control, suspension, foreground-process, and Windows gate tests from `bunProfileTestPaths({ artifact: true })`.
4. Run the repaint matrix on x64 and ARM64 using the complete provider and immediate/400 ms/700 ms timing controls. Expect the qualified 8/8 wide-character and emulator rows. Provider identity failures invalidate the run; they are not passes.
5. Record runtime/provider hashes, OS build, architecture, exact commands, counts, skips and failures. A skipped non-Windows test is not an ARM64/x64 result.

Known limits: existing 8/8 evidence is headless/emulator coverage, not installed-update lifecycle proof. ARM64 still needs a native ARM64 Windows host run; the SSH capability probe is not a substitute.
