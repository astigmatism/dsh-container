import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const tokenFile = process.env.DSH_WEB_LAUNCH_TOKEN_FILE || '/run/dsh-backend-auth/launch-token'
const profileRoot = process.env.DSH_PROFILE_ROOT || '/data/dsh/profiles/web'
const port = Number(process.env.DSH_WEB_PORT || 3080)
const token = (await readFile(tokenFile, 'utf8')).trim()

if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Harness launch token is invalid')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Harness web port is invalid')

const require = createRequire(`${profileRoot}/package.json`)
const { chromium } = require(`${profileRoot}/node_modules/playwright-core`)
const errors = []
let browser

try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })

  const response = await page.goto(`http://127.0.0.1:${port}/?token=${token}`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  })
  if (!response?.ok()) throw new Error(`Harness browser returned HTTP ${response?.status()}`)

  await page.waitForSelector('[data-composer-input]', { timeout: 15000 })
  await page.waitForSelector('[data-local-speech-button]', { timeout: 15000 })
  const state = await page.evaluate(() => {
    const composer = document.querySelector('[data-composer-card]')
    const input = composer?.querySelector('[data-composer-input], textarea')
    const button = composer?.querySelector('[data-local-speech-button]')
    return {
      composerPresent: composer !== null,
      inputPresent: input !== null,
      buttonCount: document.querySelectorAll('[data-local-speech-button]').length,
      buttonInsideComposer: button !== null,
      buttonLabel: button?.getAttribute('aria-label') ?? null,
      buttonType: button?.getAttribute('type') ?? null,
      moduleLoader: typeof window.__ModuleLoader__,
    }
  })

  if (!state.composerPresent || !state.inputPresent) throw new Error('Harness composer did not render')
  if (state.buttonCount !== 1 || !state.buttonInsideComposer) {
    throw new Error(`expected one dictation control in the composer, found ${state.buttonCount}`)
  }
  if (state.buttonLabel !== 'Dictate with local speech-to-text' || state.buttonType !== 'button') {
    throw new Error(`dictation control contract is invalid: ${JSON.stringify(state)}`)
  }
  if (state.moduleLoader !== 'object') throw new Error('Harness module loader is unavailable')
  if (errors.length > 0) throw new Error(errors.join('\n'))

  console.log('Verified the rendered local dictation control in the deployed Harness client.')
} catch (error) {
  const detail = String(error?.stack ?? error).split(token).join('<redacted>')
  console.error(detail)
  process.exitCode = 1
} finally {
  await browser?.close()
}
