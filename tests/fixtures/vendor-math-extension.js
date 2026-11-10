/**
 * The shipped single-dollar inline-math extension, extracted verbatim from
 * vendor-BUMdD3V7.js of @deepseek-ai/dsh-web-frontend@0.2.2-rc.1: the bundle
 * region holding its text tokenizer, that tokenizer's event resolver and escape
 * guard, and the extension factory. Extracting it lets
 * tests/dsh-markdown-money-math-patch.test.mjs drive real shipped code with no
 * installed dependencies.
 *
 * The line-ending helper and the display-math flow tokenizer are stubbed below;
 * both are referenced by the region and neither is what the test asserts about.
 * Assigning to globalThis keeps this file a valid script, so the test can
 * evaluate the patched text inside a vm context.
 *
 * If a Harness release changes this region, scripts/patch-dsh-markdown-money-math.mjs
 * fails the image build; regenerate this fixture only as part of that work.
 */
const X = code => code === 10 || code === 13 || code === 8232 || code === 8233;
function Yg() {}
function Qg(e){let n={}.singleDollarTextMath;return n==null&&(n=!0),{tokenize:r,resolve:Jg,previous:e4,name:"mathText"};function r(a,i,s){let o=0,l,u;return c;function c(k){return a.enter("mathText"),a.enter("mathTextSequence"),h(k)}function h(k){return k===36?(a.consume(k),o++,h):o<2&&!n?s(k):(a.exit("mathTextSequence"),f(k))}function f(k){return k===null?s(k):k===36?(u=a.enter("mathTextSequence"),l=0,b(k)):k===32?(a.enter("space"),a.consume(k),a.exit("space"),f):X(k)?(a.enter("lineEnding"),a.consume(k),a.exit("lineEnding"),f):(a.enter("mathTextData"),d(k))}function d(k){return k===null||k===32||k===36||X(k)?(a.exit("mathTextData"),f(k)):(a.consume(k),d)}function b(k){return k===36?(a.consume(k),l++,b):l===o?(a.exit("mathTextSequence"),a.exit("mathText"),i(k)):(u.type="mathTextData",d(k))}}}function Jg(e){let t=e.length-4,n=3,r,a;if((e[n][1].type==="lineEnding"||e[n][1].type==="space")&&(e[t][1].type==="lineEnding"||e[t][1].type==="space")){for(r=n;++r<t;)if(e[r][1].type==="mathTextData"){e[t][1].type="mathTextPadding",e[n][1].type="mathTextPadding",n+=2,t-=2;break}}for(r=n-1,t++;++r<=t;)a===void 0?r!==t&&e[r][1].type!=="lineEnding"&&(a=r):(r===t||e[r][1].type==="lineEnding")&&(e[a][1].type="mathTextData",r!==a+2&&(e[a][1].end=e[r-1][1].end,e.splice(a+2,r-a-2),t-=r-a-2,r=a+2),a=void 0);return e}function e4(e){return e!==36||this.events[this.events.length-1][1].type==="characterEscape"}function k5(e){return{flow:{36:Yg},text:{36:Qg()}}}
globalThis.__dshMathExtension = k5();
