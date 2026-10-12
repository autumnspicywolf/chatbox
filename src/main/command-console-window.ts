import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getLogger } from './util'

const log = getLogger('command-console-window')

/**
 * 让 `run_command` 的执行过程可见。
 *
 * 执行本身不能改：stdout/stderr 必须走管道被捕获（落盘 + 回填给模型/用户），所以子进程
 * PowerShell 不可能拥有自己的控制台，Node 侧也无法要求 CREATE_NEW_CONSOLE。
 * 因此这里不改执行路径，而是**另开一个只读窗口**：窗口里的 PowerShell 实时 tail 上面那份
 * 落盘捕获文件（命令 + 输出都看得见），命令跑完时 close() 写一个标记文件，窗口自行退出。
 *
 * 跑完之后窗口不会立刻消失：先打一行「命令结束（退出码 · 耗时）」横幅，再停留一段时间，
 * 免得短命令一闪而过什么都读不到（keypress 可提前关窗，见下面的停留设置）。
 * 窗口是那个 PowerShell 进程的，脚本一 return 窗口就没了，所以「停留」只能是这个进程在等。
 *
 * 环境变量：
 * - CHATBOX_COMMAND_WINDOW=0            完全不打开镜像窗口（测试环境自动关闭）
 * - CHATBOX_COMMAND_WINDOW_LINGER=0     跑完立刻关窗（旧行为）
 * - CHATBOX_COMMAND_WINDOW_LINGER=hold  一直留着，按任意键才关
 * - CHATBOX_COMMAND_WINDOW_LINGER=<秒>  停留这么久（默认 60，上限 3600）
 */

/** 窗口至少保留这么久，避免短命令一闪而过完全看不见。 */
const MIN_VISIBLE_MS = 2_000
/** 命令跑完后窗口默认再停留这么久，让短命令的输出读得完。 */
const DEFAULT_LINGER_SECONDS = 60
const MAX_LINGER_SECONDS = 3_600
/** 兜底：命令异常久时窗口也不会永久挂着。 */
const VIEWER_MAX_MINUTES = 60
const WINDOW_TITLE_MAX = 60
const COMMAND_ECHO_MAX = 400

interface ViewerLinger {
  seconds: number
  /** true = 一直留着，按任意键才关（此时 seconds 无意义）。 */
  hold: boolean
}

export interface CommandConsoleWindow {
  /**
   * 告诉窗口「命令结束了」。keepCaptureFile=true 时窗口不动那份捕获文件
   * （输出被截断的命令，捕获文件本来就要留给用户打开），否则窗口顺手删掉它。
   * exitCode / durationMs 只用于窗口最后那行「命令结束」横幅。
   */
  close(options?: { keepCaptureFile?: boolean; exitCode?: number | null; durationMs?: number }): void
}

function isDisabledValue(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no'
}

export function isCommandConsoleWindowEnabled(): boolean {
  if (process.platform !== 'win32') return false
  if (process.env.VITEST) return false
  return !isDisabledValue(process.env.CHATBOX_COMMAND_WINDOW)
}

function resolveViewerLinger(value: string | undefined): ViewerLinger {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return { seconds: DEFAULT_LINGER_SECONDS, hold: false }
  if (normalized === 'hold' || normalized === 'wait' || normalized === 'forever') {
    return { seconds: 0, hold: true }
  }
  if (isDisabledValue(normalized)) return { seconds: 0, hold: false }
  const seconds = Number.parseFloat(normalized)
  if (!Number.isFinite(seconds) || seconds <= 0) return { seconds: DEFAULT_LINGER_SECONDS, hold: false }
  return { seconds: Math.min(seconds, MAX_LINGER_SECONDS), hold: false }
}

