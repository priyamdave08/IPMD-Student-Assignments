/**
 * Building one email: personalization, the CAN-SPAM footer, a plain-text
 * alternative, and the raw MIME message with List-Unsubscribe headers.
 *
 * Apps Script's MailApp/GmailApp cannot set custom headers, so mail goes out
 * through the Gmail API (advanced service) as a raw RFC 2822 message — the
 * only way to get Gmail's own "Unsubscribe" button and RFC 8058 one-click.
 */

function isValidEmail_(email) {
  return typeof email === 'string' && email.length <= 254 &&
    /^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(email);
}

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function unsubscribeUrl_(token) {
  var base = getSetting_('WEB_APP_URL');
  if (!base) throw new Error('WEB_APP_URL is not set. Deploy the web app and add its /exec URL in Script Properties.');
  return base + '?a=unsubscribe&t=' + encodeURIComponent(token);
}

/** Fills {{first_name}} (HTML-escaped; "there" when unknown). */
function personalize_(html, firstName) {
  var name = String(firstName || '').trim() || 'there';
  return String(html).replace(/\{\{\s*first_name\s*\}\}/gi, escapeHtml_(name));
}

/** Appends the physical address + unsubscribe link every email must carry. */
function addFooter_(html, unsubLink) {
  var footer =
    '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;' +
    'font-family:Arial,sans-serif;font-size:12px;color:#888;line-height:1.5;">' +
    escapeHtml_(getSetting_('POSTAL_ADDRESS')) + '<br>' +
    'You are receiving this because you signed up for EchoSphere updates. ' +
    '<a href="' + escapeHtml_(unsubLink) + '" style="color:#888;">Unsubscribe</a>' +
    '</div>';
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, footer + '</body>') : html + footer;
}

/**
 * Plain-text alternative derived from the final HTML, so its links match.
 * Links become "label (url)"; hidden preheaders, comments, styles and images drop.
 */
function htmlToText_(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<div[^>]*display:\s*none[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, function (m, href, label) {
      var text = label.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      href = href.replace(/&amp;/g, '&');
      return text && text !== href ? text + ' (' + href + ')' : href;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** RFC 2047 encoded-word for non-ASCII header text (subjects with emoji etc.). */
function encodeHeader_(text) {
  text = String(text).replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return '=?UTF-8?B?' + Utilities.base64Encode(text, Utilities.Charset.UTF_8) + '?=';
}

/** Base64 body wrapped at 76 chars, as MIME requires. */
function base64Lines_(text) {
  return Utilities.base64Encode(text, Utilities.Charset.UTF_8).replace(/(.{76})/g, '$1\r\n');
}

/**
 * Raw multipart/alternative message (text first, HTML preferred) with the
 * List-Unsubscribe headers Gmail and Yahoo require from bulk senders.
 */
function buildRawMessage_(opts) {
  var boundary = 'b_' + Utilities.getUuid().replace(/-/g, '');
  var from = encodeHeader_(opts.fromName) + ' <' + opts.fromEmail + '>';
  var lines = [
    'From: ' + from,
    'To: ' + opts.to,
    'Subject: ' + encodeHeader_(opts.subject),
    'MIME-Version: 1.0',
    'List-Unsubscribe: <' + opts.unsubscribeUrl + '>',
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines_(opts.text),
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines_(opts.html),
    '--' + boundary + '--',
    ''
  ];
  return lines.join('\r\n');
}

/** Everything for one recipient: personalized HTML + footer, text part, raw MIME. */
function composeEmail_(subscriber, campaign, fromEmail) {
  var unsub = unsubscribeUrl_(subscriber.token);
  var html = addFooter_(personalize_(campaign.html, subscriber.firstName), unsub);
  return buildRawMessage_({
    fromName: getSetting_('SENDER_NAME'),
    fromEmail: fromEmail,
    to: subscriber.email,
    subject: campaign.subject.replace(/\{\{\s*first_name\s*\}\}/gi, String(subscriber.firstName || '').trim() || 'there'),
    html: html,
    text: htmlToText_(html),
    unsubscribeUrl: unsub
  });
}

function sendRaw_(raw) {
  Gmail.Users.Messages.send({ raw: Utilities.base64EncodeWebSafe(raw, Utilities.Charset.UTF_8) }, 'me');
}
