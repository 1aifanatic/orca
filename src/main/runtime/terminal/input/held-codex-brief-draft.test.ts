import { afterEach, expect, it } from 'vitest'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import { projectTerminalVisibleLines } from '../../../daemon/emulation/terminal-screen-projection'
import { buildDispatchPreamble } from '../../orchestration/workers/launch/worker-dispatch-preamble'
import { isHeldAgentPromptDraft } from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import { readTerminalComposerTypedText } from '../../../../shared/terminal/input/terminal-composer-draft'

// The spec behind the stuck Windows Codex 0.172.0 screen in #51750; its head was scrolled off.
const SPEC = `# Codex 中文多行说明书派发复现

## 背景说明
此前在 Windows 上通过 \`--spec-file\` 派发较长的中文多行说明书时，出现了以下现象：
1. 粘贴的文本停留在 Codex TUI 的输入栏中未能成功提交；
2. 状态查询显示 \`stage=input_accepted\`，但实际上 \`activity=idle\` 且 \`session_not_reported\`；
3. 后续补发消息会被防打断机制拦截并提示输入栏有未发送文本。

## 具体测试要求（请严格遵守以下说明）
为了在不消耗过多额度、也不产生任何副作用的前提下完成验证，请按以下步骤执行：
- 第一步：确认你已完整收到本说明书，读取当前工作区根目录下的 \`README.md\` 文件；
- 第二步：不要修改仓库中的任何现有文件，也不要执行任何网络请求或危险命令；
- 第三步：只需在工作区根目录新建一个极简的测试回执文件 \`repro_ack.txt\`，写入一行内容：\`OK: Chinese multiline spec received and processed.\`；
- 第四步：完成上述操作后，直接汇报任务完成并结束本轮工作。

## 附加说明与边界条件
- 本文件刻意保持在 1,200 字符以上的长度，并混合使用全角标点（如：“”、（）、「」、——、……）、Markdown 代码块格式标记（例如 \`orca orchestration worker-show\` 与 \`--spec-file\`）以及多段换行结构；
- 模拟真实业务场景中“研究分析 / 文档审校 / 演示文稿检查”类长中文指令的特征，例如：
  - 核查第 1 页至第 8 页的版面结构、字体层级、图例说明与数据口径一致性；
  - 检查核心论点与引用来源之间是否存在逻辑跳跃、数字单位混用或年份错位；
  - 针对发现的问题逐条列出修改优先级（高 / 中 / 低），并给出可直接落地的改写建议；
  - 输出结构化验收清单，标明每一项的通过状态（PASS / NEEDS_FIXES）以及对应的文件定位。
- 再次提醒：以上四条仅作为模拟长中文文本体积与结构的占位示例，**不需要**真正去执行任何演示文稿检查，只需按上方“具体测试要求”创建 \`repro_ack.txt\` 即可。

## 验收标准
1. 如果你能够立即开始执行并创建 \`repro_ack.txt\`，说明本次派发成功提交；
2. 如果你没有收到回车提交指令而停留在输入框等待状态，我们将抓取最后 20 行终端画面（已确认不含任何隐私数据）提供给 Orca 维护者用于修复匹配逻辑。
`

