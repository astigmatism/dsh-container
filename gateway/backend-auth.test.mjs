import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  appendBackendCookie,
  backendSessionCookie,
  createBackendAuthenticator,
  readLaunchToken,
} from './backend-auth.mjs'

const token = 'A'.repeat(43)
const cookie = `dsh-auth-${'B'.repeat(43)}=v1.${'C'.repeat(8)}.${'D'.repeat(43)}`

test('validates the private launch-token file and backend cookie shape', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-backend-auth.'))
  try {
    const path = join(directory, 'token')
    writeFileSync(path, token)
    assert.equal(readLaunchToken(path), token)
    assert.equal(backendSessionCookie([`${cookie}; Path=/; HttpOnly`]), cookie)
    assert.throws(() => backendSessionCookie(['unrelated=value; Path=/']), /valid session cookie/)
    writeFileSync(path, 'short')
    assert.throws(() => readLaunchToken(path), /launch-token file is invalid/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
});

test('adds backend authentication without discarding unrelated browser cookies', () => {
  assert.equal(appendBackendCookie(null, cookie), cookie)
  assert.equal(appendBackendCookie('theme=dark', cookie), `theme=dark; ${cookie}`)
});

test('exchanges once per launch token and refreshes after a Harness restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-backend-auth.'))
  const path = join(directory, 'token')
  writeFileSync(path, token)
  let exchanges = 0
  const server = createServer((request, response) => {
    exchanges += 1
    assert.equal(request.headers.host, `127.0.0.1:${server.address().port}`)
    assert.equal(new URL(request.url, 'http://local').searchParams.get('token'), readLaunchToken(path))
    response.writeHead(303, { location: '/', 'set-cookie': `${cookie}; Path=/; HttpOnly` })
    response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const backend = new URL(`http://127.0.0.1:${server.address().port}`)
    const authenticator = createBackendAuthenticator(backend, path)
    assert.deepEqual(await Promise.all([authenticator.cookie(), authenticator.cookie()]), [cookie, cookie])
    assert.equal(exchanges, 1)
    writeFileSync(path, 'E'.repeat(43))
    assert.equal(await authenticator.cookie(), cookie)
    assert.equal(exchanges, 2)
  } finally {
    await new Promise(resolve => server.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  }
});
