// Test de bout en bout : charge l'extension dans Chromium, sert une fausse page netflix.com/watch
// (vidéo non protégée) et vérifie que la lueur apparaît avec les bonnes couleurs.
//
// Lancement : xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/run.cjs
// Les captures d'écran atterrissent dans tests/e2e/out/.
//
// Pour le mode auto, on ajoute <all_urls> à une copie du manifest : l'automatisation ne peut
// pas cliquer sur l'icône, et c'est ce clic (activeTab) qui autorise la capture en vrai.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return require(path.join(globalRoot, 'playwright'));
  }
}

const { chromium } = loadPlaywright();
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const PAGE = fs.readFileSync(path.join(__dirname, 'fake-watch.html'), 'utf8');

function buildTestExtension({ allUrls }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinehalo-ext-'));
  for (const item of ['manifest.json', '_locales', 'icons', 'src']) {
    fs.cpSync(path.join(ROOT, item), path.join(dir, item), { recursive: true });
  }
  if (allUrls) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.host_permissions = ['<all_urls>'];
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  return dir;
}

// Appuie sur Alt+Shift+L au niveau X11 (il faut python-xlib), comme un vrai clavier.
function pressShortcut() {
  execSync(`python3 ${JSON.stringify(path.join(__dirname, 'press_shortcut.py'))}`);
}

