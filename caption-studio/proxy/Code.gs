/**
 * =============================================================================
 * CAPTION STUDIO — AI PROXY (Google Apps Script)
 *
 * The tool (index.html) is a static page, so it can't hold an API key: anyone
 * could read it. This script sits between the page and the model. It holds the
 * key in Script Properties, fixes the model and token budget server-side so a
 * visitor can't run up your bill, relays the request, and enforces the free
 * tier's caption limit.
 *
 * CONTRACT
 *   Request  (from index.html): { "_token": "<token>", "_client": "<device id>",
 *                                 "messages": [ ... ] }
 *            or, for the Settings → Test endpoint button:
 *                                 { "_token": "<token>", "_client": "<device id>", "_ping": true }
 *   Response (to index.html):   the model's raw /v1/messages JSON, plus a
 *                               `_usage` object. Success has a `content` array;
 *                               any failure has an `error` field. The page
 *                               branches on `error`, and on
 *                               `error.type === "limit_reached"` shows the wall.
 *
 * TIERS
 *   PROXY_TOKEN        the free token. It ships inside the public page, so it is
 *                      a soft gate, not a secret. Each device gets FREE_LIMIT
 *                      captions for life, and all free devices together get
 *                      FREE_DAILY_CEILING per day (bill protection).
 *   UNLIMITED_TOKENS   optional, comma-separated. A token on this list has no
 *                      limit. Hand one to a paying customer; they paste it in
 *                      Settings. Rotate by editing the property.
 *
 *   A device is a random id the page generates and keeps in localStorage.
 *   Clearing site data resets it. That is the honest limit of a free tier with
 *   no accounts; the daily ceiling is what actually protects the bill.
 *
 * SETUP (about ten minutes)
 *   1. script.google.com → New project → paste this file over Code.gs.
 *   2. Project Settings (gear) → Script Properties → add:
 *        ANTHROPIC_API_KEY   your sk-ant- key
 *        PROXY_TOKEN         any long random string
 *        UNLIMITED_TOKENS    (optional) comma-separated paid tokens
 *   3. Run setupCheck() once from the editor (▶) and approve the permissions.
 *   4. Deploy → New deployment → Web app → Execute as: Me → Who has access:
 *      Anyone → Deploy. Copy the URL ending in /exec.
 *   5. Put the /exec URL and PROXY_TOKEN into FREE_PROXY_URL / FREE_PROXY_TOKEN
 *      at the top of index.html's script (the free tier), or paste them into
 *      Settings on one device and press "Test endpoint".
 *
 *   Redeploy gotcha: editing this file does NOT update the live URL. After any
 *   change: Deploy → Manage deployments → pencil → Version: New version → Deploy.
 *
 * SECRETS never belong in this file or in the HTML. Script Properties only.
 * =============================================================================
 */