function quotePs(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function collapse(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

function buildViewerScript(
  scriptPath: string,
  capturePath: string,
  donePath: string,
  command: string,
  linger: ViewerLinger
): string {
  const title = collapse(`Chatbox · ${command}`, WINDOW_TITLE_MAX)
  const echo = collapse(command, COMMAND_ECHO_MAX)
  const lingerLines = linger.hold
    ? [
        "[Console]::Out.Write('窗口保持打开：按任意键关闭' + [char]13 + [char]10)",
        "try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep -Seconds 3600 }",
      ]
    : linger.seconds > 0
      ? [
          `[Console]::Out.Write('窗口将在 ${linger.seconds} 秒后自动关闭，按任意键立即关闭…' + [char]13 + [char]10)`,
          '$chatboxLingerWatch = [System.Diagnostics.Stopwatch]::StartNew()',
          `while ($chatboxLingerWatch.Elapsed.TotalSeconds -lt ${linger.seconds}) {`,
          '  $chatboxPressed = $false',
          '  try { $chatboxPressed = [Console]::KeyAvailable } catch { $chatboxPressed = $false }',
          '  if ($chatboxPressed) { try { $null = [Console]::ReadKey($true) } catch { }; break }',
          '  Start-Sleep -Milliseconds 200',
          '}',
        ]
      : []
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `try { $Host.UI.RawUI.WindowTitle = ${quotePs(title)} } catch { }`,
    `[Console]::Out.Write(${quotePs(`Chatbox ▸ ${echo}`)} + [char]13 + [char]10 + [char]13 + [char]10)`,
    `$chatboxCapture = ${quotePs(capturePath)}`,
    `$chatboxDone = ${quotePs(donePath)}`,
    '$chatboxWatch = [System.Diagnostics.Stopwatch]::StartNew()',
    '$chatboxStream = $null',
    'for ($i = 0; $i -lt 30 -and $null -eq $chatboxStream; $i++) {',
    '  try { $chatboxStream = [System.IO.File]::Open($chatboxCapture, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite) } catch { Start-Sleep -Milliseconds 100 }',
    '}',
    'if ($null -ne $chatboxStream) {',
    '  $chatboxReader = New-Object System.IO.StreamReader($chatboxStream, (New-Object System.Text.UTF8Encoding($false)))',
    '  while (-not (Test-Path -LiteralPath $chatboxDone) -and $chatboxWatch.Elapsed.TotalMinutes -lt ' +
      VIEWER_MAX_MINUTES +
      ') {',
    '    $chatboxLine = $chatboxReader.ReadLine()',
    '    if ($null -ne $chatboxLine) {',
    "      $chatboxLine = [regex]::Replace($chatboxLine, ([char]27 + '\\[[0-9;?]*[a-zA-Z]'), '')",
    '      [Console]::Out.Write($chatboxLine + [char]13 + [char]10)',
    '    } else { Start-Sleep -Milliseconds 120 }',
    '  }',
    '  $chatboxRest = $chatboxReader.ReadToEnd()',
    '  if ($chatboxRest) {',
    "    [Console]::Out.Write([regex]::Replace($chatboxRest, ([char]27 + '\\[[0-9;?]*[a-zA-Z]'), ''))",
    '  }',
    '  $chatboxReader.Dispose()',
    '}',
    `while ($chatboxWatch.ElapsedMilliseconds -lt ${MIN_VISIBLE_MS}) { Start-Sleep -Milliseconds 100 }`,
    // close() 写进来的是 JSON；空文件/半截文件时重试几轮再退化到纯文本匹配。
    '$chatboxAction = ""',
    '$chatboxPayload = $null',
    'for ($i = 0; $i -lt 10 -and $null -eq $chatboxPayload; $i++) {',
    '  try { $chatboxPayload = (Get-Content -LiteralPath $chatboxDone -Raw) | ConvertFrom-Json } catch { }',
    '  if ($null -eq $chatboxPayload) { Start-Sleep -Milliseconds 50 }',
    '}',
    'if ($null -ne $chatboxPayload) { $chatboxAction = [string]$chatboxPayload.action }',
    'else { try { $chatboxAction = (Get-Content -LiteralPath $chatboxDone -Raw) } catch { } }',
    '$chatboxExitText = "—"',
    '$chatboxSecondsText = "—"',
    'if ($null -ne $chatboxPayload) {',
    '  if ($null -ne $chatboxPayload.exitCode) { $chatboxExitText = [string]$chatboxPayload.exitCode }',
    '  if ($null -ne $chatboxPayload.durationMs) { $chatboxSecondsText = [string]([math]::Round([double]$chatboxPayload.durationMs / 1000, 1)) }',
    '}',
    `[Console]::Out.Write([char]13 + [char]10 + '── 命令结束（退出码 ' + $chatboxExitText + ' · ' + $chatboxSecondsText + 's）──' + [char]13 + [char]10)`,
    ...lingerLines,
    'Remove-Item -LiteralPath $chatboxDone -Force',
    "if ($chatboxAction -notmatch 'keep') { Remove-Item -LiteralPath $chatboxCapture -Force }",
    // 脚本最后删掉自己（-File 启动时整份脚本已在内存里，末尾删文件是安全的）。
    `Remove-Item -LiteralPath ${quotePs(scriptPath)} -Force`,
  ].join('\n')
}

/**
 * 打开（或返回 null 表示本平台/本次不打开）命令镜像窗口。
 * 任何失败都只是没有窗口，不影响命令本身。
 */
export function openCommandConsoleWindow(options: {
  command: string
  capturePath: string
  powershellPath?: string
}): CommandConsoleWindow | null {
  if (!isCommandConsoleWindowEnabled()) return null
  const powershellPath = options.powershellPath?.trim()
  if (!powershellPath) return null

  const donePath = `${options.capturePath}.done.txt`
  // 脚本必须先落盘、再用 -File 启动：整份脚本 base64 后约 8 KB，加上命令原文会顶破
  // cmd.exe 的 8191 字符命令行上限——超长时 start 只回一句「命令行太长」，窗口根本不出现，
  // 而那条 stderr 在 stdio:'ignore' 下没人看得见（表现为「点了完全访问却没有窗口」）。
  const scriptPath = `${options.capturePath}.viewer.ps1`
  const linger = resolveViewerLinger(process.env.CHATBOX_COMMAND_WINDOW_LINGER)

  const removeScript = () => {
    try {
      rmSync(scriptPath, { force: true })
    } catch {
      // 删不掉也没关系：脚本自己收尾删自己，剩下的交给 7 天清理器。
    }
  }

  try {
    mkdirSync(dirname(scriptPath), { recursive: true })
    // 必须带 BOM：Windows PowerShell 5.1 对无 BOM 文件按 ANSI 解析，中文命令原文会变乱码。
    writeFileSync(
      scriptPath,
      `\uFEFF${buildViewerScript(scriptPath, options.capturePath, donePath, options.command, linger)}`,
      'utf8'
    )
  } catch (error) {
    log.warn('failed to write command console window script', error)
    return null
  }

  try {
    // windowsHide 只管住这个 cmd.exe（免得先闪一个空窗口），真正的窗口由 start 新建。
    const launcher = spawn(
      'cmd.exe',
      [
        '/d',
        '/s',
        '/c',
        'start',
        '',
        powershellPath,
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
      ],
      { windowsHide: true, stdio: 'ignore', detached: false }
    )
    launcher.on('error', (error) => {
      log.warn('failed to open command console window', error)
      removeScript()
    })
    launcher.unref()
  } catch (error) {
    log.warn('failed to open command console window', error)
    removeScript()
    return null
  }

  let closed = false
  return {
    close(closeOptions) {
      if (closed) return
      closed = true
      try {
        // 窗口用 ConvertFrom-Json 读这个文件：action 决定要不要删捕获文件，
        // exitCode/durationMs 只用来拼最后那行「命令结束」横幅。
        // JSON.stringify 会丢掉 undefined 的键，窗口那边据此显示「—」。
        writeFileSync(
          donePath,
          JSON.stringify({
            action: closeOptions?.keepCaptureFile ? 'keep' : 'trash',
            exitCode: closeOptions?.exitCode,
            durationMs: closeOptions?.durationMs,
          }),
          'utf8'
        )
      } catch (error) {
        log.warn('failed to signal command console window', error)
      }
    },
  }
}
