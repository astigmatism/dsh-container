import assert from 'node:assert/strict'
import test from 'node:test'

import { authorityTrusted, externallyTrusted, httpsAuthority, isTopLevelGetNavigation } from './request-trust.mjs'

const authority = httpsAuthority('127.0.0.1', 3443)
const trusted = new Set([authority])

function request(headers = {}, method = 'GET') {
  return { method, headers: { host: authority, ...headers } }
}

test('accepts direct and same-origin requests for an allowed authority', () => {
  assert.equal(externallyTrusted(request(), trusted), true)
  assert.equal(externallyTrusted(request({ origin: `https://${authority}` }), trusted), true)
  assert.equal(externallyTrusted(request({ origin: `http://${authority}` }), trusted, 'http:'), true)
  assert.equal(externallyTrusted(request({ origin: `https://${authority}` }), trusted, 'http:'), false)
})

test('checks the approved authority independently for a login submission', () => {
  const login = request({
    'sec-fetch-site': 'cross-site',
    origin: 'null',
  }, 'POST')
  assert.equal(authorityTrusted(login, trusted), true)
  assert.equal(authorityTrusted({ method: 'POST', headers: { host: 'example.test:3443' } }, trusted), false)
})

test('accepts top-level navigation and its browser redirect from another site', () => {
  assert.equal(externallyTrusted(request({
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'sec-fetch-user': '?1',
  }), trusted), true)
  assert.equal(externallyTrusted(request({
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
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
})

test('rejects untrusted authorities and mismatched origins', () => {
  assert.equal(externallyTrusted({ method: 'GET', headers: { host: 'example.test:3443' } }, trusted), false)
  assert.equal(externallyTrusted(request({ origin: 'https://localhost:3443' }), trusted), false)
})
