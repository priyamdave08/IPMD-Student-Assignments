/**
 * IPMD / EchoSphere email system — Google Sheets + Apps Script.
 *
 * Settings live in Script Properties (Project Settings → Script properties),
 * never in code, so this file can be shared or committed safely. setup()
 * writes the defaults below for any property that is missing.
 */

var SHEETS = {
  SUBSCRIBERS: 'Subscribers',
  CAMPAIGNS: 'Campaigns',
  SEND_LOG: 'Send Log'
};

// Column headers, in order. Code looks columns up by header name, so people
// can add their own columns to the right without breaking anything.
var HEADERS = {
  Subscribers: ['Email', 'First Name', 'Source', 'Signed Up', 'Status', 'Unsubscribed At', 'Last Sent', 'Token'],
  Campaigns: ['Name', 'Subject', 'HTML Body', 'Status', 'Sent', 'Last Run'],
  'Send Log': ['Timestamp', 'Campaign', 'Email', 'Result', 'Detail']
};

var STATUS = { SUBSCRIBED: 'subscribed', UNSUBSCRIBED: 'unsubscribed' };

var DEFAULT_SETTINGS = {
  SENDER_NAME: 'EchoSphere',
  // Placeholder until Min confirms the business address (CAN-SPAM requires a
  // real physical address before any real campaign goes out).
  POSTAL_ADDRESS: 'IPMD Inc., [business address pending]',
  // Workspace accounts may send to 1,500 recipients/day via Apps Script; stay
  // under it so test sends and replies still go through.
  DAILY_CAP: '1400',
  // Set after the first web app deployment: the .../exec URL.
  WEB_APP_URL: '',
  // Optional: Mosaic endpoint notified on each new signup, and its shared secret.
  MOSAIC_WEBHOOK_URL: '',
  MOSAIC_SECRET: ''
};

function getSetting_(key) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  if (value === null || value === '') {
    return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key) ? DEFAULT_SETTINGS[key] : '';
  }
  return value;
}

function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name) {
  var sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error('Missing sheet "' + name + '". Run setup() first.');
  return sheet;
}

/**
 * One-time setup: creates the three tabs with headers, records the Sheet id
 * (web app requests have no "active" spreadsheet otherwise), and fills in
 * default settings. Safe to run again.
 */
function setup() {
  requireOwner_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SHEET_ID', ss.getId());

  Object.keys(HEADERS).forEach(function (name) {
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS[name]);
      sheet.setFrozenRows(1);
    }
  });

  Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
    if (props.getProperty(key) === null) props.setProperty(key, DEFAULT_SETTINGS[key]);
  });
}
