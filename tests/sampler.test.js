const test = require('node:test');
const assert = require('node:assert/strict');
const { sample, targetSize } = require('../src/shared/sampler.js');

// Image 32:9 de 320x90 avec une image 16:9 au centre (x de 80 à 240), le reste en noir.
const W = 320;
const H = 90;
const PIC = { x0: 80, x1: 240, y0: 0, y1: 90 };
const RECT = { x: 80 / W, y: 0, w: 160 / W, h: 1 };

function image(paint) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inPic = x >= PIC.x0 && x < PIC.x1 && y >= PIC.y0 && y < PIC.y1;
      const [r, g, b] = inPic ? paint(x - PIC.x0, y - PIC.y0) : [0, 0, 0];
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

const params = (extra = {}) => ({ rect: RECT, insets: { t: 0, b: 0, l: 0, r: 0 }, zonesV: 8, zonesH: 14, ...extra });
const zone = (arr, i) => arr.slice(i * 3, i * 3 + 3);

test('les bords gauche et droit prennent la couleur de leur côté', () => {
  const data = image((x) => (x < 80 ? [200, 30, 30] : [30, 60, 220]));
  const f = sample(data, W, H, params());
  assert.equal(f.left.length, 8 * 3);
  assert.equal(f.top.length, 14 * 3);
  for (let i = 0; i < 8; i++) {
    const [r, g, b] = zone(f.left, i);
    assert.ok(r > 180 && g < 50 && b < 50, `gauche zone ${i}: ${[r, g, b]}`);
    const [r2, , b2] = zone(f.right, i);
    assert.ok(b2 > 200 && r2 < 50, `droite zone ${i}`);
  }
  // en haut : rouge au début, bleu à la fin
  assert.ok(zone(f.top, 0)[0] > 180);
  assert.ok(zone(f.top, 13)[2] > 200);
});

test('les zones suivent la verticale (ciel en haut, sol en bas)', () => {
  const data = image((x, y) => (y < 45 ? [40, 90, 230] : [230, 120, 30]));
  const f = sample(data, W, H, params());
  assert.ok(zone(f.left, 0)[2] > 200, 'haut bleu');
  assert.ok(zone(f.left, 7)[0] > 200, 'bas orange');
});

test('une image noire donne une lueur noire et un pic à zéro', () => {
  const f = sample(image(() => [0, 0, 0]), W, H, params());
  assert.ok(f.left.every((v) => v === 0));
  assert.equal(f.peak, 0);
});

test('le pic central reflète la luminosité de la scène', () => {
  const f = sample(image(() => [180, 180, 180]), W, H, params());
  assert.ok(f.peak > 0.6);
});

test('les insets excluent les bandes incrustées de l’échantillonnage', () => {
  // bandes noires de 15 % en haut et en bas, image verte entre les deux
  const data = image((x, y) => (y < 14 || y >= 76 ? [0, 0, 0] : [30, 200, 60]));
  const f = sample(data, W, H, params({ insets: { t: 14 / 90, b: 14 / 90, l: 0, r: 0 } }));
  assert.ok(zone(f.top, 5)[1] > 180, 'le bord haut lit le vert, pas la bande noire');
});

test('détection des bandes incrustées, sous-titres compris', () => {
  const data = image((x, y) => {
    if (y < 11 || y >= 79) {
      // un sous-titre blanc au centre de la bande du bas
      if (y >= 81 && y < 86 && x > 40 && x < 120) return [255, 255, 255];
      return [0, 0, 0];
    }
    return [120, 80, 160];
  });
  const f = sample(data, W, H, params({ detectBaked: true }));
  assert.equal(f.content, true);
  assert.ok(Math.abs(f.cand.t - 11 / 90) < 0.012, `haut ${f.cand.t}`);
  assert.ok(Math.abs(f.cand.b - 11 / 90) < 0.012, `bas ${f.cand.b}`);
  assert.equal(f.cand.l, 0);
  assert.equal(f.cand.r, 0);
});

test('une image noire n’est pas considérée comme du contenu', () => {
  const f = sample(image(() => [0, 0, 0]), W, H, params({ detectBaked: true }));
  assert.equal(f.content, false);
});

test('le test de texture distingue la lueur lisse d’une vraie image', () => {
  const locked = { t: 0.2, b: 0, l: 0, r: 0 };
  const smooth = image((x) => [Math.round(x / 2), 20, 10]);
  const busy = image((x, y) => ((x + y) % 2 ? [220, 220, 220] : [10, 10, 10]));
  const a = sample(smooth, W, H, params({ locked }));
  const b = sample(busy, W, H, params({ locked }));
  assert.ok(a.tex.t < 3, `lisse ${a.tex.t}`);
  assert.ok(b.tex.t > 50, `détaillée ${b.tex.t}`);
});

test('targetSize garde le ratio et plafonne à 768 px', () => {
  assert.deepEqual(targetSize(5120, 1440), { w: 768, h: 216 });
  assert.deepEqual(targetSize(400, 300), { w: 400, h: 300 });
});

test('un rectangle trop petit ne renvoie rien', () => {
  const f = sample(image(() => [255, 0, 0]), W, H, params({ rect: { x: 0.5, y: 0.5, w: 0.001, h: 0.001 } }));
  assert.equal(f, null);
});

test('les candidats partent du bord de la zone déjà recouverte', () => {
  const data = image((x, y) => (y < 11 || y >= 79 ? [0, 0, 0] : [120, 80, 160]));
  const f = sample(data, W, H, params({ detectBaked: true, locked: { t: 4 / 90, b: 11 / 90, l: 0, r: 0 } }));
  assert.ok(Math.abs(f.cand.t - 7 / 90) < 0.012, `reste en haut ${f.cand.t}`);
  assert.ok(f.cand.b < 0.012, `rien en bas ${f.cand.b}`);
});
