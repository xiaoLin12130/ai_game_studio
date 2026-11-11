/**
 * The readiness probe: what "DSH is ready" actually means in PHASE 01-A.
 *
 * Ready means: the runtime process started, completed the SDK's `initialize` handshake
 * and answered with a server identity, then shut down cleanly. That is deliberately more
 * than "the binary exists" and less than "the model works":
 *
 *   proves      the runtime boots with this profile and home, loads its plugins, speaks
 *               the SDK protocol and reports its identity;
 *   does not    prove the provider route is reachable or funded — that needs a prompt,
 *               which costs model quota and is out of scope for a status probe.
 *
 * No prompt is ever sent here.
 */
import path from 'node:path'
import { classifyProbeError, type DshServerInfo, type DshStatusDetail, type DshStatus } from '../../shared/status'
import type { DshEntry } from './locate'

/** Import the ESM-only SDK from this CommonJS main process.
 *
 * TypeScript rewrites `import()` to `require()` for CommonJS output, which cannot load an
 * ESM package, so the dynamic import is built at runtime and given an absolute file URL.
 */
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>

interface SdkModule {
  HarnessClient: new (options: Record<string, unknown>) => HarnessClientLike
}

interface HarnessClientLike {
  start(): void
  initialize(params: Record<string, unknown>): Promise<{ serverInfo?: DshServerInfo }>
  close(): Promise<void>
  subscribe(): { next(): Promise<unknown>; close(): void; [Symbol.asyncIterator](): AsyncIterator<unknown> }
}

let cachedSdk: SdkModule | null = null

export async function loadSdk(sdkEntry: string): Promise<SdkModule> {
  if (cachedSdk) return cachedSdk
  const { pathToFileURL } = await import('node:url')
  const loaded = (await importEsm(pathToFileURL(sdkEntry).href)) as SdkModule
  if (typeof loaded?.HarnessClient !== 'function') {
    throw new Error('the loaded SDK module does not export HarnessClient')
  }
  cachedSdk = loaded
  return loaded
}

/** Where the SDK module lives, resolved once so the probe never guesses. */
export function sdkEntryPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require.resolve('@deepseek-ai/dsh-sdk-client')
}

export interface ProbeRequest {
  dshHome: string
  profile: string
  provider: string
  model: string
  timeoutMs: number
  cwd: string
  entry: DshEntry
  signal?: AbortSignal
}

export interface ProbeOutcome {
  status: DshStatus
  detail: DshStatusDetail
  serverInfo: DshServerInfo | null
  runtimeExitCode: number | null
  durationMs: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Every line the SDK puts after "exit code: <n>" — the only channel it exposes. */
export function exitCodeFromMessage(message: string | null | undefined): number | null {
  const match = /(?:^|\n)exit code: (-?\d+)(?:\n|$)/.exec(String(message ?? ''))
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(value) ? value : null
}

class ProbeTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeout(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}

/** The child environment, with the Electron host quirk handled. */
export function childEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

export async function runProbe(request: ProbeRequest): Promise<ProbeOutcome> {
  const started = Date.now()
  const finish = (status: DshStatus, detail: DshStatusDetail, serverInfo: DshServerInfo | null, exitCode: number | null): ProbeOutcome => ({
    status,
    detail,
    serverInfo,
    runtimeExitCode: exitCode,
    durationMs: Date.now() - started,
  })

  if (request.entry.problem) {
    return finish('UNAVAILABLE', { code: 'BINARY_MISSING', message: '找不到可用的 DSH 运行时。', raw: request.entry.problem }, null, null)
  }
  if (request.signal?.aborted) {
    return finish('UNKNOWN', { code: 'CANCELLED', message: '检测在开始前被取消。' }, null, null)
  }

  let client: HarnessClientLike | null = null
  let subscription: ReturnType<HarnessClientLike['subscribe']> | null = null
  let subscriptionError: unknown = null
  let serverInfo: DshServerInfo | null = null
  let exitCode: number | null = null

  try {
    const sdk = await loadSdk(sdkEntryPath())
    const options: Record<string, unknown> = {
      dshHome: request.dshHome,
      profile: request.profile,
      initializeTimeoutMs: request.timeoutMs,
      disposeGraceMs: 4000,
      // The SDK launches the runtime with `process.execPath`. Inside Electron that is
      // electron.exe, which starts a GUI app rather than a Node program and never speaks
      // JSON-RPC on stdio — the handshake then times out with no other explanation.
      // ELECTRON_RUN_AS_NODE makes the very same binary behave as Node for this child only.
      env: childEnvironment(),
    }
    if (request.entry.bin) options.dshBin = request.entry.bin

    client = new sdk.HarnessClient(options)
    subscription = client.subscribe()
    const drain = (async () => {
      try {
        for await (const _notification of subscription as AsyncIterable<unknown>) {
          /* the probe only needs the terminal rejection */
        }
      } catch (error) {
        subscriptionError = error
      }
    })()

    client.start()
    const initialized = await withTimeout(
      client.initialize({ cwd: request.cwd, provider: request.provider, model: request.model }),
      request.timeoutMs,
      'dsh initialize',
    )
    serverInfo = initialized?.serverInfo ?? null
    if (!serverInfo) {
      return finish('UNKNOWN', { code: 'INTERNAL_ERROR', message: 'DSH 已响应，但没有返回运行时标识。' }, null, null)
    }

    await withTimeout(client.close(), Math.max(5000, request.timeoutMs), 'dsh close')
    await Promise.race([drain, sleep(4000)])
    exitCode = exitCodeFromMessage((subscriptionError as Error | null)?.message ?? null)
    return finish('READY', { code: 'HANDSHAKE_OK', message: 'DSH 运行时已启动并完成 SDK 握手。' }, serverInfo, exitCode)
  } catch (error) {
    const message = (error as Error)?.message ?? String(error)
    const timedOut = error instanceof ProbeTimeout || /timed out after/i.test(message)
    if (client) {
      try {
        await withTimeout(client.close(), 6000, 'dsh close after failure')
      } catch {
        /* the runtime may already be gone */
      }
    }
    if (request.signal?.aborted) {
      return finish('UNKNOWN', { code: 'CANCELLED', message: '检测被取消。' }, null, null)
    }
    if (timedOut) {
      return finish('TIMEOUT', { code: 'TIMEOUT', message: 'DSH 在限定时间内没有完成握手。', raw: message.split(/\r?\n/)[0] ?? null }, null, null)
    }
    const classified = classifyProbeError(message)
    return finish(classified.status, classified.detail, null, null)
  } finally {
    try {
      subscription?.close()
    } catch {
      /* already closed */
    }
  }
}
