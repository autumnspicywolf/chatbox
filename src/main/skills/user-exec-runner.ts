import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { RunCommandShell } from '@shared/types/command-execution'
import type { UserExecApprovalSource } from '@shared/types/user-exec'
import { type CommandConsoleWindow, openCommandConsoleWindow } from '../command-console-window'
import { consumeFailedCommandRetry } from '../command-execution-policy'
import {
  COMMAND_OUTPUT_CAPTURE_FAILED_MESSAGE,
  createCommandOutputCapture,
  createCommandOutputCapturePath,
} from '../command-output-capture'
import { buildOperationFinishLog, buildOperationStartLog, createOperationId } from '../operation-log'
import { killProcessTreeAsync } from '../process-tree'
import { buildPowerShellStdinScript, buildSandboxStdinScript, stripCodesignNoise } from '../sandbox/exec-script'
import { getLoginShellPathIfReady } from '../sandbox/login-shell-env'
import { getLogger } from '../util'
import { resolveWindowsPowerShell } from '../windows-powershell'
import { type CommandJob, createCommandJob, disposeCommandJob, findCommandJobsByToolCall } from './command-jobs'

const log = getLogger('skills:user-exec')

const DEFAULT_TIMEOUT_MS = 120_000
/**
 * How long a command may be *silent* before we stop waiting inside the tool call
 * and hand it to a background job (see command-jobs.ts) — the model then decides
 * whether to keep waiting, kill it, or try something else.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000
const MIN_IDLE_TIMEOUT_MS = 1_000
const MAX_IDLE_TIMEOUT_MS = 30 * 60_000
/** After the direct child exits, how long to wait for the stdio pipes to EOF. */
const EXIT_PIPE_GRACE_MS = Number(process.env.CHATBOX_RUN_COMMAND_EXIT_GRACE_MS) || 3_000
/** After a kill request, how long to wait for 'close' before forcing the pipes shut. */
const TERMINATE_SETTLE_GRACE_MS = 1_500
const FORCE_KILL_DELAY_MS = 3_000

/** Idle threshold in ms; `CHATBOX_RUN_COMMAND_IDLE_MS` overrides the default. */
export function resolveIdleTimeoutMs(requested?: number): number {
  const envValue = Number(process.env.CHATBOX_RUN_COMMAND_IDLE_MS)
  const candidate = requested ?? (Number.isFinite(envValue) ? envValue : DEFAULT_IDLE_TIMEOUT_MS)
  if (!Number.isFinite(candidate) || candidate <= 0) return DEFAULT_IDLE_TIMEOUT_MS
  return Math.min(Math.max(candidate, MIN_IDLE_TIMEOUT_MS), MAX_IDLE_TIMEOUT_MS)
}

export interface UserExecParams {
  command: string
  cwd?: string
  timeout?: number
  /** Silence budget before the command is handed to a background job. */
  idleTimeoutMs?: number
  sessionId?: string
  toolCallId?: string
  approvalSource?: UserExecApprovalSource
  retryOf?: string
  shell?: RunCommandShell
  baseCwd?: string
  injectBundledNode?: boolean
}

export interface UserExecResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  cancelled?: boolean
  cwd?: string
  outputFile?: string
  /**
   * Stage 2: the command went quiet for too long, so it was handed to a background
   * job instead of blocking the tool call. `stdout` then holds the recent output
   * (stdout+stderr merged) captured so far.
   */
  running?: boolean
  jobId?: string
  jobReason?: 'idle' | 'timeout'
  idleMs?: number
  /**
   * Stage 1: the command itself exited, but descendant processes are still running
   * and holding its output streams open. They were not killed and are not tracked.
   */
  detachedDescendants?: boolean
}

interface ActiveUserExecCommand {
  cancel: () => void
}

interface UserExecEntry {
  command: string
  cwd?: string
  retryOf?: string
  shell?: RunCommandShell
  baseCwd?: string
  injectBundledNode?: boolean
  promise: Promise<UserExecResult>
  completedAt?: number
}

interface UserExecRunnerOptions {
  completedTtlMs?: number
  maxCompletedEntries?: number
  now?: () => number
}

const DEFAULT_COMPLETED_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_COMPLETED_ENTRIES = 32
const activeUserExecCommands = new Map<string, ActiveUserExecCommand>()

function getUserExecKey(sessionId: string | undefined, toolCallId: string | undefined): string | null {
  return toolCallId ? `${sessionId ?? ''}:${toolCallId}` : null
}

