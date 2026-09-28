var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// .build/bun-runtime-modernization/terminal-consolidation/windows-wide-qualification/bun-patch/runtime-retention-probe/retention-native.ts
var retention_native_exports = {};
__export(retention_native_exports, {
  qualifyRetention: () => qualifyRetention
});
module.exports = __toCommonJS(retention_native_exports);
var import_node_fs8 = require("node:fs");
var import_node_path6 = require("node:path");
var import_node_os2 = require("node:os");
var import_strict = __toESM(require("node:assert/strict"));

// .build/bun-runtime-modernization/source/src/main/daemon/daemon-bun-runtime-retention.ts
var import_promises2 = require("node:fs/promises");
var import_node_path5 = require("node:path");
var import_promises3 = require("node:timers/promises");

// .build/bun-runtime-modernization/source/src/main/persistence/profile-state/profile-state-access.ts
var import_node_fs7 = require("node:fs");
var import_node_path4 = require("node:path");

// .build/bun-runtime-modernization/source/src/main/persistence/profile-state/profile-state-access-owner.ts
var import_node_crypto = require("node:crypto");
var import_node_fs6 = require("node:fs");
var import_node_os = require("node:os");
var import_node_path3 = require("node:path");

// .build/bun-runtime-modernization/source/src/shared/secure-file.ts
var import_node_fs2 = require("node:fs");

// .build/bun-runtime-modernization/source/src/shared/secure-path-hardening-cache.ts
var SECURE_PATH_HARDENING_CACHE_MAX_ENTRIES = 1024;
var SECURE_PATH_HARDENING_CACHE_KEY_MAX_BYTES = 64 * 1024;
var SECURE_PATH_HARDENING_CACHE_KEYS_MAX_BYTES = 512 * 1024;
var DEFAULT_HARDENING_CACHE_BOUNDS = {
  maxEntries: SECURE_PATH_HARDENING_CACHE_MAX_ENTRIES,
  maxKeyBytes: SECURE_PATH_HARDENING_CACHE_KEY_MAX_BYTES,
  maxTotalKeyBytes: SECURE_PATH_HARDENING_CACHE_KEYS_MAX_BYTES
};
var SecurePathHardeningCache = class {
  constructor(bounds) {
    this.bounds = bounds;
  }
  entries = /* @__PURE__ */ new Map();
  retainedKeyBytes = 0;
  get(path) {
    const retained = this.entries.get(path);
    if (!retained) {
      return void 0;
    }
    this.entries.delete(path);
    this.entries.set(path, retained);
    return retained.value;
  }
  set(path, value) {
    const keyBytes = Buffer.byteLength(path, "utf8");
    this.delete(path);
    if (keyBytes > this.bounds.maxKeyBytes || keyBytes > this.bounds.maxTotalKeyBytes || this.bounds.maxEntries <= 0) {
      return false;
    }
    while (this.entries.size >= this.bounds.maxEntries || this.retainedKeyBytes + keyBytes > this.bounds.maxTotalKeyBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === void 0) {
        return false;
      }
      this.delete(oldest);
    }
    this.entries.set(path, { value, keyBytes });
    this.retainedKeyBytes += keyBytes;
    return true;
  }
  delete(path) {
    const retained = this.entries.get(path);
    if (!retained) {
      return;
    }
    this.entries.delete(path);
    this.retainedKeyBytes -= retained.keyBytes;
  }
  clear() {
    this.entries.clear();
    this.retainedKeyBytes = 0;
  }
  state() {
    return {
      entries: this.entries.size,
      keyBytes: this.retainedKeyBytes,
      paths: [...this.entries.keys()]
    };
  }
};

// .build/bun-runtime-modernization/source/src/shared/secure-path-hardening-retry-budget.ts
var HARDENING_RETRY_CEILING_MS = 30 * 6e4;

// .build/bun-runtime-modernization/source/src/shared/child-process/run-process.ts
var import_node_child_process2 = require("node:child_process");

// .build/bun-runtime-modernization/source/src/shared/child-process/windows-command-line.ts
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

// .build/bun-runtime-modernization/source/src/shared/child-process/windows-cmd-shim-resolution.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
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
  return !UNSAFE_SHIM_PATH.test(spelled) && !import_node_path.win32.isAbsolute(spelled);
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
  const sibling = import_node_path.win32.join(directory, "node.exe");
  if (statFile(sibling)) {
    return sibling;
  }
  const extensions = pathExtValue.split(";").map((extension) => extension.trim().toLowerCase()).filter((extension) => extension.startsWith("."));
  for (const entry of pathValue.split(";")) {
    const trimmed = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!trimmed || !import_node_path.win32.isAbsolute(trimmed)) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = import_node_path.win32.join(trimmed, `node${extension}`);
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
  if (!import_node_path.win32.isAbsolute(program)) {
    return null;
  }
  const parsed = readParsedShim(program);
  if (!parsed) {
    return null;
  }
  const directory = import_node_path.win32.dirname(program);
  if (parsed.kind === "direct") {
    const target = import_node_path.win32.resolve(directory, parsed.target);
    const lower = target.toLowerCase();
    if (!DIRECT_TARGET_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
      return null;
    }
    return statFile(target) ? { program: target, prefixArgs: [] } : null;
  }
  const script = import_node_path.win32.resolve(directory, parsed.script);
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

// .build/bun-runtime-modernization/source/src/shared/child-process/spawn-resolution.ts
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

// .build/bun-runtime-modernization/source/src/shared/child-process/process-tree-termination.ts
var import_node_child_process = require("node:child_process");

// .build/bun-runtime-modernization/source/src/shared/child-process/process-tree-kill-gate.ts
var gate = null;
function admitProcessTreeKill(kill) {
  try {
    return gate?.(kill) ?? true;
  } catch {
    return true;
  }
}

// .build/bun-runtime-modernization/source/src/shared/child-process/process-tree-termination.ts
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

// .build/bun-runtime-modernization/source/src/shared/child-process/bounded-output-sink.ts
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

// .build/bun-runtime-modernization/source/src/shared/child-process/child-termination-reporter.ts
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

// .build/bun-runtime-modernization/source/src/shared/child-process/process-spec.ts
var DEFAULT_PROCESS_TIMEOUT_MS = 3e4;
var DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

// .build/bun-runtime-modernization/source/src/shared/child-process/run-process.ts
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

