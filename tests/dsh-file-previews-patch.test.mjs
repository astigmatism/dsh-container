import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { MARKER, patchSidebarSource, patchDeliverablesSource } from '../scripts/patch-dsh-file-previews.mjs';

const fixture = await readFile(new URL('./fixtures/sidebar-preview-client.js', import.meta.url), 'utf8');
const patched = patchSidebarSource(fixture);

function adapter() {
  let cwd;
  let reference = 'referenced-session';
  let params;
  let navigation;
  let record;
  const jsx = (type, props, key) => ({ type, props, key });
  const context = vm.createContext({
    react: { useMemo: f => f(), useEffect: () => {}, createElement: (type, props, ...children) => jsx(type, { ...props, children }) },
    react_jsx_runtime: { jsx, jsxs: jsx },
    useRecordVersion: () => {},
    useSessionCwd: (_ctx, id) => { assert.equal(id, reference); return cwd; },
    EDITOR_KIND: 'editor',
    sidebar_module_css_default: {},
    RenderBoundary: 'boundary', OrphanedTab: 'orphan', t: key => key,
  });
  vm.runInContext(patched, context);
  const records = { ensure: input => { record = input; return { tab: input.params, expanded: [], revealed: [] }; } };
  return {
    render(path, root, overrides, id = 'referenced-session') {
      cwd = root; reference = id; params = path === undefined ? undefined : { path, line: 7 }; navigation = overrides;
      return context.NativeTabBody({
        ctx: {}, store: {}, service: { getTab: () => ({ component: 'editor' }) }, records,
        descriptorId: 'editor', sessionId: 'active-unrelated-session',
        sessionIdOf: () => reference, paramsOf: () => params,
        useTabInfo: () => ({ tab: { id: 'restored-tab', kind: 'editor', title: 'file', navigation: { params: navigation } } }),
      });
    },
    get record() { return record; },
  };
}

test('the actual native adapter resolves relative resource paths in the referenced session', () => {
  const a = adapter();
  for (const file of ['out/option-a-pills.png', './hello world #?.txt', 'preview.html', 'report.pdf', 'archive.zip']) {
    a.render(file, '/work/project');
    assert.equal(a.record.params.path, `/work/project/${file}`);
    assert.equal(a.record.params.line, 7);
    assert.equal(a.record.scope.sessionId, 'referenced-session');
  }
});

test('restored tabs wait for their cwd, then rerender using the correct session', () => {
  const a = adapter();
  const waiting = a.render('out/image.png', undefined);
  assert.equal(waiting.props['data-dsh-preview-awaiting-workspace'], true);
  assert.equal(a.record.params, undefined);
  a.render('out/image.png', '/workspace/one');
  assert.equal(a.record.params.path, '/workspace/one/out/image.png');
  a.render('out/image.png', '/workspace/two', undefined, 'second-session');
  assert.equal(a.record.params.path, '/workspace/two/out/image.png');
});

test('the installed resource-address codec preserves percent signs, spaces, fragments and unicode', () => {
  const context = vm.createContext({});
  vm.runInContext(patched, context);
  const path = 'out/image #?% ü %2F.png';
  const url = context.sessionFileAddress('session-one', path);
  assert.match(url, /%252F/);
  const parsed = context.parseFileAddress(url);
  assert.equal(parsed.path, path);
  assert.equal(parsed.sessionId, 'session-one');
  const a = adapter();
  a.render(parsed.path, '/work/project');
  assert.equal(a.record.params.path, `/work/project/${path}`);
});

test('navigation overrides resolve too; absolute POSIX, Windows and UNC paths stay intact', () => {
  const a = adapter();
  a.render('old.png', '/workspace', { path: 'new image.png', line: 12 });
  assert.equal(a.record.params.path, '/workspace/new image.png');
  assert.equal(a.record.params.line, 12);
  for (const path of ['/outside/x.png', 'C:\\work\\x.png', '\\\\server\\share\\x.png']) {
    a.render(path, undefined);
    assert.equal(a.record.params.path, path);
  }
  a.render('out\\x.png', 'C:\\work');
  assert.equal(a.record.params.path, 'C:\\work\\out\\x.png');
  a.render('../outside.png', '/workspace');
  assert.equal(a.record.params.path, '/workspace/../outside.png', 'containment remains the server responsibility');
});

test('patch is idempotent and refuses changed or repeated upstream anchors', () => {
  assert.equal(patchSidebarSource(patched), patched);
  assert.ok(patched.includes(MARKER));
  assert.throws(() => patchSidebarSource(fixture.replace('function NativeTabBody(props)', 'function Renamed(props)')), /expected one/);
  assert.throws(() => patchSidebarSource(fixture + '\n\t\tfunction NativeTabBody(props) {}'), /expected one/);
  Function(patched);
});

test('headless notice is removed without changing the native menu capability gate', () => {
  const source = `const menuDisabled = host === null || !host.available;
const children = [
\t\t\t\t\thost !== null && host !== "error" && !host.available && (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\tclassName: Deliverables_module_css_default.hostStatus,
\t\t\t\t\t\tchildren: t("presented.unavailable")
\t\t\t\t\t}),
preview];`;
  const output = patchDeliverablesSource(source);
  assert.ok(output.includes('const menuDisabled = host === null || !host.available;'));
  assert.ok(!output.includes('t("presented.unavailable")'));
  assert.equal(patchDeliverablesSource(output), output);
  Function(output);
});

test('image errors expose a retry that requests fresh bytes and returns to ready', () => {
  let state = []; let index = 0;
  const jsx = (type, props, key) => ({ type, props, key });
  const context = vm.createContext({
    react: { useState: initial => { const i = index++; if (!(i in state)) state[i] = initial; return [state[i], next => { state[i] = typeof next === 'function' ? next(state[i]) : next; }]; } },
    react_jsx_runtime: { jsx, jsxs: jsx }, sidebar_module_css_default: {}, t: key => key,
  });
  vm.runInContext(patched, context);
  const render = () => { index = 0; return context.SidebarImageAttempt({ mediaUrl: '/sidebar/file?path=x.png', title: 'x.png' }); };
  let output = render();
  output.props.children[2].props.onError();
  output = render();
  assert.equal(output.props.children[1].props.role, 'alert');
  assert.equal(output.props.children[2].props.style.display, 'none');
  output.props.children[1].props.children[1].props.onClick();
  output = render();
  assert.match(output.props.children[2].props.src, /&_dshRetry=1$/);
  output.props.children[2].props.onLoad();
  output = render();
  assert.equal(output.props['aria-busy'], false);
  assert.equal(output.props.children[2].props.hidden, false);
  assert.equal(context.SidebarImagePreview({ mediaUrl: 'next.png' }).key, 'next.png', 'new file resets image state');
});