export function cancelUserExecCommand(params: Pick<UserExecParams, 'sessionId' | 'toolCallId'>): { killed: boolean } {
  let killed = false
  const key = getUserExecKey(params.sessionId, params.toolCallId)
  const active = key ? activeUserExecCommands.get(key) : undefined
  if (active) {
    active.cancel()
    killed = true
  }
  // A command that was already handed to a background job has no `active` entry
  // (it settled the tool call), so look its job up by tool call id as well.
  if (params.toolCallId) {
    const jobs = findCommandJobsByToolCall(params.sessionId, params.toolCallId)
    if (jobs.length > 0) {
      killed = true
      void Promise.all(jobs.map((job) => job.kill('SIGTERM')))
    }
  }
  return { killed }
}

export function resolveUserExecCwd(params: Pick<UserExecParams, 'cwd' | 'baseCwd'>): string {
  const baseCwd = params.baseCwd?.trim() || os.homedir()
  return path.resolve(baseCwd, params.cwd?.trim() || '.')
}

export async function executeUserExecCommand(params: UserExecParams): Promise<UserExecResult> {
  const {
    command,
    cwd: requestedCwd,
    baseCwd: requestedBaseCwd,
    timeout,
    idleTimeoutMs: requestedIdleTimeoutMs,
    sessionId,
    toolCallId,
    approvalSource,
    retryOf,
    shell,
    injectBundledNode,
  } = params
  let resolvedCwd: string | undefined
  let consoleWindow: CommandConsoleWindow | null = null

  try {
    if (!command || typeof command !== 'string') throw new Error('Command is required')

    const cwd = resolveUserExecCwd({ cwd: requestedCwd, baseCwd: requestedBaseCwd })
    resolvedCwd = cwd
    if (retryOf) {
      if (!sessionId || !shell) throw new Error('Escalated command retries require sessionId and shell')
      const retry = consumeFailedCommandRetry({ sessionId, retryOf, command, cwd, shell })
      if (!retry.valid) throw new Error(retry.error)
    }
    const timeoutMs = timeout || DEFAULT_TIMEOUT_MS
    const idleTimeoutMs = resolveIdleTimeoutMs(requestedIdleTimeoutMs)
    const maxOutputBytes = 6_000
    const operationId = createOperationId()
    const startedAt = Date.now()

    log.info(
      buildOperationStartLog({
        operationId,
        kind: 'user_exec',
        sessionId,
        toolCallId,
        // Renderer approval metadata is audit-only. Missing values remain visible
        // instead of silently looking like a known authorization path.
        approvalSource: approvalSource ?? 'unknown',
        cwd,
        timeoutMs,
        command,
      })
    )

    const isWindows = process.platform === 'win32'
    const powershell = isWindows ? resolveWindowsPowerShell() : null
    if (isWindows && !powershell) {
      const result = {
        success: false,
        stdout: '',
        stderr: 'PowerShell is not available on this Windows host.',
        exitCode: null,
        cwd,
      }
      log.warn(
        buildOperationFinishLog({
          operationId,
          success: false,
          exitCode: null,
          durationMs: Date.now() - startedAt,
          stdout: '',
          stderr: result.stderr,
        })
      )
      return result
    }
    const shellCommand = powershell?.cmd ?? 'bash'
    const hostCommand =
      injectBundledNode && !isWindows ? buildSandboxStdinScript(command, 'bash', process.execPath, true) : command
    const shellArgs = powershell?.args ?? ['-lc', hostCommand]
    // 把命令跑的过程镜像到一个可见的控制台窗口里（见 command-console-window.ts）。
    // 真正的执行路径一点没变：仍然管道捕获、仍然全量落盘，这里只是多开一个「显示器」。
    const capturePath = createCommandOutputCapturePath(toolCallId)
    consoleWindow = openCommandConsoleWindow({ command, capturePath, powershellPath: powershell?.cmd })
    const outputCapture = createCommandOutputCapture(capturePath, { retainOutputFile: consoleWindow !== null })

    // GUI-launched Electron inherits launchd's minimal PATH; `bash -l` alone doesn't recover
    // it on macOS (Homebrew configures zsh's ~/.zprofile, which bash never sources). Read the
    // cached value synchronously: an await here would delay spawn and open a window in which
    // cancellation cannot find the child.
    const loginShellPath = getLoginShellPathIfReady()
    const spawnEnv = loginShellPath ? { ...process.env, PATH: loginShellPath } : process.env

    return await new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      let cancelled = false
      let timedOut = false
      let outputLimitExceeded = false
      let terminating = false
      let handedOff = false
      let captureFinalized = false
      let descendantsDetected = false
      let lastOutputAt = Date.now()
      let exitCode: number | null = null
      let exitSignal: NodeJS.Signals | null = null
      let pendingJob: CommandJob | undefined
      const activeKey = getUserExecKey(sessionId, toolCallId)

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      let idleCheckHandle: ReturnType<typeof setInterval> | undefined
      let forceKillHandle: ReturnType<typeof setTimeout> | undefined
      let exitGraceHandle: ReturnType<typeof setTimeout> | undefined
      let terminateGraceHandle: ReturnType<typeof setTimeout> | undefined

      const clearTimers = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        if (idleCheckHandle) clearInterval(idleCheckHandle)
        if (forceKillHandle) clearTimeout(forceKillHandle)
        if (exitGraceHandle) clearTimeout(exitGraceHandle)
        if (terminateGraceHandle) clearTimeout(terminateGraceHandle)
      }

      const scheduleForceKill = () => {
        if (forceKillHandle) return
        forceKillHandle = setTimeout(() => {
          void killProcessTreeAsync(child, 'SIGKILL')
        }, FORCE_KILL_DELAY_MS)
      }

      const buildResult = (): UserExecResult => {
        if (cancelled) return { success: false, stdout, stderr, exitCode: 130, cancelled: true }
        if (outputLimitExceeded) {
          return {
            success: false,
            stdout,
            stderr: `${stderr}${stderr ? '\n' : ''}[Command terminated: output exceeded the 10MB capture limit]`,
            exitCode: 1,
          }
        }
        if (timedOut || exitSignal === 'SIGTERM') {
          return { success: false, stdout, stderr: stderr || `Command timed out (${timeoutMs / 1000}s)`, exitCode: null }
        }
        return {
          success: exitCode === 0,
          stdout,
          stderr,
          exitCode,
          ...(descendantsDetected ? { detachedDescendants: true as const } : {}),
        }
      }

      const resolveOnce = (result: UserExecResult) => {
        if (settled) return
        settled = true
        clearTimers()
        if (activeKey) activeUserExecCommands.delete(activeKey)
        // A handed-off job must survive this tool call; only a settled one is dropped.
        if (pendingJob && !handedOff) disposeCommandJob(pendingJob.id)
        void (async () => {
          const outputFile = await outputCapture.finish()
          // 退出码/耗时只喂给窗口的「命令结束」横幅，不影响回填给模型的结果。
          consoleWindow?.close({
            keepCaptureFile: outputFile !== undefined,
            exitCode: result.exitCode,
            durationMs: Date.now() - startedAt,
          })
          const capturedResult = {
            ...result,
            ...(outputCapture.isFailed()
              ? {
                  stderr: `${result.stderr}${result.stderr ? '\n' : ''}${COMMAND_OUTPUT_CAPTURE_FAILED_MESSAGE}`,
                }
              : {}),
            ...(outputFile ? { outputFile } : {}),
          }
          const finalResult = injectBundledNode
            ? { ...capturedResult, stderr: stripCodesignNoise(capturedResult.stderr) }
            : capturedResult
          const finishLog = buildOperationFinishLog({
            operationId,
            success: finalResult.success,
            exitCode: finalResult.exitCode,
            durationMs: Date.now() - startedAt,
            timedOut: finalResult.exitCode === null && finalResult.stderr.includes('timed out'),
            stdout: finalResult.stdout,
            stderr: finalResult.stderr,
            stdoutBytes,
            stderrBytes,
          })
          if (finalResult.success) log.info(finishLog)
          else log.warn(finishLog)
          resolve({ ...finalResult, cwd })
        })()
      }

      /** 停止等待（不杀）：把命令交给后台 job，工具调用提前落定。 */
      const handOff = (reason: 'idle' | 'timeout', idleForMs: number) => {
        if (settled || handedOff) return
        handedOff = true
        finalizeCapture()
        const snapshot = pendingJob?.snapshot()
        resolveOnce({
          success: true,
          running: true,
          ...(pendingJob ? { jobId: pendingJob.id } : {}),
          jobReason: reason,
          idleMs: idleForMs,
          // 让模型「从已经输出的信息中判断」：给最近一段（stdout/stderr 合并的尾部）。
          stdout: snapshot?.recentOutput ?? stdout,
          stderr: '',
          exitCode: null,
        })
      }

      /** 主动终止：只杀不等待 'close' —— 后代可能一直握着管道，'close' 永远不来。 */
      const requestTerminate = (reason: 'cancelled' | 'timeout') => {
        if (settled || terminating) return
        terminating = true
        if (reason === 'cancelled') cancelled = true
        else timedOut = true
        if (idleCheckHandle) clearInterval(idleCheckHandle)
        // 定时器同步武装：不要 await taskkill —— 它万一不退出，定时器就永远不会被排上，
        // 反倒把这个工具调用重新卡死（而 timeout 分支此时已被 terminating 挡住）。
        void killProcessTreeAsync(child, 'SIGTERM')
        scheduleForceKill()
        terminateGraceHandle = setTimeout(() => {
          if (settled) return
          stdoutStream.destroy()
          stderrStream.destroy()
          resolveOnce(buildResult())
        }, TERMINATE_SETTLE_GRACE_MS)
      }

      const finalizeCapture = () => {
        if (captureFinalized) return
        captureFinalized = true
        // 交给 job 之后只需要内存里的尾巴，背压不再适用：确保管道继续流。
        stdoutStream.resume()
        stderrStream.resume()
      }

      const child = spawn(shellCommand, shellArgs, {
        cwd,
        stdio: [isWindows ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: spawnEnv,
        shell: false,
        // 输出走管道，子进程本来就不需要控制台；显式隐藏，避免在没有控制台的宿主里
        // 额外闪一个空白窗口（可见窗口由 command-console-window 负责）。
        windowsHide: true,
        // Keep the command in its own POSIX process group so cancellation also
        // terminates descendants. Windows uses taskkill /T in killProcessTree.
        detached: !isWindows,
      })

      // 每个命令都登记一个 job：正常结束就随工具调用一起丢弃，静默超时就留给模型接管。
      pendingJob = createCommandJob({ command, cwd, child, sessionId, toolCallId })

      if (activeKey) {
        activeUserExecCommands.set(activeKey, { cancel: () => requestTerminate('cancelled') })
      }

      timeoutHandle = setTimeout(() => {
        if (settled || terminating) return
        const idleForMs = Date.now() - lastOutputAt
        // 静默够久 = 疑似卡住 → 交给模型判断；一直在输出 = 只是太久 → 按老规矩收掉。
        if (idleForMs >= idleTimeoutMs) handOff('idle', idleForMs)
        else requestTerminate('timeout')
      }, timeoutMs)

      const idleCheckEveryMs = Math.max(500, Math.min(5_000, Math.floor(idleTimeoutMs / 4)))
      idleCheckHandle = setInterval(() => {
        if (settled || terminating) return
        const idleForMs = Date.now() - lastOutputAt
        if (idleForMs >= idleTimeoutMs) handOff('idle', idleForMs)
      }, idleCheckEveryMs)
      idleCheckHandle.unref?.()

      if (!child.stdout || !child.stderr) {
        child.kill('SIGTERM')
        resolveOnce({ success: false, stdout: '', stderr: 'Command output streams are unavailable', exitCode: null })
        return
      }
      const stdoutStream = child.stdout
      const stderrStream = child.stderr

      if (isWindows && child.stdin) {
        child.stdin.on('error', () => {
          // The process error/close handlers below own the final result.
        })
        child.stdin.end(buildPowerShellStdinScript(command, injectBundledNode ? process.execPath : undefined), 'utf8')
      }

      stdoutStream.on('data', (data: Buffer) => {
        stdoutBytes += data.byteLength
        lastOutputAt = Date.now()
        pendingJob?.appendOutput('stdout', data)
        if (!captureFinalized && !outputCapture.append('stdout', data)) {
          stdoutStream.pause()
          outputCapture.onDrain(() => stdoutStream.resume())
        }
        if (!outputLimitExceeded && outputCapture.isLimitExceeded()) {
          outputLimitExceeded = true
          void killProcessTreeAsync(child, 'SIGTERM')
          scheduleForceKill()
        }
        const remaining = maxOutputBytes - Buffer.byteLength(stdout)
        if (remaining > 0) stdout += data.subarray(0, remaining).toString()
      })
      stderrStream.on('data', (data: Buffer) => {
        stderrBytes += data.byteLength
        lastOutputAt = Date.now()
        pendingJob?.appendOutput('stderr', data)
        if (!captureFinalized && !outputCapture.append('stderr', data)) {
          stderrStream.pause()
          outputCapture.onDrain(() => stderrStream.resume())
        }
        if (!outputLimitExceeded && outputCapture.isLimitExceeded()) {
          outputLimitExceeded = true
          void killProcessTreeAsync(child, 'SIGTERM')
          scheduleForceKill()
        }
        const remaining = maxOutputBytes - Buffer.byteLength(stderr)
        if (remaining > 0) stderr += data.subarray(0, remaining).toString()
      })
      child.on('error', (error) => {
        if (forceKillHandle) clearTimeout(forceKillHandle)
        log.error('skills:user-exec spawn error', error)
        resolveOnce({ success: false, stdout, stderr: stderr || error.message, exitCode: null })
      })
      child.on('exit', (code, signal) => {
        exitCode = code
        exitSignal = signal
        pendingJob?.markExited(code)
        if (settled) return
        // 阶段 1：正常命令 'close' 会在 'exit' 之后立刻到；但如果后代进程继承了
        // stdout/stderr 管道（Start-Process / start 起的后台服务等），管道就永不 EOF，
        // 'close' 永不触发 —— 于是这里给一段宽限，到点主动放掉管道并落定。
        exitGraceHandle = setTimeout(() => {
          if (settled) return
          descendantsDetected = true
          stdoutStream.destroy()
          stderrStream.destroy()
          resolveOnce(buildResult())
        }, EXIT_PIPE_GRACE_MS)
      })
      child.on('close', (code, signal) => {
        if (forceKillHandle) clearTimeout(forceKillHandle)
        if (exitGraceHandle) clearTimeout(exitGraceHandle)
        exitCode = code
        exitSignal = signal
        pendingJob?.markExited(code)
        resolveOnce(buildResult())
      })
    })
  } catch (error) {
    consoleWindow?.close()
    log.error('skills:user-exec failed', error)
    return {
      success: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : 'Unknown error',
      exitCode: null,
      ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
    }
  }
}