// .build/bun-runtime-modernization/source/src/shared/child-process/windows-system-binary.ts
var import_node_path2 = require("node:path");
function systemRoot(env = process.env) {
  return env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? "C:\\Windows";
}
function windowsPowerShellPath(env = process.env) {
  return import_node_path2.win32.join(systemRoot(env), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// .build/bun-runtime-modernization/source/src/shared/secure-file.ts
var UNSUPPORTED_DIRECTORY_FSYNC_CODES = /* @__PURE__ */ new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP"]);
var hardenedPathsThisProcess = new SecurePathHardeningCache(
  DEFAULT_HARDENING_CACHE_BOUNDS
);
var hardenedDirectoryPathsThisProcess = new SecurePathHardeningCache(
  DEFAULT_HARDENING_CACHE_BOUNDS
);
function fsyncPathSync(path, flags) {
  const descriptor = (0, import_node_fs2.openSync)(path, flags);
  try {
    (0, import_node_fs2.fsyncSync)(descriptor);
  } finally {
    (0, import_node_fs2.closeSync)(descriptor);
  }
}
function fsyncFileSync(path) {
  fsyncPathSync(path, process.platform === "win32" ? "r+" : "r");
}
function bestEffortFsyncDirectorySync(directory) {
  if (process.platform === "win32") {
    return;
  }
  try {
    fsyncPathSync(directory, "r");
  } catch (error) {
    if (error instanceof Error && UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(error.code ?? "")) {
      return;
    }
    throw error;
  }
}

// .build/bun-runtime-modernization/source/src/main/codex-accounts/fs-utils.ts
var import_node_fs3 = require("node:fs");

// .build/bun-runtime-modernization/source/src/shared/windows-batch-spawn.ts
var WINDOWS_BATCH_UNSAFE_CHARACTERS = ["&", "|", "<", ">", "^", '"', "%", "!"];
var WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL = WINDOWS_BATCH_UNSAFE_CHARACTERS.join(" ");
var UNSAFE_WINDOWS_BATCH_SYNTAX = new RegExp(
  `[${WINDOWS_BATCH_UNSAFE_CHARACTERS.map((character) => character.replace(/[\\^\]-]/, "\\$&")).join("")}\\r\\n]`
);

// .build/bun-runtime-modernization/source/src/shared/node-file-content-equality.ts
var NODE_FILE_CONTENT_COMPARE_CHUNK_BYTES = 64 * 1024;

// .build/bun-runtime-modernization/source/src/main/codex-accounts/fs-utils.ts
function renameFileWithWindowsRetry(source, target) {
  runFileOperationWithWindowsRetry(() => (0, import_node_fs3.renameSync)(source, target));
}
function runFileOperationWithWindowsRetry(operation) {
  for (let attempt = 1; ; attempt++) {
    try {
      operation();
      return;
    } catch (error) {
      if (shouldRetryFileOperation(error, attempt)) {
        sleepSync(attempt * 50);
        continue;
      }
      throw error;
    }
  }
}
function shouldRetryFileOperation(error, attempt) {
  return process.platform === "win32" && attempt < 6 && error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY");
}
var sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

// .build/bun-runtime-modernization/source/src/shared/process-output-field-scanner.ts
var PROCESS_OUTPUT_FIELD_SCAN_MAX_CHARS = 4096;
function getProcessOutputFields(line, maxFields) {
  if (maxFields <= 0) {
    return [];
  }
  const fields = [];
  const scanLimit = Math.min(line.length, PROCESS_OUTPUT_FIELD_SCAN_MAX_CHARS);
  let tokenStart = -1;
  for (let index = 0; index <= scanLimit; index += 1) {
    const isEnd = index === scanLimit;
    if (!isEnd && !isProcessOutputWhitespace(line.charCodeAt(index))) {
      if (tokenStart === -1) {
        tokenStart = index;
      }
      continue;
    }
    if (tokenStart === -1) {
      continue;
    }
    fields.push(line.slice(tokenStart, index));
    tokenStart = -1;
    if (fields.length >= maxFields) {
      break;
    }
  }
  return fields;
}
function isProcessOutputWhitespace(code) {
  return code === 32 || code >= 9 && code <= 13 || code === 160 || code === 5760 || code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
}

// .build/bun-runtime-modernization/source/src/main/daemon/daemon-process-identity-query.ts
var import_node_child_process3 = require("node:child_process");
var import_node_util = require("node:util");
var execFileAsync = (0, import_node_util.promisify)(import_node_child_process3.execFile);
function parsePsProcessIdentity(output, utc = false) {
  const startedAtMs = Date.parse(output.slice(0, 24) + (utc ? " UTC" : ""));
  return {
    commandLine: output.slice(24).trim(),
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null
  };
}
function getPsProcessIdentity(pid, options) {
  try {
    const output = (0, import_node_child_process3.execFileSync)("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
      encoding: "utf8",
      timeout: 2e3,
      ...options?.utc ? { env: { ...process.env, TZ: "UTC", LC_ALL: "C" } } : {}
    });
    return parsePsProcessIdentity(output, options?.utc);
  } catch {
    return null;
  }
}

// .build/bun-runtime-modernization/source/src/main/daemon/daemon-process-start-time.ts
var START_TIME_TOLERANCE_MS = 1500;
function parseLinuxProcStartTicks(stat) {
  const commandEndIndex = stat.lastIndexOf(")");
  if (commandEndIndex === -1) {
    return Number.NaN;
  }
  const fields = getProcessOutputFields(stat.slice(commandEndIndex + 1), 20);
  return Number(fields[19]);
}
function startTimesWithinTolerance(actualStartedAtMs, expectedStartedAtMs, toleranceMs) {
  if (expectedStartedAtMs === null || actualStartedAtMs === null) {
    return true;
  }
  return Math.abs(actualStartedAtMs - expectedStartedAtMs) <= toleranceMs;
}

// .build/bun-runtime-modernization/source/src/main/persistence/profile-state/profile-state-access-identity.ts
var import_node_fs5 = require("node:fs");

// .build/bun-runtime-modernization/source/src/main/windows-native-registry.ts
var import_node_module = require("node:module");
var WINDOWS_REG_SZ = 1;
var requireFromMain = (0, import_node_module.createRequire)(__filename);
function loadWindowsNativeRegistry() {
  return requireFromMain("@orca/windows-registry");
}

// .build/bun-runtime-modernization/source/src/main/windows/windows-process-table.ts
var import_node_fs4 = require("node:fs");
var import_node_module2 = require("node:module");

// .build/bun-runtime-modernization/source/src/shared/process-table-snapshot-reader.ts
var import_node_child_process4 = require("node:child_process");
var import_promises = require("node:fs/promises");
var import_node_util2 = require("node:util");

// .build/bun-runtime-modernization/source/src/shared/process-table-snapshot.ts
var HOST_IS_DARWIN = typeof process !== "undefined" && process.platform === "darwin";
var PS_ARGS = HOST_IS_DARWIN ? ["-axo", "pid=,ppid=,pgid=,tpgid=,stat=,tty=,lstart=,command="] : ["-axo", "pid=,ppid=,pgid=,tpgid=,stat=,tty=,etimes=,command="];
var SHELL_FOREGROUND_PS_ARGS = [
  "-axo",
  "pid=,ppid=,pgid=,tpgid=,stat=,command="
];
function parseShellForegroundRows(stdout) {
  const rows = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(.+)$/);
    const pid = match ? Number(match[1]) : 0;
    if (match && Number.isSafeInteger(pid) && pid > 0) {
      rows.push({
        pid,
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        tpgid: Number(match[4]),
        stat: match[5],
        command: match[6]
      });
    }
  }
  if (rows.length === 0) {
    throw new ProcessTableCaptureError("empty_capture");
  }
  return rows;
}
var PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
var PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS = 500;
function parseProcessTableRows(stdout) {
  const rows = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    const macStartMatch = trimmed.match(
      /^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(\S+\s+\S+\s+\d{1,2}\s+\S+\s+\d{4})\s+(.+)$/
    );
    if (macStartMatch) {
      rows.push({
        pid: Number(macStartMatch[1]),
        ppid: Number(macStartMatch[2]),
        pgid: Number(macStartMatch[3]),
        tpgid: Number(macStartMatch[4]),
        stat: macStartMatch[5],
        tty: macStartMatch[6],
        startTime: macStartMatch[7],
        command: macStartMatch[8]
      });
      continue;
    }
    const evidenceMatch = trimmed.match(
      /^(\d+)\s+(\d+)\s+(?:(-?\d+)\s+(-?\d+)\s+)?(\S+)(?:\s+(\S+)\s+(\d+))?\s+(.+)$/
    );
    if (evidenceMatch) {
      rows.push({
        pid: Number(evidenceMatch[1]),
        ppid: Number(evidenceMatch[2]),
        ...evidenceMatch[3] !== void 0 ? { pgid: Number(evidenceMatch[3]), tpgid: Number(evidenceMatch[4]) } : {},
        stat: evidenceMatch[5] ?? evidenceMatch[3],
        ...evidenceMatch[7] !== void 0 ? { tty: evidenceMatch[6], startTime: evidenceMatch[7] } : {},
        command: evidenceMatch[8] ?? evidenceMatch[6] ?? evidenceMatch[4]
      });
      continue;
    }
    const legacyMatch = trimmed.match(
      /^((?:\d+)\s+(?:\d+)\s+)(?:(-?\d+)\s+(-?\d+)\s+)?(\S+)\s+(.+)$/
    );
    if (legacyMatch) {
      rows.push({
        pid: Number(legacyMatch[1].trim().split(/\s+/)[0]),
        ppid: Number(legacyMatch[1].trim().split(/\s+/)[1]),
        ...legacyMatch[2] !== void 0 ? { pgid: Number(legacyMatch[2]), tpgid: Number(legacyMatch[3]) } : {},
        stat: legacyMatch[4],
        command: legacyMatch[5]
      });
    }
  }
  return rows;
}
var ProcessTableCaptureError = class extends Error {
  constructor(reason) {
    super(`process table unreadable: ${reason}`);
    this.reason = reason;
    this.name = "ProcessTableCaptureError";
  }
  code = "process_table_unreadable";
};
function parseStrictProcessTableRows(stdout) {
  const rows = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^PID\s+PPID\s+PGID\s+TPGID\s+STAT\s+COMMAND$/i.test(line)) {
      continue;
    }
    const macStartMatch = line.match(
      /^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(\S+\s+\S+\s+\d{1,2}\s+\S+\s+\d{4})\s+(.+)$/
    );
    const numericMatch = macStartMatch ? null : line.match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)(?:\s+(\S+)\s+(\d+))?\s+(.+)$/);
    if (!numericMatch && !macStartMatch) {
      throw new ProcessTableCaptureError("malformed_row");
    }
    const match = numericMatch ?? macStartMatch;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    const tpgid = Number(match[4]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0 || !Number.isSafeInteger(pgid) || pgid < 0 || !Number.isSafeInteger(tpgid) || tpgid < 0 && tpgid !== -1 || (match[8] ?? match[6]).length === 0) {
      throw new ProcessTableCaptureError("invalid_numeric_field");
    }
    rows.push({
      pid,
      ppid,
      pgid,
      tpgid,
      stat: match[5],
      ...numericMatch && match[7] !== void 0 ? { tty: match[6], startTime: match[7] } : macStartMatch ? { tty: match[6], startTime: match[7] } : {},
      command: numericMatch ? match[8] ?? match[6] : match[8]
    });
  }
  if (rows.length === 0) {
    throw new ProcessTableCaptureError("empty_capture");
  }
  return rows;
}

