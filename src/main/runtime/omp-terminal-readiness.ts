// OMP 18.4.5 keeps the same idle title throughout setup and the empty composer.
export function isOmpComposerReadyScreen(screenLines: readonly string[]): boolean {
  const lines = screenLines.map((line) => line.trim())
  return (
    !lines.some((line) => /setup step \d+ of \d+/i.test(line)) &&
    lines.some((line) => /^╰─\s+[⇧⇥]+ to change thinking effort$/.test(line))
  )
}
