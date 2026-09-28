var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main/daemon/bun-pty-windows-io-failure-fixture.ts
var bun_pty_windows_io_failure_fixture_exports = {};
__export(bun_pty_windows_io_failure_fixture_exports, {
  runWindowsNativeIoFailure: () => runWindowsNativeIoFailure
});
module.exports = __toCommonJS(bun_pty_windows_io_failure_fixture_exports);
var import_node_path4 = require("node:path");
var import_promises2 = require("node:timers/promises");

// src/main/daemon/pty-subprocess/bun-pty-process-capabilities.ts
function currentRuntime() {
  return "Bun" in globalThis ? globalThis.Bun : void 0;
}
function isBunRuntime(runtime) {
  return typeof runtime === "object" && runtime !== null && "spawn" in runtime && typeof runtime.spawn === "function" && "Terminal" in runtime && typeof runtime.Terminal === "function";
}
function resolveBunRuntime(runtime = currentRuntime()) {
  if (!isBunRuntime(runtime)) {
    throw new Error("Bun terminal runtime is unavailable");
  }
  return runtime;
}

// src/main/daemon/pty-subprocess/bun-pty-process-runtime.ts
var import_node_os3 = require("node:os");

// src/main/daemon/pty-subprocess/bun-pty-terminal-io.ts
function createBunPtyTerminalIo(terminal, dimensions, isExited, terminate2) {
  let cols = dimensions.cols;
  let rows = dimensions.rows;
  let state = "active";
  const retire = () => {
    try {
      terminate2();
      state = "retiring";
    } catch (error) {
      console.warn("[daemon/pty] Failed to retire PTY:", error);
    }
  };
  const canUseTerminal = () => {
    if (isExited()) {
      return false;
    }
    if (state === "failed") {
      retire();
    }
    return state === "active" && !terminal.closed;
  };
  const fail = (error) => {
    console.warn("[daemon/pty] Native terminal I/O failed; retiring PTY:", error);
    state = "failed";
    retire();
  };
  return {
    get cols() {
      return cols;
    },
    get rows() {
      return rows;
    },
    write(data) {
      if (!canUseTerminal()) {
        return;
      }
      try {
        terminal.write(data);
      } catch (error) {
        fail(error);
      }
    },
    resize(nextCols, nextRows) {
      if (!canUseTerminal()) {
        return;
      }
      try {
        terminal.resize(nextCols, nextRows);
        cols = nextCols;
        rows = nextRows;
      } catch (error) {
        if (terminal.closed) {
          fail(error);
        } else {
          console.warn("[daemon/pty] Native terminal resize failed:", error);
        }
      }
    }
  };
}

// src/main/daemon/pty-subprocess/windows-bun-pty-native.ts
var import_node_module = require("node:module");
var requireFromMain = (0, import_node_module.createRequire)(__filename);
var JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
var JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
var JOB_LIMIT_FLAGS_OFFSET = 16;
var JOB_EXTENDED_LIMITS_BYTES = 144;
var MAX_JOB_PROCESS_IDS = 16384;
function queryWindowsBunPtyProcessIds(query) {
  for (let capacity = 64; capacity <= MAX_JOB_PROCESS_IDS; capacity *= 4) {
    const bytes = new Uint8Array(8 + capacity * 8);
    const queried = query(bytes);
    const view = new DataView(bytes.buffer);
    const assigned = view.getUint32(0, true);
    const count = view.getUint32(4, true);
    if (assigned > count) {
      continue;
    }
    if (!queried || count > capacity) {
      return null;
    }
    const pids = [];
    for (let index = 0; index < count; index += 1) {
      const pid = Number(view.getBigUint64(8 + index * 8, true));
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 4294967295) {
        return null;
      }
      pids.push(pid);
    }
    return pids;
  }
  return null;
}
var cachedNative;
function loadWindowsBunPtyJobNative() {
  if (cachedNative !== void 0) {
    return cachedNative;
  }
  if (process.platform !== "win32") {
    cachedNative = null;
    return cachedNative;
  }
  try {
    const ffi = requireFromMain("bun:ffi");
    const kernel = ffi.dlopen("kernel32.dll", {
      CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
      SetInformationJobObject: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
      GetCurrentProcess: { args: [], returns: "ptr" },
      OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
      AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
      IsProcessInJob: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
      QueryInformationJobObject: {
        args: ["ptr", "u32", "ptr", "u32", "ptr"],
        returns: "i32"
      },
      TerminateJobObject: { args: ["ptr", "u32"], returns: "i32" },
      CloseHandle: { args: ["ptr"], returns: "i32" }
    });
    const ntdll = ffi.dlopen("ntdll.dll", {
      NtSuspendProcess: { args: ["ptr"], returns: "i32" },
      NtResumeProcess: { args: ["ptr"], returns: "i32" }
    });
    const { symbols } = kernel;
    cachedNative = {
      createJob: () => symbols.CreateJobObjectW(null, null),
      configureJob(job, flags) {
        const limits = new Uint8Array(JOB_EXTENDED_LIMITS_BYTES);
        new DataView(limits.buffer).setUint32(JOB_LIMIT_FLAGS_OFFSET, flags, true);
        return symbols.SetInformationJobObject(
          job,
          JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
          ffi.ptr(limits),
          limits.byteLength
        ) !== 0;
      },
      currentProcess: () => symbols.GetCurrentProcess(),
      openProcess: (access, pid) => symbols.OpenProcess(access, 0, pid),
      assignProcess: (job, process2) => symbols.AssignProcessToJobObject(job, process2) !== 0,
      isProcessInJob(process2, job) {
        const result = new Uint32Array(1);
        return symbols.IsProcessInJob(process2, job, ffi.ptr(result)) !== 0 && result[0] !== 0;
      },
      queryProcessIds(job) {
        return queryWindowsBunPtyProcessIds(
          (bytes) => symbols.QueryInformationJobObject(
            job,
            JOB_OBJECT_BASIC_PROCESS_ID_LIST,
            ffi.ptr(bytes),
            bytes.byteLength,
            null
          ) !== 0
        );
      },
      suspendProcess: (process2) => ntdll.symbols.NtSuspendProcess(process2) >= 0,
      resumeProcess: (process2) => ntdll.symbols.NtResumeProcess(process2) >= 0,
      terminateJob: (job) => symbols.TerminateJobObject(job, 1) !== 0,
      closeHandle: (handle) => {
        symbols.CloseHandle(handle);
      }
    };
    return cachedNative;
  } catch {
    cachedNative = null;
    return cachedNative;
  }
}

