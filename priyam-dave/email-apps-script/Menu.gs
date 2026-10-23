/** "EchoSphere Email" menu in the Sheet. */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('EchoSphere Email')
    .addItem('Send a test of a campaign…', 'menuSendTest')
    .addItem('Start sending a campaign…', 'menuStartCampaign')
    .addItem('Stop sending', 'menuStopSending')
    .addSeparator()
    .addItem('Set up tabs', 'setup')
    .addItem('Add unsubscribe tokens to imported rows', 'fillMissingTokens')
    .addToUi();
}

function menuSendTest() {
  requireOwner_();
  var ui = SpreadsheetApp.getUi();
  var name = ui.prompt('Send a test', 'Campaign name (from the Campaigns tab):', ui.ButtonSet.OK_CANCEL);
  if (name.getSelectedButton() !== ui.Button.OK) return;
  var to = ui.prompt('Send a test', 'Send the test to which address?', ui.ButtonSet.OK_CANCEL);
  if (to.getSelectedButton() !== ui.Button.OK) return;
  sendTest(name.getResponseText().trim(), to.getResponseText().trim());
  ui.alert('Test sent to ' + to.getResponseText().trim() + '.');
}

function menuStartCampaign() {
  requireOwner_();
  var ui = SpreadsheetApp.getUi();
  var name = ui.prompt('Start sending', 'Campaign name (from the Campaigns tab):', ui.ButtonSet.OK_CANCEL);
  if (name.getSelectedButton() !== ui.Button.OK) return;
  var campaign = name.getResponseText().trim();
  var sent = alreadySent_(campaign);
  var remaining = getActiveSubscribers_().filter(function (s) { return !sent[s.email]; }).length;
  var ok = ui.alert('Start sending',
    'Send "' + campaign + '" to ' + remaining + ' subscriber(s)? Sending continues in the background, up to ' +
    getSetting_('DAILY_CAP') + ' per day.', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  var result = startCampaign(campaign);
  ui.alert('Sending: ' + JSON.stringify(result));
}

function menuStopSending() {
  requireOwner_();
  stopSending();
  SpreadsheetApp.getUi().alert('Sending stopped. Already-sent emails are logged; starting again skips them.');
}
