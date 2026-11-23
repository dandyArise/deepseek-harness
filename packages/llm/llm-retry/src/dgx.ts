import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)
const origin = 'http://127.0.0.1:18089'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function health() {
  try {
    const res = await fetch(origin + '/health', { signal: AbortSignal.timeout(3000), redirect: 'error' })
    const body: unknown = await res.json()
    if (isRecord(body) && res.ok && body.status === 'ok') return 'ready'
    if (isRecord(body) && res.status === 503 && isRecord(body.error)
      && typeof body.error.message === 'string' && /loading model/i.test(body.error.message)) return 'loading'
    throw new Error('Réponse de santé inattendue sur le port 18089')
  } catch (error) {
    if (error instanceof TypeError && error.cause) return 'offline'
    throw error
  }
}

// flock serializes the remote check and launch across desktop processes.
const startServer = `flock --close -w 5 /tmp/dandy-qwen38.lock sh -c '
if pgrep -x llama-server >/dev/null; then echo running; exit 0; fi
set -- /workspace/qwen38-iq4/*00001-of-00004.gguf
[ "$#" = 1 ] && [ -r "$1" ] || exit 2
nohup llama-server -m "$1" --gpu-layers 99 --flash-attn on --ctx-size 65536 --parallel 1 --jinja --alias qwen38-flash --host 127.0.0.1 --port 18089 </dev/null >>/workspace/qwen38-iq4/serveur.log 2>&1 &
'`

async function repair(signal: AbortSignal) {
  const home = process.env.DSH_HOME
  if (!home) throw new Error('DSH_HOME est requis pour la récupération DGX')
  const config: unknown = JSON.parse(await readFile(join(home, 'dgx-recovery.json'), 'utf8'))
  if (!isRecord(config) || typeof config.destination !== 'string' || !/^[\w.-]+@[\w.-]+$/.test(config.destination)
    || typeof config.hostKeyAlias !== 'string' || !/^[\w.-]+$/.test(config.hostKeyAlias)
    || typeof config.identityFile !== 'string' || !config.identityFile
    || typeof config.port !== 'number' || !Number.isInteger(config.port)
    || config.port < 1 || config.port > 65535) throw new Error('Configuration SSH DGX invalide')
  const args = ['-i', config.identityFile, '-p', String(config.port), '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=6', '-o', 'HostKeyAlias=' + config.hostKeyAlias]
  await run('ssh', [...args, config.destination, startServer], { timeout: 15000, signal, windowsHide: true })
  // The existing tunnel may already be forwarding to the newly started server.
  // ExitOnForwardFailure makes an occupied port a harmless failed bind.
  const tunnel = spawn('ssh', [...args, '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
    '-N', '-L', '127.0.0.1:18089:127.0.0.1:18089', config.destination], { detached: true, stdio: 'ignore', windowsHide: true })
  await new Promise<void>((resolve, reject) => { tunnel.once('spawn', resolve); tunnel.once('error', reject) })
  tunnel.unref()
}

export async function waitForDgx(signal: AbortSignal, probe = health, restore = repair, interval = 2000) {
  let repaired = false
  for (;;) {
    signal.throwIfAborted()
    const state = await probe()
    if (state === 'ready') return
    if (state === 'offline' && !repaired) {
      repaired = true
      await restore(signal)
    }
    await sleep(interval, undefined, { signal })
  }
}

let incident: Promise<void> | undefined
export function recoverDgx() {
  return incident ??= waitForDgx(AbortSignal.timeout(240000)).then(async () => {
    const res = await fetch(origin + '/v1/models', { signal: AbortSignal.timeout(4000) })
    const body: unknown = await res.json()
    if (!res.ok || !isRecord(body) || !Array.isArray(body.data)
      || !body.data.some((model: unknown) => isRecord(model) && model.id === 'qwen38-flash')) {
      throw new Error('Le catalogue DGX ne contient pas qwen38-flash')
    }
  }).finally(() => { incident = undefined })
}
