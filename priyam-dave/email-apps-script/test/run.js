// node test/run.js  (needs: npm i mailparser)
const assert = require('assert');
const { simpleParser } = require('mailparser');
const { createEnv } = require('./harness');

(async () => {
  const env = createEnv();
  const { ctx, sheets, props, sent, fetches, users } = env;
  const subs = () => sheets.Subscribers.data.slice(1);

  users.active = '';
  assert.throws(() => ctx.setup(), /Not authorized/, 'anonymous cannot run setup');
  users.active = 'pr@ipmdinc.com';
  ctx.setup();
  props.WEB_APP_URL = 'https://script.google.com/macros/s/X/exec';
  props.MOSAIC_WEBHOOK_URL = 'https://mosaic.example/webhook';

  const post = (p) => JSON.parse(ctx.doPost({ parameter: p }).text);
  assert.strictEqual(post({ a: 'signup', email: 'A@Example.com', first_name: 'Ana', source: 'test' }).ok, true);
  assert.strictEqual(subs().length, 1);
  assert.strictEqual(subs()[0][0], 'a@example.com');
  assert.match(subs()[0][7], /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(fetches[0].opts.payload).includes('example.com'), 'Mosaic gets no email');
  post({ a: 'signup', email: 'a@example.com' });
  env.cache['signup:a@example.com'] = null;
  post({ a: 'signup', email: 'a@example.com' });
  assert.strictEqual(subs().length, 1, 'no duplicates');
  assert.strictEqual(post({ a: 'signup', email: 'not-an-email' }).ok, false);
  post({ a: 'signup', email: 'bot@example.com', website: 'spam' });
  assert.strictEqual(subs().length, 1, 'honeypot blocked');
  post({ a: 'signup', email: 'b@example.com', first_name: 'Ben' });
  post({ a: 'signup', email: 'c@example.com' });

  // One-click unsubscribe for c; bad tokens rejected.
  const tokenC = subs()[2][7];
  assert.strictEqual(ctx.doPost({ parameter: { a: 'unsubscribe', t: tokenC } }).text, 'unsubscribed');
  assert.strictEqual(subs()[2][4], 'unsubscribed');
  assert.strictEqual(ctx.confirmUnsubscribe('f'.repeat(64)), false);

  // Campaign: blocked while address is a placeholder.
  sheets.Campaigns.appendRow(['launch', '🎉 Hi {{first_name}}', '<html><body><p>Hello {{first_name}}</p><a href="https://naru-m.com">Visit</a></body></html>', '', '', '']);
  assert.throws(() => ctx.startCampaign('launch'), /placeholder/);
  props.POSTAL_ADDRESS = 'IPMD Inc., 1 Test St, City, CA';

  // Unsubscribe b while a's email is being sent: b must be skipped.
  const tokenB = subs()[1][7];
  env.hooks.onSend = () => { env.hooks.onSend = null; ctx.unsubscribeByToken_(tokenB); };
  const r = ctx.startCampaign('launch');
  assert.strictEqual(r.state, 'done');
  assert.strictEqual(sent.length, 1, 'only a (b unsubscribed mid-run, c earlier)');

  const m = await simpleParser(sent[0]);
  assert.strictEqual(m.subject, '🎉 Hi Ana');
  assert.strictEqual(m.to.text, 'a@example.com');
  assert.match(sent[0], /^List-Unsubscribe: <https:[^>]*a=unsubscribe&t=[a-f0-9]{64}>/m);
  assert.ok(sent[0].includes('\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n'));
  assert.match(m.html, /Hello Ana/);
  assert.match(m.html, /1 Test St/);
  assert.match(m.text, /Visit \(https:\/\/naru-m\.com\)/);
  assert.match(m.text, /Unsubscribe \(https:\/\/script\.google\.com/);

  assert.strictEqual(ctx.startCampaign('launch').state, 'done');
  assert.strictEqual(sent.length, 1, 're-run does not re-send');

  users.active = '';
  assert.throws(() => ctx.startCampaign('launch'), /Not authorized/);
  assert.throws(() => ctx.sendTest('launch', 'x@example.com'), /Not authorized/);

  console.log('All tests passed.');
})().catch((e) => { console.error('FAIL:', e.stack); process.exit(1); });
