/** Real native terminal tab: UI rendering, streamed output, replay and cleanup. */
import assert from 'node:assert/strict';
export async function verifyNativeTerminal(page, sessionId, otherSessionId) {
  await page.evaluate(() => window.__previewTestContext.get('sidebarRight').openTab('terminal'));
  await page.locator('.xterm:visible').first().waitFor();
  await page.waitForFunction(() => [...window.__previewTestContext.get('webTerminals').views.values()]
    .some(view => view.state.getSnapshot().phase === 'connected'));
  const id = await page.evaluate(() => {
    const view = [...window.__previewTestContext.get('webTerminals').views.values()]
      .find(view => view.state.getSnapshot().phase === 'connected');
    const output = window.__nativeTerminalTest = { view, text: '', revision: -1 };
    const record = () => {
      const render = view.state.getSnapshot().render;
      if (render && render.revision !== output.revision) {
        output.revision = render.revision;
        output.text += render.frame.type === 'snapshot' ? render.frame.screen : render.frame.data;
      }
    };
    output.unsubscribe = view.state.subscribe(record);
    record();
    return view.id;
  });
  const send = data => page.evaluate(data => window.__nativeTerminalTest.view.write(data), data);
  const contains = text => page.waitForFunction(text => window.__nativeTerminalTest.text.includes(text), text);
  try {
    await send('printf "NATIVE_%s\\n" FIRST; sleep 2; printf "NATIVE_%s\\n" LAST\r');
    await contains('NATIVE_FIRST');
    assert.equal(await page.evaluate(() => window.__nativeTerminalTest.text.includes('NATIVE_LAST')), false);
    await contains('NATIVE_LAST');
    assert.deepEqual(await page.evaluate(async id => {
      const result = await window.__previewTestContext.remote.terminal.list(id);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    }, otherSessionId), [], 'terminal session isolation');
    await page.evaluate(() => {
      window.__nativeTerminalTest.text = '';
      window.__nativeTerminalTest.view.connect();
    });
    await contains('NATIVE_FIRST');
    await contains('NATIVE_LAST');
    await send('printf "NATIVE_%s\\n" WAITING; sleep 30; printf "NATIVE_%s\\n" BAD\r');
    await contains('NATIVE_WAITING');
    await send('\x03');
    await send('printf "NATIVE_%s\\n" RECOVERED\r');
    await contains('NATIVE_RECOVERED');
    assert.equal(await page.evaluate(() => window.__nativeTerminalTest.text.includes('NATIVE_BAD')), false);
    console.log('Verified native terminal rendering, incremental output, session isolation, reconnect, input and Ctrl-C.');
  } finally {
    await page.evaluate(async () => {
      window.__nativeTerminalTest.unsubscribe();
      await window.__nativeTerminalTest.view.close();
    });
  }
  const remaining = await page.evaluate(async session => {
    const result = await window.__previewTestContext.remote.terminal.list(session);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }, sessionId);
  assert.equal(remaining.some(row => row.id === id), false, 'terminal process cleanup');
}
