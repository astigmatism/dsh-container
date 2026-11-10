import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  FRONTEND_VERSION,
  GUARDED_MATH_EXTENSION_FACTORY,
  MATH_EXTENSION_FACTORY,
  MARKER,
  main,
  patchVendorSource,
  resolveVendorAsset,
  verifyVendorSource,
} from '../scripts/patch-dsh-markdown-money-math.mjs';

const fixture = await readFile(new URL('./fixtures/vendor-math-extension.js', import.meta.url), 'utf8');
const patched = patchVendorSource(fixture);

/**
 * Evaluate one form of the shipped region. The extension registers its `$`
 * construct at `text[36]`; that construct - tokenizer, resolver and escape
 * guard together - is what the renderer's grammar runs.
 */
function evaluate(source) {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const extension = context.__dshMathExtension;
  return { extension, mathText: extension.text[36] };
}

const shipped = evaluate(fixture);
const guarded = evaluate(patched);

/**
 * A minimal stand-in for micromark's text-construct dispatch: a `$` construct
 * is attempted at every `$` in text content, and after a rejection the scan
 * resumes one code later. That is the whole contract this tokenizer
 * participates in, and it is why a rejected span degrades to prose instead of
 * to a partial match. Escapes are modelled here by skipping a `$` a backslash
 * escapes; the extension's own `previous` guard is asserted directly below,
 * because micromark applies it with the preceding code point rather than as
 * part of dispatch.
 */
function spans(extension, source) {
  const found = [];
  let index = 0;
  while (index < source.length) {
    if (source[index] !== '$' || escapedDollar(source, index)) {
      index += 1;
      continue;
    }
    const span = attempt(extension.tokenize, source, index);
    if (span === null) {
      index += 1;
      continue;
    }
    found.push(span);
    index = span.end;
  }
  return found.map(span => span.text);
}

function escapedDollar(source, index) {
  let backslashes = 0;
  while (source[index - backslashes - 1] === '\\') backslashes += 1;
  return backslashes % 2 === 1;
}

/** Run one construct over `source` from `start`; null when it rejects. */
function attempt(tokenize, source, start) {
  let outcome = null;
  let consumed = 0;
  const effects = {
    enter: type => ({ type }),
    exit: () => {},
    consume: () => { consumed += 1 },
    attempt: (construct, ok) => code => ok(code),
    check: (construct, ok, nok) => code => {
      // `check` is a lookahead: what it enters and consumes is discarded.
      const lookahead = { enter: () => ({}), exit: () => {}, consume: () => {} };
      let result = 'nok';
      construct.tokenize.call({}, { ...effects, ...lookahead },
        () => { result = 'ok' },
        () => { result = 'nok' })(code);
      return result === 'ok' ? ok(code) : nok(code);
    },
  };
  let step = tokenize.call({ events: [] }, effects,
    () => { outcome = 'ok' },
    () => { outcome = 'nok' });
  for (let index = start; outcome === null && index <= source.length; index += 1) {
    step = step(index === source.length ? null : source.codePointAt(index));
    if (outcome === null && typeof step !== 'function') outcome = 'halted';
  }
  if (outcome !== 'ok') return null;
  return { text: source.slice(start, start + consumed), end: start + consumed };
}

const MONEY = 'The Austin GIGABYTE at $1,250 just got riskier than the Denver ASUS at $1,699.99.';

test('the shipped tokenizer really does turn two prices into one equation', () => {
  // The regression pin, read straight out of the released artifact: this is
  // the defect the guard exists to prevent.
  assert.deepEqual(spans(shipped.mathText, MONEY),
    ['$1,250 just got riskier than the Denver ASUS at $']);
  assert.deepEqual(spans(shipped.mathText, 'costs $5 or $10 depending on the seller'), ['$5 or $']);
  assert.deepEqual(spans(shipped.mathText, String.raw`$HOME and $PATH here`), ['$HOME and $']);
});

test('money, shell variables and space-padded dollars stay plain text', () => {
  for (const input of [
    MONEY,
    'costs $5 or $10 depending on the seller',
    String.raw`$HOME and $PATH here`,
    String.raw`set $LANG then $TERM and $USER follow`,
    'quoted $1,250, $1,699.99 and $2,000 flat',
    'prices range from $ 5 to $ 10 in that shop',
    'the fee is 5$ or 10$ per unit',
    '$1000 and $2000 and $3000',
    '$ x $ and $ y $',
    'a paragraph about $ per gigabyte and $ per watt',
  ]) {
    assert.deepEqual(spans(guarded.mathText, input), [], input);
  }
});

