import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SESSION_COOKIE_NAME,
  createCredentialRecord,
  createSessionAuthenticator,
  credentialsValid,
  deploymentCredentials,
  sourceManagedCredentials,
  withoutSessionCookie,
} from './session-auth.mjs'

const auth = {
  username: 'harness',
  salt: '00112233445566778899aabbccddeeff',
  iterations: 1,
  hash: '81dcdd68051c0898288842bbe2774776d2f146fcb139e6cc853ed417fa28a11e',
}

test('validates the stored PBKDF2 identity', () => {
  assert.equal(credentialsValid(auth, 'harness', 'correct horse'), true)
  assert.equal(credentialsValid(auth, 'harness', 'wrong'), false)
  assert.equal(credentialsValid(auth, 'someone-else', 'correct horse'), false)
})

test('converges an existing identity to the deployment-local credentials', () => {
  const replacement = sourceManagedCredentials(auth, 'test-operator', 'test-only-password', {
    salt: 'ffeeddccbbaa99887766554433221100',
    iterations: 1,
  })
  assert.equal(replacement.changed, true)
  assert.equal(credentialsValid(replacement.auth, 'test-operator', 'test-only-password'), true)

  const unchanged = sourceManagedCredentials(
    replacement.auth,
    'test-operator',
    'test-only-password',
  )
  assert.equal(unchanged.changed, false)
  assert.equal(unchanged.auth, replacement.auth)

  const direct = createCredentialRecord('test-operator', 'test-only-password', {
    salt: '00112233445566778899aabbccddeeff',
    iterations: 1,
  })
  assert.equal(credentialsValid(direct, 'test-operator', 'test-only-password'), true)
})

test('accepts Basic Auth and issued browser sessions', () => {
  let currentTime = 1000
  const sessions = createSessionAuthenticator(auth, { now: () => currentTime, ttlMs: 5000 })
  const basic = Buffer.from('harness:correct horse').toString('base64')
  assert.equal(sessions.acceptsRequest({ headers: { authorization: `Basic ${basic}` } }), true)

  const token = sessions.issue()
  assert.equal(sessions.acceptsRequest({ headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } }), true)
  assert.match(sessions.setCookieHeader(token), /HttpOnly; Secure; SameSite=Lax/)
  assert.match(sessions.setCookieHeader(token, { secure: false }), /HttpOnly; SameSite=Lax/)
  assert.doesNotMatch(sessions.setCookieHeader(token, { secure: false }), /; Secure/)
  currentTime = 6000
  assert.equal(sessions.acceptsRequest({ headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } }), false)
})

test('removes only the gateway session cookie before proxying', () => {
  assert.equal(withoutSessionCookie(`${SESSION_COOKIE_NAME}=secret; theme=dark`), 'theme=dark')
  assert.equal(withoutSessionCookie(`theme=dark; ${SESSION_COOKIE_NAME}=secret; layout=wide`), 'theme=dark; layout=wide')
  assert.equal(withoutSessionCookie(`${SESSION_COOKIE_NAME}=secret`), null)
})


test('gateway requires explicit private credentials and accepts eight characters', () => {
  assert.throws(() => deploymentCredentials({}), /Configure a gateway username/)
  assert.throws(() => deploymentCredentials({ HARNESS_AUTH_USERNAME: 'test', HARNESS_AUTH_PASSWORD: 'short' }), /at least 8/)
  assert.throws(() => deploymentCredentials({ HARNESS_AUTH_USERNAME: 'bad:name', HARNESS_AUTH_PASSWORD: 'testpass' }), /Configure/)
  assert.deepEqual(deploymentCredentials({ HARNESS_AUTH_USERNAME: 'test', HARNESS_AUTH_PASSWORD: 'testpass' }), { username: 'test', password: 'testpass' })
})