// src/main/daemon/pty-subprocess/windows-bun-pty-job.ts
var JOB_OBJECT_LIMIT_BREAKAWAY_OK = 2048;
var JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 8192;
var PROCESS_TERMINATE = 1;
var PROCESS_SET_QUOTA = 256;
var PROCESS_SUSPEND_RESUME = 2048;
var PROCESS_QUERY_LIMITED_INFORMATION = 4096;
var MAX_SUSPEND_PASSES = 8;
var hostJobAssigned = null;
function assignCurrentProcessToBunPtyHostJob(native = loadWindowsBunPtyJobNative()) {
  if (hostJobAssigned !== null) {
    return hostJobAssigned;
  }
  if (!native) {
    hostJobAssigned = false;
    return false;
  }
  const job = native.createJob();
  if (job === null || !native.configureJob(job, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK) || !native.assignProcess(job, native.currentProcess())) {
    if (job !== null) {
      native.closeHandle(job);
    }
    hostJobAssigned = false;
    return false;
  }
  hostJobAssigned = true;
  return true;
}
var BunPtyJob = class {
  constructor(rootPid, handle, native) {
    this.rootPid = rootPid;
    this.handle = handle;
    this.native = native;
  }
  suspended = /* @__PURE__ */ new Map();
  closed = false;
  fullySuspended = false;
  terminated = false;
  listProcessIds() {
    return this.closed ? null : this.native.queryProcessIds(this.handle);
  }
  pause() {
    if (this.closed || this.terminated) {
      return false;
    }
    if (this.fullySuspended) {
      return true;
    }
    if (this.suspended.size > 0 && !this.resume()) {
      return false;
    }
    for (let pass = 0; pass < MAX_SUSPEND_PASSES; pass += 1) {
      const pids = this.listProcessIds();
      if (!pids) {
        this.resume();
        return false;
      }
      const ordered = [...pids].sort((left, right) => {
        if (left === this.rootPid) {
          return -1;
        }
        if (right === this.rootPid) {
          return 1;
        }
        return left - right;
      });
      let progressed = false;
      for (const pid of ordered) {
        if (this.suspended.has(pid)) {
          continue;
        }
        const process2 = this.native.openProcess(
          PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION,
          pid
        );
        if (process2 === null) {
          continue;
        }
        if (!this.native.isProcessInJob(process2, this.handle)) {
          this.native.closeHandle(process2);
          continue;
        }
        if (!this.native.suspendProcess(process2)) {
          this.native.closeHandle(process2);
          continue;
        }
        this.suspended.set(pid, process2);
        progressed = true;
      }
      const remaining = this.listProcessIds();
      if (remaining && remaining.every((pid) => this.suspended.has(pid))) {
        this.fullySuspended = true;
        return true;
      }
      if (!remaining || !progressed) {
        this.resume();
        return false;
      }
    }
    this.resume();
    return false;
  }
  resume() {
    this.fullySuspended = false;
    const ownedPids = this.terminated ? [] : this.listProcessIds();
    for (const [pid, process2] of this.suspended) {
      const processExited = ownedPids !== null && !ownedPids.includes(pid);
      if (!this.terminated && !processExited && !this.native.resumeProcess(process2)) {
        continue;
      }
      this.native.closeHandle(process2);
      this.suspended.delete(pid);
    }
    return this.suspended.size === 0;
  }
  terminate() {
    if (this.closed) {
      return this.terminated ? "terminated" : "unavailable";
    }
    if (!this.terminated) {
      this.terminated = this.native.terminateJob(this.handle);
    }
    if (this.terminated) {
      this.resume();
      return "terminated";
    }
    return "unavailable";
  }
  close() {
    if (this.closed) {
      return;
    }
    if (!this.resume()) {
      console.warn(
        "[daemon/pty] Could not resume a Windows PTY tree during cleanup; terminating it"
      );
      this.terminated = this.native.terminateJob(this.handle);
      if (!this.terminated) {
        this.terminated = this.native.configureJob(this.handle, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
      }
      this.resume();
    }
    this.native.closeHandle(this.handle);
    this.closed = true;
  }
};
function createWindowsBunPtyJob(rootPid, native = loadWindowsBunPtyJobNative(), killOnClose = false) {
  if (!native || !Number.isInteger(rootPid) || rootPid <= 0) {
    return null;
  }
  const job = native.createJob();
  if (job === null || !native.configureJob(job, killOnClose ? JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE : 0)) {
    if (job !== null) {
      native.closeHandle(job);
    }
    return null;
  }
  const process2 = native.openProcess(
    PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION,
    rootPid
  );
  if (process2 === null) {
    native.closeHandle(job);
    return null;
  }
  const assigned = native.assignProcess(job, process2);
  native.closeHandle(process2);
  if (!assigned) {
    native.closeHandle(job);
    return null;
  }
  return new BunPtyJob(rootPid, job, native);
}

// src/main/daemon/pty-subprocess/windows-bun-pty-launch.ts
var import_node_fs3 = require("node:fs");
var import_node_os = require("node:os");
var import_node_path3 = require("node:path");

// src/shared/child-process/windows-command-line.ts
function quoteWindows(value, escapePercent) {
  if (!(escapePercent ? /[\\"%]/ : /[\\"]/).test(value)) {
    return `"${value}"`;
  }
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += `${"\\".repeat(backslashes * 2)}""`;
      backslashes = 0;
      continue;
    }
    if (escapePercent && char === "%") {
      quoted += `${"\\".repeat(backslashes * 2)}"^%"`;
      backslashes = 0;
      continue;
    }
    quoted += `${"\\".repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}
function quoteWindowsCmdArgument(value) {
  return quoteWindows(value, true);
}
function validateWindowsCmdArguments(values) {
  for (const value of values) {
    if (/[\r\n]/.test(value)) {
      throw new Error("cmd.exe cannot receive an argument containing a line break");
    }
  }
}
function buildWindowsCmdShimCommandLine(program, args) {
  validateWindowsCmdArguments([program, ...args]);
  const inner = [program, ...args].map(quoteWindowsCmdArgument).join(" ");
  return `/d /v:off /s /c "${inner}"`;
}
var CMD_INTERPRETED_EXTENSIONS = [".cmd", ".bat"];
function isCmdInterpretedProgram(program) {
  const lower = program.toLowerCase();
  return CMD_INTERPRETED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

// src/shared/windows-batch-spawn.ts
var import_node_path = require("node:path");
function getCmdExePath() {
  return process.env.ComSpec || import_node_path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
}
var WINDOWS_BATCH_UNSAFE_CHARACTERS = ["&", "|", "<", ">", "^", '"', "%", "!"];
var WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL = WINDOWS_BATCH_UNSAFE_CHARACTERS.join(" ");
var UNSAFE_WINDOWS_BATCH_SYNTAX = new RegExp(
  `[${WINDOWS_BATCH_UNSAFE_CHARACTERS.map((character) => character.replace(/[\\^\]-]/, "\\$&")).join("")}\\r\\n]`
);

// src/shared/child-process/run-process.ts
var import_node_child_process2 = require("node:child_process");

// src/shared/child-process/windows-cmd-shim-resolution.ts
var import_node_fs = require("node:fs");
var import_node_path2 = require("node:path");
var DISABLE_FLAG = "ORCA_DISABLE_CMD_SHIM_RESOLUTION";
var MAX_SHIM_BYTES = 64 * 1024;
var DP0 = String.raw`(?:%~dp0|%dp0%)\\?`;
var DP0_NODE_EXE = `"${DP0}node\\.exe"`;
var dp0Path = (group) => `"${DP0}(?<${group}>[^"\\r\\n]+)"`;
var ECHO_OFF = String.raw`@echo off\n`;
var FIND_DP0 = String.raw`GOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n`;
var NODE_PATH_BLOCK = String.raw`(?:@IF NOT DEFINED NODE_PATH \(\n@SET "NODE_PATH=(?<nodePath>[^"\r\n]*)"\n\) ELSE \(\n@SET "NODE_PATH=(?<nodePathElse>[^"\r\n]*)"\n\)\n)?`;
var PATHEXT_STRIP = String.raw`SET PATHEXT=%PATHEXT:;\.JS;=;%`;
var NPM_PROG_NODE_SHIM = new RegExp(
  String.raw`^${ECHO_OFF}${FIND_DP0}IF EXIST ${DP0_NODE_EXE} \(\nSET "_prog=${DP0}node\.exe"\n\) ELSE \(\nSET "_prog=node"\n${PATHEXT_STRIP}\n\)\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +${dp0Path("script")} +%\*$`,
  "i"
);
var BRANCHED_NODE_SHIM = new RegExp(
  String.raw`^(?:@SETLOCAL\n)?${NODE_PATH_BLOCK}@?IF EXIST ${DP0_NODE_EXE} \(\n${DP0_NODE_EXE} +${dp0Path("script")} +%\*\n\) ELSE \(\n(?:@?SETLOCAL\n)?@?${PATHEXT_STRIP}\nnode +${dp0Path("scriptElse")} +%\*\n\)$`,
  "i"
);
var NPM_DIRECT_SHIM = new RegExp(
  String.raw`^${ECHO_OFF}(?:${FIND_DP0})?${dp0Path("target")} +%\*$`,
  "i"
);
var PNPM_DIRECT_SHIM = new RegExp(String.raw`^(?:@SETLOCAL\n)?@?${dp0Path("target")} +%\*$`, "i");
var UNSAFE_SHIM_PATH = /[%^&|<>":\r\n]/;
var DIRECT_TARGET_EXTENSIONS = [".exe", ".com"];
function isPlainRelativePath(spelled) {
  return !UNSAFE_SHIM_PATH.test(spelled) && !import_node_path2.win32.isAbsolute(spelled);
}
function canonicalize(contents) {
  return contents.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).join("\n");
}
function parseWindowsCmdShim(contents) {
  const canonical = canonicalize(contents);
  const prog = NPM_PROG_NODE_SHIM.exec(canonical)?.groups;
  if (prog?.script) {
    return isPlainRelativePath(prog.script) ? { kind: "node", script: prog.script } : null;
  }
  const branched = BRANCHED_NODE_SHIM.exec(canonical)?.groups;
  if (branched?.script) {
    if (branched.script !== branched.scriptElse || !isPlainRelativePath(branched.script)) {
      return null;
    }
    const nodePath = branched.nodePath;
    if (nodePath === void 0) {
      return { kind: "node", script: branched.script };
    }
    if (nodePath.includes("%") || branched.nodePathElse !== `${nodePath};%NODE_PATH%`) {
      return null;
    }
    return { kind: "node", script: branched.script, nodePathPrefix: nodePath };
  }
  for (const pattern of [NPM_DIRECT_SHIM, PNPM_DIRECT_SHIM]) {
    const target = pattern.exec(canonical)?.groups?.target;
    if (target) {
      return isPlainRelativePath(target) ? { kind: "direct", target } : null;
    }
  }
  return null;
}
var parseCache = /* @__PURE__ */ new Map();
var PARSE_CACHE_LIMIT = 256;
var nodeCache = /* @__PURE__ */ new Map();
var NODE_CACHE_LIMIT = 256;
function statFile(path) {
  try {
    const stats = (0, import_node_fs.statSync)(path);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}
function readParsedShim(program) {
  const stats = statFile(program);
  if (!stats || stats.size > MAX_SHIM_BYTES) {
    return null;
  }
  const cached = parseCache.get(program);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.parsed;
  }
  let contents;
  try {
    contents = (0, import_node_fs.readFileSync)(program, "utf8");
  } catch {
    return null;
  }
  const parsed = parseWindowsCmdShim(contents);
  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    parseCache.clear();
  }
  parseCache.set(program, { mtimeMs: stats.mtimeMs, size: stats.size, parsed });
  return parsed;
}
function firstEnvKey(env, name) {
  const lower = name.toLowerCase();
  return Object.keys(env).find((key) => key.toLowerCase() === lower && env[key] !== void 0);
}
var DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
function resolveShimNode(directory, env) {
  const pathKey = firstEnvKey(env, "PATH");
  const pathValue = (pathKey ? env[pathKey] : void 0) ?? "";
  const pathExtKey = firstEnvKey(env, "PATHEXT");
  const pathExtValue = (pathExtKey ? env[pathExtKey] : void 0) || DEFAULT_PATHEXT;
  const key = `${directory}
${pathValue}
${pathExtValue}`;
  const cached = nodeCache.get(key);
  if (cached !== void 0 && (cached === null || statFile(cached))) {
    return cached;
  }
  const resolved = probeShimNode(directory, pathValue, pathExtValue);
  if (nodeCache.size >= NODE_CACHE_LIMIT) {
    nodeCache.clear();
  }
  nodeCache.set(key, resolved);
  return resolved;
}
function probeShimNode(directory, pathValue, pathExtValue) {
  const sibling = import_node_path2.win32.join(directory, "node.exe");
  if (statFile(sibling)) {
    return sibling;
  }
  const extensions = pathExtValue.split(";").map((extension) => extension.trim().toLowerCase()).filter((extension) => extension.startsWith("."));
  for (const entry of pathValue.split(";")) {
    const trimmed = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!trimmed || !import_node_path2.win32.isAbsolute(trimmed)) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = import_node_path2.win32.join(trimmed, `node${extension}`);
      if (!statFile(candidate)) {
        continue;
      }
      return extension === ".exe" ? candidate : null;
    }
  }
  return null;
}
function withNodePath(env, prefix) {
  const key = firstEnvKey(env, "NODE_PATH") ?? "NODE_PATH";
  const existing = env[key];
  return { ...env, [key]: existing ? `${prefix};${existing}` : prefix };
}
function resolveWindowsCmdShim(program, env) {
  const disableKey = firstEnvKey(env, DISABLE_FLAG);
  if (disableKey && env[disableKey]) {
    return null;
  }
  if (!import_node_path2.win32.isAbsolute(program)) {
    return null;
  }
  const parsed = readParsedShim(program);
  if (!parsed) {
    return null;
  }
  const directory = import_node_path2.win32.dirname(program);
  if (parsed.kind === "direct") {
    const target = import_node_path2.win32.resolve(directory, parsed.target);
    const lower = target.toLowerCase();
    if (!DIRECT_TARGET_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
      return null;
    }
    return statFile(target) ? { program: target, prefixArgs: [] } : null;
  }
  const script = import_node_path2.win32.resolve(directory, parsed.script);
  if (!statFile(script)) {
    return null;
  }
  const node = resolveShimNode(directory, env);
  if (!node) {
    return null;
  }
  return {
    program: node,
    prefixArgs: [script],
    ...parsed.nodePathPrefix ? { env: withNodePath(env, parsed.nodePathPrefix) } : {}
  };
}

// src/shared/child-process/spawn-resolution.ts
function resolveSpawn(spec, platform) {
  const args = spec.args ?? [];
  const base = {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.stdio ?? ["pipe", "pipe", "pipe"],
    // Why unconditional: Orca's main process is GUI-subsystem and owns no
    // console, so every console-subsystem child it starts gets a fresh visible
    // conhost that takes foreground — keystrokes typed into an Orca terminal at
    // that moment land in the black box instead.
    windowsHide: true,
    detached: spec.detached,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    // Why never `shell: true`: it concatenates arguments without escaping (Node
    // itself warns DEP0190) and it silently makes windowsHide a no-op.
    shell: false,
    ...spec.terminationBarrier && platform !== "win32" ? { detached: true } : {}
  };
  if (platform !== "win32" || !isCmdInterpretedProgram(spec.program)) {
    return { file: spec.program, args, options: base };
  }
  const shim = resolveWindowsCmdShim(spec.program, spec.env ?? process.env);
  if (shim) {
    return {
      file: shim.program,
      args: [...shim.prefixArgs, ...args],
      options: {
        ...base,
        ...shim.env ? { env: shim.env } : {},
        // Why cleared rather than inherited: the flag exists for callers that
        // hand us a whole pre-built command line, and there is no such line
        // here — Node would join `[script, ...args]` unquoted and shred any
        // argument containing a space.
        windowsVerbatimArguments: void 0
      }
    };
  }
  const comSpec = spec.env?.ComSpec ?? process.env.ComSpec ?? "cmd.exe";
  return {
    file: comSpec,
    args: [buildWindowsCmdShimCommandLine(spec.program, args)],
    options: { ...base, windowsVerbatimArguments: true }
  };
}

