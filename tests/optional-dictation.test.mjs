import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyConfiguration } from '../scripts/verify-dictation-backend.mjs'

test('an explicitly disabled service must return its authenticated disabled contract', () => {
  assert.equal(verifyConfiguration({enabled: false}, '', ''), false)
  assert.throws(() => verifyConfiguration({enabled: true}, '', 'model'), /disabled/)
  assert.throws(() => verifyConfiguration(null, '', ''), /disabled/)
})

test('a configured speech service cannot pass as disabled or with mismatched metadata', () => {
  assert.throws(() => verifyConfiguration({enabled: false}, 'http://voice/v1', 'model'), /enabled/)
  assert.throws(() => verifyConfiguration({enabled: true, model: 'wrong', maxRecordSeconds: 30}, 'http://voice/v1', 'model'), /wrong/)
  assert.equal(verifyConfiguration({enabled: true, model: 'model', maxRecordSeconds: 30}, 'http://voice/v1', 'model'), true)
})
