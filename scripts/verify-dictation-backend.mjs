import { readFile, stat } from 'node:fs/promises'
import { get } from 'node:https'

const secretFile = process.env.STT_API_KEY_FILE || '/run/secrets/stt_api_key'
const sttBase = (process.env.STT_BASE_URL || '').replace(/\/+$/, '')
const model = process.env.STT_MODEL || ''
const gatewayPort = Number(process.env.HARNESS_HTTPS_PORT || 3443)
const publicPort = Number(process.env.HARNESS_PUBLIC_HTTPS_PORT || gatewayPort)

if (sttBase === '') throw new Error('STT_BASE_URL is empty')
if (model === '') throw new Error('STT_MODEL is empty')
if ((await stat(secretFile)).size < 1) throw new Error('STT API key is empty')

const healthUrl = `${sttBase.replace(/\/v1$/, '')}/health`
const health = await fetch(healthUrl, { signal: AbortSignal.timeout(10000) })
if (!health.ok) throw new Error(`STT health returned HTTP ${health.status}`)

const ca = await readFile('/data/gateway/tls/ca.crt')
const authorization = `Basic ${Buffer.from(`${process.env.HARNESS_AUTH_USERNAME}:${process.env.HARNESS_AUTH_PASSWORD}`).toString('base64')}`
const config = await new Promise((resolve, reject) => {
  const request = get({
    hostname: '127.0.0.1',
    port: gatewayPort,
    path: '/local-stt/config',
    ca,
    headers: {
      authorization,
      host: `127.0.0.1:${publicPort}`,
    },
  }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      if (response.statusCode !== 200) {
        reject(new Error(`dictation configuration returned HTTP ${response.statusCode}`))
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('dictation configuration returned invalid JSON'))
      }
    })
  })
  request.setTimeout(10000, () => request.destroy(new Error('dictation configuration timed out')))
  request.on('error', reject)
})

if (config?.enabled !== true) throw new Error(`dictation is disabled: ${config?.reason || 'no reason provided'}`)
if (config?.model !== model) throw new Error('dictation configuration exposes the wrong STT model')
if (!Number.isFinite(Number(config?.maxRecordSeconds)) || Number(config.maxRecordSeconds) < 1) {
  throw new Error('dictation configuration exposes an invalid recording limit')
}

console.log('Verified authenticated dictation configuration and live STT backend health.')
