import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readRequestBody } from '../src/http-utils.js';

test('unlimited request bodies can exceed the former 25 MiB cap', async () => {
  const oneMiB = Buffer.alloc(1024 * 1024, 'a');
  const request = Readable.from(Array.from({ length: 26 }, () => oneMiB));

  const body = await readRequestBody(request, 0);

  assert.equal(body.length, 26 * 1024 * 1024);
});

test('positive request body limits still reject oversized bodies', async () => {
  const request = Readable.from([Buffer.alloc(600), Buffer.alloc(500)]);

  await assert.rejects(
    readRequestBody(request, 1024),
    (error) => error.statusCode === 413 && /exceeds 1024 bytes/.test(error.message)
  );
});
