// Suivi des bandes noires incrustées dans la vidéo (vieux films, docs en 4:3...).
// Une bande incrustée est constante pendant tout le film. Les scènes sombres la font paraître plus
// grande, l'interface Netflix ou un sous-titre la font paraître plus petite. On garde donc un bas
// centile sur plusieurs secondes d'images "avec contenu" avant de verrouiller.
(function (root) {
  'use strict';

  const ZERO = Object.freeze({ t: 0, b: 0, l: 0, r: 0 });
  const EDGES = ['t', 'b', 'l', 'r'];
  const MIN_FRAMES = 8;
  const MAX_SAMPLES = 120;
  const PERCENTILE = 0.2; // tolère ~20 % d'images où un overlay mord sur la bande
  const MIN_DETECT_MS = 5000;
  const WINDOW_MS = 30000; // sans résultat, on recommence une fenêtre neuve
  const MIN_EDGE = 0.015; // en dessous, ce n'est pas une bande, juste un bord sombre
  const MIN_TOTAL = 0.03;
  const MIN_GROW = 0.008; // agrandissement minimal d'une bande déjà verrouillée
  const MAX_LOCK = 0.35;
  const TEX_LIMIT = 5; // énergie de gradient au-delà de laquelle on considère que l'image déborde
  const TEX_HITS = 2;
  const COOLDOWN_MS = 10000;

  class BakedTracker {
    constructor(now = 0) {
      this.reset(now);
    }

    reset(now = 0) {
      this.state = 'detecting';
      this.locked = null;
      this.samples = [];
      this.since = now;
      this.texHits = 0;
      this.cooldownUntil = 0;
    }

    get frames() {
      return this.samples.length;
    }

    estimate() {
      return quantize(percentile(this.samples));
    }

    // Bandes à exclure pour l'échantillonnage : la valeur verrouillée, sinon l'estimation en cours.
    activeInsets() {
      if (this.locked) return this.locked;
      if (this.samples.length >= 2) return this.estimate();
      return ZERO;
    }

    // Renvoie true si l'état verrouillé a changé (il faut refaire la mise en page).
    update(frame, now) {
      if (this.state === 'cooldown') {
        if (now >= this.cooldownUntil) this.reset(now);
        return false;
      }
      // Mesure faite avec un autre état de verrouillage (capture partie avant le changement) : on l'ignore.
      if (!sameInsets(frame.covered, this.locked)) return false;
      if (this.state === 'locked') {
        const tex = frame.tex || ZERO;
        const overflow = EDGES.some((e) => this.locked[e] > 0 && tex[e] > TEX_LIMIT);
        this.texHits = overflow ? this.texHits + 1 : 0;
        if (this.texHits >= TEX_HITS) {
          this.state = 'cooldown';
          this.locked = null;
          this.cooldownUntil = now + COOLDOWN_MS;
          return true;
        }
        return this.grow(frame, now);
      }
      if (!this.collect(frame)) return false;
      if (this.samples.length >= MIN_FRAMES && now - this.since >= MIN_DETECT_MS) {
        const q = this.estimate();
        if (q.t + q.b >= MIN_TOTAL || q.l + q.r >= MIN_TOTAL) {
          this.state = 'locked';
          this.locked = q;
          this.texHits = 0;
          this.samples = [];
          this.since = now;
          return true;
        }
        if (now - this.since >= WINDOW_MS) this.reset(now);
      }
      return false;
    }

    collect(frame) {
      if (!frame.cand || !frame.content) return false;
      this.samples.push({ ...frame.cand });
      if (this.samples.length > MAX_SAMPLES) this.samples.shift();
      return true;
    }

    // Une fois verrouillé, les candidats mesurent le noir qui reste au-delà de la zone recouverte.
    // Si l'interface Netflix a faussé la première mesure, la bande s'agrandit ici jusqu'à la vraie taille.
    grow(frame, now) {
      if (!this.collect(frame)) return false;
      if (this.samples.length < MIN_FRAMES || now - this.since < MIN_DETECT_MS) return false;
      const g = percentile(this.samples);
      this.samples = [];
      this.since = now;
      let grew = false;
      for (const e of EDGES) {
        if (g[e] >= MIN_GROW) {
          this.locked = { ...this.locked, [e]: Math.min(MAX_LOCK, this.locked[e] + g[e]) };
          grew = true;
        }
      }
      return grew;
    }
  }

  function sameInsets(a, b) {
    if (!a || !b) return !a && !b;
    return EDGES.every((e) => Math.abs(a[e] - b[e]) < 1e-9);
  }

  function percentile(samples) {
    const out = {};
    for (const e of EDGES) {
      const values = samples.map((s) => s[e]).sort((a, b) => a - b);
      out[e] = values[Math.floor(PERCENTILE * (values.length - 1))];
    }
    return out;
  }

  function quantize(c) {
    const out = {};
    for (const e of EDGES) out[e] = c[e] >= MIN_EDGE ? c[e] : 0;
    return out;
  }

  const api = { BakedTracker, ZERO };
  root.CineHalo = root.CineHalo || {};
  root.CineHalo.baked = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
