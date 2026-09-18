#!/usr/bin/env node
/** Compatibility fix for the pinned sidebar's native resource adapter. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARKER = 'dsh-session-file-previews-v1';
export const SIDEBAR_VERSION = '0.19.1';
export const DSH_VERSION = '0.1.6-alpha.1';

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) !== -1) {
    throw new Error(`Cannot patch ${label}: expected one source anchor`);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

/** Reuse the sidebar's platform-aware resolver after selecting the file's session. */
export function resolvePreviewParams(params, cwd, resolvePath, isAbsolute) {
  const path = params?.path;
  if (typeof path !== 'string' || path === '' || isAbsolute(path)) return { ready: true, params };
  // Never let a cold/restored tab issue a request relative to the host process.
  if (!cwd) return { ready: false, params: undefined };
  return { ready: true, params: { ...params, path: resolvePath(cwd, path) } };
}

/** These functions are embedded in the pinned bundle and use its React/locales. */
export function SidebarImagePreview(props) {
  return react_jsx_runtime.jsx(SidebarImageAttempt, props, props.mediaUrl);
}

export function SidebarImageAttempt({ mediaUrl, title }) {
  const [attempt, setAttempt] = react.useState(0);
  const [status, setStatus] = react.useState('loading');
  const url = attempt === 0 ? mediaUrl : `${mediaUrl}${mediaUrl.includes('?') ? '&' : '?'}_dshRetry=${attempt}`;
  return react_jsx_runtime.jsxs('div', {
    className: sidebar_module_css_default.editorImageWrap,
    'data-dsh-image-preview': true,
    'aria-busy': status === 'loading',
    children: [
      status === 'loading' && react_jsx_runtime.jsx('p', { role: 'status', children: t('loading') }),
      status === 'failed' && react_jsx_runtime.jsxs('div', {
        role: 'alert',
        children: [
          react_jsx_runtime.jsx('p', { children: `${t('viewerImage')} — ${t('error')}: ${title}` }),
          react_jsx_runtime.jsx('button', {
            type: 'button',
            onClick: () => { setStatus('loading'); setAttempt(value => value + 1); },
            children: t('retry'),
          }),
        ],
      }),
      react_jsx_runtime.jsx('img', {
        className: sidebar_module_css_default.editorImage,
        src: url,
        alt: title,
        hidden: status !== 'ready',
        style: { display: status === 'ready' ? undefined : 'none' },
        onLoad: () => setStatus('ready'),
        onError: () => setStatus('failed'),
      }, url),
    ],
  });
}

export function patchSidebarSource(input) {
  if (input.includes(MARKER)) return input;
  let source = replaceOnce(input, '\t\tfunction NativeTabBody(props) {',
    `\t\t// ${MARKER}\n${resolvePreviewParams.toString()}\n${SidebarImagePreview.toString()}\n${SidebarImageAttempt.toString()}\n\t\tfunction NativeTabBody(props) {`, 'preview helpers');
  source = replaceOnce(source, '\t\t\tconst params = derived === void 0 && nativeTab.navigation.params === void 0 ? void 0 : {',
    '\t\t\tlet params = derived === void 0 && nativeTab.navigation.params === void 0 ? void 0 : {', 'native navigation params');
  source = replaceOnce(source, '\t\t\tconst descriptor = service.getTab(descriptorId);\n\t\t\tconst view = records.ensure({',
    `\t\t\tconst preview = descriptorId === EDITOR_KIND ? resolvePreviewParams(params, cwd, resolveSidebarPath, isAbsolutePath$1) : { ready: true, params };\n\t\t\tparams = preview.params;\n\t\t\tconst descriptor = service.getTab(descriptorId);\n\t\t\tconst view = records.ensure({`, 'session-relative resource resolution');
  source = replaceOnce(source, '\t\t\t}, [records, nativeTab.id]);\n\t\t\tif (descriptor === void 0)',
    `\t\t\t}, [records, nativeTab.id]);\n\t\t\tif (!preview.ready) return react_jsx_runtime.jsx("div", { role: "status", "data-dsh-preview-awaiting-workspace": true, children: t("loading") });\n\t\t\tif (descriptor === void 0)`, 'defer preview until workspace hydration');
  source = replaceOnce(source,
    `\t\t\t\t\tcomponent: ({ mediaUrl: url, title }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\tclassName: sidebar_module_css_default.editorImageWrap,\n\t\t\t\t\t\tchildren: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {\n\t\t\t\t\t\t\tclassName: sidebar_module_css_default.editorImage,\n\t\t\t\t\t\t\tsrc: url,\n\t\t\t\t\t\t\talt: title\n\t\t\t\t\t\t})\n\t\t\t\t\t})`,
    '\t\t\t\t\tcomponent: SidebarImagePreview', 'image error and retry');
  return source;
}

export function patchDeliverablesSource(input) {
  if (input.includes(MARKER)) return input;
  return replaceOnce(input,
    `\t\t\t\t\thost !== null && host !== "error" && !host.available && (0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\tclassName: Deliverables_module_css_default.hostStatus,\n\t\t\t\t\t\tchildren: t("presented.unavailable")\n\t\t\t\t\t}),`,
    `\t\t\t\t\t// ${MARKER}: desktop availability only controls the native action menu.`,
    'headless preview warning');
}

export async function main(args = process.argv.slice(2)) {
  const check = args.includes('--check');
  const profileIndex = args.indexOf('--profile');
  const profile = profileIndex < 0 ? '/opt/dsh-seed/profiles/web' : args[profileIndex + 1];
  if (!profile) throw new Error('--profile requires a directory');
  const dshRoot = process.env.DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh';
  const targets = [
    [resolve(profile, 'node_modules/dsh-better-sidebar'), SIDEBAR_VERSION, patchSidebarSource],
    [resolve(dshRoot, 'node_modules/@deepseek-ai/dsh-client-ui-deliverables'), DSH_VERSION, patchDeliverablesSource],
  ];
  for (const [root, version, patch] of targets) {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    if (manifest.version !== version) throw new Error(`${manifest.name}: expected ${version}, got ${manifest.version}`);
    const target = resolve(root, 'lib/client.js');
    const before = await readFile(target, 'utf8');
    const after = patch(before);
    Function(after);
    if (check && before !== after) throw new Error(`${manifest.name}: file preview patch is missing`);
    if (!check && before !== after) await writeFile(target, after);
  }
  console.log(`Verified ${MARKER} for sidebar ${SIDEBAR_VERSION} and Harness ${DSH_VERSION}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
