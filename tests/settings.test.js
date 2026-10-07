const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/shared/settings.js');

test('les valeurs par défaut correspondent au préréglage équilibré', () => {
  const cfg = S.sanitize();
  assert.equal(cfg.preset, 'balanced');
  assert.equal(S.presetFor(cfg), 'balanced');
  assert.equal(cfg.captureMode, 'auto');
  assert.equal(cfg.reach, 1);
});

test('sanitize borne les valeurs et rejette les modes inconnus', () => {
  const cfg = S.sanitize({ intensity: 9, zones: 2.4, captureMode: 'magic', preset: 'nope', smoothingMs: 'x' });
  assert.equal(cfg.intensity, 1.6);
  assert.equal(cfg.zones, 4);
  assert.equal(cfg.captureMode, 'auto');
  assert.equal(cfg.preset, 'balanced');
  assert.equal(cfg.smoothingMs, S.DEFAULTS.smoothingMs);
});

test('presetFor reconnaît un préréglage ou renvoie custom', () => {
  assert.equal(S.presetFor({ ...S.DEFAULTS, ...S.PRESETS.intense }), 'intense');
  assert.equal(S.presetFor({ ...S.DEFAULTS, intensity: 0.42 }), 'custom');
});