// .build/bun-runtime-modernization/source/src/shared/process-table-snapshot-reader.ts
var execFile2 = (0, import_node_util2.promisify)(import_node_child_process4.execFile);
var PS_TIMEOUT_MS = 15e3;
var DEFAULT_SNAPSHOT_TTL_MS = PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS;
function createProcessTableSnapshotReader(deps) {
  const ttlMs = deps.ttlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
  let cached = null;
  let inFlight = null;
  let sequence = 0;
  let freshQueued = null;
  async function runSnapshot() {
    const capturedAtMs = deps.now();
    const promise = deps.runPs();
    inFlight = promise;
    try {
      const value = await promise;
      cached = { value, capturedAtMs, completedAtMs: deps.now() };
      return value;
    } finally {
      if (inFlight === promise) {
        inFlight = null;
      }
    }
  }
  async function getSnapshot() {
    if (cached && deps.now() - cached.completedAtMs < ttlMs) {
      return cached.value;
    }
    if (inFlight) {
      return inFlight;
    }
    if (freshQueued) {
      return freshQueued.promise;
    }
    return runSnapshot();
  }
  async function getSnapshotWithAge() {
    const value = await getSnapshot();
    const capturedAtMs = cached?.value === value ? cached.capturedAtMs : deps.now();
    return { value, capturedAgeMs: Math.max(0, deps.now() - capturedAtMs) };
  }
  function getFreshSnapshot() {
    const requestSequence = ++sequence;
    if (freshQueued?.startSequence === null) {
      return freshQueued.promise;
    }
    const priorFresh = freshQueued?.promise ?? null;
    const priorScan = inFlight;
    const entry = {
      promise: Promise.resolve(void 0),
      startSequence: null
    };
    entry.promise = Promise.resolve().then(async () => {
      for (const prior of [priorFresh, priorScan]) {
        if (!prior) {
          continue;
        }
        try {
          await prior;
        } catch {
        }
      }
      entry.startSequence = ++sequence;
      if (entry.startSequence <= requestSequence) {
        throw new Error("fresh process snapshot did not start after request");
      }
      return runSnapshot();
    });
    freshQueued = entry;
    const clearQueued = () => {
      if (freshQueued === entry) {
        freshQueued = null;
      }
    };
    void entry.promise.then(clearQueued, clearQueued);
    return entry.promise;
  }
  return {
    getSnapshot,
    getSnapshotWithAge,
    getFreshSnapshot,
    reset: () => {
      cached = null;
      inFlight = null;
      sequence = 0;
      freshQueued = null;
    }
  };
}
function applyProcessStartTimes(rows, startTimesByPid, dropUnstableStartTimes = false) {
  if ((!startTimesByPid || startTimesByPid.size === 0) && !dropUnstableStartTimes) {
    return rows;
  }
  return rows.map((row) => {
    const startTime = startTimesByPid?.get(row.pid);
    if (startTime) {
      return { ...row, startTime };
    }
    if (dropUnstableStartTimes && row.startTime !== void 0) {
      const { startTime: _unstable, ...withoutStartTime } = row;
      return withoutStartTime;
    }
    return row;
  });
}
function createProcessTableCapture(stdout, startTimesByPid, dropUnstableStartTimes = false) {
  let lenientRows = null;
  let strictResult = null;
  return {
    lenient: () => lenientRows ??= applyProcessStartTimes(
      parseProcessTableRows(stdout),
      startTimesByPid,
      dropUnstableStartTimes
    ),
    strict: () => {
      if (strictResult === null) {
        try {
          strictResult = {
            rows: applyProcessStartTimes(
              parseStrictProcessTableRows(stdout),
              startTimesByPid,
              dropUnstableStartTimes
            )
          };
        } catch (error) {
          strictResult = { error };
        }
      }
      if ("error" in strictResult) {
        throw strictResult.error;
      }
      return strictResult.rows;
    }
  };
}
function assertWholeCapture(stdout) {
  if (Buffer.byteLength(stdout, "utf-8") >= PS_MAX_BUFFER_BYTES) {
    throw new ProcessTableCaptureError("capture_truncated");
  }
  if (!/\S/.test(stdout)) {
    throw new ProcessTableCaptureError("empty_capture");
  }
  return stdout;
}
function parseLinuxProcStatStartTime(stat) {
  const closingParen = stat.lastIndexOf(")");
  if (closingParen === -1) {
    return null;
  }
  const tail = stat.slice(closingParen + 1).trim().split(/\s+/);
  return tail[19] || null;
}
async function readLinuxProcessStartTimes(rows) {
  if (process.platform !== "linux") {
    return void 0;
  }
  const candidates = rows.filter((row) => row.tty !== void 0 && row.tty !== "?");
  const starts = await Promise.all(
    candidates.map(async (row) => {
      try {
        const startTime = parseLinuxProcStatStartTime(
          await (0, import_promises.readFile)(`/proc/${row.pid}/stat`, "utf8")
        );
        return startTime ? [row.pid, startTime] : null;
      } catch {
        return null;
      }
    })
  );
  const result = /* @__PURE__ */ new Map();
  for (const entry of starts) {
    if (entry) {
      result.set(entry[0], entry[1]);
    }
  }
  return result;
}
async function captureProcessTable(args) {
  let stdout;
  try {
    ;
    ({ stdout } = await execFile2("ps", [...args], {
      encoding: "utf-8",
      timeout: PS_TIMEOUT_MS,
      maxBuffer: PS_MAX_BUFFER_BYTES
    }));
  } catch (error) {
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new ProcessTableCaptureError("capture_truncated");
    }
    throw error;
  }
  return assertWholeCapture(stdout);
}
var processTableReader = createProcessTableSnapshotReader({
  runPs: async () => {
    const stdout = await captureProcessTable(PS_ARGS);
    const baseCapture = createProcessTableCapture(stdout);
    const startTimesByPid = await readLinuxProcessStartTimes(baseCapture.lenient());
    return createProcessTableCapture(stdout, startTimesByPid, process.platform === "linux");
  },
  now: () => Date.now()
});
var shellForegroundReader = createProcessTableSnapshotReader({
  runPs: async () => parseShellForegroundRows(await captureProcessTable(SHELL_FOREGROUND_PS_ARGS)),
  now: () => Date.now()
});

