(() => {
  'use strict';

  const { settings: S } = globalThis.CineHalo;
  const $ = (id) => document.getElementById(id);
  const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
  const NETFLIX = /^https:\/\/www\.netflix\.com\//;
  const SLIDERS = ['intensity', 'saturation', 'reach', 'smoothingMs', 'zones'];

  let cfg = S.sanitize();
  let tabId = null;
  let pending = {};
  let saveTimer = 0;

  const percent = new Intl.NumberFormat(chrome.i18n.getUILanguage(), { style: 'percent' });
  const seconds = new Intl.NumberFormat(chrome.i18n.getUILanguage(), {
    style: 'unit',
    unit: 'second',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const FORMAT = {
    intensity: (v) => percent.format(v),
    saturation: (v) => percent.format(v),
    reach: (v) => percent.format(v),
    smoothingMs: (v) => seconds.format(v / 1000),
    zones: (v) => String(v),
  };

  function translate() {
    document.documentElement.lang = chrome.i18n.getUILanguage();
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = msg(el.dataset.i18n);
  }

  // Les curseurs écrivent avec un petit délai : chrome.storage.sync limite le nombre d'écritures.
  function save(patch, delay = 0) {
    Object.assign(cfg, patch);
    Object.assign(pending, patch);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, delay);
    render();
  }

  function flush() {
    clearTimeout(saveTimer);
    if (!Object.keys(pending).length) return;
    const out = pending;
    pending = {};
    chrome.storage.sync.set(out);
  }

  function render() {
    $('enabled').checked = cfg.enabled;
    for (const btn of document.querySelectorAll('.preset')) {
      btn.setAttribute('aria-checked', String(btn.dataset.preset === cfg.preset));
    }
    $('custom').hidden = cfg.preset !== 'custom';
    for (const btn of document.querySelectorAll('[data-mode]')) {
      btn.setAttribute('aria-checked', String(btn.dataset.mode === cfg.captureMode));
    }
    for (const key of SLIDERS) {
      const input = $(key);
      if (document.activeElement !== input) input.value = cfg[key];
      $(`${key}Out`).textContent = FORMAT[key](cfg[key]);
    }
    $('ecoAuto').checked = cfg.ecoAuto;
    $('bakedBars').checked = cfg.bakedBars;
  }

  function bind() {
    $('enabled').addEventListener('change', (e) => {
      save({ enabled: e.target.checked });
      if (e.target.checked) activate();
    });
    for (const btn of document.querySelectorAll('.preset')) {
      btn.addEventListener('click', () => save({ preset: btn.dataset.preset, ...S.PRESETS[btn.dataset.preset] }));
    }
    for (const btn of document.querySelectorAll('[data-mode]')) {
      btn.addEventListener('click', () => {
        save({ captureMode: btn.dataset.mode });
        activate();
      });
    }
    for (const key of SLIDERS) {
      const input = $(key);
      const [min, max, step] = S.LIMITS[key];
      Object.assign(input, { min, max, step });
      input.addEventListener('input', () => {
        const next = { ...cfg, [key]: Number(input.value) };
        save({ [key]: Number(input.value), preset: S.presetFor(next) }, 200);
      });
      // Curseur relâché : on écrit tout de suite, au cas où le popup se ferme juste après.
      input.addEventListener('change', flush);
    }
    window.addEventListener('pagehide', flush);
    $('ecoAuto').addEventListener('change', (e) => save({ ecoAuto: e.target.checked }));
    $('bakedBars').addEventListener('change', (e) => save({ bakedBars: e.target.checked }));
    $('reset').addEventListener('click', () => save({ ...S.DEFAULTS }));
    $('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  }

  function showStatus(state, payload) {
    const box = $('status');
    box.dataset.state = state;
    let text;
    if (state === 'active') text = msg(cfg.captureMode === 'realtime' ? 'status_active_realtime' : 'status_active_auto');
    else if (state === 'error') text = msg('status_error', [payload && payload.error ? payload.error : '?']);
    else text = msg(`status_${state.replace(/-/g, '_')}`);
    $('statusText').textContent = text;
    $('tip').hidden = state !== 'black';
    $('eco').hidden = !(payload && payload.eco);
  }

  async function query(type) {
    if (tabId == null) return null;
    try {
      return await chrome.tabs.sendMessage(tabId, { type });
    } catch {
      return null;
    }
  }

  // Ouvrir le popup accorde activeTab sur l'onglet : on prévient le content script tout de suite.
  async function activate() {
    const payload = await query('activate');
    if (payload) showStatus(payload.status, payload);
    else if (tabId != null) showStatus('reload');
  }

  async function poll() {
    const payload = await query('get-status');
    if (payload) showStatus(payload.status, payload);
  }

  async function showShortcut() {
    const commands = await chrome.commands.getAll();
    const toggle = commands.find((c) => c.name === 'toggle-glow');
    $('shortcut').textContent = (toggle && toggle.shortcut) || msg('shortcutNone');
  }

  async function init() {
    translate();
    bind();
    cfg = await S.load();
    render();
    showShortcut();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && NETFLIX.test(tab.url || '')) {
      tabId = tab.id;
      await activate();
      setInterval(poll, 1000);
    } else {
      showStatus('not-netflix');
    }
  }

  init();
})();
