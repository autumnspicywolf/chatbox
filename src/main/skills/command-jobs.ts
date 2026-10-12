import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { killProcessTreeAsync } from '../process-tree'

/**
 * Background command jobs.
 *
 * A `run_command` invocation normally settles when the child exits. When it goes
 * quiet for long enough we stop waiting *in the tool call* (so the model can keep
 * talking and decide what to do) but keep the child alive here, in the main
 * process, streaming into a small ring buffer. The model can then inspect it
 * (`command_status` / `command_wait`) or stop it (`command_kill`).
 *
 * Jobs live in main so they survive across tool calls.
 */

export type CommandJobState = 'running' | 'exited' | 'killed'

export interface CommandJobSnapshot {
  id: string
  command: string
  cwd?: string
  pid: number | null
  state: CommandJobState
  exitCode: number | null
  /** epoch ms */
  startedAt: number
  /** epoch ms of the last output chunk */
  lastOutputAt: number
  /** silence so far, ms */
  idleMs: number
  /** bytes currently held in the recent-output buffer */
  outputBytes: number
  recentOutput: string
}

export type CommandJobWaitReason = 'output' | 'exited' | 'timeout'

export interface CommandJobWaitResult {
  reason: CommandJobWaitReason
  snapshot: CommandJobSnapshot
}

export interface CommandJob {
  readonly id: string
  readonly sessionId?: string
  readonly toolCallId?: string
  readonly child: ChildProcess | null
  readonly state: CommandJobState
  appendOutput(source: 'stdout' | 'stderr', chunk: Buffer): void
  markExited(exitCode: number | null): void
  snapshot(): CommandJobSnapshot
  wait(timeoutMs: number): Promise<CommandJobWaitResult>
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<boolean>
}

/** Kept for `command_status` / `command_wait` — enough tail to judge what happened. */
const RECENT_OUTPUT_MAX_BYTES = 8 * 1024
/** Settled jobs stay queryable this long, then are dropped from the registry. */
const FINISHED_JOB_RETENTION_MS = 10 * 60 * 1000
/** A live job that has produced nothing for this long is considered abandoned and killed. */
const RUNNING_JOB_MAX_SILENCE_MS = 10 * 60 * 1000
const SWEEP_INTERVAL_MS = 30 * 1000
const FORCE_KILL_DELAY_MS = 3_000

interface OutputEntry {
  source: 'stdout' | 'stderr'
  /** 存 Uint8Array 而不是 Buffer：新版 TS 的 Buffer<ArrayBufferLike> 与 Buffer.concat/from 的
   *  Uint8Array<ArrayBuffer> 形参不兼容（@types/node 20 的 Buffer.slice() 覆盖了协变位置）。 */
  buf: Uint8Array
}

interface Waiter {
  sinceVersion: number
  resolve: (result: CommandJobWaitResult) => void
  timer: NodeJS.Timeout | null
}

class CommandJobImpl implements CommandJob {
  readonly id: string
  readonly sessionId?: string
  readonly toolCallId?: string
  readonly command: string
  readonly cwd?: string
  readonly child: ChildProcess | null
  readonly startedAt = Date.now()

  state: CommandJobState = 'running'
  exitCode: number | null = null
  lastOutputAt = Date.now()

  private entries: OutputEntry[] = []
  private bytes = 0
  private version = 0
  private waiters: Waiter[] = []
  private terminateRequested = false
  private forceKillHandle: NodeJS.Timeout | null = null

  constructor(opts: {
    command: string
    cwd?: string
    child: ChildProcess | null
    sessionId?: string
    toolCallId?: string
  }) {
    this.id = `job_${randomUUID().slice(0, 8)}`
    this.command = opts.command
    this.cwd = opts.cwd
    this.child = opts.child
    this.sessionId = opts.sessionId
    this.toolCallId = opts.toolCallId
  }

  appendOutput(source: 'stdout' | 'stderr', chunk: Buffer): void {
    if (chunk.byteLength === 0) return
    // Copy: a stream chunk is often a slice of a much larger shared pool.
    const buf = new Uint8Array(chunk.byteLength)
    buf.set(chunk)
    this.entries.push({ source, buf })
    this.bytes += buf.byteLength
    while (this.bytes > RECENT_OUTPUT_MAX_BYTES && this.entries.length > 1) {
      const dropped = this.entries.shift()
      if (dropped) this.bytes -= dropped.buf.byteLength
    }
    if (this.bytes < 0) this.bytes = 0
    this.lastOutputAt = Date.now()
    this.version += 1
    this.flushWaiters('output')
  }

  markExited(exitCode: number | null): void {
    if (this.state !== 'running') return
    this.state = this.terminateRequested ? 'killed' : 'exited'
    this.exitCode = exitCode
    if (this.forceKillHandle) {
      clearTimeout(this.forceKillHandle)
      this.forceKillHandle = null
    }
    this.flushWaiters('exited')
  }

  snapshot(): CommandJobSnapshot {
    return {
      id: this.id,
      command: this.command,
      cwd: this.cwd,
      pid: this.child?.pid ?? null,
      state: this.state,
      exitCode: this.exitCode,
      startedAt: this.startedAt,
      lastOutputAt: this.lastOutputAt,
      idleMs: Math.max(0, Date.now() - this.lastOutputAt),
      outputBytes: this.bytes,
      recentOutput: this.recentOutput(),
    }
  }

