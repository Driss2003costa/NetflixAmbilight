// Content script Netflix : trouve la vidéo, calcule les bandes noires, demande les couleurs
// (capture auto ou flux temps réel) et anime la lueur.
(() => {
  'use strict';
  if (globalThis.__cineHaloLoaded) return;
  globalThis.__cineHaloLoaded = true;

  const { settings: S, sampler, baked, Panel } = globalThis.CineHalo;
  const SIDES = ['left', 'right', 'top', 'bottom'];
  const ZERO = baked.ZERO;

  const MIN_BAR_PX = 12;
  const MIN_BAR_FRAC = 0.02;
  const FILL_FRAC = 0.97; // l'image doit remplir l'écran sur au moins un axe (sinon : mini-lecteur, générique...)
  const BLACK_PEAK = 0.02;
  const BLACK_MS = 20000;
  const ECO_MAX_ZONES = 12;

  const state = {
    cfg: S.sanitize(),
    video: null,
    root: null,
    resizeObs: null,
    panels: {},
    colors: {},
    layout: null,
    tracker: new baked.BakedTracker(performance.now()),
    granted: null, // null : on ne sait pas encore, false : il faut un clic sur l'icône
    lastError: '',
    eco: false,
    battery: null,
    blackSince: 0,
    black: false,
    path: location.pathname,
    timer: 0,
    ticking: false,
    again: false,
    raf: 0,
    lastRender: 0,
    rtRunning: false,
    dead: false,
  };

  // ---------- Vidéo et géométrie ----------

  const isWatchPage = () => location.pathname.startsWith('/watch');

  function findVideo() {
    return document.querySelector('.watch-video video, [data-uia="video-canvas"] video') || document.querySelector('video');
  }

  function attachVideo(video) {
    if (state.video === video) return;
    if (state.video) for (const ev of VIDEO_EVENTS) state.video.removeEventListener(ev, onVideoEvent);
    state.resizeObs?.disconnect();
    state.video = video;
    state.tracker.reset(performance.now());
    if (!video) return;
    for (const ev of VIDEO_EVENTS) video.addEventListener(ev, onVideoEvent);
    state.resizeObs = new ResizeObserver(() => relayout());
    state.resizeObs.observe(video);
  }

  const VIDEO_EVENTS = ['play', 'pause', 'seeking', 'loadedmetadata', 'emptied', 'ended'];

  function onVideoEvent(e) {
    if (e.type === 'seeking' || e.type === 'emptied' || e.type === 'loadedmetadata') {
      state.tracker.reset(performance.now());
      relayout();
    }
    if (e.type === 'play') poke();
  }

  function ensureRoot() {
    const v = state.video;
    if (!v || !v.parentElement) return null;
    let r = state.root;
    if (!r) {
      r = document.createElement('div');
      r.dataset.cinehalo = 'root';
      Object.assign(r.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        width: '0',
        height: '0',
        overflow: 'visible',
        pointerEvents: 'none',
        opacity: '0',
        transition: 'opacity 600ms ease',
      });
      state.root = r;
    }
    // Juste après la vidéo : au-dessus de l'image, mais sous les sous-titres et les contrôles Netflix.
    if (v.nextSibling !== r) v.after(r);
    return r;
  }

  function stageRect(vr) {
    const fs = document.fullscreenElement;
    const container = fs && fs.contains(state.video) ? fs : state.video.closest('.watch-video, [data-uia="watch-video"]');
    const box = container ? container.getBoundingClientRect() : vr;
    return {
      l: Math.max(0, Math.min(box.left, vr.left)),
      t: Math.max(0, Math.min(box.top, vr.top)),
      r: Math.min(window.innerWidth, Math.max(box.right, vr.right)),
      b: Math.min(window.innerHeight, Math.max(box.bottom, vr.bottom)),
    };
  }

  // Rectangle réellement occupé par l'image dans l'élément <video> (object-fit pris en compte).
  function pictureRect(video, vr) {
    const fit = getComputedStyle(video).objectFit || 'contain';
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (fit === 'fill') return { l: vr.left, t: vr.top, r: vr.right, b: vr.bottom };
    const contain = Math.min(vr.width / vw, vr.height / vh);
    let scale = contain;
    if (fit === 'cover') scale = Math.max(vr.width / vw, vr.height / vh);
    else if (fit === 'none') scale = 1;
    else if (fit === 'scale-down') scale = Math.min(1, contain);
    const w = vw * scale;
    const h = vh * scale;
    const l = vr.left + (vr.width - w) / 2;
    const t = vr.top + (vr.height - h) / 2;
    return { l, t, r: l + w, b: t + h };
  }

  function computeLayout() {
    const v = state.video;
    if (!v || !v.isConnected || !v.videoWidth || !v.videoHeight) return null;
    const vr = v.getBoundingClientRect();
    if (vr.width < 64 || vr.height < 64) return null;
    const stage = stageRect(vr);
    const pic = pictureRect(v, vr);
    const sw = stage.r - stage.l;
    const sh = stage.b - stage.t;
    const pw = pic.r - pic.l;
    const ph = pic.b - pic.t;
    if (sw <= 0 || sh <= 0) return null;
    const fills = pw >= sw * FILL_FRAC || ph >= sh * FILL_FRAC;

    const lock = state.cfg.bakedBars && state.tracker.locked ? state.tracker.locked : ZERO;
    const act = {
      l: pic.l + lock.l * pw,
      r: pic.r - lock.r * pw,
      t: pic.t + lock.t * ph,
      b: pic.b - lock.b * ph,
    };
    const minW = Math.max(MIN_BAR_PX, sw * MIN_BAR_FRAC);
    const minH = Math.max(MIN_BAR_PX, sh * MIN_BAR_FRAC);
    const regions = {
      left: act.l - stage.l >= minW ? { l: stage.l, t: stage.t, r: act.l, b: stage.b } : null,
      right: stage.r - act.r >= minW ? { l: act.r, t: stage.t, r: stage.r, b: stage.b } : null,
      top: act.t - stage.t >= minH ? { l: act.l, t: stage.t, r: act.r, b: act.t } : null,
      bottom: stage.b - act.b >= minH ? { l: act.l, t: act.b, r: act.r, b: stage.b } : null,
    };
    if (!fills) for (const s of SIDES) regions[s] = null;

    const zonesV = state.eco ? Math.min(state.cfg.zones, ECO_MAX_ZONES) : state.cfg.zones;
    const aw = Math.max(1, act.r - act.l);
    const ah = Math.max(1, act.b - act.t);
    const zonesH = Math.max(4, Math.min(64, Math.round((zonesV * aw) / ah)));
    return { vw: window.innerWidth, vh: window.innerHeight, stage, pic, act, regions, zonesV, zonesH };
  }

  const hasRegions = () => !!state.layout && SIDES.some((s) => state.layout.regions[s]);

  function relayout() {
    if (state.dead) return;
    const layout = isWatchPage() && state.cfg.enabled ? computeLayout() : null;
    state.layout = layout;
    const root = layout ? ensureRoot() : state.root;
    if (!root) return;
    const origin = root.getBoundingClientRect();
    for (const side of SIDES) {
      const reg = layout && layout.regions[side];
      let panel = state.panels[side];
      if (!reg) {
        if (panel) {
          panel.remove();
          delete state.panels[side];
          delete state.colors[side];
        }
        continue;
      }
      if (!panel) panel = state.panels[side] = new Panel(side, root);
      panel.setRect(reg.l - origin.left, reg.t - origin.top, reg.r - reg.l, reg.b - reg.t);
      const zones = side === 'left' || side === 'right' ? layout.zonesV : layout.zonesH;
      panel.setZones(zones);
      state.colors[side] = resizeColors(state.colors[side], zones);
      panel.dirty = true;
    }
    root.style.opacity = layout && hasRegions() ? '1' : '0';
    kick();
  }

  // ---------- Couleurs ----------

  function resample(src, n) {
    const out = new Float32Array(n * 3);
    const m = src.length / 3;
    if (!m) return out;
    for (let i = 0; i < n; i++) {
      const pos = ((i + 0.5) / n) * m - 0.5;
      const i0 = Math.max(0, Math.min(m - 1, Math.floor(pos)));
      const i1 = Math.min(m - 1, i0 + 1);
      const f = Math.max(0, Math.min(1, pos - i0));
      for (let c = 0; c < 3; c++) out[i * 3 + c] = src[i0 * 3 + c] * (1 - f) + src[i1 * 3 + c] * f;
    }
    return out;
  }

  function resizeColors(entry, n) {
    if (entry && entry.cur.length === n * 3) return entry;
    if (!entry) return { cur: new Float32Array(n * 3), tgt: new Float32Array(n * 3) };
    return { cur: resample(entry.cur, n), tgt: resample(entry.tgt, n) };
  }

  function setTarget(entry, srgb) {
    const lin = new Float32Array(srgb.length);
    for (let i = 0; i < srgb.length; i++) lin[i] = sampler.TO_LINEAR[srgb[i] | 0];
    entry.tgt = lin.length === entry.cur.length ? lin : resample(lin, entry.cur.length / 3);
  }

  function applyFrame(frame) {
    if (!frame || state.dead) return;
    const now = performance.now();
    state.granted = true;
    state.lastError = '';
    if (state.cfg.bakedBars && state.tracker.update(frame, now)) relayout();
    if (frame.peak < BLACK_PEAK) {
      if (!state.blackSince) state.blackSince = now;
      state.black = now - state.blackSince > BLACK_MS;
    } else {
      state.blackSince = 0;
      state.black = false;
    }
    for (const side of SIDES) {
      const entry = state.colors[side];
      if (entry && frame[side]) setTarget(entry, frame[side]);
    }
    kick();
  }

  // ---------- Animation ----------

  function kick() {
    if (state.raf || state.dead) return;
    if (!state.lastRender) state.lastRender = performance.now();
    state.raf = requestAnimationFrame(renderFrame);
  }

  function renderFrame(ts) {
    state.raf = 0;
    if (state.eco && ts - state.lastRender < 33) {
      state.raf = requestAnimationFrame(renderFrame);
      return;
    }
    const dt = Math.max(8, Math.min(250, ts - state.lastRender));
    state.lastRender = ts;
    const a = 1 - Math.exp(-dt / (state.cfg.smoothingMs / 3));
    const look = { intensity: state.cfg.intensity, saturation: state.cfg.saturation, reach: state.cfg.reach };
    let moving = false;
    for (const side of SIDES) {
      const entry = state.colors[side];
      const panel = state.panels[side];
      if (!entry || !panel) continue;
      let changed = false;
      const { cur, tgt } = entry;
      for (let i = 0; i < cur.length; i++) {
        const diff = tgt[i] - cur[i];
        if (diff === 0) continue;
        cur[i] = Math.abs(diff) > 0.0004 ? cur[i] + diff * a : tgt[i];
        changed = true;
      }
      if (changed || panel.dirty) panel.draw(cur, look);
      if (changed) moving = true;
    }
    if (moving) state.raf = requestAnimationFrame(renderFrame);
    else state.lastRender = 0;
  }

  // ---------- Capture ----------

  function captureParams() {
    const L = state.layout;
    const insets = state.cfg.bakedBars ? state.tracker.activeInsets() : ZERO;
    return {
      view: { w: L.vw, h: L.vh },
      rect: {
        x: L.pic.l / L.vw,
        y: L.pic.t / L.vh,
        w: (L.pic.r - L.pic.l) / L.vw,
        h: (L.pic.b - L.pic.t) / L.vh,
      },
      insets,
      zonesV: L.zonesV,
      zonesH: L.zonesH,
      detectBaked: state.cfg.bakedBars && state.tracker.state !== 'cooldown',
      locked: state.cfg.bakedBars ? state.tracker.locked : null,
    };
  }

  // Il y a quelque chose à éclairer, ou des bandes incrustées à chercher.
  const hasWork = () => hasRegions() || (state.cfg.bakedBars && state.tracker.state !== 'locked' && !!state.layout);

  function streamWanted() {
    return state.cfg.enabled && isWatchPage() && !!state.layout && state.granted !== false && hasWork();
  }

  function playingVisible() {
    const v = state.video;
    return !!v && !v.paused && !v.ended && v.readyState >= 2 && document.visibilityState === 'visible';
  }

  function captureInterval() {
    if (state.black) return 2000; // capture noire : on vérifie de temps en temps si ça revient
    if (!hasRegions()) return 1000; // on cherche seulement des bandes incrustées
    return state.eco ? 1000 : 500; // Chrome limite captureVisibleTab à 2 appels par seconde
  }

  function handleError(res) {
    const err = res && res.error;
    if (err === 'permission') state.granted = false;
    else if (err === 'context') teardown();
    // inactive, quota, message (service worker qui redémarre) : passager, on réessaie au prochain tour
    else if (err && !['inactive', 'quota', 'message'].includes(err)) state.lastError = res.message || err;
  }

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      // L'extension a été mise à jour ou rechargée : ce script est orphelin.
      if (!chrome.runtime?.id) return { ok: false, error: 'context' };
      return { ok: false, error: 'message', message: String(e && e.message) };
    }
  }

  async function autoTick() {
    if (!(streamWanted() && playingVisible())) return 1000;
    const started = performance.now();
    const res = await send({ type: 'capture', params: captureParams() });
    if (res && res.ok) applyFrame(res.frame);
    else handleError(res);
    return Math.max(0, captureInterval() - (performance.now() - started));
  }

  async function realtimeTick() {
    if (!streamWanted()) {
      await stopRealtime();
      return 1000;
    }
    const message = {
      params: captureParams(),
      active: playingVisible(),
      fps: state.eco ? 10 : 24,
    };
    const res = await send({ type: state.rtRunning ? 'rt-update' : 'rt-start', ...message });
    if (res && res.ok) state.rtRunning = true;
    else {
      state.rtRunning = false;
      handleError(res);
    }
    return 500;
  }

  async function stopRealtime() {
    if (!state.rtRunning) return;
    state.rtRunning = false;
    await send({ type: 'rt-stop' });
  }

  function refresh() {
    if (location.pathname !== state.path) {
      state.path = location.pathname;
      state.tracker.reset(performance.now());
      state.black = false;
      state.blackSince = 0;
      for (const side of SIDES) delete state.colors[side];
    }
    const video = isWatchPage() ? findVideo() : null;
    if (video !== state.video) attachVideo(video);
    relayout();
  }

  // Une seule boucle à la fois : un poke() pendant une capture en cours relance juste derrière.
  async function tick() {
    state.timer = 0;
    if (state.dead) return;
    if (state.ticking) {
      state.again = true;
      return;
    }
    state.ticking = true;
    let delay = 1000;
    try {
      refresh();
      if (state.cfg.captureMode === 'realtime') {
        delay = await realtimeTick();
      } else {
        await stopRealtime();
        delay = await autoTick();
      }
    } catch (e) {
      state.lastError = String((e && e.message) || e);
    } finally {
      state.ticking = false;
    }
    if (state.again) {
      state.again = false;
      delay = 0;
    }
    if (state.dead) return;
    // État lisible dans les DevTools sur <div data-cinehalo="root">, pratique pour diagnostiquer.
    if (state.root) {
      state.root.dataset.status = computeStatus();
      state.root.dataset.baked = state.tracker.state;
    }
    clearTimeout(state.timer);
    state.timer = setTimeout(tick, delay);
  }

  function poke() {
    if (state.dead) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(tick, 0);
  }

  function teardown() {
    state.dead = true;
    clearTimeout(state.timer);
    cancelAnimationFrame(state.raf);
    state.resizeObs?.disconnect();
    state.root?.remove();
  }

  // ---------- Statut pour le popup ----------

  function computeStatus() {
    if (!state.cfg.enabled) return 'disabled';
    if (!isWatchPage()) return 'not-watch';
    if (!state.layout) return 'waiting';
    if (state.granted === false) return 'needs-click';
    if (state.black) return 'black';
    if (state.lastError) return 'error';
    if (!hasRegions()) return state.cfg.bakedBars && state.tracker.state !== 'locked' ? 'detecting' : 'no-bars';
    if (state.video && state.video.paused) return 'paused';
    return 'active';
  }

  function statusPayload() {
    return {
      status: computeStatus(),
      mode: state.cfg.captureMode,
      eco: state.eco,
      error: state.lastError,
      baked: state.tracker.state,
      sides: SIDES.filter((s) => state.panels[s]),
    };
  }

  // ---------- Événements ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'activate':
        // Le popup vient de s'ouvrir ou le raccourci a été utilisé : activeTab est accordé.
        state.granted = null;
        state.lastError = '';
        poke();
        sendResponse(statusPayload());
        break;
      case 'get-status':
        sendResponse(statusPayload());
        break;
      case 'frame':
        if (state.cfg.captureMode === 'realtime') applyFrame(msg.frame);
        break;
      case 'rt-ended':
        state.rtRunning = false;
        // Partage arrêté depuis la barre de Chrome : on ne relance pas sans un nouveau clic.
        if (msg.reason === 'ended') state.granted = false;
        break;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const next = { ...state.cfg };
    for (const [key, { newValue }] of Object.entries(changes)) next[key] = newValue;
    state.cfg = S.sanitize(next);
    updateEco();
    for (const side of SIDES) if (state.panels[side]) state.panels[side].dirty = true;
    relayout();
    poke();
  });

  function updateEco() {
    const eco = state.cfg.ecoAuto && !!state.battery && !state.battery.charging;
    if (eco !== state.eco) {
      state.eco = eco;
      relayout();
    }
  }

  if (navigator.getBattery) {
    navigator
      .getBattery()
      .then((battery) => {
        state.battery = battery;
        battery.addEventListener('chargingchange', updateEco);
        updateEco();
      })
      .catch(() => {});
  }

  window.addEventListener('resize', relayout);
  document.addEventListener('fullscreenchange', () => {
    relayout();
    poke();
  });
  document.addEventListener('visibilitychange', poke);

  S.load()
    .then((cfg) => {
      state.cfg = cfg;
    })
    .catch(() => {})
    .finally(poke);
})();
