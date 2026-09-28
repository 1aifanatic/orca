import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { packagedTerminalFloorDockerArgs } from './run-linux-packaged-terminal-floor-smoke.mjs'

describe('packaged terminal Linux floor qualification', () => {
  it('isolates exact packaged artifacts from writable fixture state on Ubuntu 20.04', () => {
    const args = packagedTerminalFloorDockerArgs({
      appDirectory: '/tmp/app with spaces',
      fixtureDirectory: '/tmp/gate'
    })
    expect(args).toContain('type=bind,src=/tmp/app with spaces,dst=/artifact,readonly')
    expect(args).toContain('type=bind,src=/tmp/gate,dst=/qualification,readonly')
    expect(args).toContain('ubuntu:20.04')
    expect(args).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(args).toContain('ORCA_BACKGROUND_LAUNCH=1')
    expect(args.at(-3)).toContain('/artifact/orca-ide')
    expect(args.at(-3)).toContain('/artifact/resources')
  })
  it('does not splice caller paths into a shell command', () => {
    const args = packagedTerminalFloorDockerArgs({
      appDirectory: '/tmp/$(unexpected)',
      fixtureDirectory: '/tmp/gate'
    })
    expect(args.at(-3)).not.toContain('unexpected')
    expect(args).toContain('type=bind,src=/tmp/$(unexpected),dst=/artifact,readonly')
    expect(() =>
      packagedTerminalFloorDockerArgs({
        appDirectory: '/tmp/app,readonly',
        fixtureDirectory: '/tmp/gate'
      })
    ).toThrow('commas')
  })
  it('runs the exact packaged terminal on both release architectures before upload', () => {
    const workflow = parse(readFileSync('.github/workflows/release-cut.yml', 'utf8'))
    const steps = workflow.jobs.build.steps
    const gate = steps.find(
      (step) => step.name === 'Qualify packaged Bun terminal on the Linux floor'
    )
    expect(gate.if).toContain("matrix.platform == 'linux-x64'")
    expect(gate.if).toContain("matrix.platform == 'linux-arm64'")
    expect(gate.with.command).toContain('run-linux-packaged-terminal-floor-smoke.mjs')
    expect(gate.with.command).toContain('${{ matrix.unpacked_dir }}')
    expect(steps.indexOf(gate)).toBeLessThan(
      steps.findIndex((step) => step.uses?.startsWith('actions/upload-artifact'))
    )
    expect(
      packagedTerminalFloorDockerArgs({
        appDirectory: '/app',
        fixtureDirectory: '/gate',
        containerName: 'owned-probe'
      })
    ).toContain('owned-probe')
  })
})