// .build/bun-runtime-modernization/source/src/main/windows/windows-command-line-recovery-health.ts
var warned = false;
function reportWindowsCommandLineRecoveryHealth(rows) {
  if (warned) {
    return;
  }
  const self = rows.find((row) => row.pid === process.pid);
  if (!self || (self.commandLine ?? "") !== "") {
    return;
  }
  warned = true;
  const recovered = rows.filter((row) => (row.commandLine ?? "") !== "").length;
  console.warn(
    "[windows-process-table] command-line recovery is refused on this host: the querying process has no command line of its own, so NtQueryInformationProcess(ProcessCommandLineInformation) is failing for every process. Agent identity matching falls back to image names. A hooked ntdll that does not know class 60 is the usual cause.",
    { processes: rows.length, withCommandLine: recovered }
  );
}

// .build/bun-runtime-modernization/source/src/main/windows/windows-process-table-cim-scan.ts
var WINDOWS_CIM_QUERY_TIMEOUT_MS = 3e3;
var WINDOWS_CIM_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
var POWERSHELL_PROCESS_QUERY = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance -ClassName Win32_Process -Property CommandLine,Name,ParentProcessId,ProcessId | Select-Object CommandLine,Name,ParentProcessId,ProcessId | ConvertTo-Json -Compress";
function fieldAsString(value) {
  if (typeof value === "string") {
    return value;
  }
  return value === null || value === void 0 ? "" : String(value);
}
function fieldAsNumber(value) {
  if (typeof value === "number") {
    return value;
  }
  return typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
}
function parseWindowsCimProcessRows(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const row = item;
    const pid = fieldAsNumber(row.ProcessId);
    const ppid = fieldAsNumber(row.ParentProcessId);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) {
      return [];
    }
    const name = fieldAsString(row.Name);
    return [{ pid, ppid, name, command: fieldAsString(row.CommandLine) || name }];
  });
}
async function readWindowsProcessRowsWithCim() {
  const result = await runProcess({
    program: windowsPowerShellPath(),
    args: ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_PROCESS_QUERY],
    timeoutMs: WINDOWS_CIM_QUERY_TIMEOUT_MS,
    maxOutputBytes: WINDOWS_CIM_MAX_OUTPUT_BYTES
  });
  if (result.timedOut || result.code !== 0) {
    throw new Error(
      `windows process table CIM scan failed (code=${result.code} timedOut=${result.timedOut})`
    );
  }
  const rows = parseWindowsCimProcessRows(result.stdout);
  if (!rows || rows.length === 0) {
    throw new Error("windows process table CIM scan returned no rows");
  }
  return rows;
}

