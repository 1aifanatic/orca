import { parseAgentHookEndpointFile } from '../../shared/agent-hook-endpoint-file'
import {
  OPENCODE_STARTUP_PROMPT_SHA256_ENV,
  OPENCODE_STARTUP_PROMPT_NONCE_ENV,
  OPENCODE_STARTUP_PROMPT_ENDPOINT_ENV,
  OPENCODE_STARTUP_PROMPT_CLAIM_PATH,
  OPENCODE_STARTUP_PROMPT_BODY_ENV
} from '../../shared/opencode-startup-prompt'

export function getOpenCodeStartupPromptSource(): string {
  return String.raw`
const parseEndpoint = ${parseAgentHookEndpointFile.toString()};
async function claimStartupPrompt(nonce, digest, endpoint) {
  const { readFile, stat } = await import("node:fs/promises");
  if ((await stat(endpoint)).size > 4096) return false;
  const coords = parseEndpoint(await readFile(endpoint, "utf8"));
  const port = Number(coords.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const response = await fetch("http://127.0.0.1:" + port + "${OPENCODE_STARTUP_PROMPT_CLAIM_PATH}", {
    method: "POST", headers: { "content-type": "application/json", "x-orca-agent-hook-token": coords.token },
    body: JSON.stringify({ nonce, digest }), signal: AbortSignal.timeout(1000)
  });
  if (!response.ok) return false;
  const result = await response.json();
  return result.allowed === true ? true : result.pending === true ? "pending" : false;
}
async function submitStartupPrompt(ctx) {
  const noop = async () => {};
  const digest = process.env.${OPENCODE_STARTUP_PROMPT_SHA256_ENV};
  const nonce = process.env.${OPENCODE_STARTUP_PROMPT_NONCE_ENV};
  const endpoint = process.env.${OPENCODE_STARTUP_PROMPT_ENDPOINT_ENV};
  const prompt = process.env.${OPENCODE_STARTUP_PROMPT_BODY_ENV};
  if (ctx?.app?.version !== "2.0.16" || !/^[a-f0-9]{64}$/.test(digest || "") || !nonce || !endpoint || !prompt) return noop;
  const input = ctx.renderer?.keyInput;
  if (typeof ctx.storage?.memory !== "function" || typeof input?.on !== "function" ||
      typeof input?.off !== "function" || typeof ctx.keymap?.dispatch !== "function" ||
      typeof ctx.ui?.router?.current !== "function" ||
      typeof ctx.data?.location?.agent?.list !== "function" ||
      typeof ctx.data?.location?.model?.list !== "function") return noop;
  const [memory, setMemory] = ctx.storage.memory("startup-prompt", {
    initial: { settled: false, expiresAt: Date.now() + 20000 }
  });
  if (memory.settled) return noop;
  let timer, editor, seen = false, disposed = false, createHash, claimed = false, claiming = false, populated = false;
  const isComposer = (candidate) => candidate?.traits?.owner === "opencode" &&
    candidate.traits.role === "prompt" && !candidate.traits.status &&
    candidate.traits.capture?.length === 1 && candidate.traits.capture[0] === "tab";
  const matches = (candidate) => typeof candidate?.plainText === "string" &&
    createHash("sha256").update(candidate.plainText).digest("hex") === digest;
  const cleanup = () => {
    clearInterval(timer);
    input.off("keypress", cancel);
    input.off("paste", cancel);
    editor?.off("line-info-change", changed);
  };
  const settle = () => {
    setMemory((draft) => { draft.settled = true; });
    cleanup();
  };
  const cancel = () => settle();
  // OpenCode clears the editor before awaiting session creation; never retry a restored failure.
  const changed = () => { if (seen && editor.plainText !== (populated ? prompt : "")) settle(); };
  input.on("keypress", cancel);
  input.on("paste", cancel);
  const dispose = async () => { disposed = true; settle(); };
  try {
    ({ createHash } = await import("node:crypto"));
    if (createHash("sha256").update(prompt).digest("hex") !== digest) { await dispose(); return noop; }
    if (memory.settled) return dispose;
    timer = setInterval(async () => {
      if (disposed || memory.settled) return;
      try {
        if (Date.now() >= memory.expiresAt || ctx.ui.router.current()?.type !== "home") return settle();
        const current = ctx.renderer.currentFocusedEditor;
        if (!isComposer(current)) { if (seen) settle(); return; }
        if (editor !== current) {
          if (seen) return settle();
          editor?.off("line-info-change", changed);
          editor = current;
          editor?.on("line-info-change", changed);
        }
        if (typeof editor?.plainText !== "string" || typeof editor?.insertText !== "function") return;
        if (editor.plainText !== (populated ? prompt : "")) return settle();
        seen = true;
        const agents = ctx.data.location.agent.list(ctx.location);
        const models = ctx.data.location.model.list(ctx.location);
        if (!editor.focused || !agents?.length || !models?.length) return;
        if (claiming) return;
        if (!claimed) {
          claiming = true;
          const allowed = await claimStartupPrompt(nonce, digest, endpoint);
          claiming = false;
          if (allowed === "pending") return;
          if (!allowed) return settle();
          claimed = true;
        }
        if (disposed || memory.settled || Date.now() >= memory.expiresAt ||
            ctx.ui.router.current()?.type !== "home" || ctx.renderer.currentFocusedEditor !== editor ||
            !editor.focused || !isComposer(editor) || editor.plainText !== (populated ? prompt : "")) return settle();
        if (!populated) {
          populated = true;
          editor.insertText(prompt);
          if (memory.settled || !matches(editor)) return settle();
        }
        ctx.keymap.dispatch("prompt.submit");
      } catch { settle(); }
    }, 100);
    timer.unref?.();
    return dispose;
  } catch {
    settle();
    return noop;
  }
}
export default { id: "orca-opencode-startup-prompt", setup: submitStartupPrompt };
`.trimStart()
}
