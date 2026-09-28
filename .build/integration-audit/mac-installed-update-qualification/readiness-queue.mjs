// One surviving serve supervisor can publish several replacement-child readiness frames.
export function createReadinessQueue(child, { cancelled = () => false, maxBytes = 2 ** 20 } = {}) {
  const queue = []
  let pending = '', total = 0, failure = null, waiter = null
  const deliver = () => {
    if (!waiter) return
    if (failure) waiter.reject(failure)
    else if (queue.length) waiter.resolve(queue.shift())
  }
  child.stdout.on('data', bytes => {
    total += bytes.length
    if (total > maxBytes) { failure = new Error('Supervisor output limit'); deliver(); return }
    pending += bytes
    const lines = pending.split('\n'); pending = lines.pop()
    for (const line of lines) {
      try {
        const data = JSON.parse(line)
        if (data.type === 'orca_server_ready') {
          if (queue.length >= 4) throw new Error('Unexpected readiness frame count')
          queue.push(data)
        }
      } catch (error) { if (error.message === 'Unexpected readiness frame count') failure = error }
    }
    deliver()
  })
  child.stderr.on('data', () => {})
  child.once('error', () => { failure = new Error('Supervisor spawn failed'); deliver() })
  child.once('exit', code => { failure = new Error(`Supervisor exited: ${code}`); deliver() })
  return {
    next(timeoutMs = 180_000) {
      if (waiter) throw new Error('Concurrent readiness wait')
      return new Promise((resolve, reject) => {
        let timer, poll
        const finish = (fn, value) => { clearTimeout(timer); clearInterval(poll); waiter = null; fn(value) }
        waiter = { resolve: value => finish(resolve, value), reject: error => finish(reject, error) }
        timer = setTimeout(() => waiter?.reject(new Error('Replacement readiness timeout')), timeoutMs)
        poll = setInterval(() => { if (cancelled()) waiter?.reject(new Error('Readiness wait cancelled')) }, 50)
        deliver()
      })
    }
  }
}
