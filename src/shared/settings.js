// Réglages partagés par le service worker, le popup, l'offscreen et le content script.
// Script classique (pas de module) pour pouvoir être chargé partout, y compris dans Node pour les tests.
(function (root) {
  'use strict';

  // Les trois préréglages du popup. "balanced" correspond à la config par défaut.
  const PRESETS = {
    subtle: { intensity: 0.7, saturation: 0.9, reach: 0.6, smoothingMs: 1400 },
    balanced: { intensity: 1.0, saturation: 1.15, reach: 1.0, smoothingMs: 1000 },
    intense: { intensity: 1.35, saturation: 1.45, reach: 1.0, smoothingMs: 600 },
  };

  const DEFAULTS = {
    enabled: true,
    preset: 'balanced',
    captureMode: 'auto', // 'auto' (captureVisibleTab) ou 'realtime' (tabCapture)
    ...PRESETS.balanced,
    zones: 16,
    ecoAuto: true,
    bakedBars: true,
  };

  // [min, max, pas] pour les curseurs avancés
  const LIMITS = {
    intensity: [0.3, 1.6, 0.05],
    saturation: [0.5, 2, 0.05],
    reach: [0.2, 1, 0.05],
    smoothingMs: [150, 2500, 50],
    zones: [4, 32, 1],
  };

  const CAPTURE_MODES = ['auto', 'realtime'];

  function clampNumber(value, [min, max], fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function sanitize(raw) {
    const s = { ...DEFAULTS, ...(raw || {}) };
    const out = {
      enabled: Boolean(s.enabled),
      preset: s.preset === 'custom' || PRESETS[s.preset] ? s.preset : DEFAULTS.preset,
      captureMode: CAPTURE_MODES.includes(s.captureMode) ? s.captureMode : DEFAULTS.captureMode,
      ecoAuto: Boolean(s.ecoAuto),
      bakedBars: Boolean(s.bakedBars),
    };
    for (const key of Object.keys(LIMITS)) {
      out[key] = clampNumber(s[key], LIMITS[key], DEFAULTS[key]);
    }
    out.zones = Math.round(out.zones);
    return out;
  }

  // Retrouve le préréglage qui correspond aux valeurs, sinon "custom".
  function presetFor(values) {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const same = Object.keys(preset).every((k) => Math.abs(preset[k] - values[k]) < 1e-6);
      if (same) return name;
    }
    return 'custom';
  }

  async function load() {
    const raw = await chrome.storage.sync.get(DEFAULTS);
    return sanitize(raw);
  }

  const api = { PRESETS, DEFAULTS, LIMITS, CAPTURE_MODES, sanitize, presetFor, load };
  root.CineHalo = root.CineHalo || {};
  root.CineHalo.settings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
