import assert from 'node:assert/strict'
import test from 'node:test'

import { externallyTrusted, httpsAuthority, isTopLevelGetNavigation } from './request-trust.mjs'

const authority = httpsAuthority('127.0.0.1', 3443)
const trusted = new Set([authority])

function request(headers = {}, method = 'GET') {
  return { method, headers: { host: authority, ...headers } }
}

test('accepts direct and same-origin requests for an allowed authority', () => {
  assert.equal(externallyTrusted(request(), trusted), true)
  assert.equal(externallyTrusted(request({ origin: `https://${authority}` }), trusted), true)
})

test('accepts the user-activated top-level HTTPS navigation from Service Portal', () => {
  assert.equal(externallyTrusted(request({
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'sec-fetch-user': '?1',
  }), trusted), true)
})

test('recognizes a top-level refresh without treating it as cross-site authorization', () => {
  const refresh = request({
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  })
  assert.equal(isTopLevelGetNavigation(refresh), true)
  assert.equal(externallyTrusted(refresh, trusted), true)
})

test('rejects other cross-site requests', () => {
  const navigationHeaders = {
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'sec-fetch-user': '?1',
  }
  assert.equal(externallyTrusted(request(navigationHeaders, 'POST'), trusted), false)
  assert.equal(externallyTrusted(request({
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  }), trusted), false)
  assert.equal(externallyTrusted(request({
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  }), trusted), false)
})

test('rejects untrusted authorities and mismatched origins', () => {
  assert.equal(externallyTrusted({ method: 'GET', headers: { host: 'example.test:3443' } }, trusted), false)
  assert.equal(externallyTrusted(request({ origin: 'https://localhost:3443' }), trusted), false)
})
