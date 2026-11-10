#!/usr/bin/env node
/**
 * Stop a pair of dollar amounts from being typeset as one inline equation.
 *
 * `micromark-extension-math@3.1.0` implements GitHub's math syntax, which has
 * no adjacency rules for `$…$`: its text tokenizer consumes a `$` run, then
 * accepts the next matching `$` run whatever surrounds either delimiter. So a
 * paragraph that merely mentions two prices opens a span at the first `$` and
 * closes it at the second:
 *
 *   The Austin GIGABYTE at $1,250 just got riskier than the Denver ASUS at $1,699.99.
 *
 * becomes one `inlineMath` node holding `1,250 just got riskier than the
 * Denver ASUS at `. KaTeX lays that out one character per line, and because
 * commas and letters are valid TeX the renderer's `throwOnError:false` retry
 * paints it instead of raising, so nothing ever reported it. The same pair in
 * adjacent table cells mangles a cost table.
 *
 * This patch adds pandoc's `tex_math_dollars` adjacency rule - the rule GFM
 * style renderers use for exactly this failure - by swapping the extension's
 * text tokenizer for one that only accepts a span when the characters touching
 * the delimiters say it is mathematics:
 *
 *   1. the code after the opening `$` run is not whitespace,
 *   2. the code before the closing `$` run is not whitespace,
 *   3. the code after the closing `$` run is not an ASCII digit.
 *
 * Any violation rejects the whole span: the dollars stay literal text and
 * micromark resumes one code after the opening `$`. There is no partial math
 * guess, so an ambiguous `$…$` resolves to the sentence rather than to a
 * KaTeX island. `$x^2$` keeps rendering as math, and `\$` keeps escaping
 * because `resolve`, `previous` (which is what makes `\$` an escape) and
 * `name` stay upstream's: the patch replaces `tokenize` and nothing else.
 * Display `$$…$$`, `\(…\)`, `\[…\]` and ```math fences are separate
 * constructs; the flow entry is left byte-identical.
 *
 * The shipped build cannot be configured instead of patched: the extension is
 * created by `Qg()` with no options and esbuild has already folded the option
 * read to `({}).singleDollarTextMath`, so `singleDollarTextMath:false` is not
 * reachable from this artifact, and setting it would also drop `$x^2$`.
 *
 * Drop this patch when a Harness release registers a guarded math text
 * extension in `packages/client/ui-primitives/src/markdown/parse.ts` (which
 * today calls `math()` with no options and no extension point).
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARKER = 'dsh-container-money-safe-math-v1';
export const FRONTEND_VERSION = '0.2.2-rc.1';

/** The shipped extension factory, verbatim, and its guarded replacement. */
export const MATH_EXTENSION_FACTORY
  = 'function k5(e){return{flow:{36:Yg},text:{36:Qg()}}}';