// src/shared/child-process/process-tree-termination.ts
var import_node_child_process = require("node:child_process");

// src/shared/child-process/process-tree-kill-gate.ts
var gate = null;
function admitProcessTreeKill(kill) {
  try {
    return gate?.(kill) ?? true;
  } catch {
    return true;
  }
}

// src/shared/child-process/process-tree-termination.ts
var PROBE_INTERVAL_MS = 25;
var SUBPROCESS_TIMEOUT_MS = 2e3;
var MAX_PS_OUTPUT_BYTES = 8 * 1024 * 1024;
function signalProcessTree(child, signal) {
  if (!child.pid) {
    killRoot(child, signal);
    return Promise.resolve(true);
  }
  if (process.platform === "win32") {
    if (hasExited(child)) {
      killRoot(child, signal);
      return Promise.resolve(false);
    }
    return taskkillTree(child, child.pid, signal);
  }
  if (!admitProcessTreeKill({
    pid: child.pid,
    site: "run-process-tree",
    scope: "posix-process-group"
  })) {
    killRoot(child, signal);
    return Promise.resolve(false);
  }
  try {
    process.kill(-child.pid, signal);
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(!processGroupExists(child.pid));
  }
}
async function forceTerminateProcessTree(child) {
  const signaled = await signalProcessTree(child, "SIGKILL");
  if (!signaled) {
    return false;
  }
  if (process.platform !== "win32" && child.pid) {
    return waitForPosixProcessGroupQuiescence(child.pid);
  }
  return true;
}
function hasExited(child) {
  return (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null;
}
function taskkillTree(child, rootPid, signal) {
  if (!admitProcessTreeKill({ pid: rootPid, site: "run-process-tree", scope: "win-taskkill-tree" })) {
    killRoot(child, signal);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let killer;
    try {
      killer = (0, import_node_child_process.spawn)("taskkill", ["/pid", String(rootPid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false
      });
    } catch {
      killRoot(child, signal);
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (fallback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (fallback) {
        killRoot(child, signal);
      }
      resolve(!fallback);
    };
    killer.once("error", () => finish(true));
    killer.once("close", (code) => finish(code !== 0));
    const timer = setTimeout(() => {
      killer.kill();
      finish(true);
    }, SUBPROCESS_TIMEOUT_MS);
    timer.unref?.();
  });
}
async function waitForPosixProcessGroupQuiescence(processGroupId) {
  const deadline = Date.now() + SUBPROCESS_TIMEOUT_MS;
  while (true) {
    const states = await readPosixProcessGroupStates(processGroupId);
    if (states ? states.every((state) => state.startsWith("Z")) : !processGroupExists(processGroupId)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
}
function readPosixProcessGroupStates(processGroupId) {
  return new Promise((resolve) => {
    let probe;
    try {
      probe = (0, import_node_child_process.spawn)("ps", ["-axo", "pgid=,state="], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: false
      });
    } catch {
      resolve(null);
      return;
    }
    let output = "";
    let truncated = false;
    let settled = false;
    const finish = (states) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(states);
    };
    probe.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      if (output.length + text.length > MAX_PS_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      output += text;
    });
    probe.stdout?.on("error", () => {
    });
    probe.once("error", () => finish(null));
    probe.once("close", (code) => {
      if (code !== 0 || truncated) {
        finish(null);
        return;
      }
      const states = output.split("\n").flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\S+)/);
        return match && Number(match[1]) === processGroupId ? [match[2]] : [];
      });
      finish(states);
    });
    const timer = setTimeout(() => {
      probe.kill();
      finish(null);
    }, SUBPROCESS_TIMEOUT_MS);
    timer.unref?.();
  });
}
function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function killRoot(child, signal) {
  try {
    child.kill(signal);
  } catch {
  }
}

// src/shared/child-process/bounded-output-sink.ts
var import_node_buffer = require("node:buffer");
function createOutputSink(maxBytes) {
  const chunks = [];
  let bytes = 0;
  return {
    write(raw) {
      const chunk = import_node_buffer.Buffer.isBuffer(raw) ? raw : import_node_buffer.Buffer.from(raw);
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        bytes += chunk.length;
        return;
      }
      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      bytes += chunk.length;
    },
    text: () => chunks.length === 0 ? "" : (chunks.length === 1 ? chunks[0] : import_node_buffer.Buffer.concat(chunks)).toString("utf8"),
    // Why: callers that parse the output need to tell a short answer from a
    // clipped one -- truncated JSON or JSONL parses as a smaller valid result.
    truncated: () => bytes > maxBytes
  };
}

// src/shared/child-process/child-termination-reporter.ts
function createChildTerminationReporter(callback) {
  let reported = false;
  const report = () => {
    if (reported) {
      return;
    }
    reported = true;
    callback?.();
  };
  return { report, reportIf: (confirmed) => confirmed ? report() : void 0 };
}

// src/shared/child-process/process-spec.ts
var DEFAULT_PROCESS_TIMEOUT_MS = 3e4;
var DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

// src/shared/child-process/run-process.ts
var PROCESS_EXIT_GRACE_MS = 2e3;
var BARRIER_UNVERIFIED_EXIT_GRACE_MS = 1e4;
function spawnProcess(spec) {
  const resolved = resolveSpawn(spec, process.platform);
  return (0, import_node_child_process2.spawn)(
    resolved.file,
    [...resolved.args],
    resolved.options
  );
}
function runProcess(spec) {
  if (spec.signal?.aborted) {
    spec.onChildTerminated?.();
    return Promise.resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false });
  }
  const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const terminationReporter = createChildTerminationReporter(spec.onChildTerminated);
    let child;
    try {
      child = spawnProcess(spec);
    } catch (error) {
      terminationReporter.report();
      reject(error);
      return;
    }
    const stdout = createOutputSink(maxOutputBytes);
    const stderr = createOutputSink(maxOutputBytes);
    let timedOut = false;
    let settled = false;
    let barrierStopping = false;
    let barrierAttemptComplete = false;
    let barrierTerminationVerified = false;
    let initialBarrierTermination;
    let deferredExit = null;
    let deferredClose = null;
    let deferredError = null;
    let rootExitedBeforeBarrier = false;
    const settle = (act) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      clearTimeout(barrierDeadlineTimer);
      spec.signal?.removeEventListener("abort", onAbort);
      act();
    };
    child.stdout?.on("data", (chunk) => stdout.write(chunk));
    child.stderr?.on("data", (chunk) => {
      stderr.write(chunk);
      if (typeof spec.terminationBarrier === "object") {
        spec.terminationBarrier.observeStderr?.(chunk);
      }
    });
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on("error", () => {
      });
    }
    let graceTimer;
    let barrierDeadlineTimer;
    const signalBarrierTree = (signal) => (typeof spec.terminationBarrier === "object" ? spec.terminationBarrier.signal(child, signal) : signalProcessTree(child, signal)).catch(() => false);
    const forceBarrierTree = () => (typeof spec.terminationBarrier === "object" ? spec.terminationBarrier.force(child) : forceTerminateProcessTree(child)).catch(() => false);
    const resolveFromClose = (code, signal) => settle(
      () => resolve({
        code,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        outputTruncated: stdout.truncated() || stderr.truncated()
      })
    );
    const settleBarrierOutcome = () => {
      const rootExit = deferredClose ?? deferredExit;
      if (deferredError) {
        settle(() => reject(deferredError));
        return;
      }
      resolveFromClose(rootExit?.code ?? null, rootExit?.signal ?? null);
    };
    const resolveBarrierIfSafe = () => {
      const rootExit = deferredClose ?? deferredExit;
      if (barrierTerminationVerified || rootExitedBeforeBarrier && rootExit) {
        settleBarrierOutcome();
        return;
      }
      if (!barrierAttemptComplete) {
        return;
      }
      barrierDeadlineTimer ??= setTimeout(settleBarrierOutcome, BARRIER_UNVERIFIED_EXIT_GRACE_MS);
      barrierDeadlineTimer.unref?.();
    };
    const stopAndSettle = () => {
      if (spec.terminationBarrier) {
        barrierStopping = true;
        initialBarrierTermination ??= signalBarrierTree();
        if (process.platform === "win32") {
          void initialBarrierTermination.then((terminated) => {
            if (!terminated) {
              return;
            }
            barrierAttemptComplete = true;
            barrierTerminationVerified = true;
            terminationReporter.report();
            resolveBarrierIfSafe();
          });
        }
      } else {
        terminate(child);
      }
      graceTimer ??= setTimeout(() => {
        if (spec.terminationBarrier) {
          const initialTermination = initialBarrierTermination ?? Promise.resolve(false);
          if (process.platform === "win32") {
            if (typeof spec.terminationBarrier === "object") {
              void Promise.all([initialTermination, forceBarrierTree()]).then(
                ([initialTerminated, forceTerminated]) => {
                  barrierAttemptComplete = true;
                  barrierTerminationVerified = initialTerminated || forceTerminated;
                  terminationReporter.reportIf(barrierTerminationVerified);
                  if (!barrierTerminationVerified) {
                    terminate(child, "SIGKILL");
                  }
                  resolveBarrierIfSafe();
                }
              );
              return;
            }
            void initialTermination.then((terminated) => {
              if (!terminated) {
                terminate(child, "SIGKILL");
              }
              barrierAttemptComplete = true;
              barrierTerminationVerified = terminated;
              terminationReporter.reportIf(barrierTerminationVerified);
              resolveBarrierIfSafe();
            });
            return;
          }
          void Promise.all([initialTermination, forceBarrierTree()]).then(
            ([_initialTerminated, forceTerminated]) => {
              barrierAttemptComplete = true;
              barrierTerminationVerified = forceTerminated;
              terminationReporter.reportIf(barrierTerminationVerified);
              if (!barrierTerminationVerified) {
                terminate(child, "SIGKILL");
              }
              resolveBarrierIfSafe();
            }
          );
          return;
        }
        terminate(child, "SIGKILL");
        resolveFromClose(null, null);
      }, PROCESS_EXIT_GRACE_MS);
      graceTimer.unref?.();
    };
    const timer = spec.timeoutMs === null ? void 0 : setTimeout(() => {
      timedOut = true;
      stopAndSettle();
    }, spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS);
    timer?.unref?.();
    const onAbort = () => stopAndSettle();
    spec.signal?.addEventListener("abort", onAbort, { once: true });
    if (spec.signal?.aborted) {
      onAbort();
    }
    child.once("error", (error) => {
      terminationReporter.reportIf(!child.pid);
      if (barrierStopping) {
        deferredError = error;
        resolveBarrierIfSafe();
        return;
      }
      settle(() => reject(error));
    });
    child.once("exit", (code, signal) => {
      if (!barrierStopping) {
        rootExitedBeforeBarrier = true;
      }
      deferredExit = { code, signal };
      if (barrierStopping) {
        resolveBarrierIfSafe();
      }
    });
    child.once("close", (code, signal) => {
      terminationReporter.report();
      if (!barrierStopping) {
        rootExitedBeforeBarrier = true;
      }
      if (barrierStopping) {
        deferredClose = { code, signal };
        resolveBarrierIfSafe();
        return;
      }
      resolveFromClose(code, signal);
    });
    child.stdin?.end(spec.input);
  });
}
function terminate(child, signal) {
  try {
    child.kill(signal);
  } catch {
  }
}
function runProcessSync(spec) {
  const resolved = resolveSpawn(spec, process.platform);
  const result = (0, import_node_child_process2.spawnSync)(resolved.file, [...resolved.args], {
    ...resolved.options,
    input: spec.input,
    timeout: spec.timeoutMs === null ? void 0 : spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
    maxBuffer: spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    encoding: "buffer"
  });
  if (result.error && result.error.code !== "ETIMEDOUT") {
    throw result.error;
  }
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout?.toString("utf8") ?? "",
    stderr: result.stderr?.toString("utf8") ?? "",
    // Why always false: spawnSync reports an overrun as an ENOBUFS error, and
    // the guard above rethrows it, so no truncated result reaches this point.
    outputTruncated: false,
    // Why ETIMEDOUT and not the signal: a timeout kills with SIGTERM, but so
    // does anything else that terminates the child, and only a timeout also
    // sets this error. Reading the signal alone reports a deliberately
    // stopped process as having timed out, which callers retry.
    timedOut: result.error?.code === "ETIMEDOUT"
  };
}

