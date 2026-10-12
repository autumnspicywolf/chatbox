import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'

/** `taskkill` exits 0 on success and 128 when the pid is already gone / not found. */
const TASKKILL_SUCCESS_CODE = 0

/**
 * `taskkill /T /F` for a pid, resolving once it has actually exited.
 * Resolves `true` only on exit code 0; a missing pid (128) or a spawn failure
 * counts as "not killed", so the caller can fall back to `child.kill()`.
 */
function taskkillTreeAsync(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      // taskkill failing (e.g. process already gone) surfaces as an async 'error'
      // event; swallow it so it never crashes the main process.
      killer.on('error', () => done(false))
      killer.on('close', (code) => done(code === TASKKILL_SUCCESS_CODE))
    } catch {
      done(false)
    }
  })
}

/**
 * Terminate a spawned child and its descendants across platforms.
 * POSIX: signal the detached process group (negative pid). Windows: `taskkill /T`
 * since detached process-group signalling does not exist there.
 *
 * Fire-and-forget; use {@link killProcessTreeAsync} when the caller needs to know
 * whether the kill actually landed.
 */
export function killProcessTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  void killProcessTreeAsync(child, signal)
}

/**
 * Like {@link killProcessTree}, but awaits the attempt and reports whether it is
 * believed to have succeeded.
 *
 * Windows: `taskkill /T /F` is awaited and its exit code checked — previously it
 * was "fire and forget" (never awaited, exit code never read), so a failed kill
 * (taskkill exits non-zero rather than emitting 'error') went unnoticed and left
 * descendants alive, holding the child's stdout/stderr pipes open. When it fails
 * we fall back to `child.kill(signal)` so at least the direct child dies.
 */
export async function killProcessTreeAsync(
  child: ChildProcess,
  signal: 'SIGTERM' | 'SIGKILL'
): Promise<boolean> {
  if (process.platform === 'win32') {
    if (child.pid && (await taskkillTreeAsync(child.pid))) return true
    return child.kill(signal)
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, signal)
      return true
    } catch {
      return child.kill(signal)
    }
  }
  return child.kill(signal)
}