  /** Decoded lazily: multi-byte characters split across chunks must not be mangled. */
  recentOutput(): string {
    if (this.entries.length === 0) return ''
    let total = 0
    for (const entry of this.entries) total += entry.buf.byteLength
    const merged = new Uint8Array(total)
    let offset = 0
    for (const entry of this.entries) {
      merged.set(entry.buf, offset)
      offset += entry.buf.byteLength
    }
    return Buffer.from(merged).toString('utf8')
  }

  wait(timeoutMs: number): Promise<CommandJobWaitResult> {
    if (this.state !== 'running') {
      return Promise.resolve({ reason: 'exited', snapshot: this.snapshot() })
    }
    return new Promise<CommandJobWaitResult>((resolve) => {
      const waiter: Waiter = { sinceVersion: this.version, resolve, timer: null }
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.removeWaiter(waiter)
          resolve({ reason: 'timeout', snapshot: this.snapshot() })
        }, timeoutMs)
      }
      this.waiters.push(waiter)
    })
  }

  async kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<boolean> {
    this.terminateRequested = true
    const child = this.child
    if (!child || !child.pid) {
      this.markExited(null)
      return false
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      this.markExited(child.exitCode)
      return false
    }
    const ok = await killProcessTreeAsync(child, signal)
    if (this.state === 'running' && signal === 'SIGTERM' && !this.forceKillHandle) {
      this.forceKillHandle = setTimeout(() => {
        void killProcessTreeAsync(child, 'SIGKILL')
      }, FORCE_KILL_DELAY_MS)
      this.forceKillHandle.unref?.()
    }
    return ok
  }

  dispose(): void {
    if (this.forceKillHandle) {
      clearTimeout(this.forceKillHandle)
      this.forceKillHandle = null
    }
    for (const waiter of this.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve({ reason: 'exited', snapshot: this.snapshot() })
    }
    this.waiters = []
    this.entries = []
    this.bytes = 0
    jobs.delete(this.id)
  }

  private removeWaiter(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter)
    if (index >= 0) this.waiters.splice(index, 1)
  }

  private flushWaiters(reason: 'output' | 'exited'): void {
    if (this.waiters.length === 0) return
    const remaining: Waiter[] = []
    for (const waiter of this.waiters) {
      if (reason === 'exited' || this.version > waiter.sinceVersion) {
        if (waiter.timer) clearTimeout(waiter.timer)
        waiter.resolve({ reason, snapshot: this.snapshot() })
      } else {
        remaining.push(waiter)
      }
    }
    this.waiters = remaining
  }
}

const jobs = new Map<string, CommandJobImpl>()

let sweepHandle: NodeJS.Timeout | null = null

function ensureSweeper(): void {
  if (sweepHandle) return
  sweepHandle = setInterval(() => {
    const now = Date.now()
    for (const job of [...jobs.values()]) {
      if (job.state === 'running') {
        if (now - job.snapshot().lastOutputAt > RUNNING_JOB_MAX_SILENCE_MS) {
          void job.kill('SIGKILL')
        }
        continue
      }
      if (now - job.snapshot().lastOutputAt > FINISHED_JOB_RETENTION_MS) job.dispose()
    }
  }, SWEEP_INTERVAL_MS)
  sweepHandle.unref?.()
}

export function createCommandJob(opts: {
  command: string
  cwd?: string
  child: ChildProcess | null
  sessionId?: string
  toolCallId?: string
}): CommandJob {
  ensureSweeper()
  const job = new CommandJobImpl(opts)
  jobs.set(job.id, job)
  return job
}

export function getCommandJob(id: string): CommandJob | undefined {
  return jobs.get(id)
}

export function listCommandJobs(filter?: { sessionId?: string }): CommandJob[] {
  const all = [...jobs.values()]
  if (!filter?.sessionId) return all
  return all.filter((job) => job.sessionId === filter.sessionId)
}

export function findCommandJobsByToolCall(sessionId: string | undefined, toolCallId: string): CommandJob[] {
  return [...jobs.values()].filter(
    (job) => job.toolCallId === toolCallId && (sessionId === undefined || job.sessionId === sessionId)
  )
}

export function disposeCommandJob(id: string): void {
  jobs.get(id)?.dispose()
}

export async function killCommandJobsForToolCall(sessionId: string | undefined, toolCallId: string): Promise<number> {
  const targets = findCommandJobsByToolCall(sessionId, toolCallId)
  await Promise.all(targets.map((job) => job.kill('SIGTERM')))
  return targets.length
}

export async function killCommandJobsForSession(sessionId: string): Promise<number> {
  const targets = [...jobs.values()].filter((job) => job.sessionId === sessionId)
  await Promise.all(targets.map((job) => job.kill('SIGTERM')))
  return targets.length
}

export async function killAllCommandJobs(): Promise<number> {
  const targets = [...jobs.values()]
  await Promise.all(targets.map((job) => job.kill('SIGTERM')))
  return targets.length
}

/** Test-only: reset registry state between cases. */
export function __resetCommandJobsForTests(): void {
  for (const job of [...jobs.values()]) job.dispose()
  jobs.clear()
  if (sweepHandle) {
    clearInterval(sweepHandle)
    sweepHandle = null
  }
}