// The composer rows as Codex painted them: its own wraps (one between `执行：` and `- 第一步` was
// lost on the way in), blank lines, and no footer below.
const COMPOSER_ROWS = [
  '1. 粘贴的文本停留在 Codex TUI 的输入栏中未能成功提交；',
  '2. 状态查询显示 `stage=input_accepted`，但实际上 `activity=idle` 且 `session_not_reported`；',
  '3. 后续补发消息会被防打断机制拦截并提示输入栏有未发送文本。',
  '',
  '## 具体测试要求（请严格遵守以下说明）',
  '为了在不消耗过多额度、也不产生任何副作用的前提下完成验证，请按以下步骤执行：- 第一步：确认你已',
  '完整收到本说明书，读取当前工作区根目录下的 `README.md` 文件；',
  '- 第二步：不要修改仓库中的任何现有文件，也不要执行任何网络请求或危险命令；',
  '- 第三步：只需在工作区根目录新建一个极简的测试回执文件 `repro_ack.txt`，写入一行内容：`OK:',
  'Chinese multiline spec received and processed.`；',
  '- 第四步：完成上述操作后，直接汇报任务完成并结束本轮工作。',
  '',
  '## 附加说明与边界条件',
  '- 本文件刻意保持在 1,200 字符以上的长度，并混合使用全角标点（如：“”、（）、「」、——、……）、',
  'Markdown 代码块格式标记（例如 `orca orchestration worker-show` 与 `--spec-file`）以及多段换行',
  '结构；',
  '- 模拟真实业务场景中“研究分析 / 文档审校 / 演示文稿检查”类长中文指令的特征，例如：',
  '  - 核查第 1 页至第 8 页的版面结构、字体层级、图例说明与数据口径一致性；',
  '  - 检查核心论点与引用来源之间是否存在逻辑跳跃、数字单位混用或年份错位；',
  '  - 针对发现的问题逐条列出修改优先级（高 / 中 / 低），并给出可直接落地的改写建议；',
  '  - 输出结构化验收清单，标明每一项的通过状态（PASS / NEEDS_FIXES）以及对应的文件定位。',
  '- 再次提醒：以上四条仅作为模拟长中文文本体积与结构的占位示例，**不需要**真正去执行任何演示文稿',
  '检查，只需按上方“具体测试要求”创建 `repro_ack.txt` 即可。',
  '',
  '## 验收标准',
  '1. 如果你能够立即开始执行并创建 `repro_ack.txt`，说明本次派发成功提交；',
  '2. 如果你没有收到回车提交指令而停留在输入框等待状态，我们将抓取最后 20 行终端画面（已确认不含',
  '任何隐私数据）提供给 Orca 维护者用于修复匹配逻辑。'
]
const HEADER_ROWS = 3
const SCROLL_INDICATOR_COLUMN = 97

const BRIEF = buildDispatchPreamble({
  taskId: 'task_a5183404aebd',
  dispatchId: 'ctx_2856e3ca4fc5',
  taskSpec: SPEC,
  coordinatorHandle: 'term_efcd796e-a434-4138-a69d-b4c63abf195c',
  workerHandle: 'term_21d1f680-cb4b-49d2-bb9a-15fd24d2a468',
  runsOnNativeWindows: true,
  canDispatchSubWorkers: true
})

let emulator: HeadlessEmulator | null = null
afterEach(() => {
  emulator?.dispose()
  emulator = null
})

// Codex's scroll offset picks the top row; row 5 fills the textarea, so `↑` touches its last glyph.
async function paintScrolledComposer(
  firstRow: number,
  scrollIndicator: 'dim' | 'typed' | 'none'
): Promise<HeadlessEmulator> {
  const shown = COMPOSER_ROWS.slice(firstRow)
  emulator = new HeadlessEmulator({ cols: 100, rows: HEADER_ROWS + shown.length + 1 })
  const arrow = { dim: '\x1b[2m↑\x1b[22m', typed: '↑', none: '' }[scrollIndicator]
  const rows = shown.map((text, index) => {
    const row = HEADER_ROWS + 1 + index
    return index === 0
      ? `\x1b[${row};1H\x1b[1m›\x1b[22m ${text}\x1b[${row};${SCROLL_INDICATOR_COLUMN}H${arrow}`
      : `\x1b[${row};3H${text}`
  })
  await emulator.write(
    `\x1b[2J\x1b[1;3H>_ OpenAI Codex (v0.172.0)\x1b[2;6H~\\orca\\workspaces\\orca-codex-repro\\codex-zh-repro-1${rows.join('')}`
  )
  return emulator
}

it.each([0, 5])(
  'reads a Codex brief scrolled past its footer from row %i as the held brief (#51750)',
  async (firstRow) => {
    const terminal = await paintScrolledComposer(firstRow, 'dim')
    const screen = projectTerminalVisibleLines(terminal)

    expect(screen.lines).toEqual([
      '  >_ OpenAI Codex (v0.172.0)',
      '     ~\\orca\\workspaces\\orca-codex-repro\\codex-zh-repro-1',
      '›'
    ])
    expect(screen.draft?.startsWith(COMPOSER_ROWS[firstRow])).toBe(true)
    expect(isHeldAgentPromptDraft(screen.draft, BRIEF, 1)).toBe(true)
    expect(isHeldAgentPromptDraft(screen.draft, `${BRIEF}\n补充一句用户自己的话`, 1)).toBe(false)
    // Only the tail shows, so it is not the user's whole typed text.
    expect(readTerminalComposerTypedText(terminal.getCursorLineContext())).toBeNull()
  }
)

it.each(['typed', 'none'] as const)(
  'keeps a footerless row with a %s scroll arrow out of the composer',
  async (scrollIndicator) => {
    const screen = projectTerminalVisibleLines(await paintScrolledComposer(0, scrollIndicator))
    expect(screen.draft).toBeUndefined()
  }
)