test('every cell of a price table stays plain text', () => {
  // A table row is one paragraph to the tokenizer, so the guarantee that
  // matters is that no cell can pair its `$` with a neighbouring cell's.
  const row = '| Austin GIGABYTE | $1,250 | $1,699.99 | $2,000 |';
  const cells = row.split('|').map(cell => cell.trim()).filter(cell => cell.includes('$'));
  assert.equal(cells.length, 3);
  for (const cell of cells) assert.deepEqual(spans(guarded.mathText, cell), [], cell);
  assert.deepEqual(spans(guarded.mathText, 'from $1,250 to $1,699.99 in one cell'), []);
  assert.deepEqual(spans(guarded.mathText, 'from $1,250 or\nfrom $1,699.99'), []);
});

test('real inline math still renders, and `$x^2$` is math by design', () => {
  for (const [input, expected] of [
    ['$x^2$ is the parabola', ['$x^2$']],
    ['where $a+b$ is fine and 5$ and 10$ are not', ['$a+b$']],
    ['set $x$=1 then $y$=2', ['$x$', '$y$']],
    [String.raw`both $\alpha$ and $\beta$`, [String.raw`\alpha`, String.raw`\beta`].map(part => `$${part}$`)],
    ['$$x^2$$ inline', ['$$x^2$$']],
  ]) {
    assert.deepEqual(spans(guarded.mathText, input), expected, input);
  }
});

test('an ambiguous span resolves to text, never to a math guess', () => {
  // Each guard in isolation, so a regression names itself.
  assert.deepEqual(spans(guarded.mathText, 'a $x^2$5 b'), [], 'digit after the close');
  assert.deepEqual(spans(guarded.mathText, 'a $x^2$ then 5 b'), ['$x^2$'], 'space after the close');
  assert.deepEqual(spans(guarded.mathText, '$ x^2$ y'), [], 'space after the open');
  assert.deepEqual(spans(guarded.mathText, '$x^2 $ y'), [], 'space before the close');
  assert.deepEqual(spans(guarded.mathText, '$'), [], 'lone dollar');
  assert.deepEqual(spans(guarded.mathText, '$x'), [], 'unterminated span');
});

test('backslash escapes keep working and leave no artifacts', () => {
  assert.deepEqual(spans(guarded.mathText, String.raw`\$1,250 and \$1,699.99`), []);
  assert.deepEqual(spans(guarded.mathText, String.raw`\$x^2\$ stays literal`), []);
  // The same text without the escapes is math, so passing above is the escape
  // working and not the span being rejected for another reason.
  assert.deepEqual(spans(guarded.mathText, '$x^2$ stays literal'), ['$x^2$']);
  // `\$` keeps working because the guard reuses the shipped one instead of
  // reimplementing it. Micromark calls that guard with the code point *before*
  // the `$` and skips the construct when it returns false, so the cases are:
  // a `$` may not open a span straight after another `$`…
  assert.equal(guarded.mathText.previous.call({ events: [['exit', { type: 'data' }]] }, 36), false);
  // …unless that dollar was itself an escape, which is what makes `\\$x$` open.
  assert.equal(guarded.mathText.previous.call({ events: [['exit', { type: 'characterEscape' }]] }, 36), true);
  // Any other preceding code is unrestricted.
  assert.equal(guarded.mathText.previous.call({ events: [['exit', { type: 'data' }]] }, 32), true);
});

test('display math and the rest of the grammar are untouched', () => {
  // `$$ … $$` on its own line, `\(…\)`, `\[…\]` and ```math fences are other
  // constructs; the patch replaces the text tokenizer and nothing else, so the
  // flow entry is still the very function the shipped bundle created.
  assert.ok(patched.includes('flow:{36:Yg}'), 'the display-math flow entry must stay byte-identical');
  assert.deepEqual(Object.keys(guarded.extension.flow), Object.keys(shipped.extension.flow));
  assert.deepEqual(Object.keys(guarded.mathText), Object.keys(shipped.mathText));
  assert.equal(guarded.mathText.name, 'mathText');
  assert.equal(typeof guarded.mathText.resolve, 'function');
  // Space-padded display delimiters inside a sentence are ambiguous, so they
  // read as text; a real display block never reaches the text tokenizer.
  assert.deepEqual(spans(guarded.mathText, '$$ E = mc^2 $$'), []);
  assert.deepEqual(spans(guarded.mathText, String.raw`\( x^2 \)`), [], 'TeX delimiters use no dollar at all');
});

