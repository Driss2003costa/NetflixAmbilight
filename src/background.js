// Service worker : capture d'onglet (mode auto), pilotage du flux temps réel via un document
// offscreen, et raccourci clavier.
importScripts('shared/settings.js', 'shared/sampler.js');

const { settings: S, sampler } = self.CineHalo;

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const CAPTURE_GAP_MS = 510; // Chrome autorise 2 captureVisibleTab par seconde

// ---------- Mode auto : captureVisibleTab ----------

let lastCapture = 0;
let captureChain = Promise.resolve();
let work = null; // { canvas, ctx } réutilisé d'une capture à l'autre

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function throttledCapture(windowId) {
  const run = async () => {
    const wait = lastCapture + CAPTURE_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCapture = Date.now();
    return chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 });
  };
  const p = captureChain.then(run, run);
  captureChain = p.catch(() => {});
  return p;
}

function classifyError(e) {
  const msg = String((e && e.message) || e);
  if (/activeTab|all_urls|invoked|permission/i.test(msg)) return 'permission';
  if (/MAX_CAPTURE|quota/i.test(msg)) return 'quota';
  return 'capture';
}

function context2d(w, h) {
  if (!work || work.canvas.width !== w || work.canvas.height !== h) {
    const canvas = new OffscreenCanvas(w, h);
    work = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  return work.ctx;
}

async function handleCapture(msg, sender) {
  const tab = sender.tab;
  if (!tab || !tab.active) return { ok: false, error: 'inactive' };
  let dataUrl;
  try {
    dataUrl = await throttledCapture(tab.windowId);
  } catch (e) {
    return { ok: false, error: classifyError(e), message: String((e && e.message) || e) };
  }
  try {
    const { w, h } = sampler.targetSize(msg.params.view.w, msg.params.view.h);
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' });
    const ctx = context2d(w, h);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const { data } = ctx.getImageData(0, 0, w, h);
    return { ok: true, frame: sampler.sample(data, w, h, msg.params) };
  } catch (e) {
    return { ok: false, error: 'decode', message: String((e && e.message) || e) };
  }
}

// ---------- Mode temps réel : tabCapture + offscreen ----------

let creatingOffscreen = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['USER_MEDIA'],
        justification: 'Lire le flux de l’onglet pour calculer les couleurs de la lueur.',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

async function sendToOffscreen(message, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(100);
    }
  }
}

async function currentRealtime() {
  const { rt } = await chrome.storage.session.get('rt');
  return rt || null;
}

async function startRealtime(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return { ok: false, error: 'no-tab' };
  const rt = await currentRealtime();
  if (rt && rt.tabId === tabId && (await hasOffscreen())) return updateRealtime(msg, sender);
  if (rt) await stopRealtime(rt.tabId);

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    return { ok: false, error: classifyError(e), message: String((e && e.message) || e) };
  }
  try {
    await ensureOffscreen();
    await chrome.storage.session.set({ rt: { tabId } });
    const res = await sendToOffscreen({
      type: 'rt-start',
      streamId,
      tabId,
      params: msg.params,
      active: msg.active,
      fps: msg.fps,
    });
    if (res && res.ok) return { ok: true };
    await stopRealtime(tabId);
    return { ok: false, error: (res && res.error) || 'offscreen', message: res && res.message };
  } catch (e) {
    await stopRealtime(tabId);
    return { ok: false, error: 'offscreen', message: String((e && e.message) || e) };
  }
}

async function updateRealtime(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  const rt = await currentRealtime();
  if (!rt || rt.tabId !== tabId) return { ok: false, error: 'not-running' };
  try {
    const res = await sendToOffscreen(
      { type: 'rt-update', tabId, params: msg.params, active: msg.active, fps: msg.fps },
      1,
    );
    return { ok: !!(res && res.ok), error: res && res.ok ? undefined : 'not-running' };
  } catch {
    await chrome.storage.session.remove('rt');
    return { ok: false, error: 'not-running' };
  }
}

async function stopRealtime(tabId) {
  const rt = await currentRealtime();
  if (!rt || (tabId != null && rt.tabId !== tabId)) return;
  await sendToOffscreen({ type: 'rt-stop' }, 1).catch(() => {});
  await chrome.storage.session.remove('rt');
  await closeOffscreen();
}

async function onOffscreenStopped(msg) {
  const rt = await currentRealtime();
  if (rt && rt.tabId === msg.tabId) {
    await chrome.storage.session.remove('rt');
    await closeOffscreen();
  }
  chrome.tabs.sendMessage(msg.tabId, { type: 'rt-ended', reason: msg.reason }).catch(() => {});
}

// ---------- Messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  const reply = (promise) => {
    promise.then(sendResponse, (e) => sendResponse({ ok: false, error: 'internal', message: String(e) }));
    return true;
  };
  switch (msg.type) {
    case 'capture':
      return reply(handleCapture(msg, sender));
    case 'rt-start':
      return reply(startRealtime(msg, sender));
    case 'rt-update':
      return reply(updateRealtime(msg, sender));
    case 'rt-stop':
      return reply(stopRealtime(sender.tab && sender.tab.id).then(() => ({ ok: true })));
    case 'rt-frame':
      // Relais offscreen -> onglet : l'offscreen n'a pas accès à chrome.tabs.
      chrome.tabs.sendMessage(msg.tabId, { type: 'frame', frame: msg.frame }).catch(() => {});
      return false;
    case 'rt-stopped':
      onOffscreenStopped(msg);
      return false;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stopRealtime(tabId);
});

// Le raccourci accorde aussi activeTab, comme un clic sur l'icône. Si la lueur attendait justement
// ce clic, on l'active au lieu de l'éteindre.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-glow') return;
  const tabId = tab && tab.id != null ? tab.id : null;
  const cfg = await S.load();
  const status = tabId == null ? null : await chrome.tabs.sendMessage(tabId, { type: 'get-status' }).catch(() => null);
  if (cfg.enabled && status && status.status === 'needs-click') {
    chrome.tabs.sendMessage(tabId, { type: 'activate' }).catch(() => {});
    return;
  }
  const enabled = !cfg.enabled;
  await chrome.storage.sync.set({ enabled });
  if (enabled && tabId != null) chrome.tabs.sendMessage(tabId, { type: 'activate' }).catch(() => {});
});
