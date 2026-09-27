/**
 * =============================================================================
 * CAPTION STUDIO — AI PROXY (Google Apps Script)
 *
 * The tool (index.html) is a static page, so it can't hold an API key: anyone
 * could read it. This script sits between the page and the model. It holds the
 * key in Script Properties, fixes the model and token budget server-side,
 * bounds the size of what it will relay, relays the request, and enforces the
 * free tier's caption limit.
 *
 * CONTRACT
 *   Request  (from index.html): { "_token": "<token>", "_client": "<device id>",
 *                                 "_rid": "<request id>", "messages": [ ... ] }
 *            or, for the Settings → Test endpoint button:
 *                                 { "_token": "<token>", "_client": "<device id>", "_ping": true }
 *   Response (to index.html):   the model's raw /v1/messages JSON, plus a
 *                               `_usage` object. Success has a `content` array;
 *                               any failure has an `error` field. The page
 *                               branches on `error`, and on
 *                               `error.type === "limit_reached"` shows the wall.
 *
 *   _rid makes a request idempotent: if the page retries the same _rid within
 *   ten minutes (a reply lost to bad signal), the cached reply comes back and
 *   nothing is charged twice.
 *
 * TIERS
 *   PROXY_TOKEN        the free token. It ships inside the public page, so it is
 *                      a soft gate, not a secret. Each device gets FREE_LIMIT
 *                      captions for life, and all free devices together get
 *                      FREE_DAILY_CEILING per day (bill protection).
 *   UNLIMITED_TOKENS   optional, comma-separated. A token on this list has no
 *                      caption limit. Hand one to a paying customer; they paste
 *                      it in Settings. Rotate by editing the property.
 *
 *   A device is a random id the page generates and keeps in localStorage.
 *   Clearing site data resets it. That is the honest limit of a free tier with
 *   no accounts; the daily ceiling and the request-size bounds are what
 *   actually protect the bill.
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
  MODEL: 'claude-sonnet-5',     // vision-capable; change here only, never from the page
  MAX_TOKENS: 1200,

  FREE_LIMIT: 10,               // captions per device, for life, on the free token. 0 = no per-device limit
  FREE_DAILY_CEILING: 200,      // captions per UTC day across ALL free devices. 0 = off

  // Request-size bounds. The page sends at most 6 photos downscaled to 1280px
  // (well under 500 KB each as base64) plus one prompt of about 2,000 characters.
  // Anything bigger is not the page talking.
  MAX_IMAGES: 6,
  MAX_IMAGE_B64_CHARS: 1200000,  // ~900 KB decoded
  MAX_TEXT_CHARS: 6000,
  MAX_BODY_CHARS: 8000000,

  PING_CACHE_SECONDS: 600,      // a real model round-trip for Test endpoint at most once per 10 min
  REPLY_CACHE_SECONDS: 600,     // how long a reply is held for an idempotent retry

  UPGRADE_URL: 'https://www.bradybaxter.com',
  UPGRADE_CTA: "Contact Brady and let's build your own tool",
  // {n} is replaced with FREE_LIMIT
  UPGRADE_MESSAGE: "That's your {n} free captions. Want this built for your business, with your voice, your tags, and no limit?"
};

function doPost(e) {
  try {
    return handle(e);
  } catch (err) {
    // Whatever happens, the page gets JSON, never an HTML error page.
    return jsonOut({ error: 'Proxy failure: ' + String(err && err.message || err) });
  }
}

function handle(e) {
  var raw = e && e.postData && e.postData.contents || '';
  if (raw.length > CONFIG.MAX_BODY_CHARS) return jsonOut({ error: 'Request too large' });
  var body;
  try { body = JSON.parse(raw); }
  catch (err) { return jsonOut({ error: 'Request body is not valid JSON' }); }
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
  if (!client) return jsonOut({ error: 'Missing device id' });

  // Settings → Test endpoint. Proves the key and deployment work with a fixed,
  // tiny request, never relays the caller's own messages, never counts, and hits
  // the model at most once per PING_CACHE_SECONDS no matter how often it's called.
  if (body._ping === true) {
    var cache = CacheService.getScriptCache();
    var okText = cache.get('ping-ok');
    if (okText) {
      return jsonOut(withUsage({ content: [{ type: 'text', text: okText }], cached: true }, usageFor(tier, client, props)));
    }
    var pingResp = callModel(apiKey, [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ready' }] }]);
    if (pingResp.body && pingResp.body.content) {
      var t = textOf(pingResp.body) || 'ready';
      cache.put('ping-ok', t, CONFIG.PING_CACHE_SECONDS);
    }
    return jsonOut(withUsage(pingResp.body, usageFor(tier, client, props)));
  }

  var shape = validateMessages(body.messages);
  if (shape) return jsonOut({ error: shape });

  // Idempotent retry: same device + same request id within the cache window
  // returns the reply already paid for.
  var rid = typeof body._rid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body._rid) ? body._rid : '';
  var replyKey = rid ? 'r:' + client + ':' + rid : '';
  if (replyKey) {
    var prior = CacheService.getScriptCache().get(replyKey);
    if (prior) {
      try { return jsonOut(withUsage(JSON.parse(prior), usageFor(tier, client, props))); }
      catch (ignore) { /* fall through to a fresh call */ }
    }
  }

  // Free tier: reserve one caption under a lock before calling the model, so
  // two simultaneous requests can't both slip past the last slot. A failure on
  // our side or the model's side refunds it; a rejected request does not.
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
      if (gate.reason === 'storage') {
        return jsonOut({ error: 'The free tier is full right now. Try again later.' });
      }
      return jsonOut(withUsage({ error: { type: 'limit_reached', message: upgradeMessage() } }, usage));
    }
    reserved = true;
  }

  var resp = callModel(apiKey, body.messages);
  var delivered = !!(resp.body && resp.body.content);
  if (reserved && !delivered && refundable(resp)) refundFree(client, props);

  if (delivered && replyKey) {
    var s = JSON.stringify(resp.body);
    if (s.length < 90000) CacheService.getScriptCache().put(replyKey, s, CONFIG.REPLY_CACHE_SECONDS);
  }
  return jsonOut(withUsage(resp.body, usageFor(tier, client, props)));
}