export const GUARDED_MATH_EXTENSION_FACTORY
  = 'function k5(e){return{flow:{36:Yg},text:{36:dshMoneySafeMathText(Qg())}}}';

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) !== -1) {
    throw new Error(`Cannot patch ${label}: expected one source anchor`);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

/**
 * The tokenizer this build lacks: upstream's `$…$` state machine plus the
 * three adjacency guards. Embedded into the bundle by source text, so it may
 * only close over its argument and its own scope.
 * @param {object} base - The extension `micromark-extension-math` created; its
 *   `resolve`, `previous` and `name` are reused unchanged.
 * @returns {{tokenize: Function, resolve: Function, previous: Function, name: string}}
 */
export function dshMoneySafeMathText(base) {
  // MARKER dsh-container-money-safe-math-v1: money is not mathematics.
  // A span is math only when the code after the opening `$` run and the code
  // before and after the closing `$` run all permit it (see the rule above);
  // otherwise the whole span is rejected and stays literal text. `$x^2$`
  // matches, `$1,250 … $1,699.99.` does not. Whitespace here is a space, a
  // tab, a line ending or the end of the text; a tab inside an otherwise
  // valid span remains math data exactly as upstream tokenizes it.
  const DOLLAR = 36;
  const SPACE = 32;
  const isLineEnding = code => code === 10 || code === 13 || code === 8232 || code === 8233;
  const isWhitespace = code =>
    code === null || code === 9 || code === 11 || code === 12 || code === SPACE || isLineEnding(code);
  const isDigit = code => code !== null && code >= 48 && code <= 57;

  // Lookahead for guard 3: `check` restores the position, so the digit that
  // disqualifies the span is never swallowed into it.
  function startsDigit(effects, ok, nok) {
    return function (code) {
      if (!isDigit(code)) return nok(code);
      effects.consume(code);
      return ok(code);
    };
  }

  function tokenize(effects, ok, nok) {
    let open = 0;
    let close = 0;
    let closeSequence;
    let spaceBefore = false;
    return start;

    function start(code) {
      effects.enter('mathText');
      effects.enter('mathTextSequence');
      return openSequence(code);
    }

    function openSequence(code) {
      if (code === DOLLAR) {
        effects.consume(code);
        open += 1;
        return openSequence;
      }
      // Guard 1: `$ x$` and `$` at the end of the text open nothing.
      if (isWhitespace(code)) return nok(code);
      effects.exit('mathTextSequence');
      return between(code);
    }

    function between(code) {
      if (code === null) return nok(code);
      if (code === DOLLAR) {
        // Guard 2: `a $` cannot close a span; the space says it is prose.
        if (spaceBefore) return nok(code);
        closeSequence = effects.enter('mathTextSequence');
        close = 0;
        return closeSequenceStep(code);
      }
      if (code === SPACE) {
        spaceBefore = true;
        effects.enter('space');
        effects.consume(code);
        effects.exit('space');
        return between;
      }
      if (isLineEnding(code)) {
        spaceBefore = true;
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        return between;
      }
      spaceBefore = false;
      effects.enter('mathTextData');
      return data(code);
    }

    function data(code) {
      if (code === null || code === DOLLAR || code === SPACE || isLineEnding(code)) {
        effects.exit('mathTextData');
        return between(code);
      }
      effects.consume(code);
      return data;
    }

    function closeSequenceStep(code) {
      if (code === DOLLAR) {
        effects.consume(code);
        close += 1;
        return closeSequenceStep;
      }
      if (close !== open) {
        // Upstream's own fallback: a `$` run of the wrong length is data.
        closeSequence.type = 'mathTextData';
        spaceBefore = false;
        return data(code);
      }
      // Guard 3: `$n$5` is prose about a price, not math followed by a digit.
      return effects.check({ partial: true, tokenize: startsDigit }, nok, succeed)(code);
    }

    function succeed(code) {
      effects.exit('mathTextSequence');
      effects.exit('mathText');
      return ok(code);
    }
  }

  return { ...base, tokenize };
}

/**
 * Swap the shipped extension's text tokenizer for the guarded one.
 * @param {string} input - The whole `vendor-*.js` chunk.
 * @returns {string} The patched chunk (unchanged when already patched).
 */
export function patchVendorSource(input) {
  if (input.includes(MARKER)) return input;
  const helper = dshMoneySafeMathText.toString()
    .replace(/^function \*?\w+/, 'function dshMoneySafeMathText');
  return replaceOnce(input, MATH_EXTENSION_FACTORY,
    `// ${MARKER}: $…$ stays text unless the delimiters are adjacency-clean.\n`
    + `${helper}\n${GUARDED_MATH_EXTENSION_FACTORY}`,
    'the math extension factory');
}

/**
 * Fail when the shipped chunk does not carry the guard.
 * @param {string} input - The whole `vendor-*.js` chunk.
 * @returns {string} The same source.
 */
export function verifyVendorSource(input) {
  if (!input.includes(MARKER)) throw new Error(`${MARKER} is absent from the shipped chunk`);
  if (input.includes(MATH_EXTENSION_FACTORY)) {
    throw new Error(`${MARKER} is present but the unguarded factory is still registered`);
  }
  return input;
}

/**
 * The chunk a browser actually executes, resolved through `index.html` rather
 * than by a filename guess, so a patched file nobody loads cannot pass.
 * @param {string} distDir - The `dsh-web-frontend/dist` directory.
 * @returns {Promise<string>} Absolute path to the vendor chunk.
 */
export async function resolveVendorAsset(distDir) {
  const html = await readFile(resolve(distDir, 'index.html'), 'utf8');
  const referenced = [...html.matchAll(/href="\.\/assets\/(vendor-[^"]+\.js)"/g)]
    .map(match => match[1]);
  if (referenced.length !== 1) {
    throw new Error(`${distDir}/index.html must reference exactly one vendor chunk, found ${referenced.length}`);
  }
  const assetDir = resolve(distDir, 'assets');
  const assets = (await readdir(assetDir)).filter(name => name.endsWith('.js'));
  const carrying = [];
  for (const name of assets) {
    const source = await readFile(resolve(assetDir, name), 'utf8');
    if (source.includes('singleDollarTextMath')) carrying.push(name);
  }
  if (carrying.length !== 1) {
    throw new Error(`exactly one asset may carry the $…$ tokenizer, found ${carrying.length}: ${carrying.join(', ')}`);
  }
  if (carrying[0] !== referenced[0]) {
    throw new Error(`the $…$ tokenizer lives in ${carrying[0]}, but index.html loads ${referenced[0]}`);
  }
  return resolve(assetDir, carrying[0]);
}

/** Compile the patched ES module without executing it. */
function assertEsModule(source, label) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: source, encoding: 'utf8', maxBuffer: 1 << 28,
  });
  if (result.status !== 0) {
    throw new Error(`${label} is not a valid ES module: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const given = argv.find(argument => !argument.startsWith('--'));
  const runtimeRoot = process.env.DSH_RUNTIME_ROOT
    ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh';
  const packageRoot = given
    ?? resolve(runtimeRoot, 'node_modules/@deepseek-ai/dsh-web-frontend');
  const distDir = resolve(packageRoot, 'dist');
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  if (manifest.version !== FRONTEND_VERSION) {
    throw new Error(`${manifest.name}: expected ${FRONTEND_VERSION}, got ${manifest.version}`);
  }
  const target = await resolveVendorAsset(distDir);
  const before = await readFile(target, 'utf8');
  const after = patchVendorSource(before);
  assertEsModule(after, `${manifest.name} ${MARKER}`);
  if (before !== after) {
    if (check) throw new Error(`${manifest.name}: ${MARKER} is missing from ${basename(target)}`);
    await writeFile(target, after);
    // Prove the file that was written is the file the guard is in.
    verifyVendorSource(await readFile(target, 'utf8'));
  } else {
    verifyVendorSource(after);
  }
  console.log(`Verified ${MARKER} for ${manifest.name}@${manifest.version} (${basename(target)}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
