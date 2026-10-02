import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { destination, publicAddress, startBrowserProxy } from '../plugin/dsh-ego-adapter/network.mjs';
import { wrapTool, currentSpace, conversationSpace, browserEnvironment, scopeSpaces } from '../plugin/dsh-ego-adapter/integration.mjs';

test('network policy refuses private addresses and mixed DNS, and pins the checked address', async () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '192.168.1.5', '172.16.1.2', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', '::ffff:127.0.0.1', '2002:7f00:1::']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  await assert.rejects(destination('fixture.invalid', false, async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }]));
  assert.equal(await destination('fixture.invalid', false, async () => [{ address: '8.8.8.8' }]), '8.8.8.8');
  assert.equal(await destination('192.168.1.5', true), '192.168.1.5');
});
test('actual policy proxy rejects private requests, permits opted-in destinations and closes connections', async t => {
  const site = createServer((req, res) => res.end('PRIVATE_FIXTURE'));
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => site.close(resolve)));
  for (const allowPrivate of [false, true]) {
    const proxy = await startBrowserProxy({ allowPrivate });
    try {
      const response = await new Promise((resolve, reject) => {
        const req = request(proxy.url, { path: `http://127.0.0.1:${site.address().port}/`, agent: false }, res => {
          let data = ''; res.on('data', value => data += value); res.on('end', () => resolve({ status: res.statusCode, data }));
        }); req.on('error', reject); req.end();
      });
      assert.equal(response.status, allowPrivate ? 200 : 403);
      if (allowPrivate) assert.equal(response.data, 'PRIVATE_FIXTURE');
    } finally { await proxy.close(); }
  }
});
test('tool defaults, explicit spaces and screenshot pixels stay in their calling conversation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ego-adapter-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(home, { recursive: true, force: true }); });
  const homeBefore = process.env.HOME;
  assert.ok(browserEnvironment().HOME.startsWith(home)); assert.equal(process.env.HOME, homeBefore);
  const tool = { name: 'ego_js', description: '', output: {}, execute: async args => { const before = currentSpace(); await delay(5); return { ok: true, before, after: currentSpace(), args }; } };
  const wrapped = wrapTool({}, tool);
  const execution = id => ({ agent: { session: { id } }, callId: id, signal: new AbortController().signal });
  const values = await Promise.all(['a', 'b'].map(id => wrapped.execute({}, execution(id))));
  for (const [i, value] of values.entries()) { assert.equal(value.before, conversationSpace(['a','b'][i])); assert.equal(value.after, value.before); }
  const explicit = await wrapped.execute({ space: conversationSpace('b') }, execution('a'));
  assert.ok(explicit.args.space.startsWith(conversationSpace('a') + '-'));
  for (const name of ['ego_login_import', 'ego_cli', 'ego_script']) assert.equal(wrapTool({}, { name }), null);
  await mkdir(join(home, 'ego-browser/screenshots'), { recursive: true });
  const image = { kind: 'fixture-image' };
  const shot = wrapTool({ attachments: { saveImage: async args => { assert.equal(args.data.toString(), 'PIXELS'); return image; } } }, {
    name: 'ego_screenshot', description: '', output: { render: (args, value) => [{ type: 'text', text: value.path }] },
    execute: async args => { await writeFile(args.path, 'PIXELS'); return { ok: true, path: args.path }; },
  });
  const value = await shot.execute({}, execution('a'));
  assert.deepEqual(shot.output.render({}, value)[1], { type: 'image', attachment: image });
  await mkdir(browserEnvironment().EGO_LINUX_STATE_DIR, { recursive: true });
  await writeFile(join(browserEnvironment().EGO_LINUX_STATE_DIR, 'task-spaces.json'), JSON.stringify({ spaces: [{ name: conversationSpace('a'), targetIds: ['one'] }, { name: conversationSpace('b'), targetIds: ['two'] }] }));
  assert.deepEqual((await scopeSpaces({ url: '/api/ego/spaces?sessionId=a' }, { spaces: [{ targetId: 'one' }, { targetId: 'two' }] })).spaces, [{ targetId: 'one' }]);
});
