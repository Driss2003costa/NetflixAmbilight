// Analyse d'une capture d'onglet réduite : couleurs des bords de l'image, détection des bandes
// incrustées et repère "image noire" pour le DRM. Fonctions pures, testées dans Node.
(function (root) {
  'use strict';

  // sRGB 8 bits -> lumière linéaire, et l'inverse via une table. Les moyennes se font en linéaire,
  // sinon les zones contrastées sortent plus sombres et plus sales qu'en vrai.
  const TO_LINEAR = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const LUT_SIZE = 4096;
  const TO_SRGB = new Uint8Array(LUT_SIZE + 1);
  for (let i = 0; i <= LUT_SIZE; i++) {
    const c = i / LUT_SIZE;
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    TO_SRGB[i] = Math.round(s * 255);
  }

  function linearToSrgb8(v) {
    if (!(v > 0)) return 0;
    if (v >= 1) return 255;
    return TO_SRGB[(v * LUT_SIZE + 0.5) | 0];
  }

  const DARK_LUMA = 20; // sur 255 : en dessous, le pixel compte comme noir
  const EDGE_DEPTH = 0.08; // profondeur de la bande lue au bord de l'image
  const MAX_BAR = 0.35; // une bande incrustée ne dépasse pas 35 % de l'image
  const ROW_EDGE = 0.12; // pour les lignes on ne lit que les 12 % de chaque bout (les sous-titres sont au centre)
  const TEX_SIDE = 0.15; // zone lue pour le test de texture dans les bandes recouvertes
  const ZERO = { t: 0, b: 0, l: 0, r: 0 };

  function luma(d, i) {
    return (54 * d[i] + 183 * d[i + 1] + 19 * d[i + 2]) >> 8;
  }

  // Taille de travail pour une capture : on réduit pour que le plus grand côté fasse 768 px max.
  function targetSize(srcW, srcH, max = 768) {
    const scale = Math.min(1, max / Math.max(srcW, srcH));
    return {
      w: Math.max(16, Math.round(srcW * scale)),
      h: Math.max(16, Math.round(srcH * scale)),
    };
  }

  function toBox(rect, w, h) {
    const x0 = Math.max(0, Math.round(rect.x * w));
    const y0 = Math.max(0, Math.round(rect.y * h));
    const x1 = Math.min(w, Math.round((rect.x + rect.w) * w));
    const y1 = Math.min(h, Math.round((rect.y + rect.h) * h));
    if (x1 - x0 < 8 || y1 - y0 < 8) return null;
    return { x0, y0, x1, y1 };
  }

  // Couleur moyenne de n segments le long d'un bord. Les pixels proches du bord et les pixels
  // saturés pèsent plus lourd, c'est ce qui donne une lueur vivante plutôt qu'un gris moyen.
  function edgeZones(d, w, a, side, depth, n) {
    const acc = new Float64Array(n * 4);
    const vertical = side === 'left' || side === 'right';
    const len = vertical ? a.y1 - a.y0 : a.x1 - a.x0;
    depth = Math.min(depth, vertical ? a.x1 - a.x0 : a.y1 - a.y0);
    for (let k = 0; k < depth; k++) {
      const wd = 1 - 0.6 * (k / depth);
      for (let s = 0; s < len; s++) {
        let x;
        let y;
        if (side === 'left') {
          x = a.x0 + k;
          y = a.y0 + s;
        } else if (side === 'right') {
          x = a.x1 - 1 - k;
          y = a.y0 + s;
        } else if (side === 'top') {
          x = a.x0 + s;
          y = a.y0 + k;
        } else {
          x = a.x0 + s;
          y = a.y1 - 1 - k;
        }
        const i = (y * w + x) * 4;
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
        const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
        const sat = mx > 0 ? (mx - mn) / mx : 0;
        const wt = wd * (0.35 + 0.65 * sat);
        const o = Math.min(n - 1, ((s * n) / len) | 0) * 4;
        acc[o] += TO_LINEAR[r] * wt;
        acc[o + 1] += TO_LINEAR[g] * wt;
        acc[o + 2] += TO_LINEAR[b] * wt;
        acc[o + 3] += wt;
      }
    }
    const out = new Array(n * 3);
    for (let z = 0; z < n; z++) {
      const o = z * 4;
      const wt = acc[o + 3] || 1;
      out[z * 3] = linearToSrgb8(acc[o] / wt);
      out[z * 3 + 1] = linearToSrgb8(acc[o + 1] / wt);
      out[z * 3 + 2] = linearToSrgb8(acc[o + 2] / wt);
    }
    return out;
  }

  // Luminosité "haute" (98e centile) au centre de l'image. Si elle reste à ~0 pendant que la
  // vidéo tourne, la capture est très probablement noircie par le DRM.
  function centralPeak(d, w, a) {
    const aw = a.x1 - a.x0;
    const ah = a.y1 - a.y0;
    const hist = new Uint32Array(256);
    let count = 0;
    for (let y = a.y0 + Math.round(ah * 0.15); y < a.y0 + Math.round(ah * 0.75); y += 2) {
      for (let x = a.x0 + Math.round(aw * 0.1); x < a.x1 - Math.round(aw * 0.1); x += 2) {
        hist[luma(d, (y * w + x) * 4)]++;
        count++;
      }
    }
    if (!count) return 0;
    let seen = 0;
    const target = count * 0.98;
    for (let v = 0; v < 256; v++) {
      seen += hist[v];
      if (seen >= target) return v / 255;
    }
    return 1;
  }

  // Bandes noires encodées dans la vidéo, vues sur cette image seule. La mesure part du bord de la
  // zone déjà recouverte par la lueur (covered), pour pouvoir encore agrandir une bande verrouillée.
  // Résultat en fractions de l'image complète.
  function bakedCandidates(d, w, pic, covered) {
    const pw = pic.x1 - pic.x0;
    const ph = pic.y1 - pic.y0;
    const c = covered || ZERO;
    const b = {
      x0: pic.x0 + Math.round(c.l * pw),
      x1: pic.x1 - Math.round(c.r * pw),
      y0: pic.y0 + Math.round(c.t * ph),
      y1: pic.y1 - Math.round(c.b * ph),
    };
    const bw = b.x1 - b.x0;
    const bh = b.y1 - b.y0;
    if (bw < 8 || bh < 8) return { ...ZERO };
    const edgeW = Math.max(1, Math.round(bw * ROW_EDGE));
    const rowLimit = Math.max(1, edgeW * 2 * 0.06);
    const rowDark = (y) => {
      let lit = 0;
      const base = y * w;
      for (let x = b.x0; x < b.x0 + edgeW; x++) if (luma(d, (base + x) * 4) > DARK_LUMA) lit++;
      for (let x = b.x1 - edgeW; x < b.x1; x++) if (luma(d, (base + x) * 4) > DARK_LUMA) lit++;
      return lit <= rowLimit;
    };
    // Pour les colonnes on évite le bas de l'image, là où vivent les sous-titres.
    const yA = b.y0 + Math.round(bh * 0.1);
    const yB = b.y1 - Math.round(bh * 0.3);
    const colLimit = Math.max(1, (yB - yA) * 0.04);
    const colDark = (x) => {
      let lit = 0;
      for (let y = yA; y < yB; y++) if (luma(d, (y * w + x) * 4) > DARK_LUMA) lit++;
      return lit <= colLimit;
    };
    const maxRows = Math.max(0, Math.floor(ph * MAX_BAR) - Math.round(Math.max(c.t, c.b) * ph));
    const maxCols = Math.max(0, Math.floor(pw * MAX_BAR) - Math.round(Math.max(c.l, c.r) * pw));
    let t = 0;
    while (t < maxRows && rowDark(b.y0 + t)) t++;
    let bo = 0;
    while (bo < maxRows && rowDark(b.y1 - 1 - bo)) bo++;
    let l = 0;
    while (l < maxCols && colDark(b.x0 + l)) l++;
    let r = 0;
    while (r < maxCols && colDark(b.x1 - 1 - r)) r++;
    // +1 pour la ligne de transition à moitié noire : mieux vaut déborder d'un pixel sur l'image
    // (invisible avec le mode "lighten") que laisser un liseré noir entre l'image et la lueur.
    const edge = (n) => (n > 0 ? n + 1 : 0);
    return { t: edge(t) / ph, b: edge(bo) / ph, l: edge(l) / pw, r: edge(r) / pw };
  }

  // Est-ce que le milieu de l'image montre quelque chose ? Les images noires ne disent rien sur
  // les bandes, on les ignore pour la détection.
  function hasContent(d, w, b) {
    const pw = b.x1 - b.x0;
    const ph = b.y1 - b.y0;
    let lit = 0;
    let count = 0;
    for (let y = b.y0 + Math.round(ph * 0.35); y < b.y0 + Math.round(ph * 0.65); y++) {
      for (let x = b.x0 + Math.round(pw * 0.15); x < b.x1 - Math.round(pw * 0.15); x++) {
        if (luma(d, (y * w + x) * 4) > DARK_LUMA) lit++;
        count++;
      }
    }
    return count > 0 && lit / count > 0.03;
  }

  // Variation moyenne entre pixels voisins dans une zone. Notre lueur est lisse (proche de 0),
  // une vraie image a du détail. Ça permet de voir si l'image déborde sur une bande qu'on recouvre.
  function gradientEnergy(d, w, x0, y0, x1, y1) {
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1 - 1; y++) {
      for (let x = x0; x < x1 - 1; x++) {
        const i = (y * w + x) * 4;
        const v = luma(d, i);
        sum += Math.abs(v - luma(d, i + 4)) + Math.abs(v - luma(d, i + w * 4));
        count++;
      }
    }
    return count ? sum / count : 0;
  }

  function lockedTexture(d, w, b, locked) {
    const pw = b.x1 - b.x0;
    const ph = b.y1 - b.y0;
    const side = Math.max(2, Math.round(pw * TEX_SIDE));
    const out = { t: 0, b: 0, l: 0, r: 0 };
    const rows = (y0, y1) =>
      Math.max(gradientEnergy(d, w, b.x0, y0, b.x0 + side, y1), gradientEnergy(d, w, b.x1 - side, y0, b.x1, y1));
    // On laisse deux lignes de marge côté image pour ne pas mesurer la frontière elle-même.
    if (locked.t > 0) out.t = rows(b.y0, b.y0 + Math.round(locked.t * ph) - 2);
    if (locked.b > 0) out.b = rows(b.y1 - Math.round(locked.b * ph) + 2, b.y1);
    const yA = b.y0 + Math.round(ph * 0.1);
    const yB = b.y1 - Math.round(ph * 0.3);
    if (locked.l > 0) out.l = gradientEnergy(d, w, b.x0, yA, b.x0 + Math.round(locked.l * pw) - 2, yB);
    if (locked.r > 0) out.r = gradientEnergy(d, w, b.x1 - Math.round(locked.r * pw) + 2, yA, b.x1, yB);
    return out;
  }

  /**
   * data : pixels RGBA de la capture réduite (w x h), qui couvre toute la zone visible de l'onglet.
   * p.rect : rectangle de l'image vidéo, normalisé sur la zone visible (0..1)
   * p.insets : bandes incrustées à exclure, en fractions de l'image
   * p.zonesV / p.zonesH : nombre de segments pour les bords gauche/droite et haut/bas
   * p.detectBaked : calcule les candidats de bandes incrustées (au-delà de p.locked)
   * p.locked : bandes actuellement recouvertes par la lueur (test de texture, point de départ des candidats)
   */
  function sample(data, w, h, p) {
    const pic = toBox(p.rect, w, h);
    if (!pic) return null;
    const pw = pic.x1 - pic.x0;
    const ph = pic.y1 - pic.y0;
    const ins = p.insets || ZERO;
    const act = {
      x0: pic.x0 + Math.round(ins.l * pw),
      x1: pic.x1 - Math.round(ins.r * pw),
      y0: pic.y0 + Math.round(ins.t * ph),
      y1: pic.y1 - Math.round(ins.b * ph),
    };
    if (act.x1 - act.x0 < 4 || act.y1 - act.y0 < 4) return null;
    const dx = Math.max(2, Math.round((act.x1 - act.x0) * EDGE_DEPTH));
    const dy = Math.max(2, Math.round((act.y1 - act.y0) * EDGE_DEPTH));
    const frame = {
      left: edgeZones(data, w, act, 'left', dx, p.zonesV),
      right: edgeZones(data, w, act, 'right', dx, p.zonesV),
      top: edgeZones(data, w, act, 'top', dy, p.zonesH),
      bottom: edgeZones(data, w, act, 'bottom', dy, p.zonesH),
      peak: centralPeak(data, w, act),
    };
    if (p.detectBaked) {
      frame.cand = bakedCandidates(data, w, pic, p.locked);
      frame.content = hasContent(data, w, pic);
    }
    // Rappel de la zone recouverte au moment de la capture : une réponse arrivée après un
    // changement de verrouillage ne doit pas être interprétée avec le nouvel état.
    frame.covered = p.locked || null;
    if (p.locked) frame.tex = lockedTexture(data, w, pic, p.locked);
    return frame;
  }

  const api = { sample, targetSize, linearToSrgb8, TO_LINEAR, DARK_LUMA };
  root.CineHalo = root.CineHalo || {};
  root.CineHalo.sampler = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
