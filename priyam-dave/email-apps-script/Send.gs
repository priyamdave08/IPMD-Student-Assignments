/**
 * Campaign sending. A campaign is one row of the Campaigns tab (Name, Subject,
 * HTML Body — {{first_name}} allowed in both). Sending is resumable:
 *  - every send is logged to Send Log before moving on, so a run that is cut
 *    off never re-sends to the same person;
 *  - a run stops at ~4.5 minutes (Apps Script's limit is 6) and schedules
 *    itself to continue a minute later;
 *  - at DAILY_CAP it pauses and resumes the next morning.
 */

var RUN_BUDGET_MS = 4.5 * 60 * 1000;

/**
 * Only the Sheet's own users (menu / editor) may run admin actions. An
 * anonymous web app visitor has no active user, so this blocks them from
 * calling these functions through google.script.run.
 */
function requireOwner_() {
  var active = Session.getActiveUser().getEmail();
  if (!active || active !== Session.getEffectiveUser().getEmail()) {
    throw new Error('Not authorized.');
  }
}

function findCampaign_(name) {
  var t = readTable_(SHEETS.CAMPAIGNS);
  for (var i = 0; i < t.rows.length; i++) {
    var r = t.rows[i];
    if (String(t.get(r.values, 'Name')).trim() === name) {
      return {
        table: t,
        row: r.row,
        name: name,
        subject: String(t.get(r.values, 'Subject') || ''),
        html: String(t.get(r.values, 'HTML Body') || '')
      };
    }
  }
  throw new Error('No campaign named "' + name + '" in the Campaigns tab.');
}

function setCampaignStatus_(c, status, sent) {
  c.table.sheet.getRange(c.row, c.table.col('Status')).setValue(status);
  c.table.sheet.getRange(c.row, c.table.col('Last Run')).setValue(new Date());
  if (sent !== undefined) c.table.sheet.getRange(c.row, c.table.col('Sent')).setValue(sent);
}

function log_(campaign, email, result, detail) {
  getSheet_(SHEETS.SEND_LOG).appendRow([new Date(), campaign, email, result, detail || '']);
}

function alreadySent_(campaign) {
  var t = readTable_(SHEETS.SEND_LOG);
  var sent = {};
  t.rows.forEach(function (r) {
    if (t.get(r.values, 'Campaign') === campaign && t.get(r.values, 'Result') === 'sent') {
      sent[String(t.get(r.values, 'Email')).toLowerCase()] = true;
    }
  });
  return sent;
}

function todayKey_() {
  return 'SENT_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function sentToday_() {
  return Number(PropertiesService.getScriptProperties().getProperty(todayKey_()) || 0);
}

function countSend_() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty(todayKey_(), String(sentToday_() + 1));
}

function scheduleContinue_(when) {
  clearContinueTriggers_();
  var b = ScriptApp.newTrigger('continueSending').timeBased();
  (when ? b.at(when) : b.after(60 * 1000)).create();
}

function clearContinueTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'continueSending') ScriptApp.deleteTrigger(tr);
  });
}

function tomorrowMorning_() {
  var d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

/** Starts (or restarts) sending a campaign to every current subscriber. */
function startCampaign(name) {
  requireOwner_();
  var c = findCampaign_(name);
  if (!c.subject || !c.html) throw new Error('Campaign "' + name + '" needs a Subject and HTML Body.');
  if (!getSetting_('WEB_APP_URL')) throw new Error('Set WEB_APP_URL first (deploy the web app).');
  if (/pending|placeholder|\[/i.test(getSetting_('POSTAL_ADDRESS'))) {
    throw new Error('POSTAL_ADDRESS is still a placeholder. CAN-SPAM requires a real mailing address before a real send. Test sends still work.');
  }
  PropertiesService.getScriptProperties().setProperty('ACTIVE_CAMPAIGN', name);
  setCampaignStatus_(c, 'Sending');
  return runSend_();
}

/** Trigger target for resuming. Only continues a campaign an owner started. */
function continueSending() {
  if (!PropertiesService.getScriptProperties().getProperty('ACTIVE_CAMPAIGN')) return;
  runSend_();
}

function stopSending() {
  requireOwner_();
  var props = PropertiesService.getScriptProperties();
  var name = props.getProperty('ACTIVE_CAMPAIGN');
  props.deleteProperty('ACTIVE_CAMPAIGN');
  clearContinueTriggers_();
  if (name) setCampaignStatus_(findCampaign_(name), 'Stopped');
}

function runSend_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { state: 'busy' };
  try {
    var name = PropertiesService.getScriptProperties().getProperty('ACTIVE_CAMPAIGN');
    if (!name) return { state: 'idle' };

    var c = findCampaign_(name);
    var fromEmail = Session.getEffectiveUser().getEmail();
    var cap = Number(getSetting_('DAILY_CAP')) || 1400;
    var started = Date.now();
    var sent = alreadySent_(name);
    var subsTable = readTable_(SHEETS.SUBSCRIBERS);
    var queue = getActiveSubscribers_().filter(function (s) { return !sent[s.email]; });
    var sentThisRun = 0;

    for (var i = 0; i < queue.length; i++) {
      if (Date.now() - started > RUN_BUDGET_MS) {
        scheduleContinue_();
        return { state: 'continuing', sent: sentThisRun, remaining: queue.length - i };
      }
      if (sentToday_() >= cap) {
        scheduleContinue_(tomorrowMorning_());
        setCampaignStatus_(c, 'Paused (daily cap)');
        return { state: 'daily_cap', sent: sentThisRun, remaining: queue.length - i };
      }
      var s = queue[i];
      if (!isStillSubscribed_(subsTable, s.row, s.token)) continue;
      try {
        sendRaw_(composeEmail_(s, c, fromEmail));
        log_(name, s.email, 'sent');
        countSend_();
        subsTable.sheet.getRange(s.row, subsTable.col('Last Sent')).setValue(new Date());
        sentThisRun++;
      } catch (err) {
        var msg = String(err && err.message || err);
        log_(name, s.email, 'error', msg.slice(0, 300));
        if (/limit|too many times|quota|rate/i.test(msg)) {
          scheduleContinue_(tomorrowMorning_());
          setCampaignStatus_(c, 'Paused (Gmail limit)');
          return { state: 'gmail_limit', sent: sentThisRun, remaining: queue.length - i };
        }
      }
    }

    PropertiesService.getScriptProperties().deleteProperty('ACTIVE_CAMPAIGN');
    clearContinueTriggers_();
    setCampaignStatus_(c, 'Sent', Object.keys(alreadySent_(name)).length);
    return { state: 'done', sent: sentThisRun };
  } finally {
    lock.releaseLock();
  }
}

/** Sends one copy of a campaign to `to`, marked [TEST]. Not logged, not counted against subscribers. */
function sendTest(name, to) {
  requireOwner_();
  var c = findCampaign_(name);
  to = normalizeEmail_(to);
  if (!isValidEmail_(to)) throw new Error('Invalid test address: ' + to);
  var fake = { email: to, firstName: 'Test', token: 'test-link-not-a-real-subscriber' };
  sendRaw_(composeEmail_(fake, { subject: '[TEST] ' + c.subject, html: c.html }, Session.getEffectiveUser().getEmail()));
  countSend_();
}
