/* ------------------------------------------------------------------ *
 * One child-process runner, own copy of the pattern addons/telegram's
 * voice-reply.mjs already uses — captures stdout/stderr, times out, never
 * throws. Every call site in this addon takes `exec` as an injected
 * dependency so tests never spawn a real tmux/ssh/claude process.
 * ------------------------------------------------------------------ */
import { spawn } from 'node:child_process'

/** → { code, stdout, stderr, missing?, timedOut? }. Never throws. */
export function run(bin, args, { timeoutMs = 15000, captureStdout = true } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'] })
    } catch (e) {
      return resolve({ code: null, stdout: '', stderr: String(e?.message || e), missing: true })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: null, stdout, stderr, timedOut: true })
    }, timeoutMs)
    child.stdout?.on('data', (d) => (stdout += d))
    child.stderr?.on('data', (d) => (stderr += d))
    child.on('error', (e) => finish({ code: null, stdout, stderr: String(e?.message || e), missing: e?.code === 'ENOENT' }))
    child.on('close', (code) => finish({ code, stdout, stderr }))
  })
}