// src/main/daemon/pty-subprocess/windows-bun-pty-spawn-receipt.ts
var import_node_fs2 = require("node:fs");
var import_promises = require("node:timers/promises");
var WindowsBunPtySpawnUnconfirmedError = class extends Error {
};
function readWindowsBunPtySpawnReceipt(path) {
  try {
    const receipt = (0, import_node_fs2.readFileSync)(path, "utf8");
    const pid = Number(receipt);
    if (/^[1-9][0-9]{0,9}$/.test(receipt) && Number.isSafeInteger(pid) && pid <= 4294967295) {
      return { pid };
    }
  } catch {
  }
  try {
    return { error: (0, import_node_fs2.readFileSync)(`${path}.error`, "utf8") };
  } catch {
    return void 0;
  }
}
async function waitForWindowsBunPtySpawn(readReceipt, wrapperExited) {
  let ended = false;
  const markEnded = () => {
    ended = true;
  };
  void wrapperExited.then(markEnded, markEnded);
  const deadline = Date.now() + 3e4;
  while (true) {
    const receipt = readReceipt();
    if (receipt) {
      if ("pid" in receipt) {
        return;
      }
      if (ended) {
        throw new Error(receipt.error);
      }
    }
    if (ended || Date.now() >= deadline) {
      throw new WindowsBunPtySpawnUnconfirmedError("Windows shell spawn could not be confirmed");
    }
    await (0, import_promises.setTimeout)(5);
  }
}

// src/main/daemon/pty-subprocess/windows-bun-pty-gate.ts
var WINDOWS_BUN_PTY_GATE_ENV = "ORCA_BUN_PTY_JOB_GATE";
var WINDOWS_BUN_PTY_RUNTIME_OPTION_KEYS = ["NODE_OPTIONS", "BUN_OPTIONS"];

// src/main/daemon/pty-subprocess/windows-bun-pty-launch.ts
var CLEAR_SEQUENCE = "\x1B[3J\x1B[2J\x1B[H";
var CLEANUP_MAX_RETRIES = 5;
var CLEANUP_RETRY_DELAY_MS = 50;
function resolveWindowsBunPtyGateEntry(runtimeDir = __dirname, pathExists = import_node_fs3.existsSync) {
  const directory = runtimeDir.replace(/app\.asar(?=[\\/]|$)/, "app.asar.unpacked");
  const candidates = [
    (0, import_node_path3.join)(directory, "windows-bun-pty-gate-entry.js"),
    (0, import_node_path3.join)(directory, "..", "windows-bun-pty-gate-entry.js")
  ];
  return candidates.find(pathExists) ?? candidates[0];
}
function removeLaunchDirectory(directory) {
  try {
    (0, import_node_fs3.rmSync)(directory, {
      recursive: true,
      force: true,
      maxRetries: CLEANUP_MAX_RETRIES,
      retryDelay: CLEANUP_RETRY_DELAY_MS
    });
    return true;
  } catch (error) {
    console.warn(`[pty] failed to remove Windows Bun launch directory ${directory}:`, error);
    return false;
  }
}
function createWindowsBunPtyLaunch(args, deps = {}) {
  if (import_node_path3.win32.basename(args.file).toLowerCase() === "cmd.exe") {
    validateWindowsCmdArguments([args.file, ...args.args]);
  }
  const workerPath = deps.workerPath ?? resolveWindowsBunPtyGateEntry();
  if (!(0, import_node_fs3.existsSync)(workerPath)) {
    throw new Error(`Windows PTY gate entry not found: ${workerPath}`);
  }
  const directory = (0, import_node_fs3.mkdtempSync)((0, import_node_path3.join)((0, import_node_os.tmpdir)(), "orca-bun-pty-"));
  const gatePath = (0, import_node_path3.join)(directory, "job-assigned");
  const requestPath = (0, import_node_path3.join)(directory, "request.json");
  const shellPidPath = (0, import_node_path3.join)(directory, "shell.pid");
  const configPath = (0, import_node_path3.join)(directory, "bunfig.toml");
  const clearPath = (0, import_node_path3.join)(directory, "clear.cmd");
  const cmdExe = getCmdExePath();
  let released = false;
  let disposed = false;
  let spawnReceipt;
  const readSpawnReceipt = () => {
    if (!disposed) {
      spawnReceipt ??= readWindowsBunPtySpawnReceipt(shellPidPath);
    }
    return spawnReceipt;
  };
  const env = { ...args.env, [WINDOWS_BUN_PTY_GATE_ENV]: gatePath };
  const runtimeOptions = {};
  for (const key of WINDOWS_BUN_PTY_RUNTIME_OPTION_KEYS) {
    if (env[key] !== void 0) {
      runtimeOptions[key] = env[key];
    }
    delete env[key];
  }
  try {
    (0, import_node_fs3.writeFileSync)(
      requestPath,
      JSON.stringify({
        file: args.file,
        args: args.args,
        cwd: args.cwd ?? process.cwd(),
        gatePath,
        shellPidPath,
        runtimeOptions
      }),
      { encoding: "utf8", flag: "wx", mode: 384 }
    );
    (0, import_node_fs3.writeFileSync)(configPath, "", { flag: "wx", mode: 384 });
    (0, import_node_fs3.writeFileSync)(clearPath, `@echo off\r
<nul set /p "=${CLEAR_SEQUENCE}"\r
`, {
      encoding: "ascii",
      flag: "wx"
    });
  } catch (error) {
    removeLaunchDirectory(directory);
    throw error;
  }
  return {
    // Run outside the workspace so its bunfig/.env/preloads cannot execute before job assignment.
    command: [
      deps.runtimePath ?? process.execPath,
      "--no-env-file",
      `--config=${configPath}`,
      `--cwd=${directory}`,
      workerPath,
      requestPath
    ],
    clearCommand: [cmdExe, buildWindowsCmdShimCommandLine(clearPath, [])],
    env,
    windowsVerbatimArguments: false,
    readShellProcessId() {
      const receipt = readSpawnReceipt();
      return receipt && "pid" in receipt ? receipt.pid : void 0;
    },
    waitForSpawn: (wrapperExited) => waitForWindowsBunPtySpawn(readSpawnReceipt, wrapperExited),
    release() {
      if (released) {
        return;
      }
      (0, import_node_fs3.writeFileSync)(gatePath, "", { flag: "wx" });
      released = true;
    },
    dispose() {
      if (disposed) {
        return;
      }
      readSpawnReceipt();
      disposed = removeLaunchDirectory(directory);
    }
  };
}

// src/main/daemon/pty-subprocess/bun-pty-process-flow-control.ts
var import_node_os2 = require("node:os");