/* ---- REQUEST SHAPE ------------------------------------------------------
   The page sends exactly one user message: up to MAX_IMAGES base64 JPEG/PNG/WebP
   images and one text block. Anything else is refused before it costs money. */
function validateMessages(messages) {
  if (!messages || !Array.isArray(messages) || messages.length !== 1) return 'Expected exactly one message';
  var m = messages[0];
  if (!m || m.role !== 'user' || !Array.isArray(m.content) || !m.content.length) return 'Expected one user message with content';
  if (m.content.length > CONFIG.MAX_IMAGES + 1) return 'Too many content blocks';
  var images = 0, textChars = 0;
  for (var i = 0; i < m.content.length; i++) {
    var b = m.content[i];
    if (!b || typeof b !== 'object') return 'Bad content block';
    if (b.type === 'text') {
      if (typeof b.text !== 'string') return 'Bad text block';
      textChars += b.text.length;
    } else if (b.type === 'image') {
      images++;
      var src = b.source;
      if (!src || src.type !== 'base64' || typeof src.data !== 'string') return 'Bad image block';
      if (['image/jpeg', 'image/png', 'image/webp'].indexOf(src.media_type) < 0) return 'Unsupported image type';
      if (src.data.length > CONFIG.MAX_IMAGE_B64_CHARS) return 'Image too large';
    } else {
      return 'Unsupported content type';
    }
  }
  if (images > CONFIG.MAX_IMAGES) return 'Too many images';
  if (textChars > CONFIG.MAX_TEXT_CHARS) return 'Prompt too long';
  return '';
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
    var status = r.getResponseCode();
    try { return { status: status, body: JSON.parse(r.getContentText()) }; }
    catch (parseErr) { return { status: status, body: { error: 'Model returned a non-JSON response (HTTP ' + status + ')' } }; }
  } catch (err) {
    return { status: 0, body: { error: 'Proxy fetch failed: ' + String(err && err.message || err) } };
  }
}
/* A caption is refunded when the failure was ours or the model's (network,
   5xx, overloaded, rate-limited). A request the model rejected as malformed
   (4xx) stays charged, so a bad request can't be looped for free. */
function refundable(resp) {
  return resp.status === 0 || resp.status === 429 || resp.status >= 500;
}
function textOf(body) {
  var out = [];
  (body.content || []).forEach(function (b) { if (b.type === 'text' && b.text) out.push(b.text); });
  return out.join('\n').trim();
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
    try {
      props.setProperty('u:' + client, String(used + 1));
      props.setProperty(dayKey, String(day + 1));
    } catch (storeErr) {
      // Script Properties is full (see pruneDevices). Fail closed, in JSON.
      return { ok: false, reason: 'storage' };
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}
function refundFree(client, props) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    var used = +(props.getProperty('u:' + client) || 0);
    props.setProperty('u:' + client, String(Math.max(0, used - 1)));
    var dayKey = 'd:' + todayUTC();
    var day = +(props.getProperty(dayKey) || 0);
    props.setProperty(dayKey, String(Math.max(0, day - 1)));
  } catch (ignore) {
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
    note: 'POST { _token, _client, _rid, messages } to use the proxy.'
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
  var devices = 0, captions = 0, maxed = 0, bytes = 0;
  for (var k in all) {
    bytes += k.length + String(all[k]).length;
    if (k.indexOf('u:') === 0) {
      devices++; captions += +all[k];
      if (+all[k] >= CONFIG.FREE_LIMIT) maxed++;
    }
  }
  Logger.log('Devices: ' + devices + ' · captions: ' + captions + ' · at limit: ' + maxed);
  Logger.log('Today: ' + (all['d:' + todayUTC()] || 0) + ' / ' + CONFIG.FREE_DAILY_CEILING);
  Logger.log('Properties store: ~' + Math.round(bytes / 1024) + ' KB of 500 KB');
}

/* Script Properties hold about 500 KB, roughly 7,000 device counters. When
   usageReport() shows the store filling up, run this: it drops the counters of
   devices that never reached the limit (they were not blocked anyway; they get
   a fresh count) and keeps the ones at the limit, which are the ones that matter. */
function pruneDevices() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var n = 0;
  for (var k in all) {
    if (k.indexOf('u:') === 0 && +all[k] < CONFIG.FREE_LIMIT) { props.deleteProperty(k); n++; }
  }
  Logger.log('Pruned ' + n + ' device counter(s) below the limit');
}

/* Drop day counters older than 30 days. Run occasionally, or add a monthly
   time-driven trigger for it. */
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
