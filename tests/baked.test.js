const test = require('node:test');
const assert = require('node:assert/strict');
const { BakedTracker } = require('../src/shared/baked.js');

const frame = (cand, extra = {}) => ({ cand, content: true, ...extra });
const BARS = { t: 0.12, b: 0.12, l: 0, r: 0 };
const NONE = { t: 0, b: 0, l: 0, r: 0 };

// Les images portent la zone recouverte au moment de la capture, comme celles du sampler.
function feed(tracker, f, from, to, step = 500) {
  let changed = false;
  for (let now = from; now <= to; now += step) {
    changed = tracker.update({ covered: tracker.locked, ...f }, now) || changed;
  }
  return changed;
}

const covered = (tr, f) => ({ covered: tr.locked, ...f });

test('verrouille des bandes stables après quelques secondes', () => {
  const tr = new BakedTracker(0);
  assert.equal(feed(tr, frame(BARS), 0, 3000), false);
  assert.equal(tr.state, 'detecting');
  assert.equal(feed(tr, frame(BARS), 3500, 5500), true);
  assert.equal(tr.state, 'locked');
  assert.ok(Math.abs(tr.locked.t - 0.12) < 1e-9);
  assert.equal(tr.locked.l, 0);
});

test('une scène sombre ne gonfle pas les bandes', () => {
  const tr = new BakedTracker(0);
  feed(tr, frame({ t: 0.3, b: 0.3, l: 0, r: 0 }), 0, 1000);
  feed(tr, frame(BARS), 1500, 6000);
  assert.equal(tr.state, 'locked');
  assert.ok(tr.locked.t < 0.13);
});

test('un overlay ponctuel (interface Netflix) ne casse pas la détection', () => {
  const tr = new BakedTracker(0);
  feed(tr, frame({ t: 0.016, b: 0.12, l: 0, r: 0 }), 0, 500);
  feed(tr, frame(BARS), 1000, 6000);
  assert.equal(tr.state, 'locked');
  assert.ok(Math.abs(tr.locked.t - 0.12) < 1e-9, `haut ${tr.locked.t}`);
});

test('ignore les images sans contenu', () => {
  const tr = new BakedTracker(0);
  feed(tr, { cand: { t: 0.35, b: 0.35, l: 0.35, r: 0.35 }, content: false }, 0, 10000);
  assert.equal(tr.state, 'detecting');
  assert.equal(tr.frames, 0);
});

test('pas de bandes : rien n’est verrouillé et la fenêtre repart', () => {
  const tr = new BakedTracker(0);
  feed(tr, frame(NONE), 0, 29500);
  assert.equal(tr.state, 'detecting');
  feed(tr, frame(NONE), 30000, 30000);
  assert.equal(tr.frames, 0, 'fenêtre réinitialisée après 30 s');
});

test('déverrouille si l’image déborde sur la bande, puis repart après une pause', () => {
  const tr = new BakedTracker(0);
  feed(tr, frame(BARS), 0, 6000);
  assert.equal(tr.state, 'locked');
  assert.equal(tr.update(covered(tr, frame(BARS, { tex: { t: 9, b: 0, l: 0, r: 0 } })), 6500), false);
  assert.equal(tr.update(covered(tr, frame(BARS, { tex: { t: 9, b: 0, l: 0, r: 0 } })), 7000), true);
  assert.equal(tr.state, 'cooldown');
  assert.equal(tr.locked, null);
  tr.update(frame(BARS), 16000);
  assert.equal(tr.state, 'cooldown');
  tr.update(frame(BARS), 17000);
  assert.equal(tr.state, 'detecting');
});

test('une texture ponctuelle (un seul pic) ne suffit pas', () => {
  const tr = new BakedTracker(0);
  feed(tr, frame(BARS), 0, 6000);
  tr.update(covered(tr, frame(BARS, { tex: { t: 9, b: 0, l: 0, r: 0 } })), 6500);
  tr.update(covered(tr, frame(BARS, { tex: { t: 1, b: 0, l: 0, r: 0 } })), 7000);
  tr.update(covered(tr, frame(BARS, { tex: { t: 9, b: 0, l: 0, r: 0 } })), 7500);
  assert.equal(tr.state, 'locked');
});

test('activeInsets donne une estimation prudente pendant la détection', () => {
  const tr = new BakedTracker(0);
  assert.deepEqual(tr.activeInsets(), NONE);
  feed(tr, frame(BARS), 0, 500);
  assert.ok(tr.activeInsets().t > 0.1);
});

test('une bande verrouillée trop petite s’agrandit ensuite jusqu’à la vraie taille', () => {
  const tr = new BakedTracker(0);
  feed(tr, frame({ t: 0.02, b: 0.12, l: 0, r: 0 }), 0, 5000);
  assert.equal(tr.state, 'locked');
  assert.ok(Math.abs(tr.locked.t - 0.02) < 1e-9);
  // il reste 10 % de noir au-delà de la zone recouverte en haut, rien en bas
  const changed = feed(tr, frame({ t: 0.1, b: 0, l: 0, r: 0 }), 6500, 12000);
  assert.equal(changed, true);
  assert.ok(Math.abs(tr.locked.t - 0.12) < 1e-9, `haut ${tr.locked.t}`);
  assert.ok(Math.abs(tr.locked.b - 0.12) < 1e-9);
});

test('une capture partie avant le verrouillage est ignorée', () => {
  const tr = new BakedTracker(0);
  feed(tr, frame(BARS), 0, 5000);
  assert.equal(tr.state, 'locked');
  // réponse en retard, mesurée sans zone recouverte : ce n'est pas un agrandissement
  for (let now = 5500; now <= 12000; now += 500) tr.update({ ...frame(BARS), covered: null }, now);
  assert.ok(Math.abs(tr.locked.t - 0.12) < 1e-9, `haut ${tr.locked.t}`);
});
