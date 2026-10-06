import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const namespace = 'ui-settings-general';
const field = 'welcomeNoticeVersion';

/** Dismiss the notice only in this verification browser, never in user settings. */
export async function installVerificationOnboarding(page, base) {
  let acknowledged;
  const virtualView = view => ({ ...view,
    value: { ...view.value, [field]: acknowledged },
    user: { ...view.user, [field]: acknowledged },
  });
  await page.route('**/api/settings/describe', async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (acknowledged && body.result?.ok) {
      body.result.value.namespaces = body.result.value.namespaces.map(view =>
        view.ns === namespace ? virtualView(view) : view);
    }
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/settings/mutate', async route => {
    const request = route.request().postDataJSON();
    const args = request?.payload?.args;
    const op = args?.ops?.[0];
    if (args?.ns !== namespace || args.ops?.length !== 1 || op?.op !== 'set'
        || op.path?.length !== 1 || op.path[0] !== field || typeof op.value !== 'string') {
      await route.continue();
      return;
    }
    // Read the authenticated, redacted descriptor. Acknowledge only in the
    // browser's transport view; no settings mutation reaches the Host.
    const response = await page.request.post(`${base}/api/settings/describe`, { data: {
      type: 'client-request', rpcId: randomUUID(), method: 'settings/describe', payload: { args: {} },
    } });
    assert.equal(response.status(), 200, 'welcome settings descriptor HTTP status');
    const body = await response.json();
    assert.equal(body.result?.ok, true, 'welcome settings descriptor is available');
    const view = body.result.value.namespaces.find(row => row.ns === namespace);
    assert.ok(view, 'welcome settings namespace is registered');
    acknowledged = op.value;
    await route.fulfill({ json: { type: 'server-response', rpcId: request.rpcId,
      result: { ok: true, value: { ...virtualView(view), revision: view.revision + 1 } },
    } });
  });
  // Notices mount asynchronously and may appear after an explicit dismissal
  // check, while Playwright is already trying to click the underlying UI.
  // Handle them during actionability checks, within this browser only.
  for (const name of ['Preview Notice', 'Add an API key to get started']) {
    await page.addLocatorHandler(page.getByRole('dialog', { name, exact: true }),
      () => dismissVerificationOnboarding(page));
  }
}

export async function dismissVerificationOnboarding(page) {
  const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true });
  if (await notice.isVisible()) {
    await notice.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 5000 });
    await notice.waitFor({ state: 'hidden', timeout: 5000 });
  }
  const credentials = page.getByRole('dialog', { name: 'Add an API key to get started', exact: true });
  if (await credentials.isVisible()) {
    await credentials.getByRole('button', { name: 'Configure later', exact: true }).click({ timeout: 5000 });
    await credentials.waitFor({ state: 'hidden', timeout: 5000 });
  }
}
