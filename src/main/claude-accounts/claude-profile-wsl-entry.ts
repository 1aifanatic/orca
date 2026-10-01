import { ClaudeWslProfileRequest, runClaudeWslProfileRequest } from './claude-profile-wsl-guest'

async function main(): Promise<void> {
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
    if (input.length > 16_384) {
      throw new Error('Claude profile request is too large')
    }
  }
  const request = ClaudeWslProfileRequest.parse(JSON.parse(input))
  process.stdout.write(JSON.stringify(await runClaudeWslProfileRequest(request)))
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