// .build/bun-runtime-modernization/source/src/main/windows/windows-process-table.ts
var requireFromMain2 = (0, import_node_module2.createRequire)(__filename);
var requireNative = requireFromMain2;
var PROCESS_DATA_FLAG = { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 };
var RELAY_ADDON_FILENAME = "./windows-process-tree.node";
var FLAGGED_ADDON_IMPORT = "ReadProcessMemory";
function stagedRelayAddonIsUnpatched() {
  const addonPath = requireNative.resolve?.(RELAY_ADDON_FILENAME);
  if (!addonPath) {
    return false;
  }
  try {
    return (0, import_node_fs4.readFileSync)(addonPath).includes(FLAGGED_ADDON_IMPORT);
  } catch {
    return false;
  }
}
var warnedAboutCimFallback = false;
var cachedModule;
var moduleLoader = loadWindowsProcessTree;
var cimScan = readWindowsProcessRowsWithCim;
function adaptAddon(addon) {
  return {
    ProcessDataFlag: PROCESS_DATA_FLAG,
    supportedProcessDataFlags: addon.supportedProcessDataFlags,
    getProcessCreationTime: addon.getProcessCreationTime,
    getAllProcesses: (callback, flags) => addon.getProcessList(callback, flags ?? 0)
  };
}
function loadWindowsProcessTree() {
  if (cachedModule !== void 0) {
    return cachedModule;
  }
  if (process.platform !== "win32") {
    cachedModule = null;
    return cachedModule;
  }
  try {
    cachedModule = requireNative("@vscode/windows-process-tree");
    return cachedModule;
  } catch {
  }
  try {
    const addon = requireNative(RELAY_ADDON_FILENAME);
    if (typeof addon?.getProcessList !== "function") {
      cachedModule = null;
      return cachedModule;
    }
    if (stagedRelayAddonIsUnpatched()) {
      console.warn(
        `[windows-process-table] the addon staged beside the relay bundle still imports ${FLAGGED_ADDON_IMPORT}, so it was built from unpatched source and reads every process address space. Refusing it and falling back to the CIM scan; redeploy the relay so the staged addon is rebuilt.`
      );
      cachedModule = null;
      return cachedModule;
    }
    cachedModule = adaptAddon(addon);
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}
var WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 3e3;
var unreturnedReads = /* @__PURE__ */ new Set();
var readSequence = 0;
var nativeReaderEpoch = 0;
var nativeReadGate = Promise.resolve();
function toIdentityRow(row) {
  return {
    pid: row.pid,
    ppid: row.ppid,
    name: row.name,
    ...typeof row.creationTimeMs === "number" ? { creationTimeMs: row.creationTimeMs } : {}
  };
}
var IDENTITY_PROJECTION = {
  flags: (native) => native.ProcessDataFlag.None | (native.ProcessDataFlag.CreationTime ?? 0),
  fromNative: toIdentityRow
};
var DETAILED_PROJECTION = {
  flags: (native) => IDENTITY_PROJECTION.flags(native) | native.ProcessDataFlag.CommandLine,
  fromNative: (row) => ({ ...toIdentityRow(row), command: row.commandLine ?? "" }),
  cimFallback: readCimRows
};
function ignoreSettlement() {
}
function readNativeRows(projection) {
  const attempt = nativeReadGate.then(() => readOneSnapshot(projection));
  nativeReadGate = attempt.then(ignoreSettlement, ignoreSettlement);
  return attempt;
}
function readOneSnapshot(projection) {
  const native = moduleLoader();
  if (!native) {
    if (process.platform === "win32" && projection.cimFallback) {
      if (!warnedAboutCimFallback) {
        warnedAboutCimFallback = true;
        console.warn(
          "[windows-process-table] no native binding; falling back to a powershell.exe CIM scan at each caller poll. See docs/reference/windows-process-enumeration.md."
        );
      }
      return projection.cimFallback();
    }
    return Promise.reject(new Error("windows process table unavailable"));
  }
  if (unreturnedReads.size > 0) {
    return Promise.reject(
      new Error("windows process table is wedged: an earlier read has not returned")
    );
  }
  const readId = ++readSequence;
  const readerEpoch = nativeReaderEpoch;
  const flags = projection.flags(native);
  return new Promise((resolve, reject) => {
    let deadline;
    try {
      deadline = setTimeout(() => {
        if (readerEpoch === nativeReaderEpoch) {
          unreturnedReads.add(readId);
        }
        reject(new Error("windows process table timed out"));
      }, WINDOWS_PROCESS_QUERY_TIMEOUT_MS);
      deadline.unref?.();
      native.getAllProcesses((processes) => {
        clearTimeout(deadline);
        unreturnedReads.delete(readId);
        if (!processes) {
          reject(new Error("windows process table returned no snapshot"));
          return;
        }
        if (!processes.some((row) => row.pid === process.pid)) {
          reject(new Error("windows process table is unreadable"));
          return;
        }
        if ((flags & native.ProcessDataFlag.CommandLine) !== 0) {
          reportWindowsCommandLineRecoveryHealth(processes);
        }
        resolve(processes.map(projection.fromNative));
      }, flags);
    } catch (error) {
      clearTimeout(deadline);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
async function readCimRows() {
  const rows = await cimScan();
  if (!rows.some((row) => row.pid === process.pid)) {
    throw new Error("windows process table is unreadable");
  }
  return rows;
}
var identityReader = createProcessTableSnapshotReader({
  runPs: () => readNativeRows(IDENTITY_PROJECTION),
  now: () => Date.now()
});
var detailedReader = createProcessTableSnapshotReader({
  runPs: () => readNativeRows(DETAILED_PROJECTION),
  now: () => Date.now()
});
function readWindowsProcessTableFresh() {
  return detailedReader.getFreshSnapshot();
}
function isWindowsProcessTableAvailable() {
  return moduleLoader() !== null;
}
function isWindowsProcessStartTimeAvailable() {
  const native = moduleLoader();
  return native !== null && ((native.supportedProcessDataFlags ?? 0) & PROCESS_DATA_FLAG.CreationTime) !== 0;
}
function readWindowsProcessCreationTime(pid) {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0 || pid > 4294967295) {
    return null;
  }
  try {
    const value = moduleLoader()?.getProcessCreationTime?.(pid);
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

// .build/bun-runtime-modernization/source/src/main/persistence/profile-state/profile-state-access-identity.ts
var bootIdentity;
var machineIdentity;
var ownProcessIdentity;
function profileStateAccessMachineIdentity() {
  if (machineIdentity !== void 0) {
    return machineIdentity;
  }
  machineIdentity = null;
  try {
    if (process.platform === "linux") {
      const value = (0, import_node_fs5.readFileSync)("/etc/machine-id", "utf8").trim();
      machineIdentity = /^[a-f0-9]{32}$/.test(value) && !/^0+$/.test(value) ? value : null;
    } else if (process.platform === "win32") {
      const registry = loadWindowsNativeRegistry();
      const values = registry.getRegistryKey(registry.HK.LM, "SOFTWARE\\Microsoft\\Cryptography");
      const entry = Object.entries(values ?? {}).find(
        ([name]) => name.toLowerCase() === "machineguid"
      )?.[1];
      const value = entry?.type === WINDOWS_REG_SZ && typeof entry.value === "string" ? entry.value.trim().toLowerCase() : "";
      machineIdentity = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && value !== "00000000-0000-0000-0000-000000000000" ? `win32-machine-guid:${value}` : null;
    } else if (process.platform === "darwin") {
      const result = runProcessSync({
        program: "/usr/sbin/sysctl",
        args: ["-n", "kern.hostuuid"],
        timeoutMs: 1e3,
        maxOutputBytes: 1024
      });
      machineIdentity = result.code === 0 ? result.stdout.trim() || null : null;
    }
  } catch {
  }
  return machineIdentity;
}
function profileStateAccessBootIdentity() {
  if (bootIdentity !== void 0) {
    return bootIdentity;
  }
  bootIdentity = null;
  try {
    if (process.platform === "linux") {
      bootIdentity = (0, import_node_fs5.readFileSync)("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    } else if (process.platform === "darwin") {
      const result = runProcessSync({
        program: "/usr/sbin/sysctl",
        args: ["-n", "kern.bootsessionuuid"],
        timeoutMs: 1e3,
        maxOutputBytes: 1024
      });
      bootIdentity = result.code === 0 ? result.stdout.trim() || null : null;
    }
  } catch {
  }
  return bootIdentity;
}
function profileStateAccessProcessIdentity(pid) {
  if (pid !== process.pid) {
    return readProcessIdentity(pid);
  }
  if (ownProcessIdentity === void 0) {
    ownProcessIdentity = readProcessIdentity(pid);
  }
  return ownProcessIdentity;
}
function readProcessIdentity(pid) {
  if (process.platform === "win32") {
    const startedAtMs2 = readWindowsProcessCreationTime(pid);
    return startedAtMs2 === null ? null : `win32-creation-ms:${startedAtMs2}`;
  }
  if (process.platform === "linux") {
    try {
      const ticks = parseLinuxProcStartTicks((0, import_node_fs5.readFileSync)(`/proc/${pid}/stat`, "utf8"));
      return Number.isSafeInteger(ticks) && ticks >= 0 ? `linux-start-ticks:${ticks}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform !== "darwin") {
    return null;
  }
  const startedAtMs = getPsProcessIdentity(pid, { utc: true })?.startedAtMs;
  return startedAtMs == null ? null : `darwin-utc-start-ms:${startedAtMs}`;
}

// .build/bun-runtime-modernization/source/src/main/persistence/profile-state/profile-state-access-owner.ts
var ProfileStateAccessError = class extends Error {
  code = "profile-state-access-refused";
  constructor(message) {
    super(message);
    this.name = "ProfileStateAccessError";
  }
};
function profileStateAccessPaths(userDataPath) {
  (0, import_node_fs6.mkdirSync)(userDataPath, { recursive: true, mode: 448 });
  const root = (0, import_node_path3.join)((0, import_node_fs6.realpathSync)(userDataPath), ".profile-state-access");
  const paths = {
    root,
    participants: (0, import_node_path3.join)(root, "participants"),
    candidates: (0, import_node_path3.join)(root, "candidates"),
    maintenance: (0, import_node_path3.join)(root, "maintenance")
  };
  for (const path of [root, paths.participants, paths.candidates]) {
    (0, import_node_fs6.mkdirSync)(path, { recursive: true, mode: 448 });
  }
  return paths;
}
var PROFILE_STATE_ACCESS_TOKEN = /^[a-f0-9-]{36}$/;
function profileStateAccessPidNamespace() {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    return (0, import_node_fs6.readlinkSync)("/proc/self/ns/pid");
  } catch {
    return null;
  }
}
function readOwner(path) {
  try {
    if (!(0, import_node_fs6.lstatSync)(path).isFile()) {
      throw new ProfileStateAccessError(`Profile state owner is not a regular file: ${path}`);
    }
    const owner = JSON.parse((0, import_node_fs6.readFileSync)(path, "utf8"));
    if (typeof owner === "object" && owner !== null && "token" in owner && typeof owner.token === "string" && PROFILE_STATE_ACCESS_TOKEN.test(owner.token) && "pid" in owner && typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0 && "host" in owner && typeof owner.host === "string" && owner.host.length > 0 && "platform" in owner && typeof owner.platform === "string" && "pidNamespace" in owner && (owner.pidNamespace === null || typeof owner.pidNamespace === "string")) {
      return {
        token: owner.token,
        pid: owner.pid,
        host: owner.host,
        platform: owner.platform,
        pidNamespace: owner.pidNamespace,
        bootIdentity: "bootIdentity" in owner && typeof owner.bootIdentity === "string" ? owner.bootIdentity : null,
        machineIdentity: "machineIdentity" in owner && typeof owner.machineIdentity === "string" ? owner.machineIdentity : null,
        processStartIdentity: "processStartIdentity" in owner && typeof owner.processStartIdentity === "string" && /^(?:(?:linux-start-ticks|darwin-utc-start-ms|wall-time-ms):\d+|win32-creation-ms:[1-9]\d*)$/.test(
          owner.processStartIdentity
        ) && Number.isSafeInteger(Number(owner.processStartIdentity.split(":")[1])) ? owner.processStartIdentity : null
      };
    }
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return void 0;
    }
    throw new ProfileStateAccessError(`Profile state ownership is unverifiable: ${path}`);
  }
  throw new ProfileStateAccessError(`Profile state ownership is malformed: ${path}`);
}
function ownerExited(owner) {
  const currentBoot = profileStateAccessBootIdentity();
  const currentMachine = profileStateAccessMachineIdentity();
  const sameBoot = Boolean(owner.bootIdentity && owner.bootIdentity === currentBoot);
  const sameMachine = Boolean(owner.machineIdentity && owner.machineIdentity === currentMachine);
  const sameHost = owner.host === (0, import_node_os.hostname)();
  if (process.platform === "win32" && !sameHost || !sameBoot && !sameHost || owner.platform !== process.platform || !sameBoot && owner.machineIdentity && currentMachine && !sameMachine) {
    return false;
  }
  if (sameHost && sameMachine && owner.bootIdentity && currentBoot && owner.bootIdentity !== currentBoot) {
    return true;
  }
  if (process.platform === "linux" && (owner.pidNamespace === null || owner.pidNamespace !== profileStateAccessPidNamespace())) {
    return false;
  }
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return hasCode(error, "ESRCH");
  }
  const recordedStart = owner.processStartIdentity;
  const canCompareStart = sameBoot || process.platform === "win32" && sameMachine && sameHost;
  const actualStart = !canCompareStart || recordedStart == null ? null : profileStateAccessProcessIdentity(owner.pid);
  return actualStart !== null && recordedStart != null && actualStart.split(":")[0] === recordedStart.split(":")[0] && (actualStart.startsWith("darwin-utc-start-ms:") ? !startTimesWithinTolerance(
    Number(actualStart.split(":")[1]),
    Number(recordedStart.split(":")[1]),
    START_TIME_TOLERANCE_MS
  ) : actualStart !== recordedStart);
}
function hasCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function removeOwnerEntry(path) {
  try {
    (0, import_node_fs6.unlinkSync)(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
}
function removeEmptyOwnerDirectory(path) {
  try {
    (0, import_node_fs6.rmdirSync)(path);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST", "EBUSY"].some((code) => hasCode(error, code))) {
      throw error;
    }
  }
}
function reclaimExitedOwner(path) {
  let entries;
  try {
    if (!(0, import_node_fs6.lstatSync)(path).isDirectory()) {
      throw new ProfileStateAccessError(`Profile state owner is not a directory: ${path}`);
    }
    entries = (0, import_node_fs6.readdirSync)(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const token = entry.endsWith(".owner") ? entry.slice(0, -6) : "";
    if (!PROFILE_STATE_ACCESS_TOKEN.test(token)) {
      throw new ProfileStateAccessError(`Profile state ownership is unverifiable: ${path}`);
    }
    const owner = readOwner((0, import_node_path3.join)(path, entry));
    if (owner === void 0) {
      continue;
    }
    if (owner.token !== token || !ownerExited(owner)) {
      throw new ProfileStateAccessError(
        `Profile state is in use or its owner is unverifiable: ${path}. Stop Orca and orcad on every host using this profile, then retry. If this remains, verify PID ${owner.pid} on ${owner.host} has exited before removing its owner entry ${(0, import_node_path3.join)(path, entry)}.`
      );
    }
    removeOwnerEntry((0, import_node_path3.join)(path, entry));
  }
  removeEmptyOwnerDirectory(path);
}
function publishAccessOwner(paths, exclusive) {
  const token = (0, import_node_crypto.randomUUID)();
  const candidate = (0, import_node_path3.join)(paths.candidates, token);
  const target = exclusive ? paths.maintenance : (0, import_node_path3.join)(paths.participants, token);
  const entry = `${token}.owner`;
  (0, import_node_fs6.mkdirSync)(candidate, { mode: 448 });
  let published = false;
  try {
    (0, import_node_fs6.writeFileSync)(
      (0, import_node_path3.join)(candidate, entry),
      JSON.stringify({
        token,
        pid: process.pid,
        host: (0, import_node_os.hostname)(),
        platform: process.platform,
        pidNamespace: profileStateAccessPidNamespace(),
        bootIdentity: profileStateAccessBootIdentity(),
        machineIdentity: profileStateAccessMachineIdentity(),
        processStartIdentity: profileStateAccessProcessIdentity(process.pid)
      }),
      {
        flag: "wx",
        mode: 384
      }
    );
    fsyncFileSync((0, import_node_path3.join)(candidate, entry));
    bestEffortFsyncDirectorySync(candidate);
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameFileWithWindowsRetry(candidate, target);
        published = true;
        break;
      } catch (error) {
        if (!exclusive || attempt >= 2) {
          throw error;
        }
        reclaimExitedOwner(target);
      }
    }
    bestEffortFsyncDirectorySync((0, import_node_path3.dirname)(target));
    bestEffortFsyncDirectorySync(paths.candidates);
  } catch (error) {
    if (published) {
      removeOwnerEntry((0, import_node_path3.join)(target, entry));
      removeEmptyOwnerDirectory(target);
    }
    throw error;
  } finally {
    if (!published) {
      removeOwnerEntry((0, import_node_path3.join)(candidate, entry));
      removeEmptyOwnerDirectory(candidate);
    }
  }
  let released = false;
  return {
    token,
    assertActive() {
      if (released || readOwner((0, import_node_path3.join)(target, entry))?.token !== token) {
        throw new ProfileStateAccessError("Profile state access has already been released");
      }
    },
    release() {
      if (released) {
        return;
      }
      removeOwnerEntry((0, import_node_path3.join)(target, entry));
      removeEmptyOwnerDirectory(target);
      released = true;
    }
  };
}

// .build/bun-runtime-modernization/source/src/main/persistence/profile-state/profile-state-access.ts
var maintenanceRoots = /* @__PURE__ */ new WeakMap();
function assertProfileStateMaintenance(maintenance, profile) {
  const root = maintenanceRoots.get(maintenance);
  if (root === void 0 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(profile.profileId)) {
    throw new ProfileStateAccessError(
      "Profile state recovery requires an acquired maintenance owner"
    );
  }
  maintenance.assertActive();
  const expectedDirectory = (0, import_node_path4.join)(root, "profiles", profile.profileId);
  for (const [path, expectedName] of [
    [profile.dataFile, "orca-data.json"],
    [profile.databasePath, "profile-state.db"]
  ]) {
    if (!samePath((0, import_node_fs7.realpathSync)((0, import_node_path4.dirname)(path)), expectedDirectory) || !samePath((0, import_node_path4.basename)(path), expectedName)) {
      throw new ProfileStateAccessError(
        "Profile state recovery paths do not belong to the maintenance root"
      );
    }
    try {
      if ((0, import_node_fs7.lstatSync)(path).isSymbolicLink()) {
        throw new ProfileStateAccessError("Profile state recovery cannot replace a symbolic link");
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
}
function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function acquireProfileStateRuntimeAdmission(userDataPath) {
  const paths = profileStateAccessPaths(userDataPath);
  const owner = publishAccessOwner(paths, false);
  try {
    reclaimExitedOwner(paths.maintenance);
    return owner;
  } catch (error) {
    owner.release();
    throw error;
  }
}
function acquireProfileStateMaintenance(userDataPath) {
  const paths = profileStateAccessPaths(userDataPath);
  const owner = publishAccessOwner(paths, true);
  try {
    for (const entry of (0, import_node_fs7.readdirSync)(paths.participants)) {
      reclaimExitedOwner((0, import_node_path4.join)(paths.participants, entry));
    }
    const maintenance = {
      ...owner,
      assertProfile(profileId, dataFile, databasePath) {
        assertProfileStateMaintenance(maintenance, { profileId, dataFile, databasePath });
      }
    };
    maintenanceRoots.set(maintenance, (0, import_node_path4.dirname)(paths.root));
    return maintenance;
  } catch (error) {
    owner.release();
    throw error;
  }
}

// .build/bun-runtime-modernization/source/src/main/daemon/daemon-bun-runtime-retention.ts
var MANAGED_DAEMON_RUNTIME_DIRECTORY = "managed-v1";
var GENERATION = /^bun-[a-f0-9]{64}(?:\.repair-[1-9][0-9]*)?$/u;
var STAGING = /^\.bun-staging-[a-f0-9-]{36}$/u;
var RETAIN_UNUSED = 2;
var DELETE_LIMIT = 4;
async function acquireDaemonRuntimeLaunchPin(root) {
  for (let attempt = 0; ; attempt++) {
    try {
      return acquireProfileStateRuntimeAdmission(root);
    } catch (error) {
      if (!(error instanceof ProfileStateAccessError) || attempt >= 30) {
        throw error;
      }
      await (0, import_promises3.setTimeout)(100);
    }
  }
}
function normalized(path) {
  return path.replaceAll("/", "\\").toLowerCase();
}
async function collectPinnedDaemonRuntimeDirectories(rows, directories, resolveExecutablePath = import_promises2.realpath) {
  const pinned = /* @__PURE__ */ new Set();
  const canonicalImages = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (!/^(?:bun(?:-runtime)?|openconsole)\.exe$/iu.test(row.name)) {
      continue;
    }
    if (!row.creationTimeMs || !Number.isSafeInteger(row.creationTimeMs) || !row.command) {
      return null;
    }
    const executable = row.command.startsWith('"') ? /^"([^"\r\n]+)"/u.exec(row.command)?.[1] : /^([^\s"]+)/u.exec(row.command)?.[1];
    if (!executable || !import_node_path5.win32.isAbsolute(executable) || !/^(?:[a-z]:\\|\\\\)/iu.test(normalized(executable))) {
      return null;
    }
    let canonicalExecutable;
    try {
      canonicalExecutable = normalized(await resolveExecutablePath(executable));
    } catch {
      return null;
    }
    const command = normalized(row.command);
    for (const directory of directories) {
      const prefix = `${normalized(directory)}\\`;
      if (canonicalExecutable.startsWith(prefix) || command.includes(prefix)) {
        pinned.add(directory);
        continue;
      }
      const image = row.name.toLowerCase() === "openconsole.exe" ? (0, import_node_path5.join)(directory, "conpty", "OpenConsole.exe") : (0, import_node_path5.join)(directory, "bun-runtime.exe");
      let canonicalImage = canonicalImages.get(image);
      if (canonicalImage === void 0) {
        try {
          canonicalImage = normalized(await resolveExecutablePath(image));
          canonicalImages.set(image, canonicalImage);
        } catch (error) {
          if (!STAGING.test(import_node_path5.win32.basename(directory)) || !(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
            return null;
          }
          canonicalImage = null;
          canonicalImages.set(image, null);
        }
      }
      if (canonicalImage === canonicalExecutable) {
        pinned.add(directory);
      }
    }
  }
  return pinned;
}
async function pruneDaemonBunRuntimes(hostRoot) {
  if (!isWindowsProcessTableAvailable() || !isWindowsProcessStartTimeAvailable()) {
    return;
  }
  const requestedRoot = (0, import_node_path5.join)(hostRoot, MANAGED_DAEMON_RUNTIME_DIRECTORY);
  let admission;
  try {
    if ((await (0, import_promises2.lstat)(requestedRoot)).isSymbolicLink()) {
      return;
    }
    const root = await (0, import_promises2.realpath)(requestedRoot);
    admission = acquireProfileStateMaintenance(root);
    const candidates = [];
    for (const entry of await (0, import_promises2.readdir)(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !GENERATION.test(entry.name) && !STAGING.test(entry.name)) {
        continue;
      }
      const path = (0, import_node_path5.join)(root, entry.name);
      const stat = await (0, import_promises2.lstat)(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await (0, import_promises2.realpath)(path) !== path) {
        continue;
      }
      candidates.push({ path, modified: stat.mtimeMs, staging: STAGING.test(entry.name) });
    }
    const pinned = await collectPinnedDaemonRuntimeDirectories(
      await readWindowsProcessTableFresh(),
      candidates.map(({ path }) => path)
    );
    if (!pinned) {
      return;
    }
    const unused = candidates.filter(({ path, staging }) => !staging && !pinned.has(path)).sort((a, b) => b.modified - a.modified).slice(RETAIN_UNUSED);
    const abandonedStaging = candidates.filter(({ path, staging }) => staging && !pinned.has(path));
    for (const candidate of [...abandonedStaging, ...unused].slice(0, DELETE_LIMIT)) {
      admission.assertActive();
      if ((await (0, import_promises2.lstat)(candidate.path)).isSymbolicLink()) {
        continue;
      }
      await (0, import_promises2.rm)(candidate.path, { recursive: true, force: true });
    }
  } catch {
  } finally {
    try {
      admission?.release();
    } catch (error) {
      console.warn("[daemon] Could not release runtime retention ownership", error);
    }
  }
}

// .build/bun-runtime-modernization/terminal-consolidation/windows-wide-qualification/bun-patch/runtime-retention-probe/retention-native.ts
async function waitFor(test, label) {
  const deadline = Date.now() + 1e4;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("Timed out: " + label);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function qualifyRetention() {
  import_strict.default.equal(process.platform, "win32");
  (0, import_strict.default)(isWindowsProcessTableAvailable(), "native process table must load");
  (0, import_strict.default)(isWindowsProcessStartTimeAvailable(), "native creation-time support must load");
  const host = (0, import_node_fs8.realpathSync)((0, import_node_fs8.mkdtempSync)((0, import_node_path6.join)((0, import_node_os2.tmpdir)(), "orca-retention-native-")));
  const root = (0, import_node_path6.join)(host, "managed-v1");
  (0, import_node_fs8.mkdirSync)(root);
  const payload = (0, import_node_path6.join)(host, "payload");
  (0, import_node_fs8.mkdirSync)(payload);
  (0, import_node_fs8.copyFileSync)(process.execPath, (0, import_node_path6.join)(payload, "bun-runtime.exe"));
  (0, import_node_fs8.copyFileSync)((0, import_node_path6.join)((0, import_node_path6.dirname)(process.env.BUN_CONPTY_LIBRARY), "OpenConsole.exe"), (0, import_node_path6.join)(payload, "OpenConsole.exe"));
  const generations = Array.from({ length: 7 }, (_, i) => (0, import_node_path6.join)(root, `bun-${i.toString(16).padStart(64, "0")}`));
  for (const generation of generations) {
    (0, import_node_fs8.mkdirSync)(generation);
    (0, import_node_fs8.mkdirSync)((0, import_node_path6.join)(generation, "conpty"));
    (0, import_node_fs8.linkSync)((0, import_node_path6.join)(payload, "bun-runtime.exe"), (0, import_node_path6.join)(generation, "bun-runtime.exe"));
    (0, import_node_fs8.linkSync)((0, import_node_path6.join)(payload, "OpenConsole.exe"), (0, import_node_path6.join)(generation, "conpty", "OpenConsole.exe"));
    (0, import_node_fs8.writeFileSync)((0, import_node_path6.join)(generation, "daemon-entry.js"), "fixture-only");
  }
  const legacy = (0, import_node_path6.join)(host, "legacy-version");
  (0, import_node_fs8.mkdirSync)(legacy);
  const stage = (0, import_node_path6.join)(root, ".bun-staging-12345678-1234-1234-1234-123456789abc");
  (0, import_node_fs8.mkdirSync)(stage);
  (0, import_node_fs8.writeFileSync)((0, import_node_path6.join)(stage, "partial.js"), "incomplete copy");
  const remaining = () => (0, import_node_fs8.readdirSync)(root).filter((name) => name.startsWith("bun-"));
  let child;
  let pin;
  try {
    pin = await acquireDaemonRuntimeLaunchPin(root);
    const ready = (0, import_node_path6.join)(host, "ready");
    child = Bun.spawn([(0, import_node_path6.join)(generations[0], "bun-runtime.exe"), "--no-env-file", "-e", `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`], { env: { ...process.env, ORCA_BACKGROUND_LAUNCH: "1" }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    await waitFor(() => (0, import_node_fs8.existsSync)(ready), "live child ready");
    const rows = await readWindowsProcessTableFresh();
    const ownChild = rows.find((row) => row.pid === child?.pid);
    (0, import_strict.default)(ownChild?.creationTimeMs && ownChild.command, "native child row must include command and creation time");
    await pruneDaemonBunRuntimes(host);
    import_strict.default.equal(remaining().length, 7, "active launch pin must exclude pruning");
    (0, import_strict.default)((0, import_node_fs8.existsSync)(stage), "active launch pin must preserve incomplete staging");
    const participantRoot = (0, import_node_path6.join)(root, ".profile-state-access", "participants");
    const [token] = (0, import_node_fs8.readdirSync)(participantRoot);
    const owner = (0, import_node_path6.join)(participantRoot, token, `${token}.owner`);
    const original = (0, import_node_fs8.readFileSync)(owner, "utf8");
    (0, import_node_fs8.writeFileSync)(owner, "{}");
    await pruneDaemonBunRuntimes(host);
    import_strict.default.equal(remaining().length, 7, "unknown admission owner must exclude pruning");
    (0, import_strict.default)((0, import_node_fs8.existsSync)(stage));
    (0, import_node_fs8.writeFileSync)(owner, original);
    const unknownRow = { ...ownChild, creationTimeMs: void 0 };
    import_strict.default.equal(await collectPinnedDaemonRuntimeDirectories([unknownRow], generations), null, "unknown process identity must veto pruning");
    pin.release();
    pin = void 0;
    await pruneDaemonBunRuntimes(host);
    (0, import_strict.default)((0, import_node_fs8.existsSync)(generations[0]), "live native child runtime must survive pruning");
    import_strict.default.equal(remaining().length, 4, "first pass removes one incomplete staging plus three unused generations");
    (0, import_strict.default)(!(0, import_node_fs8.existsSync)(stage), "exclusive pruning reclaims incomplete abandoned staging");
    await pruneDaemonBunRuntimes(host);
    import_strict.default.equal(remaining().length, 3, "live runtime plus two unused generations retained");
    (0, import_strict.default)((0, import_node_fs8.existsSync)(generations[0]));
    (0, import_strict.default)((0, import_node_fs8.existsSync)(legacy), "legacy namespace must remain untouched");
    child.kill();
    await child.exited;
    child = void 0;
    await pruneDaemonBunRuntimes(host);
    import_strict.default.equal(remaining().length, 2, "after confirmed child exit only two unused generations remain");
    return { passed: true, arch: process.arch, runtime: process.versions, liveChild: ownChild, stages: ["launch-pin-preserved", "unknown-admission-preserved", "unknown-native-identity-veto", "live-owner-preserved", "incomplete-staging-reclaimed", "bounded-prune", "legacy-preserved", "exited-owner-pruned"] };
  } finally {
    pin?.release();
    child?.kill();
    if (child) await child.exited;
    (0, import_node_fs8.rmSync)(host, { recursive: true, force: true });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  qualifyRetention
});
