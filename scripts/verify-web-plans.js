/* 一次性探针：把 web/index.html 塞进 jsdom 真跑一遍内联脚本，
   断言三档价格、顶栏「起价」、以及三个购买按钮的 mailto 正文都被正确填充。
   为什么用 jsdom 而不是肉眼看代码：价格是脚本填的，静态看 HTML 看不出来。
   跑法：npm run verify:web（或 node scripts/verify-web-plans.js）
   不需要 build / electron —— 纯 jsdom 跑 web/index.html 的内联脚本。 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require(path.join(__dirname, '..', 'node_modules', 'jsdom'));

const file = path.join(__dirname, '..', 'web', 'index.html');
const html = fs.readFileSync(file, 'utf8');

/* 把内联脚本的异常收集起来。默认 jsdom 只往 stderr 印，脚本中断了断言也照样「过」——
   而事实上脚本一抛错，它后面所有的价格/邮件填充都会静默失效。 */
const vc = new VirtualConsole();
const scriptErrors = [];
vc.on('jsdomError', (e) => scriptErrors.push(e && e.message ? e.message : String(e)));
vc.on('error', (...a) => scriptErrors.push(a.join(' ')));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  virtualConsole: vc,
  beforeParse(window) {
    /* jsdom 没有 matchMedia（真实浏览器有）。不补的话脚本会在滚动入场那段中断，
       后面的 FAQ 手风琴逻辑根本跑不到 —— 那是探针的假象，不是页面的 bug。 */
    if (typeof window.matchMedia !== 'function') {
      window.matchMedia = function () {
        return {
          matches: false, media: '', onchange: null,
          addListener() {}, removeListener() {},
          addEventListener() {}, removeEventListener() {},
          dispatchEvent() { return false; }
        };
      };
    }
  }
});
const { document } = dom.window;

let fail = 0;
function eq(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}\n       got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}
function truthy(label, v) {
  const ok = !!v;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : '  got=' + JSON.stringify(v)}`);
}

/* 1. 三档价格 —— 值必须与 server/lib/env.js 的 STORE_PRICES 一致 */
const wantPrice = { month: '49', quarter: '129', year: '399' };
Object.keys(wantPrice).forEach((k) => {
  const el = document.querySelector(`[data-price="${k}"]`);
  truthy(`存在 data-price="${k}" 的节点`, el);
  if (el) eq(`data-price="${k}" 渲染值`, el.textContent.trim(), wantPrice[k]);
});

/* 2. 顶栏起价 = 最低档，不能是写死的数字 */
const from = document.querySelector('[data-price-from]');
truthy('存在 data-price-from 节点', from);
if (from) eq('顶栏起价', from.textContent.trim(), '\u00A549');

/* 3. 定价区不应再有「买断 / 永久 / 免费版」字样，也不该还有折价旧值 */
const priceSec = document.querySelector('#pricing');
truthy('#pricing 存在', priceSec);
if (priceSec) {
  const txt = priceSec.textContent;
  /* 注意：不能用裸「99」当判据 ——「¥399」里就含子串 99，会假失败。要带 ¥ 前缀。 */
  ['买断', '永久', '免费版', '\u00A599'].forEach((bad) => {
    truthy(`定价区不含「${bad}」`, !txt.includes(bad));
  });
  ['31 天', '93 天', '366 天'].forEach((good) => {
    truthy(`定价区含「${good}」`, txt.includes(good));
  });
}

/* 4. 三张卡的购买按钮：mailto 里应带上对应档位与价格 */
const cards = ['month', 'quarter', 'year'].map((k) => {
  const a = document.querySelector(`[data-mail="buy"][data-plan="${k}"]`);
  truthy(`存在 data-plan="${k}" 的购买按钮`, a);
  return { k, a };
});
cards.forEach(({ k, a }) => {
  if (!a) return;
  const href = a.getAttribute('href') || '';
  truthy(`[${k}] href 是 mailto`, href.startsWith('mailto:2776778868@qq.com?'));
  const body = decodeURIComponent((href.split('&body=')[1] || ''));
  const subject = decodeURIComponent((href.split('subject=')[1] || '').split('&body=')[0]);
  truthy(`[${k}] 正文含 ¥${wantPrice[k]}`, body.includes('\u00A5' + wantPrice[k]));
  truthy(`[${k}] 标题含档位名`, subject.includes('购买专业版') && subject.length > 6);
  console.log(`       subject=${subject}\n       body=${JSON.stringify(body.split('\n')[0])}`);
});

/* 5. 收尾 CTA 没指定档位 —— 应列全三档让人自己留一个 */
const finalBuy = document.querySelector('.final__cta [data-mail="buy"]');
truthy('收尾 CTA 存在', finalBuy);
if (finalBuy) {
  const href = finalBuy.getAttribute('href') || '';
  const body = decodeURIComponent(href.split('&body=')[1] || '');
  truthy('收尾 CTA 正文列全三档', ['¥49', '¥129', '¥399'].every((p) => body.includes(p)));
}

/* 6. 整页不应再出现「免费」套餐语义（"免费更新"是合法用法，单独排除） */
const all = document.body.textContent;
truthy('全页不含「买断」', !all.includes('买断'));
truthy('全页不含「免费版」', !all.includes('免费版'));
truthy('全页不含 ¥99', !all.includes('\u00A599'));

/* 7. 内联脚本必须整段跑完且零异常。放在最后 —— 前面所有断言都建立在这一条之上。 */
eq('内联脚本异常数', scriptErrors.length, 0);
scriptErrors.forEach((m) => console.log('       ' + m));

console.log(fail === 0 ? '\nWEB_PLANS_OK' : `\nWEB_PLANS_FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
