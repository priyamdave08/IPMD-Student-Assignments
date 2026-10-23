/**
 * Public web app (deployed "Execute as: me", "Who has access: Anyone").
 *
 *   POST  ?a=signup        form fields: email, first_name, source, website (honeypot)
 *   GET   ?a=unsubscribe&t=TOKEN   confirmation page (footer link)
 *   POST  ?a=unsubscribe&t=TOKEN   RFC 8058 one-click (Gmail/Yahoo "Unsubscribe")
 *
 * SECURITY: every function a visitor's browser can reach through
 * google.script.run is public, so only doGet, doPost and confirmUnsubscribe
 * are meant to be called from outside. Helpers end in "_" (private), and admin
 * functions call requireOwner_().
 */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.a === 'unsubscribe') {
    var page = HtmlService.createTemplateFromFile('Unsubscribe');
    page.token = String(p.t || '');
    return page.evaluate()
      .setTitle('Unsubscribe — EchoSphere')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return json_({ ok: true, service: 'EchoSphere email' });
}

function doPost(e) {
  var p = (e && e.parameter) || {};

  // One-click: the mailbox provider POSTs "List-Unsubscribe=One-Click" to the
  // List-Unsubscribe URL, which carries ?a=unsubscribe&t=TOKEN.
  if (p.a === 'unsubscribe') {
    var email = unsubscribeByToken_(p.t);
    return ContentService.createTextOutput(email ? 'unsubscribed' : 'unknown token');
  }

  if (p.a === 'signup') return handleSignup_(p);

  return json_({ ok: false, error: 'unknown action' });
}

/** Called from the unsubscribe page's button. Token-gated, so safe to expose. */
function confirmUnsubscribe(token) {
  return !!unsubscribeByToken_(token);
}

function handleSignup_(p) {
  // Bots fill every field; people never see the honeypot. Pretend success.
  if (p.website) return json_({ ok: true });

  var email = normalizeEmail_(p.email);
  if (!isValidEmail_(email)) return json_({ ok: false, error: 'Please enter a valid email address.' });

  // One signup per address per minute, to blunt scripted floods.
  var cache = CacheService.getScriptCache();
  var key = 'signup:' + email;
  if (cache.get(key)) return json_({ ok: true });
  cache.put(key, '1', 60);

  var result = addSubscriber_(email, p.first_name, p.source || 'website');
  if (result.status === 'added') notifyMosaic_(p.first_name, p.source);
  return json_({ ok: true, status: result.status === 'exists' ? 'already_subscribed' : 'subscribed' });
}

/**
 * Tells Mosaic a new supporter joined so the wall updates live. Sends a
 * display name only — never the email address — and never blocks a signup.
 */
function notifyMosaic_(firstName, source) {
  var url = getSetting_('MOSAIC_WEBHOOK_URL');
  if (!url) return;
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Mosaic-Secret': getSetting_('MOSAIC_SECRET') },
      payload: JSON.stringify({
        type: 'signup',
        displayName: String(firstName || '').trim().slice(0, 40) || 'New supporter',
        source: String(source || 'website').slice(0, 100),
        createdAt: new Date().toISOString()
      }),
      muteHttpExceptions: true
    });
  } catch (err) {
    console.warn('Mosaic notify failed: ' + err);
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