export function createUserExecRunner(
  execute: (params: UserExecParams) => Promise<UserExecResult>,
  options: UserExecRunnerOptions = {}
) {
  const completedTtlMs = options.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS
  const maxCompletedEntries = options.maxCompletedEntries ?? DEFAULT_MAX_COMPLETED_ENTRIES
  const now = options.now ?? Date.now
  const entries = new Map<string, UserExecEntry>()

  function pruneCompletedEntries(): void {
    const currentTime = now()
    for (const [key, entry] of entries) {
      if (entry.completedAt !== undefined && currentTime - entry.completedAt >= completedTtlMs) {
        entries.delete(key)
      }
    }

    const completedEntries = [...entries.entries()]
      .filter((entry): entry is [string, UserExecEntry & { completedAt: number }] => entry[1].completedAt !== undefined)
      .sort((a, b) => a[1].completedAt - b[1].completedAt)
    for (const [key] of completedEntries.slice(0, Math.max(0, completedEntries.length - maxCompletedEntries))) {
      entries.delete(key)
    }
  }

  return {
    run(params: UserExecParams): Promise<UserExecResult> {
      if (!params.toolCallId) return execute(params)

      pruneCompletedEntries()
      const key = `${params.sessionId ?? ''}:${params.toolCallId}`
      const existing = entries.get(key)
      if (existing) {
        if (
          existing.command !== params.command ||
          existing.cwd !== params.cwd ||
          existing.retryOf !== params.retryOf ||
          existing.shell !== params.shell ||
          existing.baseCwd !== params.baseCwd ||
          existing.injectBundledNode !== params.injectBundledNode
        ) {
          return Promise.resolve({
            success: false,
            stdout: '',
            stderr: `Tool call ${params.toolCallId} was reused with a different command or working directory, or retry binding`,
            exitCode: null,
          })
        }
        return existing.promise
      }

      const entry: UserExecEntry = {
        command: params.command,
        cwd: params.cwd,
        retryOf: params.retryOf,
        shell: params.shell,
        baseCwd: params.baseCwd,
        injectBundledNode: params.injectBundledNode,
        promise: Promise.resolve().then(() => execute(params)),
      }
      entries.set(key, entry)
      const markCompleted = () => {
        entry.completedAt = now()
        pruneCompletedEntries()
      }
      void entry.promise.then(markCompleted, markCompleted)
      return entry.promise
    },
  }
}

export function createDefaultUserExecRunner() {
  return createUserExecRunner(executeUserExecCommand)
}
