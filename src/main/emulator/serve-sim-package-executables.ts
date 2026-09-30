import { join } from 'node:path'

// Standalone Mach-O helpers serve-sim spawns; the napi addon is dlopen'd and needs no +x.
export const SERVE_SIM_EXECUTABLE_RELATIVE_PATHS = [
  join('dist', 'simax', 'serve-sim-ax-settings'),
  join('dist', 'simcam', 'serve-sim-camera-helper'),
  join('dist', 'simduo', 'serve-sim-duo-hid'),
  join('dist', 'simduo', 'serve-sim-duo-render')
]