test('the patch is one contiguous edit, so code spans cannot widen', () => {
  // A `$` inside a code span or fence never reaches a text construct. That
  // priority lives in this same bundle and is only still intact because the
  // patch is a single contiguous edit.
  const index = fixture.indexOf(MATH_EXTENSION_FACTORY);
  const before = fixture.slice(0, index);
  const after = fixture.slice(index + MATH_EXTENSION_FACTORY.length);
  assert.ok(patched.startsWith(before), 'everything before the anchor is byte-identical');
  assert.ok(patched.endsWith(after), 'everything after the anchor is byte-identical');
  const inserted = patched.slice(before.length, patched.length - after.length);
  assert.ok(inserted.startsWith(`// ${MARKER}`));
  assert.ok(inserted.endsWith(GUARDED_MATH_EXTENSION_FACTORY));
  // The guard spreads the shipped construct and replaces only its tokenizer,
  // so `resolve` and `previous` cannot have been reimplemented.
  assert.match(inserted, /return \{ \.\.\.base, tokenize \};/);
  assert.ok(!inserted.includes('previous'), 'the escape guard must stay upstream\'s');
  assert.ok(!inserted.includes('resolve'), 'the event resolver must stay upstream\'s');
  assert.ok(!inserted.includes(MATH_EXTENSION_FACTORY));
  assert.ok(patched.length < fixture.length + 8_000, 'the guard stays a small edit');
});

test('the patch is idempotent and refuses drifted or repeated anchors', () => {
  assert.equal(patchVendorSource(patched), patched);
  assert.equal(verifyVendorSource(patched), patched);
  assert.throws(() => patchVendorSource(fixture.replace('function k5(', 'function mathExtension(')),
    /expected one source anchor/);
  assert.throws(() => patchVendorSource(`${fixture}\n${MATH_EXTENSION_FACTORY}`),
    /expected one source anchor/);
  assert.throws(() => verifyVendorSource(fixture), new RegExp(`${MARKER} is absent`));
});

test('the fixture is still the shipped tokenizer', async () => {
  const runtimeRoot = process.env.DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh';
  const dist = `${runtimeRoot}/node_modules/@deepseek-ai/dsh-web-frontend/dist`;
  if (!existsSync(dist)) return;
  const source = await readFile(await resolveVendorAsset(dist), 'utf8');
  // Compare tokenizer, resolver and escape guard. The factory line is the one
  // thing the patch is allowed to rewrite, so a patched deployment differs
  // there by design.
  const region = fixture.slice(fixture.indexOf('function Qg(e){'), fixture.indexOf('function k5(e){'));
  assert.ok(region.length > 1_000);
  assert.ok(source.includes(region), 'the tested tokenizer no longer matches the shipped artifact');
  assert.ok(source.includes(MARKER) || source.includes(MATH_EXTENSION_FACTORY));
});

/** A package shaped like `dsh-web-frontend`, with the shipped region as its chunk. */
async function fakeFrontend(disturb) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-money-math-'));
  await mkdir(resolve(root, 'dist/assets'), { recursive: true });
  await writeFile(resolve(root, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-web-frontend',
    version: disturb?.version ?? FRONTEND_VERSION,
  }));
  await writeFile(resolve(root, 'dist/index.html'),
    '<script type="module" crossorigin src="./assets/index-abc.js"></script>\n'
    + `<link rel="modulepreload" crossorigin href="./assets/${disturb?.loaded ?? 'vendor-def.js'}">\n`);
  await writeFile(resolve(root, 'dist/assets/index-abc.js'), 'import { x } from "./vendor-def.js";\nexport default x;\n');
  await writeFile(resolve(root, 'dist/assets/vendor-def.js'),
    `import { x } from "./index-abc.js";\nexport const math = (() => {\n${fixture}\nreturn globalThis.__dshMathExtension;\n})();\n`);
  return root;
}

test('main patches the chunk index.html actually loads, then verifies it', async () => {
  const root = await fakeFrontend({});
  try {
    const asset = resolve(root, 'dist/assets/vendor-def.js');
    await main([root]);
    const source = await readFile(asset, 'utf8');
    assert.ok(source.includes(MARKER));
    // The image build gates the result on it still compiling as an ES module,
    // which is also what rejects an identifier collision with the minified names.
    await main([root]);
    await main(['--check', root]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('main refuses a chunk index.html does not load, or another release', async () => {
  const orphan = await fakeFrontend({ loaded: 'vendor-other.js' });
  const drifted = await fakeFrontend({ version: '9.9.9' });
  try {
    await assert.rejects(main([orphan]), /index.html loads vendor-other\.js/);
    await assert.rejects(main([drifted]), /expected 0\.2\.2-rc\.1, got 9\.9\.9/);
  } finally {
    await rm(orphan, { recursive: true, force: true });
    await rm(drifted, { recursive: true, force: true });
  }
});
