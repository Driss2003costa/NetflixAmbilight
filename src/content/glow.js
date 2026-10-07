// Rendu d'un panneau de lueur (une bande noire). On dessine dans un tout petit canvas que le
// navigateur agrandit en lissant, ça coûte presque rien même sur un écran 32:9.
(function (root) {
  'use strict';

  const { linearToSrgb8 } = root.CineHalo.sampler;

  const ACROSS = 48; // résolution interne dans le sens de la profondeur de la bande
  const NOISE_SCALE = 2; // le bruit anti-banding est généré à demi-résolution

  // Atténuation avec la distance à l'image, en lumière linéaire. reach = 1 : la lueur
  // s'éteint pile au bord de l'écran.
  function falloff(t, reach) {
    const u = t / reach;
    if (u >= 1) return 0;
    return 0.92 * Math.pow(1 - u, 2.2);
  }

  function alongFor(zones) {
    return Math.max(48, Math.min(192, zones * 6));
  }

  class Panel {
    constructor(side, parent) {
      this.side = side;
      this.vertical = side === 'left' || side === 'right';
      this.zones = 0;
      this.along = 0;
      this.dirty = true;

      this.el = document.createElement('div');
      this.el.dataset.cinehalo = side;
      Object.assign(this.el.style, {
        position: 'absolute',
        overflow: 'hidden',
        pointerEvents: 'none',
        isolation: 'isolate',
        // "lighten" : sur du noir on voit la lueur, et si l'image déborde sur une bande
        // incrustée qu'on recouvre, elle reste visible au lieu d'être masquée.
        mixBlendMode: 'lighten',
      });

      this.canvas = document.createElement('canvas');
      Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
      this.ctx = this.canvas.getContext('2d', { alpha: false });

      // Léger bruit en "soft-light" : invisible, mais casse les escaliers de couleur des grands
      // dégradés sombres. Sur du noir pur, soft-light ne change rien, le noir reste noir.
      this.noise = document.createElement('canvas');
      Object.assign(this.noise.style, {
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
        mixBlendMode: 'soft-light',
        imageRendering: 'pixelated',
      });

      this.el.append(this.canvas, this.noise);
      parent.append(this.el);
    }

    setRect(x, y, w, h) {
      const s = this.el.style;
      s.left = `${x}px`;
      s.top = `${y}px`;
      s.width = `${w}px`;
      s.height = `${h}px`;
      const nw = Math.max(1, Math.ceil(w / NOISE_SCALE));
      const nh = Math.max(1, Math.ceil(h / NOISE_SCALE));
      if (this.noise.width !== nw || this.noise.height !== nh) {
        this.noise.width = nw;
        this.noise.height = nh;
        paintNoise(this.noise);
      }
    }

    setZones(zones) {
      if (zones === this.zones) return;
      this.zones = zones;
      this.along = alongFor(zones);
      const w = this.vertical ? ACROSS : this.along;
      const h = this.vertical ? this.along : ACROSS;
      this.canvas.width = w;
      this.canvas.height = h;
      this.img = this.ctx.createImageData(w, h);
      this.base = new Float32Array(this.along * 3);
      this.prefix = new Float64Array((this.along + 1) * 3);
      this.dirty = true;
    }

    // colors : Float32Array de n couleurs en linéaire. look : { intensity, saturation, reach }
    draw(colors, look) {
      const n = this.zones;
      const along = this.along;
      const base = this.base;
      const P = this.prefix;
      const sat = look.saturation;
      // Intensité perceptuelle : 50 % sur le curseur donne une lueur qui paraît deux fois moins forte.
      const gain = Math.pow(look.intensity, 2.2);

      // 1. Couleur au ras de l'image, interpolée en douceur entre les centres des zones.
      for (let j = 0; j < along; j++) {
        let pos = ((j + 0.5) / along) * n - 0.5;
        if (pos < 0) pos = 0;
        let i0 = Math.floor(pos);
        if (i0 > n - 1) i0 = n - 1;
        const i1 = Math.min(n - 1, i0 + 1);
        const f = (1 - Math.cos(Math.PI * (pos - i0))) / 2;
        const o = j * 3;
        for (let c = 0; c < 3; c++) {
          base[o + c] = colors[i0 * 3 + c] * (1 - f) + colors[i1 * 3 + c] * f;
        }
        const Y = 0.2126 * base[o] + 0.7152 * base[o + 1] + 0.0722 * base[o + 2];
        for (let c = 0; c < 3; c++) {
          const v = (Y + (base[o + c] - Y) * sat) * gain;
          base[o + c] = v > 0 ? v : 0;
        }
      }

      // 2. Sommes cumulées pour un flou qui s'élargit en s'éloignant de l'image (la lumière diffuse).
      P[0] = P[1] = P[2] = 0;
      for (let j = 0; j < along; j++) {
        const o = j * 3;
        const q = (j + 1) * 3;
        P[q] = P[o] + base[o];
        P[q + 1] = P[o + 1] + base[o + 1];
        P[q + 2] = P[o + 2] + base[o + 2];
      }

      // 3. Une colonne par distance à l'image.
      const data = this.img.data;
      const W = this.canvas.width;
      for (let k = 0; k < ACROSS; k++) {
        const t = k / (ACROSS - 1);
        const fall = falloff(t, look.reach);
        const rad = Math.round((0.03 + 0.22 * t) * along);
        for (let j = 0; j < along; j++) {
          let r = 0;
          let g = 0;
          let b = 0;
          if (fall > 0) {
            const a0 = j - rad > 0 ? j - rad : 0;
            const a1 = j + rad + 1 < along ? j + rad + 1 : along;
            const inv = fall / (a1 - a0);
            r = linearToSrgb8((P[a1 * 3] - P[a0 * 3]) * inv);
            g = linearToSrgb8((P[a1 * 3 + 1] - P[a0 * 3 + 1]) * inv);
            b = linearToSrgb8((P[a1 * 3 + 2] - P[a0 * 3 + 2]) * inv);
          }
          let x;
          let y;
          if (this.side === 'left') {
            x = ACROSS - 1 - k;
            y = j;
          } else if (this.side === 'right') {
            x = k;
            y = j;
          } else if (this.side === 'top') {
            x = j;
            y = ACROSS - 1 - k;
          } else {
            x = j;
            y = k;
          }
          const i = (y * W + x) * 4;
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
          data[i + 3] = 255;
        }
      }
      this.ctx.putImageData(this.img, 0, 0);
      this.dirty = false;
    }

    remove() {
      this.el.remove();
    }
  }

  function paintNoise(canvas) {
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      // bruit triangulaire autour de 128, amplitude ±4 : de l'ordre d'un niveau de couleur au final
      const v = 128 + Math.round((Math.random() + Math.random() - 1) * 4);
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  root.CineHalo.Panel = Panel;
})(globalThis);