// src/shared/crash-report-redaction.ts
var MAX_STRING_DETAIL_LENGTH = 240;
var MAX_STACK_DETAIL_LENGTH = 4e3;
var MAX_BREADCRUMB_NAME_LENGTH = 80;
var MAX_BREADCRUMBS = 30;
var SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
];
var CREDENTIAL_URL_PATTERN = /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@(?=[^/\s]+)/g;
var SECRET_ASSIGNMENT_PATTERN = /\b(token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|secret|password|account[_-]?key)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^&\s,;]+)/gi;
var PATH_PATTERNS = [
  /(["'`])\/[A-Za-z0-9._-]+\/(?:(?!\1)[^<>\n\r])+\1/g,
  /(["'`])[A-Za-z]:\\(?:(?!\1)[^<>\n\r])+\1/gi,
  /(["'`])\\\\[^\\\s"'`<>\n\r)]+\\(?:(?!\1)[^<>\n\r])+\1/gi,
  /(?<![A-Za-z0-9./])\/[A-Za-z0-9._-]+\/(?:\\ |[^\s"'`<>)]*)/g,
  /(?<![A-Za-z0-9])[A-Za-z]:\\(?:\\ |[^\s"'`<>\n\r)]*)/gi,
  /\\\\[^\\\s"'`<>\n\r)]+\\(?:\\ |[^\s"'`<>\n\r)]*)/gi,
  /%(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH)%[^\s"'`<>)]*/gi
];
function sanitizeCrashReportString(value, maxLength = MAX_STRING_DETAIL_LENGTH) {
  let sanitized = value;
  for (const pattern of PATH_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted-path]");
  }
  sanitized = sanitized.replace(CREDENTIAL_URL_PATTERN, "[redacted-credential]@");
  sanitized = sanitized.replace(SECRET_ASSIGNMENT_PATTERN, (_match, key) => {
    return `${key}=[redacted]`;
  });
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted-secret]");
  }
  return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength)}...` : sanitized;
}
function sanitizeCrashReportDetails(details) {
  const sanitized = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "string") {
      const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
      if (/(?:^|_)path$/i.test(normalizedKey)) {
        sanitized[key] = "[redacted-path]";
      } else {
        const maxLength = /(?:^|_)(?:stack|component_stack|error_stack|minidump_check_message)$/i.test(
          normalizedKey
        ) ? MAX_STACK_DETAIL_LENGTH : MAX_STRING_DETAIL_LENGTH;
        sanitized[key] = sanitizeCrashReportString(value, maxLength);
      }
    } else if (typeof value === "number" && Number.isFinite(value)) {
      sanitized[key] = value;
    } else if (typeof value === "boolean" || value === null) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
function sanitizeCrashReportBreadcrumbs(breadcrumbs2) {
  if (!breadcrumbs2 || breadcrumbs2.length === 0) {
    return void 0;
  }
  const sanitized = breadcrumbs2.slice(-MAX_BREADCRUMBS).map((breadcrumb) => {
    if (!breadcrumb.name.trim() || !breadcrumb.createdAt.trim()) {
      return null;
    }
    const data = breadcrumb.data ? sanitizeCrashReportDetails(breadcrumb.data) : {};
    const origin = breadcrumb.origin ? sanitizeCrashReportString(breadcrumb.origin).slice(0, 80) : "";
    return {
      createdAt: sanitizeCrashReportString(breadcrumb.createdAt),
      name: sanitizeCrashReportString(breadcrumb.name).slice(0, MAX_BREADCRUMB_NAME_LENGTH),
      ...Object.keys(data).length > 0 ? { data } : {},
      ...origin ? { origin } : {}
    };
  }).filter((breadcrumb) => breadcrumb !== null);
  return sanitized.length > 0 ? sanitized : void 0;
}

// src/shared/crash-reporting.ts
var MAX_USER_NOTES_LENGTH = 8e3;
var MAX_USER_NOTES_SANITIZE_LENGTH = MAX_USER_NOTES_LENGTH * 2;

// src/main/observability/tracer.ts
var import_node_async_hooks = require("node:async_hooks");
var import_node_crypto = require("node:crypto");

// src/main/observability/redactor.ts
var LABELED_KV = /\b(?:api[-_]?key|token|secret|password|bearer|authorization)\b\s*[:=]\s*(?:Bearer\s+\S+|Token\s+\S+|\S+)/gi;
var PROVIDER_PATTERNS = [
  { tag: "anthropic-key", re: /sk-ant-[a-zA-Z0-9_-]{40,}/g },
  { tag: "openai-key", re: /sk-(?:proj-)?[a-zA-Z0-9_-]{32,}/g },
  { tag: "github-token", re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { tag: "aws-access-key-id", re: /AKIA[0-9A-Z]{16}/g },
  {
    tag: "aws-secret-access-key",
    re: /aws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+=]{40}/gi
  },
  {
    tag: "jwt",
    re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
  },
  { tag: "slack-token", re: /xox[baprsoe]-[A-Za-z0-9-]{10,}/g },
  {
    tag: "pem",
    // Lazy `[\s\S]+?` so two back-to-back PEM blocks redact independently, not as one gobbled span.
    re: /-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g
  }
];
var URL_USERINFO = /(https?:\/\/)([^/@\s]+)@/g;
var ENV_LINE = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*\S.*/my;
var WHITESPACE_RUN = /\s*/y;
var LINE_TERMINATORS = ["\n", "\r", "\u2028", "\u2029"];
var CLIENT_ATTR_BLOCKLIST = /* @__PURE__ */ new Set([
  "env",
  "environment",
  "env_vars",
  "api_key",
  "api-key",
  "apikey",
  "authorization",
  "bearer",
  "cookie",
  "password",
  "set-cookie",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "proxy-authorization",
  "headers.authorization"
]);
var SERVER_ATTR_BLOCKLIST_EXTRA = /* @__PURE__ */ new Set([
  "install_id",
  "installid",
  "distinct_id",
  "distinctid"
]);
function shouldDropAttributeKey(key, mode) {
  const k = key.toLowerCase();
  const normalized = k.replace(/[^a-z0-9]+/g, "");
  if (CLIENT_ATTR_BLOCKLIST.has(k)) {
    return true;
  }
  if (/\b(api[-_]?key|token|secret|password|bearer|authorization|private[-_]?key)\b/i.test(key) || /(apikey|token|secret|password|authorization|bearer|privkey|privatekey)/.test(normalized)) {
    return true;
  }
  if (mode === "server" && SERVER_ATTR_BLOCKLIST_EXTRA.has(k)) {
    return true;
  }
  return false;
}
function redactString(input) {
  if (typeof input !== "string" || input.length === 0) {
    return input;
  }
  let out = input;
  out = out.replace(LABELED_KV, "[redacted:labeled-kv]");
  for (const { tag, re } of PROVIDER_PATTERNS) {
    out = out.replace(re, `[redacted:${tag}]`);
  }
  out = out.replace(URL_USERINFO, "$1[redacted]@");
  out = redactEnvironmentLines(out);
  return out;
}
function skipWhitespace(input, index) {
  const length = input.length;
  while (index < length) {
    const code = input.charCodeAt(index);
    if (code === 32 || code >= 9 && code <= 13) {
      index++;
    } else if (code < 128) {
      return index;
    } else {
      WHITESPACE_RUN.lastIndex = index;
      WHITESPACE_RUN.test(input);
      if (WHITESPACE_RUN.lastIndex === index) {
        return index;
      }
      index = WHITESPACE_RUN.lastIndex;
    }
  }
  return index;
}
function redactEnvironmentLines(input) {
  const parts = [];
  let copiedThrough = 0;
  let start = 0;
  const nextTerminator = [-2, -2, -2, -2];
  while (start < input.length) {
    const content = skipWhitespace(input, start);
    if (content === input.length) {
      break;
    }
    const code = input.charCodeAt(content);
    if (code >= 65 && code <= 90 || code === 95) {
      ENV_LINE.lastIndex = start;
      const match = ENV_LINE.exec(input);
      if (match) {
        parts.push(input.slice(copiedThrough, start), `${match[1]}=[redacted:env-value]`);
        copiedThrough = ENV_LINE.lastIndex;
        start = copiedThrough + 1;
        continue;
      }
    }
    let terminator = -1;
    for (let kind = 0; kind < LINE_TERMINATORS.length; kind++) {
      let next = nextTerminator[kind];
      if (next !== -1 && next < content) {
        next = input.indexOf(LINE_TERMINATORS[kind], content);
        nextTerminator[kind] = next;
      }
      if (next !== -1 && (terminator === -1 || next < terminator)) {
        terminator = next;
      }
    }
    if (terminator === -1) {
      break;
    }
    start = terminator + 1;
  }
  if (parts.length === 0) {
    return input;
  }
  parts.push(input.slice(copiedThrough));
  return parts.join("");
}
function redactValue(value, mode = "client", seen = /* @__PURE__ */ new WeakSet()) {
  if (value === null || value === void 0) {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return value.map((entry) => redactValue(entry, mode, seen));
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (shouldDropAttributeKey(k, mode)) {
        continue;
      }
      out[k] = redactValue(v, mode, seen);
    }
    return out;
  }
  return `[unsupported:${typeof value}]`;
}
function redactAttributes(attrs, mode = "client") {
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (shouldDropAttributeKey(k, mode)) {
      continue;
    }
    out[k] = redactValue(v, mode);
  }
  return out;
}
function redactSpan(span, mode = "client") {
  const redactedAttrs = redactAttributes(span.attributes, mode);
  const redactedEvents = span.events.map((ev) => ({
    name: ev.name,
    timeUnixNano: ev.timeUnixNano,
    attributes: redactAttributes(ev.attributes, mode)
  }));
  const exit = span.exit.cause ? { _tag: span.exit._tag, cause: redactString(span.exit.cause) } : { _tag: span.exit._tag };
  return {
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    ...span.parentSpanId ? { parentSpanId: span.parentSpanId } : {},
    kind: span.kind,
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    durationMs: span.durationMs,
    attributes: redactedAttrs,
    events: redactedEvents,
    exit
  };
}

// src/main/observability/tracer.ts
var noopSpan = {
  traceId: "",
  spanId: "",
  setAttribute() {
  },
  addEvent() {
  },
  fail() {
  },
  interrupt() {
  },
  end() {
  }
};
var activeSink = null;
var contextStorage = new import_node_async_hooks.AsyncLocalStorage();
function genTraceId() {
  return (0, import_node_crypto.randomBytes)(16).toString("hex");
}
function genSpanId() {
  return (0, import_node_crypto.randomBytes)(8).toString("hex");
}
function nowUnixNano() {
  return BigInt(Date.now()) * 1000000n;
}
function flushActiveSink() {
  try {
    activeSink?.flush();
  } catch {
  }
}
function startSpan(name, options) {
  if (!activeSink) {
    return noopSpan;
  }
  const parent = contextStorage.getStore();
  const traceId = parent?.traceId ?? genTraceId();
  const spanId = genSpanId();
  const startTimeUnixNano = nowUnixNano();
  const pending = {
    name,
    traceId,
    spanId,
    parentSpanId: parent?.spanId,
    kind: options?.kind ?? "internal",
    startTimeUnixNano,
    attributes: new Map(Object.entries(options?.attributes ?? {})),
    events: [],
    exit: null,
    ended: false
  };
  const finalize = (exit) => {
    if (pending.ended) {
      return;
    }
    pending.ended = true;
    pending.exit = exit;
    const endTimeUnixNano = nowUnixNano();
    const durationMs = Number(endTimeUnixNano - pending.startTimeUnixNano) / 1e6;
    const record = {
      name: pending.name,
      traceId: pending.traceId,
      spanId: pending.spanId,
      ...pending.parentSpanId ? { parentSpanId: pending.parentSpanId } : {},
      kind: pending.kind,
      startTimeUnixNano: String(pending.startTimeUnixNano),
      endTimeUnixNano: String(endTimeUnixNano),
      durationMs,
      attributes: Object.fromEntries(pending.attributes),
      events: pending.events,
      exit
    };
    if (options?.shouldRecord && !options.shouldRecord(record)) {
      return;
    }
    const redacted = redactSpan(record, "client");
    try {
      activeSink?.push({ type: "effect-span", ...redacted });
    } catch {
    }
  };
  return {
    traceId,
    spanId,
    setAttribute(key, value) {
      pending.attributes.set(key, value);
    },
    addEvent(eventName, attributes) {
      pending.events.push({
        name: eventName,
        timeUnixNano: String(nowUnixNano()),
        attributes: attributes ?? {}
      });
    },
    fail(cause) {
      const causeStr = cause instanceof Error ? formatError(cause) : String(cause);
      finalize({ _tag: "Failure", cause: causeStr });
    },
    interrupt(cause) {
      finalize({ _tag: "Interrupted", ...cause ? { cause } : {} });
    },
    end() {
      finalize({ _tag: "Success" });
    }
  };
}
function formatError(err) {
  const head = `${err.name}: ${err.message}`;
  return err.stack ? `${head}
${err.stack}` : head;
}

// src/main/crash-reporting/crash-breadcrumb-store.ts
var MAX_BREADCRUMBS2 = 30;
var MAX_RETAINED_BREADCRUMBS = 8;
var MAX_COALESCE_KEYS = 128;
var monotonicNow = () => performance.now();
var breadcrumbs = [];
var retainedBreadcrumbs = /* @__PURE__ */ new Map();
var coalescedBreadcrumbs = /* @__PURE__ */ new Map();
function retainedBreadcrumbKey(breadcrumb) {
  if (breadcrumb.name !== "renderer_memory_highwater") {
    return null;
  }
  const surface = breadcrumb.data?.rendererSurface;
  const threshold = breadcrumb.data?.thresholdPct !== void 0 ? `pct${String(breadcrumb.data.thresholdPct)}` : `privMB${String(breadcrumb.data?.thresholdPrivateMB)}`;
  return `${breadcrumb.name}:${String(surface)}:${threshold}:${breadcrumb.origin ?? "global"}`;
}
function recordCrashBreadcrumb(name, data, origin) {
  const sanitized = sanitizeCrashReportBreadcrumbs([
    {
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      name,
      data,
      ...origin ? { origin } : {}
    }
  ]);
  const breadcrumb = sanitized?.[0];
  if (!breadcrumb) {
    return;
  }
  const retainedKey = retainedBreadcrumbKey(breadcrumb);
  if (retainedKey) {
    retainedBreadcrumbs.delete(retainedKey);
    retainedBreadcrumbs.set(retainedKey, breadcrumb);
    while (retainedBreadcrumbs.size > MAX_RETAINED_BREADCRUMBS) {
      const oldestKey = retainedBreadcrumbs.keys().next();
      if (oldestKey.done) {
        break;
      }
      retainedBreadcrumbs.delete(oldestKey.value);
    }
    return breadcrumb;
  }
  breadcrumbs.push(breadcrumb);
  if (breadcrumbs.length > MAX_BREADCRUMBS2) {
    breadcrumbs.splice(evictionIndex(breadcrumbs), 1);
  }
  return breadcrumb;
}
function evictionGroupKey(entry) {
  return `${entry.name}\0${entry.origin ?? ""}`;
}
function ownsUnresolvedRepeats(entry) {
  for (const state of coalescedBreadcrumbs.values()) {
    if (state.emitted === entry && state.suppressed > state.resolved) {
      return true;
    }
  }
  return false;
}
function evictionIndex(ring) {
  const counts = /* @__PURE__ */ new Map();
  for (const entry of ring) {
    const key = evictionGroupKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let crowdedKey = "";
  let crowdedCount = 0;
  for (const entry of ring) {
    const key = evictionGroupKey(entry);
    const count = counts.get(key) ?? 0;
    if (count > crowdedCount) {
      crowdedKey = key;
      crowdedCount = count;
    }
  }
  let oldestOfGroup = 0;
  let foundGroup = false;
  for (let index = 0; index < ring.length - 1; index += 1) {
    if (evictionGroupKey(ring[index]) !== crowdedKey) {
      continue;
    }
    if (!foundGroup) {
      oldestOfGroup = index;
      foundGroup = true;
    }
    if (!ownsUnresolvedRepeats(ring[index])) {
      return index;
    }
  }
  return oldestOfGroup;
}
function recordCoalescedCrashBreadcrumb({
  name,
  data,
  coalesceKey,
  minIntervalMs,
  origin
}) {
  const now = monotonicNow();
  const previous = coalescedBreadcrumbs.get(coalesceKey);
  if (previous && now - previous.windowStartedAtMs < minIntervalMs) {
    previous.suppressed += 1;
    previous.pending = data;
    coalescedBreadcrumbs.delete(coalesceKey);
    coalescedBreadcrumbs.set(coalesceKey, previous);
    return void 0;
  }
  for (const [key, entry] of coalescedBreadcrumbs) {
    if (now - entry.windowStartedAtMs >= minIntervalMs) {
      if (key !== coalesceKey) {
        preservePendingCoalescedBreadcrumb(entry);
      }
      coalescedBreadcrumbs.delete(key);
    }
  }
  coalescedBreadcrumbs.delete(coalesceKey);
  const suppressedSinceLast = previous ? previous.suppressed - previous.resolved : 0;
  const state = {
    name,
    windowStartedAtMs: now,
    suppressed: 0,
    carried: suppressedSinceLast,
    resolved: 0,
    ...origin ? { origin } : {}
  };
  coalescedBreadcrumbs.set(coalesceKey, state);
  while (coalescedBreadcrumbs.size > MAX_COALESCE_KEYS) {
    const oldest = coalescedBreadcrumbs.entries().next();
    if (oldest.done) {
      break;
    }
    preservePendingCoalescedBreadcrumb(oldest.value[1]);
    coalescedBreadcrumbs.delete(oldest.value[0]);
  }
  state.emitted = recordCrashBreadcrumb(
    name,
    suppressedSinceLast > 0 ? { ...data, suppressedSinceLast } : data,
    origin
  );
  return { suppressedSinceLast };
}
function isCoalescedCrumbStillInEvidence(crumb, reporterOrigin) {
  const retained = [...retainedBreadcrumbs.values()].filter(
    (breadcrumb) => isVisibleToReporter(breadcrumb, reporterOrigin)
  );
  if (retained.some((retainedBreadcrumb) => retainedBreadcrumb === crumb)) {
    return true;
  }
  const visibleRecent = breadcrumbs.filter(
    (breadcrumb) => isVisibleToReporter(breadcrumb, reporterOrigin)
  );
  return visibleReportWindow(visibleRecent, MAX_BREADCRUMBS2 - retained.length).some(
    (recentBreadcrumb) => recentBreadcrumb === crumb
  );
}
function visibleReportWindow(visibleRecent, budget) {
  if (visibleRecent.length <= budget) {
    return visibleRecent;
  }
  const window = [...visibleRecent];
  while (window.length > budget) {
    window.splice(evictionIndex(window), 1);
  }
  return window;
}
function resolvePendingCoalescedBreadcrumb(state, reporterOrigin) {
  if (!state.emitted || state.suppressed <= state.resolved) {
    return;
  }
  if (!isCoalescedCrumbStillInEvidence(state.emitted, reporterOrigin)) {
    state.emitted = void 0;
    return;
  }
  state.emitted.data = sanitizeCrashReportDetails({
    ...state.pending,
    suppressedSinceLast: state.carried + state.suppressed
  });
  state.resolved = state.suppressed;
  state.pending = void 0;
}
function preservePendingCoalescedBreadcrumb(state) {
  resolvePendingCoalescedBreadcrumb(state, state.origin);
  const unresolved = state.suppressed - state.resolved;
  if (state.emitted || unresolved <= 0) {
    return;
  }
  recordCrashBreadcrumb(
    state.name,
    { ...state.pending, suppressedSinceLast: unresolved },
    state.origin
  );
  state.resolved = state.suppressed;
  state.pending = void 0;
}
function isVisibleToReporter(breadcrumb, reporterOrigin) {
  return !reporterOrigin || !breadcrumb.origin || breadcrumb.origin === reporterOrigin;
}

// src/main/crash-reporting/main-process-lifecycle-identity.ts
var import_node_crypto2 = require("node:crypto");
var mainProcessLifecycleIdentity = Object.freeze({
  mainProcessPid: process.pid,
  mainProcessLaunchId: (0, import_node_crypto2.randomUUID)(),
  mainProcessStartedAt: new Date(Date.now() - process.uptime() * 1e3).toISOString()
});
function getMainProcessLifecycleIdentity() {
  return mainProcessLifecycleIdentity;
}

// src/main/crash-reporting/durable-crash-breadcrumb.ts
function buildLifecycleData(data) {
  return {
    ...data ? sanitizeCrashReportDetails(data) : {},
    ...getMainProcessLifecycleIdentity()
  };
}
function traceDurableBreadcrumb(name, data, failureCause) {
  const span = startSpan("crash.breadcrumb", {
    attributes: {
      kind: "crash-breadcrumb",
      "breadcrumb.name": name,
      "breadcrumb.data": data
    }
  });
  if (failureCause) {
    span.fail(sanitizeCrashReportString(failureCause, 1e3));
  } else {
    span.end();
  }
  flushActiveSink();
}
function recordCoalescedDurableCrashBreadcrumb({
  name,
  data,
  coalesceKey,
  minIntervalMs,
  origin
}) {
  const sanitizedName = sanitizeCrashReportString(name);
  const lifecycleData = buildLifecycleData(data);
  const coalesced = recordCoalescedCrashBreadcrumb({
    name: sanitizedName,
    data: lifecycleData,
    coalesceKey,
    minIntervalMs,
    ...origin ? { origin } : {}
  });
  if (!coalesced) {
    return;
  }
  traceDurableBreadcrumb(
    sanitizedName,
    coalesced.suppressedSinceLast > 0 ? { ...lifecycleData, suppressedSinceLast: coalesced.suppressedSinceLast } : lifecycleData
  );
}

// src/main/crash-reporting/self-initiated-tree-kill-log.ts
var MAX_TRACKED_SELF_KILLS = 32;
var SELF_TREE_KILL_LOOKBACK_MS = 5e3;
var GROUP_KILL_COALESCE_MS = 6e4;
var selfInitiatedKills = [];
function isPidAddressedTreeKill(scope) {
  return scope === "win-taskkill-tree";
}
function evictOneSelfInitiatedTreeKill() {
  const lastCandidate = selfInitiatedKills.length - 1;
  const oldestGroupKill = selfInitiatedKills.findIndex(
    (kill, index) => index < lastCandidate && !isPidAddressedTreeKill(kill.scope)
  );
  selfInitiatedKills.splice(Math.max(oldestGroupKill, 0), 1);
}
function recordSelfInitiatedTreeKill({
  pid,
  site,
  scope,
  at = Date.now()
}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  selfInitiatedKills.push({ pid, site, scope, at });
  while (selfInitiatedKills.length > MAX_TRACKED_SELF_KILLS) {
    evictOneSelfInitiatedTreeKill();
  }
  recordCoalescedDurableCrashBreadcrumb({
    name: "self_tree_kill",
    data: { pid, site, scope },
    coalesceKey: `${scope}\0${site}`,
    minIntervalMs: isPidAddressedTreeKill(scope) ? SELF_TREE_KILL_LOOKBACK_MS : GROUP_KILL_COALESCE_MS
  });
}

// src/shared/abort-signal-reason.ts
function abortSignalReason(signal) {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}
function waitForPromiseWithSignal(promise, signal) {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(abortSignalReason(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortSignalReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// src/main/pty/posix-pty-process-groups.ts
var PROCESS_TABLE_TIMEOUT_MS = 1e3;
var PROCESS_TABLE_MAX_BYTES = 1024 * 1024;
var SELECTED_COLUMNS = "pid=,pgid=,tty=,stat=";
var ALL_PROCESS_ARGS = [
  "-e",
  "-o",
  "pid=PROCESS_ID,pgid=PROCESS_GID,tty=TERMINAL_DEVICE_NUMBER,stat=PROCESS_STATE"
];
var psDialect;
var dialectProbe;
var UnsupportedPsSelectionError = class extends Error {
};
function readProcessTableResult(result) {
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error("PTY process table is unavailable");
  }
  return result.stdout;
}
function readSelectionResult(result, option) {
  const rejectedOption = /^ps: (?:invalid|illegal|unrecognized) option(?: -- |: | )['"]?-?([pt])['"]?\s*$/m.exec(
    result.stderr ?? ""
  )?.[1];
  if (result.code !== null && result.code !== 0 && !result.signal && !result.timedOut && !result.outputTruncated && rejectedOption === option) {
    throw new UnsupportedPsSelectionError();
  }
  const output = readProcessTableResult(result);
  if (psDialect === "all") {
    throw new UnsupportedPsSelectionError();
  }
  return output;
}
function hasControllingTty(tty) {
  return tty !== "?" && tty !== "??" && tty !== "-" && tty !== "0" && !/^0,\d+$/.test(tty);
}
function* processTableQueries(rootPid) {
  if (psDialect !== "all") {
    try {
      const root = readSelectionResult(yield ["-p", String(rootPid), "-o", SELECTED_COLUMNS], "p");
      const rootRow = parseProcessRows(root).find((row) => row.pid === rootPid);
      if (!rootRow || !hasControllingTty(rootRow.tty)) {
        return root;
      }
      const terminal = readSelectionResult(yield ["-t", rootRow.tty, "-o", SELECTED_COLUMNS], "t");
      psDialect ??= "selected";
      return `${root}
${terminal}`;
    } catch (error) {
      if (!(error instanceof UnsupportedPsSelectionError)) {
        throw error;
      }
      psDialect = "all";
    }
  }
  return readProcessTableResult(yield ALL_PROCESS_ARGS);
}
function processTableSpec(args) {
  return {
    program: "ps",
    args,
    env: { ...process.env, LC_ALL: "C" },
    timeoutMs: PROCESS_TABLE_TIMEOUT_MS,
    maxOutputBytes: PROCESS_TABLE_MAX_BYTES
  };
}
function readPtyProcessTable(rootPid) {
  const queries = processTableQueries(rootPid);
  let next = queries.next();
  while (!next.done) {
    next = queries.next(runProcessSync(processTableSpec(next.value)));
  }
  return next.value;
}
async function readPosixPtyProcessTable(rootPid, signal) {
  while (dialectProbe) {
    await waitForPromiseWithSignal(dialectProbe, signal);
  }
  signal?.throwIfAborted();
  let releaseProbe;
  if (psDialect === void 0) {
    dialectProbe = new Promise((resolve) => {
      releaseProbe = resolve;
    });
  }
  try {
    const queries = processTableQueries(rootPid);
    let next = queries.next();
    while (!next.done) {
      signal?.throwIfAborted();
      const result = await runProcess({ ...processTableSpec(next.value), signal });
      signal?.throwIfAborted();
      next = queries.next(result);
    }
    return next.value;
  } finally {
    if (releaseProbe) {
      dialectProbe = void 0;
      releaseProbe();
    }
  }
}
function parseProcessRows(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(\S+))?/.exec(line);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    if (pid > 0 && pgid > 1) {
      rows.push({ pid, pgid, tty: match[3], state: match[4] });
    }
  }
  return rows;
}
function isPosixPtyRootStopped(output, rootPid) {
  return parseProcessRows(output).find((row) => row.pid === rootPid)?.state?.startsWith("T") === true;
}
function getPosixPtyStoppedJobGroups(output, rootPid) {
  const rows = parseProcessRows(output);
  const root = rows.find((row) => row.pid === rootPid);
  return new Set(
    rows.filter(
      (row) => root && row.tty === root.tty && row.pgid !== root.pgid && /^[Tt]/.test(row.state ?? "")
    ).map((row) => row.pgid)
  );
}
function getPosixPtyProcessGroups(output, rootPid, currentPid = process.pid) {
  const rows = parseProcessRows(output);
  const root = rows.find((row) => row.pid === rootPid);
  if (!root || !hasControllingTty(root.tty)) {
    return null;
  }
  if (rows.some((row) => row.pid === currentPid && row.tty === root.tty)) {
    return null;
  }
  const groups = new Set(rows.filter((row) => row.tty === root.tty).map((row) => row.pgid));
  if (!groups.has(root.pgid)) {
    return null;
  }
  return [...groups].sort((left, right) => {
    if (left === root.pgid) {
      return 1;
    }
    if (right === root.pgid) {
      return -1;
    }
    return left - right;
  });
}
function isProcessAlreadyGone(error) {
  return error?.code === "ESRCH";
}
function signalPosixPtyProcessGroups(rootPid, signal, fallback, deps = {}) {
  if ((deps.platform ?? process.platform) === "win32") {
    fallback();
    return;
  }
  let groups;
  try {
    groups = getPosixPtyProcessGroups(
      (deps.readProcessTable ?? (() => readPtyProcessTable(rootPid)))(),
      rootPid,
      deps.currentPid ?? process.pid
    );
  } catch {
    groups = null;
  }
  if (!groups || groups.length === 0) {
    fallback();
    return;
  }
  if (signal === "SIGSTOP") {
    groups.unshift(...groups.splice(-1));
  }
  const signalProcessGroup = deps.signalProcessGroup ?? ((pgid) => process.kill(-pgid, signal));
  let firstError;
  for (const pgid of groups) {
    try {
      signalProcessGroup(pgid);
    } catch (error) {
      if (signal === "SIGSTOP" && pgid === groups[0]) {
        if (isProcessAlreadyGone(error)) {
          return;
        }
        throw error;
      }
      if (!isProcessAlreadyGone(error) && firstError === void 0) {
        firstError = error;
      }
      continue;
    }
    if (signal === "SIGKILL") {
      recordSelfInitiatedTreeKill({
        pid: pgid,
        site: "posix-pty-process-group-sweep",
        scope: "posix-process-group"
      });
    }
  }
  if (firstError !== void 0) {
    throw firstError;
  }
}

// src/main/daemon/pty-subprocess/bun-pty-process-suspension.ts
function createBunPtyProcessSuspension(options) {
  const stoppedGroups = /* @__PURE__ */ new Set();
  return {
    hasStoppedGroups: () => stoppedGroups.size > 0,
    signal(signal, table, requireGroups = false) {
      const alreadyStopped = signal === "SIGSTOP" && table !== void 0 ? getPosixPtyStoppedJobGroups(table, options.pid) : /* @__PURE__ */ new Set();
      let resumeFailed = false;
      signalPosixPtyProcessGroups(
        options.pid,
        signal,
        () => {
          if (requireGroups) {
            throw new Error("Paused PTY group ownership is unavailable");
          }
          options.signalRoot(signal);
        },
        {
          platform: options.platform,
          ...table !== void 0 ? { readProcessTable: () => table } : options.readProcessTable ? { readProcessTable: options.readProcessTable } : {},
          signalProcessGroup(pgid) {
            if (signal === "SIGSTOP" ? alreadyStopped.has(pgid) && !stoppedGroups.has(pgid) : !stoppedGroups.has(pgid)) {
              return;
            }
            if (signal === "SIGCONT" && requireGroups && resumeFailed) {
              throw new Error("An earlier PTY group could not be resumed");
            }
            try {
              if (options.signalProcessGroup) {
                options.signalProcessGroup(pgid, signal);
              } else {
                process.kill(-pgid, signal);
              }
            } catch (error) {
              const gone = error instanceof Error && "code" in error && error.code === "ESRCH";
              if (gone) {
                stoppedGroups.delete(pgid);
              }
              resumeFailed = !gone;
              throw error;
            }
            if (signal === "SIGSTOP") {
              stoppedGroups.add(pgid);
            } else {
              stoppedGroups.delete(pgid);
            }
          }
        }
      );
      if (signal === "SIGCONT") {
        stoppedGroups.clear();
      }
    }
  };
}

// src/main/daemon/pty-subprocess/bun-pty-process-flow-control.ts
var TRANSITION_RETRY_MS = 500;
function createBunPtyProducerFlowControl(options) {
  let state = "running";
  let pauseRequested = false;
  let shuttingDown = false;
  let pendingRead;
  let transitionRetry;
  let pauseDenied = false;
  const signalRoot = (signal) => {
    options.processHandle.kill(import_node_os2.constants.signals[signal]);
  };
  const suspension = createBunPtyProcessSuspension({
    pid: options.processHandle.pid,
    platform: options.platform,
    signalRoot,
    readProcessTable: options.readProcessTable,
    signalProcessGroup: options.signalProcessGroup
  });
  const pausePermanentlyDenied = (error) => error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES");
  const clearTransitionRetry = () => {
    clearTimeout(transitionRetry);
    transitionRetry = void 0;
  };
  const needsTransition = () => !shuttingDown && !options.isExited() && state !== (pauseRequested ? "paused" : "running");
  const retryTransition = () => {
    if (!needsTransition() || transitionRetry) {
      return;
    }
    transitionRetry = setTimeout(() => {
      transitionRetry = void 0;
      reconcile();
    }, TRANSITION_RETRY_MS);
    transitionRetry.unref?.();
  };
  const reconcile = () => {
    if (!needsTransition() || pendingRead) {
      return;
    }
    if (options.platform === "win32") {
      const succeeded = pauseRequested ? options.windowsJob?.pause() : options.windowsJob?.resume();
      state = succeeded ? pauseRequested ? "paused" : "running" : "uncertain";
      if (pauseRequested && !succeeded) {
        pauseRequested = false;
      }
      retryTransition();
      return;
    }
    if (pauseRequested && state === "running") {
      try {
        signalRoot("SIGSTOP");
        state = "uncertain";
      } catch (error) {
        if (pausePermanentlyDenied(error)) {
          pauseDenied = true;
          pauseRequested = false;
        }
        retryTransition();
        return;
      }
    }
    const controller = new AbortController();
    pendingRead = controller;
    void Promise.resolve().then(
      () => options.readProcessTableAsync ? options.readProcessTableAsync(controller.signal) : options.readProcessTable ? options.readProcessTable() : readPosixPtyProcessTable(options.processHandle.pid, controller.signal)
    ).catch(() => "").then((table) => {
      pendingRead = void 0;
      if (!needsTransition()) {
        return;
      }
      const nextPaused = pauseRequested;
      state = "uncertain";
      if (nextPaused) {
        if (!isPosixPtyRootStopped(table, options.processHandle.pid)) {
          retryTransition();
          return;
        }
        suspension.signal("SIGSTOP", table, true);
      } else if (suspension.hasStoppedGroups()) {
        suspension.signal("SIGCONT", table, true);
      } else {
        signalRoot("SIGCONT");
      }
      state = nextPaused ? "paused" : "running";
    }).catch((error) => {
      if (pauseRequested && pausePermanentlyDenied(error)) {
        pauseDenied = true;
        pauseRequested = false;
        reconcile();
      } else {
        retryTransition();
      }
    });
  };
  return {
    pause() {
      if (shuttingDown || options.isExited() || pauseDenied) {
        return;
      }
      clearTransitionRetry();
      pauseRequested = true;
      reconcile();
    },
    resume() {
      clearTransitionRetry();
      pauseDenied = false;
      pauseRequested = false;
      reconcile();
    },
    resumeForShutdown() {
      clearTransitionRetry();
      shuttingDown = true;
      if (options.platform === "win32") {
        if (!options.isExited()) {
          options.windowsJob?.resume();
        }
        state = "running";
        return;
      }
      pendingRead?.abort();
      try {
        if (!options.isExited() && state !== "running") {
          if (suspension.hasStoppedGroups()) {
            suspension.signal("SIGCONT");
          } else {
            signalRoot("SIGCONT");
          }
        }
      } catch {
      }
      state = "running";
    }
  };
}

// src/main/daemon/pty-subprocess/bun-pty-process-runtime.ts
function spawnBunPty(args, deps = {}) {
  const runtime = resolveBunRuntime(deps.runtime);
  const platform = deps.platform ?? process.platform;
  let processHandle;
  let windowsLaunch = null;
  let windowsJob = null;
  let windowsTerminal = null;
  let processExitCode;
  let terminalFinished = false;
  let clearInFlight = null;
  const dataListeners = /* @__PURE__ */ new Set();
  const exitListeners = /* @__PURE__ */ new Set();
  const decoder = new TextDecoder();
  let pendingData = "";
  let exited = false;
  let exitCode = 0;
  let exitSignal;
  const emitData = (data) => {
    if (dataListeners.size === 0) {
      pendingData = (pendingData + data).slice(-512 * 1024);
      return;
    }
    for (const listener of dataListeners) {
      listener(data);
    }
  };
  const onProcessExit = (code) => {
    processExitCode = code;
    windowsLaunch?.dispose();
    if (!windowsTerminal || terminalFinished) {
      emitExit(code);
      return;
    }
    if (!windowsTerminal.closed) {
      windowsTerminal.close();
    }
  };
  const emitExit = (code) => {
    if (exited) {
      return;
    }
    exited = true;
    producerFlowControl.resumeForShutdown();
    windowsLaunch?.readShellProcessId();
    exitCode = code;
    exitSignal = Object.entries(import_node_os3.constants.signals).find(
      ([name]) => name === processHandle.signalCode
    )?.[1];
    const pending = decoder.decode();
    if (pending) {
      emitData(pending);
    }
    for (const dispose of [
      () => processHandle.terminal.closed ? void 0 : processHandle.terminal.close(),
      () => windowsJob?.close()
    ]) {
      try {
        dispose();
      } catch (error) {
        console.warn("[daemon/pty] PTY cleanup failed:", error);
      }
    }
    for (const listener of exitListeners) {
      listener({ exitCode: code, ...exitSignal === void 0 ? {} : { signal: exitSignal } });
    }
    dataListeners.clear();
    exitListeners.clear();
  };
  if (platform === "win32") {
    if (!(deps.assignHostJob ?? assignCurrentProcessToBunPtyHostJob)()) {
      throw new Error("Windows Bun PTY host crash ownership is unavailable");
    }
    windowsLaunch = (deps.createWindowsLaunch ?? createWindowsBunPtyLaunch)(args);
  }
  try {
    const terminalOptions = {
      cols: args.cols,
      rows: args.rows,
      name: args.env.TERM ?? "xterm-256color",
      data: (_terminal, data) => {
        const decoded = decoder.decode(data, { stream: true });
        if (decoded) {
          emitData(decoded);
        }
      },
      exit() {
        terminalFinished = true;
        if (processExitCode !== void 0) {
          emitExit(processExitCode);
        }
      }
    };
    if (windowsLaunch) {
      windowsTerminal = new runtime.Terminal(terminalOptions);
    }
    processHandle = runtime.spawn(windowsLaunch?.command ?? [args.file, ...args.args], {
      cwd: args.cwd,
      env: windowsLaunch?.env ?? args.env,
      ...windowsLaunch ? {
        windowsVerbatimArguments: windowsLaunch.windowsVerbatimArguments
      } : {},
      terminal: windowsTerminal ?? terminalOptions
    });
  } catch (error) {
    windowsTerminal?.close();
    windowsLaunch?.dispose();
    throw error;
  }
  if (windowsLaunch) {
    try {
      windowsJob = (deps.createJob ?? createWindowsBunPtyJob)(
        processHandle.pid,
        void 0,
        args.windowsJobKillOnClose === true
      );
      if (!windowsJob) {
        throw new Error("Windows Bun PTY job ownership is unavailable");
      }
      windowsLaunch.release();
    } catch (error) {
      windowsJob?.terminate();
      try {
        processHandle.kill("SIGTERM");
      } catch {
      }
      if (!processHandle.terminal.closed) {
        processHandle.terminal.close();
      }
      windowsJob?.close();
      windowsLaunch.dispose();
      const disposeLaunch = () => windowsLaunch?.dispose();
      void processHandle.exited.then(disposeLaunch, disposeLaunch);
      throw error;
    }
  }
  void processHandle.exited.then(onProcessExit, () => onProcessExit(1));
  const producerFlowControl = createBunPtyProducerFlowControl({
    platform,
    processHandle,
    windowsJob,
    isExited: () => exited,
    ...deps.readProcessTable ? { readProcessTable: deps.readProcessTable } : {},
    ...deps.signalProcessGroup ? { signalProcessGroup: deps.signalProcessGroup } : {}
  });
  const windowsCapabilities = windowsJob ? {
    waitForSpawn: () => windowsLaunch?.waitForSpawn(processHandle.exited) ?? Promise.resolve(),
    terminateOwnedTree: () => windowsJob?.terminate() ?? "unavailable",
    listOwnedProcessIds: () => windowsJob?.listProcessIds() ?? null,
    jobRootProcessIsWrapper: true,
    signalProcess(signal) {
      if (signal === "SIGWINCH") {
        return;
      }
      if (windowsJob?.terminate() === "terminated") {
        return;
      }
      try {
        processHandle.kill(signal);
      } finally {
        if (!processHandle.terminal.closed) {
          processHandle.terminal.close();
        }
      }
    }
  } : {};
  const clearCapability = windowsLaunch ? {
    clear() {
      if (exited || clearInFlight) {
        return;
      }
      try {
        const clearProcess = runtime.spawn(windowsLaunch.clearCommand, {
          cwd: args.cwd,
          env: args.env,
          terminal: processHandle.terminal,
          windowsVerbatimArguments: true
        });
        clearInFlight = clearProcess.exited;
        const settled = () => {
          clearInFlight = null;
        };
        void clearInFlight.then(settled, settled);
      } catch {
        clearInFlight = null;
      }
    }
  } : {};
  const terminate2 = (signal) => {
    producerFlowControl.resumeForShutdown();
    const treeTerminated = windowsJob?.terminate() === "terminated";
    try {
      processHandle.kill(signal);
    } catch (error) {
      if (!treeTerminated) {
        throw error;
      }
    }
  };
  const terminalIo = createBunPtyTerminalIo(
    processHandle.terminal,
    args,
    () => exited,
    () => terminate2("SIGKILL")
  );
  return {
    pid: processHandle.pid,
    get shellProcessId() {
      return windowsLaunch?.readShellProcessId();
    },
    handleFlowControl: false,
    processNameIsSpawnFile: true,
    clear() {
    },
    process: args.file,
    get cols() {
      return terminalIo.cols;
    },
    get rows() {
      return terminalIo.rows;
    },
    write: terminalIo.write,
    resize: terminalIo.resize,
    onData(listener) {
      if (pendingData) {
        const data = pendingData;
        pendingData = "";
        listener(data);
      }
      if (exited) {
        return { dispose() {
        } };
      }
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit(listener) {
      if (exited) {
        listener({ exitCode, ...exitSignal === void 0 ? {} : { signal: exitSignal } });
        return { dispose() {
        } };
      }
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    ...clearCapability,
    ...producerFlowControl,
    ...windowsCapabilities,
    // Interactive POSIX shells ignore SIGTERM.
    kill(signal = platform === "win32" ? "SIGTERM" : "SIGHUP") {
      if (!exited) {
        terminate2(signal);
      }
    },
    destroy() {
      if (!exited) {
        terminate2(platform === "win32" ? "SIGTERM" : "SIGHUP");
      }
      if (!processHandle.terminal.closed) {
        processHandle.terminal.close();
      }
    }
  };
}

// src/main/daemon/bun-pty-windows-io-failure-fixture.ts
var CHILD = `
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('NATIVE_READY');
process.stdin.on('data', chunk => {
  if (chunk.toString().includes('finish')) {
    process.stdout.write('FINAL_STATE_END', () => process.exit(17));
  } else {
    process.stdout.write('WITNESS_REPLY_END');
  }
});`;
async function runWindowsNativeIoFailure(options) {
  if (process.platform !== "win32") {
    throw new Error("Windows native qualification only");
  }
  const runtime = resolveBunRuntime();
  let closeOnWrite = false;
  let nativeFailure = "";
  class ClosingTerminal extends runtime.Terminal {
    constructor(args) {
      super(args);
      const nativeWrite = this.write.bind(this);
      this.write = (data) => {
        if (closeOnWrite) {
          closeOnWrite = false;
          this.close();
        }
        try {
          return nativeWrite(data);
        } catch (error) {
          nativeFailure = error instanceof Error ? error.message : String(error);
          throw error;
        }
      };
    }
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== void 0)
  );
  const launch = (victim) => {
    const proc = spawnBunPty(
      {
        file: process.execPath,
        args: ["--no-env-file", "-e", CHILD],
        cwd: process.cwd(),
        env,
        cols: 120,
        rows: 30,
        windowsJobKillOnClose: true
      },
      {
        ...victim ? { runtime: { Terminal: ClosingTerminal, spawn: runtime.spawn.bind(runtime) } } : {},
        createWindowsLaunch: (args) => createWindowsBunPtyLaunch(args, {
          workerPath: options.workerPath ?? (0, import_node_path4.join)(__dirname, "pty-subprocess/windows-bun-pty-gate-entry.ts")
        })
      }
    );
    let output = "";
    let exitCount = 0;
    proc.onData((data) => {
      output += data;
    });
    const exited = new Promise((resolve) => {
      proc.onExit(({ exitCode }) => {
        exitCount++;
        resolve(exitCode);
      });
    });
    return { proc, exited, output: () => output, exitCount: () => exitCount };
  };
  const uncaught = [];
  const onUncaught = (error) => {
    uncaught.push(error.message);
  };
  process.on("uncaughtException", onUncaught);
  const terminals = [];
  const bounded = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Native I/O fixture deadline exceeded")),
            15e3
          );
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const waitFor = async (terminal, marker) => {
    const deadline = Date.now() + 15e3;
    while (!terminal.output().includes(marker)) {
      if (Date.now() > deadline) {
        throw new Error(`Missing ${marker}: ${terminal.output()}`);
      }
      await (0, import_promises2.setTimeout)(10);
    }
  };
  try {
    const victim = launch(true);
    terminals.push(victim);
    const witness = launch(false);
    terminals.push(witness);
    await bounded(Promise.all(terminals.map((t) => t.proc.waitForSpawn?.())));
    await Promise.all(terminals.map((t) => waitFor(t, "NATIVE_READY")));
    if (options.operation === "write-close") {
      closeOnWrite = true;
      victim.proc.write("trigger");
    } else if (options.operation === "late-write") {
      victim.proc.kill();
    } else {
      victim.proc.write("finish");
    }
    const exitCode = await bounded(victim.exited);
    victim.proc.write("late input");
    victim.proc.resize(90, 24);
    await (0, import_promises2.setTimeout)(1500);
    witness.proc.write("probe");
    await waitFor(witness, "WITNESS_REPLY_END");
    return {
      nativeFailure,
      exitCode,
      victimExitCount: victim.exitCount(),
      witnessExitCount: witness.exitCount(),
      witnessWritable: true,
      finalOutputBeforeExit: victim.output().includes("FINAL_STATE_END"),
      uncaught
    };
  } finally {
    for (const terminal of terminals) {
      terminal.proc.kill();
    }
    await bounded(Promise.all(terminals.map((t) => t.exited)));
    for (const terminal of terminals) {
      terminal.proc.destroy();
    }
    await (0, import_promises2.setTimeout)(1500);
    process.off("uncaughtException", onUncaught);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  runWindowsNativeIoFailure
});
