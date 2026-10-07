// Agent-like TUI output: spinner status line redrawn in place, colored tool blocks, periodic bursts.
const ESC = '\x1b['
const spin = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
let n = 0
const tools = ['Read', 'Edit', 'Bash', 'Grep', 'Write', 'TodoWrite']
function block() {
  const t = tools[n % tools.length]
  let s = `\r${ESC}2K${ESC}38;5;208m●${ESC}0m ${ESC}1m${t}${ESC}0m(src/file-${n % 97}.ts)\n`
  for (let i = 0; i < 1 + (n % 6); i++) {
    s += `  ${ESC}2m⎿${ESC}0m  ${ESC}32m+ line ${i}${ESC}0m ${'x'.repeat((n * 7 + i) % 90)}\n`
  }
  return s
}
setInterval(() => {
  n++
  let out = ''
  if (n % 8 === 0) {
    out += block()
  }
  out += `\r${ESC}2K${ESC}38;5;174m${spin[n % spin.length]} Working… ${ESC}2m(${n}s · esc to interrupt)${ESC}0m`
  process.stdout.write(out)
}, 100)