var CONFIG = {
  ANTHROPIC_URL: 'https://api.anthropic.com/v1/messages',
  ANTHROPIC_VERSION: '2023-06-01',
  MODEL: 'claude-sonnet-4-6',   // vision-capable; change here only, never from the page
  MAX_TOKENS: 1000,

  FREE_LIMIT: 10,               // captions per device, for life, on the free token. 0 = no per-device limit
  FREE_DAILY_CEILING: 200,      // captions per UTC day across ALL free devices. 0 = off

  UPGRADE_URL: 'https://www.bradybaxter.com',
  UPGRADE_CTA: "Contact Brady and let's build your own tool",
  // {n} is replaced with FREE_LIMIT
  UPGRADE_MESSAGE: "That's your {n} free captions. Want this built for your business, with your voice, your tags, and no limit?"
};

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e && e.postData && e.postData.contents || '');
  } catch (err) {
    return jsonOut({ error: 'Request body is not valid JSON' });
  }
  if (!body || typeof body !== 'object') return jsonOut({ error: 'Request body is not valid JSON' });

  var props = PropertiesService.getScriptProperties();
  var freeToken = props.getProperty('PROXY_TOKEN');
  var apiKey = props.getProperty('ANTHROPIC_API_KEY');
  var unlimited = (props.getProperty('UNLIMITED_TOKENS') || '').split(',')
    .map(function (s) { return s.trim(); }).filter(Boolean);

  if (!freeToken || !apiKey) {
    return jsonOut({ error: 'Proxy not configured: set PROXY_TOKEN and ANTHROPIC_API_KEY in Script Properties.' });
  }

  var token = typeof body._token === 'string' ? body._token : '';
  var tier;
  if (token && unlimited.indexOf(token) >= 0) tier = 'unlimited';
  else if (token && token === freeToken) tier = 'free';
  else return jsonOut({ error: 'Bad or missing token' });

  // Device id: the page generates one and keeps it. Only shape-checked here.
  var client = typeof body._client === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body._client) ? body._client : '';
  if (tier === 'free' && CONFIG.FREE_LIMIT > 0 && !client) {
    return jsonOut({ error: 'Missing device id' });
  }

  // Settings → Test endpoint. Proves the key and deployment work with a fixed,
  // tiny request. Never counts, and never relays the caller's own messages.
  if (body._ping === true) {
    var pingResp = callModel(apiKey, [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ready' }] }]);
    return jsonOut(withUsage(pingResp, usageFor(tier, client, props)));
  }

  if (!body.messages || !Array.isArray(body.messages) || !body.messages.length) {
    return jsonOut({ error: 'Missing or empty messages array' });
  }

  // Free tier: reserve one caption under a lock before calling the model, so
  // two simultaneous requests can't both slip past the last slot. A failed
  // model call refunds it below.
  var reserved = false;
  if (tier === 'free') {
    var gate = reserveFree(client, props);
    if (!gate.ok) {
      var usage = usageFor(tier, client, props);
      if (gate.reason === 'daily') {
        return jsonOut(withUsage({ error: { type: 'free_tier_paused', message: 'The free tier has hit its daily ceiling. Try again tomorrow.' } }, usage));
      }
      if (gate.reason === 'busy') {
        return jsonOut({ error: 'The proxy is busy. Try again in a few seconds.' });
      }
      return jsonOut(withUsage({ error: { type: 'limit_reached', message: upgradeMessage() } }, usage));
    }
    reserved = true;
  }

  var resp = callModel(apiKey, body.messages);
  if (reserved && !(resp && resp.content)) refundFree(client, props);
  return jsonOut(withUsage(resp, usageFor(tier, client, props)));
}

/* ---- MODEL CALL -------------------------------------------------------- */
function callModel(apiKey, messages) {
  // Model and max_tokens are fixed here so the browser can't override them.
  var payload = { model: CONFIG.MODEL, max_tokens: CONFIG.MAX_TOKENS, messages: messages };
  try {
    var r = UrlFetchApp.fetch(CONFIG.ANTHROPIC_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': CONFIG.ANTHROPIC_VERSION },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true   // pass the model's error body through unchanged
    });
    try { return JSON.parse(r.getContentText()); }
    catch (parseErr) { return { error: 'Model returned a non-JSON response (HTTP ' + r.getResponseCode() + ')' }; }
  } catch (err) {
    return { error: 'Proxy fetch failed: ' + String(err && err.message || err) };
  }
}

/* ---- FREE-TIER COUNTERS --------------------------------------------------
   Script Properties hold two kinds of counter:
     u:<device id>   captions used by that device, for life
     d:<YYYY-MM-DD>  captions used by all free devices that UTC day
   LockService serializes read-increment-write. */