function hasXlib() {
  try {
    execSync('python3 -c "import Xlib"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout, label) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timeout: ${label}`);
}

// Pixel moyen d'un panneau de lueur, mesuré côté image (t ~ 0) au milieu de la hauteur.
async function panelColor(page, side) {
  return page.evaluate((side) => {
    const el = document.querySelector(`[data-cinehalo="${side}"]`);
    if (!el) return null;
    const canvas = el.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    let x;
    let y;
    if (side === 'left') [x, y] = [w - 1, h >> 1];
    else if (side === 'right') [x, y] = [0, h >> 1];
    else if (side === 'top') [x, y] = [w >> 1, h - 1];
    else [x, y] = [w >> 1, 0];
    const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
    const rect = el.getBoundingClientRect();
    return { r, g, b, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
  }, side);
}

async function status(page) {
  return page.evaluate(() => document.querySelector('[data-cinehalo="root"]')?.style.opacity);
}

async function glowStatus(page) {
  return page.evaluate(() => document.querySelector('[data-cinehalo="root"]')?.dataset.status);
}

// Une fenêtre par format d'écran, en taille réelle (viewport: null). L'émulation de viewport de
// Playwright décale la surface réellement capturée et fausserait les mesures.
async function launch(ext, width, height) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cinehalo-profile-'));
  const context = await chromium.launchPersistentContext(userData, {
    headless: false,
    viewport: null,
    // sans la barre "contrôlé par un logiciel de test", qui change la hauteur après le chargement
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      '--autoplay-policy=no-user-gesture-required',
      `--window-size=${width},${height}`,
    ],
  });
  await context.route('https://www.netflix.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }),
  );
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  return { context, sw };
}

// Géométrie attendue : image 16:9 centrée dans la zone visible
async function geometry(page) {
  return page.evaluate(() => {
    const vw = innerWidth;
    const vh = innerHeight;
    const pw = Math.min(vw, (vh * 16) / 9);
    const ph = Math.min(vh, (vw * 9) / 16);
    return { vw, vh, pw, ph, sideBar: (vw - pw) / 2 };
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ext = buildTestExtension({ allUrls: true });
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` -> ${detail}` : ''}`);
  };

  // Écran très large (~32:9), image 16:9 : grosses bandes latérales
  const first = await launch(ext, 1600, 540);
  try {
    const { context, sw } = first;
    const extId = new URL(sw.url()).host;
    const page = context.pages()[0] || (await context.newPage());
    page.on('console', (m) => {
      if (m.type() === 'error') console.log('[page]', m.text());
    });
    await page.goto('https://www.netflix.com/watch/80000001');
    await waitFor(() => page.evaluate(() => !!document.querySelector('[data-cinehalo="left"]')), 10000, 'panneau gauche');
    const left = await waitFor(async () => {
      const c = await panelColor(page, 'left');
      return c && c.r > 120 ? c : null;
    }, 10000, 'lueur gauche chaude');
    const geo = await geometry(page);
    console.log(`zone visible ${geo.vw}x${geo.vh}, bande latérale attendue ${geo.sideBar.toFixed(1)} px`);
    check('ultrawide : lueur gauche chaude', left.r > 120 && left.r > left.b, JSON.stringify(left));
    const right = await panelColor(page, 'right');
    check('ultrawide : lueur droite froide', right && right.b > 120 && right.b > right.r, JSON.stringify(right));
    check('ultrawide : le panneau couvre toute la bande', Math.abs(left.rect.w - geo.sideBar) < 2, `largeur ${left.rect.w}`);
    check('ultrawide : pas de panneau haut/bas', !(await panelColor(page, 'top')) && !(await panelColor(page, 'bottom')));
    await sleep(1500);
    await page.screenshot({ path: path.join(OUT, 'ultrawide.png') });

    // Pause : la lueur reste figée
    await page.evaluate(() => document.querySelector('video').pause());
    await sleep(1200);
    const paused = await panelColor(page, 'left');
    check('pause : la lueur reste allumée', paused.r > 120, JSON.stringify(paused));
    await page.evaluate(() => document.querySelector('video').play());

    // Réglages en direct : intensité à 0.3, la lueur baisse
    await sw.evaluate(() => chrome.storage.sync.set({ intensity: 0.3, preset: 'custom' }));
    const dimmed = await waitFor(async () => {
      const c = await panelColor(page, 'left');
      return c && c.r < paused.r * 0.5 ? c : null;
    }, 5000, 'lueur atténuée');
    check('intensité réduite appliquée', true, JSON.stringify(dimmed));
    await sw.evaluate(() => chrome.storage.sync.set({ intensity: 1, preset: 'balanced' }));

    // Désactivation
    await sw.evaluate(() => chrome.storage.sync.set({ enabled: false }));
    await waitFor(async () => (await status(page)) === '0', 4000, 'lueur cachée');
    check('désactivation cache la lueur', true);
    await sw.evaluate(() => chrome.storage.sync.set({ enabled: true }));

    // Popup (aperçu visuel)
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    await popup.click('#advanced summary');
    await sleep(300);
    await popup.locator('.app').screenshot({ path: path.join(OUT, 'popup.png') });
    check('popup affiché', true);
  } finally {
    await first.context.close();
  }

  // Écran 16:9 + bandes incrustées dans la vidéo : la lueur doit apparaître dedans après détection
  const second = await launch(ext, 1280, 860);
  try {
    const page = second.context.pages()[0] || (await second.context.newPage());
    await page.goto('https://www.netflix.com/watch/80000002?baked=1');
    await sleep(1000);
    const geo = await geometry(page);
    const bar = 0.12 * geo.ph;
    console.log(`zone visible ${geo.vw}x${geo.vh}, bande incrustée attendue ${bar.toFixed(1)} px`);
    const top = await waitFor(async () => {
      const c = await panelColor(page, 'top');
      return c && c.g > 80 && c.rect.h > bar - 6 ? c : null;
    }, 30000, 'lueur dans la bande incrustée du haut');
    check('bandes incrustées : haut (vert)', Math.abs(top.rect.h - bar) < 4, JSON.stringify(top));
    const bottom = await waitFor(async () => {
      const c = await panelColor(page, 'bottom');
      return c && Math.abs(c.rect.h - bar) < 4 ? c : null;
    }, 15000, 'lueur dans la bande incrustée du bas');
    check('bandes incrustées : bas', true, JSON.stringify(bottom));
    // Lueur latérale seulement si la fenêtre n'est pas pile en 16:9 (seuil : 12 px et 2 % de la largeur)
    const sides = !!(await panelColor(page, 'left')) && !!(await panelColor(page, 'right'));
    const expectSides = geo.sideBar >= Math.max(12, 0.02 * geo.vw);
    check('16:9 : lueur latérale seulement si besoin', sides === expectSides, `bande latérale ${geo.sideBar.toFixed(1)} px`);
    await sleep(1500);
    await page.screenshot({ path: path.join(OUT, 'baked-16x9.png') });
  } finally {
    await second.context.close();
  }

  // Parcours réel, manifest d'origine (sans <all_urls>) : il faut le raccourci (ou un clic) pour
  // accorder activeTab. On teste ensuite le mode temps réel (tabCapture + offscreen).
  if (!hasXlib()) {
    console.log('SKIP parcours réel : python-xlib absent (pip install python-xlib)');
  } else {
    const real = await launch(buildTestExtension({ allUrls: false }), 1600, 540);
    try {
      const { context, sw } = real;
      const page = context.pages()[0] || (await context.newPage());
      await page.goto('https://www.netflix.com/watch/80000003');
      await waitFor(async () => (await glowStatus(page)) === 'needs-click', 10000, 'attente du clic');
      check('sans clic : la capture attend activeTab', true);
      await page.bringToFront();
      pressShortcut();
      await waitFor(async () => (await glowStatus(page)) === 'active', 10000, 'activation par raccourci');
      const enabled = (await sw.evaluate(() => chrome.storage.sync.get({ enabled: true }))).enabled;
      check('raccourci : active la lueur au lieu de l’éteindre', enabled === true);
      await waitFor(async () => {
        const c = await panelColor(page, 'left');
        return c && c.r > 120 && c.r > c.b ? c : null;
      }, 10000, 'lueur chaude après activation');

      await sw.evaluate(() => chrome.storage.sync.set({ captureMode: 'realtime' }));
      const contexts = () => sw.evaluate(async () => (await chrome.runtime.getContexts({})).map((c) => c.contextType));
      await waitFor(async () => (await contexts()).includes('OFFSCREEN_DOCUMENT'), 10000, 'document offscreen');
      check('temps réel : flux d’onglet démarré', true);
      await page.evaluate(() => (window.swapColors = true));
      const swapped = await waitFor(async () => {
        const c = await panelColor(page, 'left');
        return c && c.b > 120 && c.b > c.r ? c : null;
      }, 8000, 'la lueur suit le changement en temps réel');
      check('temps réel : la lueur suit l’image', true, JSON.stringify(swapped));
      await page.screenshot({ path: path.join(OUT, 'realtime.png') });

      await sw.evaluate(() => chrome.storage.sync.set({ captureMode: 'auto' }));
      await waitFor(async () => !(await contexts()).includes('OFFSCREEN_DOCUMENT'), 8000, 'fermeture offscreen');
      check('retour en auto : le flux est coupé', true);
    } finally {
      await real.context.close();
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} vérifications OK`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
