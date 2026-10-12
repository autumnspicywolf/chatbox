/**
 * 回归测试：run_command 的「必然落定」。
 *
 * 改前症状（真实复现过）：命令自己退出后，它启动的后台进程仍握着 stdout/stderr
 * 管道 → 'close' 永不触发 → 工具调用的 promise 永不落定（前台一直转圈，
 * 强行终止也救不回来）。这里用 `Start-Process -NoNewWindow`（子进程继承 std 句柄）
 * 造出这个形态。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { logger } = vi.hoisted(() => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../util', () => ({
  getLogger: () => logger,
}))

import { __resetCommandJobsForTests, getCommandJob, killAllCommandJobs } from './command-jobs'
import { cancelUserExecCommand, executeUserExecCommand, resolveIdleTimeoutMs } from './user-exec-runner'

process.env.CHATBOX_COMMAND_WINDOW = '0'
// 缩短「exit 后等管道 EOF」的宽限，让测试跑得快又不失真实性。
process.env.CHATBOX_RUN_COMMAND_EXIT_GRACE_MS = '600'

const orphanPids: number[] = []
let workDir = ''

/** 一个每秒写一行输出的长跑叶子进程（模拟被 Start-Process 起的后台服务）。 */
function makeTickingLeafCommand(): { command: string; pidFile: string } {
  const leaf = path.join(workDir, 'leaf.cjs')
  const pidFile = path.join(workDir, 'leaf.pid')
  writeFileSync(
    leaf,
    [
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      'let n = 0',
      "setInterval(() => { process.stdout.write('tick' + (++n) + '\\n') }, 300)",
    ].join('\n')
  )
  // -NoNewWindow：子进程继承当前 std 句柄（即我们的管道），且 Start-Process 立刻返回。
  const command = `Start-Process -FilePath '${process.execPath}' -ArgumentList '${leaf}' -NoNewWindow`
  return { command, pidFile }
}

function recordOrphanPid(pidFile: string): void {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    if (pid) orphanPids.push(pid)
  } catch {
    // 没写出来就算了
  }
}

describe('resolveIdleTimeoutMs', () => {
  const original = process.env.CHATBOX_RUN_COMMAND_IDLE_MS
  afterEach(() => {
    if (original === undefined) delete process.env.CHATBOX_RUN_COMMAND_IDLE_MS
    else process.env.CHATBOX_RUN_COMMAND_IDLE_MS = original
  })

  test('defaults to 120 s', () => {
    delete process.env.CHATBOX_RUN_COMMAND_IDLE_MS
    expect(resolveIdleTimeoutMs()).toBe(120_000)
    expect(resolveIdleTimeoutMs(undefined)).toBe(120_000)
  })

  test('prefers an explicit value and honours the env override', () => {
    process.env.CHATBOX_RUN_COMMAND_IDLE_MS = '20000'
    expect(resolveIdleTimeoutMs()).toBe(20_000)
    expect(resolveIdleTimeoutMs(45_000)).toBe(45_000)
  })

  test('clamps nonsense values', () => {
    expect(resolveIdleTimeoutMs(1)).toBe(1_000)
    expect(resolveIdleTimeoutMs(99_999_999)).toBe(30 * 60_000)
    expect(resolveIdleTimeoutMs(-5)).toBe(120_000)
    process.env.CHATBOX_RUN_COMMAND_IDLE_MS = 'not-a-number'
    expect(resolveIdleTimeoutMs()).toBe(120_000)
  })
})

describe.skipIf(process.platform !== 'win32')('user_exec settlement (native Windows)', () => {
  beforeEach(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'chatbox-user-exec-hang-'))
    __resetCommandJobsForTests()
  })

  afterEach(() => {
    void killAllCommandJobs()
    __resetCommandJobsForTests()
    for (const pid of orphanPids.splice(0)) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    }
    rmSync(workDir, { recursive: true, force: true })
  })

  test(
    'settles when the command exits but a descendant keeps holding the output pipes',
    async () => {
      const { command, pidFile } = makeTickingLeafCommand()
      const started = Date.now()
      const result = await executeUserExecCommand({
        command,
        cwd: workDir,
        timeout: 60_000,
        idleTimeoutMs: 60_000,
        injectBundledNode: false,
      })
      const elapsed = Date.now() - started
      recordOrphanPid(pidFile)

      expect(result.exitCode).toBe(0)
      expect(result.detachedDescendants).toBe(true)
      expect(result.running).toBeFalsy()
      // 改前这里永远不会返回（'close' 不来）；600ms 宽限 + 启动开销，给足余量。
      expect(elapsed).toBeLessThan(10_000)
    },
    30_000
  )

  test(
    'hands a silent command to a background job instead of blocking the tool call',
    async () => {
      const started = Date.now()
      const result = await executeUserExecCommand({
        command: 'Start-Sleep -Seconds 60',
        cwd: workDir,
        timeout: 60_000,
        idleTimeoutMs: 1_000,
        injectBundledNode: false,
      })
      const elapsed = Date.now() - started

      expect(result.running).toBe(true)
      expect(result.jobId).toBeTruthy()
      expect(result.jobReason).toBe('idle')
      expect(result.idleMs).toBeGreaterThanOrEqual(1_000)
      expect(elapsed).toBeLessThan(10_000)

      const job = getCommandJob(result.jobId as string)
      expect(job?.state).toBe('running')

      await job?.kill('SIGKILL')
      // 终止是异步的：等 job 真的记录到退出，而不是立刻断言。
      const settled = await job?.wait(5_000)
      expect(settled?.reason).toBe('exited')
      expect(getCommandJob(result.jobId as string)?.state).not.toBe('running')
    },
    30_000
  )

  test(
    'cancelling settles promptly instead of waiting for a close that never comes',
    async () => {
      const started = Date.now()
      const promise = executeUserExecCommand({
        command: 'Start-Sleep -Seconds 60',
        cwd: workDir,
        timeout: 120_000,
        idleTimeoutMs: 120_000,
        sessionId: 'settle-session',
        toolCallId: 'settle-tool',
        injectBundledNode: false,
      })
      setTimeout(() => {
        cancelUserExecCommand({ sessionId: 'settle-session', toolCallId: 'settle-tool' })
      }, 500)

      const result = await promise
      expect(result.cancelled).toBe(true)
      expect(result.exitCode).toBe(130)
      expect(Date.now() - started).toBeLessThan(15_000)
    },
    30_000
  )
})