function reserveFree(client, props) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, reason: 'busy' };
  try {
    var used = +(props.getProperty('u:' + client) || 0);
    if (CONFIG.FREE_LIMIT > 0 && used >= CONFIG.FREE_LIMIT) return { ok: false, reason: 'device' };
    var dayKey = 'd:' + todayUTC();
    var day = +(props.getProperty(dayKey) || 0);
    if (CONFIG.FREE_DAILY_CEILING > 0 && day >= CONFIG.FREE_DAILY_CEILING) return { ok: false, reason: 'daily' };
    if (client) props.setProperty('u:' + client, String(used + 1));
    props.setProperty(dayKey, String(day + 1));
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}
function refundFree(client, props) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    if (client) {
      var used = +(props.getProperty('u:' + client) || 0);
      props.setProperty('u:' + client, String(Math.max(0, used - 1)));
    }
    var dayKey = 'd:' + todayUTC();
    var day = +(props.getProperty(dayKey) || 0);
    props.setProperty(dayKey, String(Math.max(0, day - 1)));
  } finally {
    lock.releaseLock();
  }
}
function usageFor(tier, client, props) {
  if (tier !== 'free' || CONFIG.FREE_LIMIT <= 0) {
    return { tier: tier, used: null, limit: null, remaining: null };
  }
  var used = +(props.getProperty('u:' + client) || 0);
  return {
    tier: 'free',
    used: used,
    limit: CONFIG.FREE_LIMIT,
    remaining: Math.max(0, CONFIG.FREE_LIMIT - used),
    upgradeUrl: CONFIG.UPGRADE_URL,
    upgradeCta: CONFIG.UPGRADE_CTA,
    upgradeMessage: upgradeMessage()
  };
}
function upgradeMessage() { return CONFIG.UPGRADE_MESSAGE.replace('{n}', String(CONFIG.FREE_LIMIT)); }
function withUsage(obj, usage) { obj = obj || {}; obj._usage = usage; return obj; }
function todayUTC() { return Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd'); }

/* Open the /exec URL in a browser: this JSON means the web app is reachable.
   It never reveals whether the key is set. */
function doGet() {
  return jsonOut({
    ok: true,
    service: 'caption-studio-proxy',
    model: CONFIG.MODEL,
    freeLimit: CONFIG.FREE_LIMIT,
    note: 'POST { _token, _client, messages } to use the proxy.'
  });
}

/* ---- MAINTENANCE (run from the editor) ------------------------------------ */

/* Run once after setting Script Properties. Authorizes UrlFetch and confirms
   the secrets exist WITHOUT logging their values. */
function setupCheck() {
  var props = PropertiesService.getScriptProperties();
  var hasToken = !!props.getProperty('PROXY_TOKEN');
  var hasKey = !!props.getProperty('ANTHROPIC_API_KEY');
  var paid = (props.getProperty('UNLIMITED_TOKENS') || '').split(',').filter(function (s) { return s.trim(); }).length;
  Logger.log('PROXY_TOKEN set: ' + hasToken);
  Logger.log('ANTHROPIC_API_KEY set: ' + hasKey);
  Logger.log('UNLIMITED_TOKENS: ' + paid + ' token(s)');
  Logger.log('Model: ' + CONFIG.MODEL + ' · max_tokens: ' + CONFIG.MAX_TOKENS);
  Logger.log('Free tier: ' + CONFIG.FREE_LIMIT + ' per device, ' + CONFIG.FREE_DAILY_CEILING + ' per day overall');
  if (!hasToken || !hasKey) {
    Logger.log('>> Set the missing property under Project Settings → Script Properties, then re-run.');
  }
}

/* Give one device its free captions back: paste its id from the page's
   Settings panel into the string below and run. */
function resetDevice() {
  var deviceId = 'PASTE-DEVICE-ID-HERE';
  PropertiesService.getScriptProperties().deleteProperty('u:' + deviceId);
  Logger.log('Reset ' + deviceId);
}

/* Show how many devices have used the free tier and today's total. */
function usageReport() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var devices = 0, captions = 0, maxed = 0;
  for (var k in all) {
    if (k.indexOf('u:') === 0) {
      devices++; captions += +all[k];
      if (+all[k] >= CONFIG.FREE_LIMIT) maxed++;
    }
  }
  Logger.log('Devices: ' + devices + ' · captions: ' + captions + ' · at limit: ' + maxed);
  Logger.log('Today: ' + (all['d:' + todayUTC()] || 0) + ' / ' + CONFIG.FREE_DAILY_CEILING);
}

/* Drop day counters older than 30 days so Script Properties stay small.
   Run occasionally, or add a monthly time-driven trigger for it. */
function pruneOldDays() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var cutoff = Utilities.formatDate(new Date(Date.now() - 30 * 86400000), 'UTC', 'yyyy-MM-dd');
  var n = 0;
  for (var k in all) if (k.indexOf('d:') === 0 && k.slice(2) < cutoff) { props.deleteProperty(k); n++; }
  Logger.log('Pruned ' + n + ' day counter(s)');
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
