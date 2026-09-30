import {
  readAgentProcess,
  windowsAgentProcessReader
} from '../../shared/agent-process-presence-probe'
import { readWindowsProcessCreationTime } from '../windows/windows-process-table'

export async function readHostAgentProcess(pid: number) {
  return process.platform === 'win32'
    ? windowsAgentProcessReader(readWindowsProcessCreationTime)(pid)
    : readAgentProcess(pid)
}
