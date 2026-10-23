/**
 * Subscriber list: signup, unsubscribe and lookup. The Subscribers tab is the
 * source of truth; every write happens under a script lock so two signups or
 * an unsubscribe arriving mid-send never clobber each other's rows.
 */

/** Reads a tab into { sheet, headers, col(name) → 1-based index, rows: [{row, values}] }. */
function readTable_(sheetName) {
  var sheet = getSheet_(sheetName);
  var values = sheet.getDataRange().getValues();
  var headers = values[0] || [];
  var index = {};
  headers.forEach(function (h, i) { index[h] = i; });
  return {
    sheet: sheet,
    headers: headers,
    col: function (name) {
      if (!(name in index)) throw new Error('Column "' + name + '" not found in ' + sheetName);
      return index[name] + 1;
    },
    get: function (values, name) { return values[index[name]]; },
    rows: values.slice(1).map(function (v, i) { return { row: i + 2, values: v }; })
  };
}

function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

function newToken_() {
  // Two UUIDs → 244 random bits; the token is the only thing an unsubscribe
  // link carries, so it must not be guessable.
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Adds a subscriber, or re-subscribes an existing one (signing up again is a
 * fresh opt-in). Returns { status: 'added' | 'resubscribed' | 'exists', token }.
 */
function addSubscriber_(email, firstName, source) {
  email = normalizeEmail_(email);
  if (!isValidEmail_(email)) throw new Error('Invalid email');
  firstName = String(firstName || '').trim().slice(0, 60);
  source = String(source || 'unknown').trim().slice(0, 200);

  return withLock_(function () {
    var t = readTable_(SHEETS.SUBSCRIBERS);
    for (var i = 0; i < t.rows.length; i++) {
      var r = t.rows[i];
      if (normalizeEmail_(t.get(r.values, 'Email')) !== email) continue;
      if (t.get(r.values, 'Status') === STATUS.UNSUBSCRIBED) {
        t.sheet.getRange(r.row, t.col('Status')).setValue(STATUS.SUBSCRIBED);
        t.sheet.getRange(r.row, t.col('Unsubscribed At')).setValue('');
        if (firstName) t.sheet.getRange(r.row, t.col('First Name')).setValue(firstName);
        return { status: 'resubscribed', token: t.get(r.values, 'Token') };
      }
      return { status: 'exists', token: t.get(r.values, 'Token') };
    }

    var token = newToken_();
    var record = {
      'Email': email,
      'First Name': firstName,
      'Source': source,
      'Signed Up': new Date(),
      'Status': STATUS.SUBSCRIBED,
      'Unsubscribed At': '',
      'Last Sent': '',
      'Token': token
    };
    t.sheet.appendRow(t.headers.map(function (h) { return h in record ? record[h] : ''; }));
    return { status: 'added', token: token };
  });
}

/**
 * Marks the subscriber with this token as unsubscribed, effective immediately
 * (CAN-SPAM allows 10 business days; sending re-checks status per email).
 * Returns the email on success, or null for an unknown token.
 */
function unsubscribeByToken_(token) {
  token = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) return null;

  return withLock_(function () {
    var t = readTable_(SHEETS.SUBSCRIBERS);
    for (var i = 0; i < t.rows.length; i++) {
      var r = t.rows[i];
      if (t.get(r.values, 'Token') !== token) continue;
      if (t.get(r.values, 'Status') !== STATUS.UNSUBSCRIBED) {
        t.sheet.getRange(r.row, t.col('Status')).setValue(STATUS.UNSUBSCRIBED);
        t.sheet.getRange(r.row, t.col('Unsubscribed At')).setValue(new Date());
      }
      return normalizeEmail_(t.get(r.values, 'Email'));
    }
    return null;
  });
}

/** Current subscribed rows: [{ row, email, firstName, token }]. */
function getActiveSubscribers_() {
  var t = readTable_(SHEETS.SUBSCRIBERS);
  return t.rows
    .filter(function (r) {
      return t.get(r.values, 'Status') === STATUS.SUBSCRIBED && isValidEmail_(normalizeEmail_(t.get(r.values, 'Email')));
    })
    .map(function (r) {
      return {
        row: r.row,
        email: normalizeEmail_(t.get(r.values, 'Email')),
        firstName: String(t.get(r.values, 'First Name') || ''),
        token: t.get(r.values, 'Token')
      };
    });
}

/**
 * Re-reads one row right before sending, so an unsubscribe that lands mid-run
 * is honored. `table` is a readTable_() result (for its sheet and headers); the
 * token check catches rows that moved because someone deleted rows above.
 */
function isStillSubscribed_(table, row, token) {
  var values = table.sheet.getRange(row, 1, 1, table.headers.length).getValues()[0];
  return table.get(values, 'Token') === token && table.get(values, 'Status') === STATUS.SUBSCRIBED;
}

/** Backfills tokens for rows pasted in by hand (imports, the old EMS list). */
function fillMissingTokens() {
  requireOwner_();
  withLock_(function () {
    var t = readTable_(SHEETS.SUBSCRIBERS);
    t.rows.forEach(function (r) {
      if (!t.get(r.values, 'Token') && t.get(r.values, 'Email')) {
        t.sheet.getRange(r.row, t.col('Token')).setValue(newToken_());
        if (!t.get(r.values, 'Status')) t.sheet.getRange(r.row, t.col('Status')).setValue(STATUS.SUBSCRIBED);
      }
    });
  });
}
