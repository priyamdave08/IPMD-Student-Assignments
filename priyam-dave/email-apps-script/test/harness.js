// Runs the Apps Script .gs files in Node against in-memory fakes of the
// Google services they use. Not a Google emulator: it checks this project's
// own logic (signup, tokens, unsubscribe, sending, MIME) before deployment.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function makeSheet(name) {
  const data = [];
  const sheet = {
    name,
    data,
    appendRow(row) { data.push(row.slice()); },
    getLastRow() { return data.length; },
    setFrozenRows() {},
    getDataRange() { return { getValues: () => data.map((r) => r.slice()) }; },
    getRange(row, col, nr = 1, nc = 1) {
      return {
        setValue(v) {
          while (data.length < row) data.push([]);
          data[row - 1][col - 1] = v;
        },
        getValues() {
          const out = [];
          for (let r = 0; r < nr; r++) {
            const src = data[row - 1 + r] || [];
            const line = [];
            for (let c = 0; c < nc; c++) line.push(src[col - 1 + c] === undefined ? '' : src[col - 1 + c]);
            out.push(line);
          }
          return out;
        }
      };
    }
  };
  return sheet;
}

function createEnv() {
  const sheets = {};
  const props = {};
  const cache = {};
  const sent = [];
  const fetches = [];
  const triggers = [];
  const users = { active: 'pr@ipmdinc.com', effective: 'pr@ipmdinc.com' };
  const hooks = { onSend: null };

  const spreadsheet = {
    getId: () => 'sheet-123',
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n))
  };

  const ctx = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      openById: (id) => { if (id !== 'sheet-123') throw new Error('bad id'); return spreadsheet; }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; }
      })
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    Utilities: {
      Charset: { UTF_8: 'utf8' },
      getUuid: () => crypto.randomUUID(),
      base64Encode: (s) => Buffer.from(s, 'utf8').toString('base64'),
      base64EncodeWebSafe: (s) => Buffer.from(s, 'utf8').toString('base64url'),
      formatDate: (d) => d.toISOString().slice(0, 10)
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => users.active }),
      getEffectiveUser: () => ({ getEmail: () => users.effective }),
      getScriptTimeZone: () => 'America/Los_Angeles'
    },
    UrlFetchApp: { fetch: (url, opts) => { fetches.push({ url, opts }); return {}; } },
    Gmail: {
      Users: {
        Messages: {
          send: (msg) => {
            if (hooks.onSend) hooks.onSend(msg);
            sent.push(Buffer.from(msg.raw, 'base64url').toString('utf8'));
          }
        }
      }
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, mime: 'text', setMimeType(m) { this.mime = m; return this; } })
    },
    HtmlService: {
      createTemplateFromFile: (name) => ({
        name,
        evaluate() { const t = this; return { template: t, setTitle() { return this; }, addMetaTag() { return this; } }; }
      })
    },
    ScriptApp: {
      newTrigger: (fn) => {
        const t = { fn };
        const b = {
          timeBased: () => b,
          after: (ms) => { t.after = ms; return b; },
          at: (d) => { t.at = d; return b; },
          create: () => { triggers.push({ ...t, getHandlerFunction: () => fn }); }
        };
        return b;
      },
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => { triggers.splice(triggers.indexOf(t), 1); }
    }
  };
  vm.createContext(ctx);
  const dir = path.join(__dirname, '..');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  }
  return { ctx, sheets, props, cache, sent, fetches, triggers, users, hooks };
}

module.exports = { createEnv };
