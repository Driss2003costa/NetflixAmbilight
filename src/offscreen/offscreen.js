// Document offscreen : reçoit le flux de l'onglet (tabCapture) et en tire les couleurs à 10-24 img/s.
// Il n'a accès qu'à chrome.runtime, les résultats passent donc par le service worker.
(() => {
  'use strict';

  const { sampler } = globalThis.CineHalo;
  const HEARTBEAT_TIMEOUT_MS = 6000; // plus de nouvelles de l'onglet : on coupe le flux

  let session = null;
  let work = null;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return false;
    if (msg.type === 'rt-start') {
      start(msg).then(sendResponse, (e) =>
        sendResponse({ ok: false, error: 'getUserMedia', message: String((e && e.message) || e) }),
      );
      return true;
    }
    if (msg.type === 'rt-update') sendResponse({ ok: update(msg) });
    else if (msg.type === 'rt-stop') {
      stop(null);
      sendResponse({ ok: true });
    }
    return false;
  });

  async function start(msg) {
    stop(null);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: msg.streamId,
          // min et max avec des ratios différents : Chrome garde le ratio de l'onglet sans bandes.
          maxWidth: 1280,
          maxHeight: 1280,
          minWidth: 64,
          minHeight: 36,
          maxFrameRate: 30,
        },
      },
    });
    const track = stream.getVideoTracks()[0];
    const s = {
      tabId: msg.tabId,
      stream,
      track,
      params: msg.params,
      active: msg.active,
      fps: msg.fps || 24,
      lastBeat: performance.now(),
      lastSample: 0,
      stopped: false,
    };
    session = s;
    // "ended" : l'utilisateur a cliqué sur "Arrêter le partage" dans Chrome.
    track.addEventListener('ended', () => {
      if (session === s) stop('ended');
    });
    s.watchdog = setInterval(() => {
      if (performance.now() - s.lastBeat > HEARTBEAT_TIMEOUT_MS) stop('timeout');
    }, 2000);
    if (typeof MediaStreamTrackProcessor === 'function') readFrames(s);
    else readVideo(s);
    return { ok: true };
  }

  function update(msg) {
    const s = session;
    if (!s || s.tabId !== msg.tabId) return false;
    s.params = msg.params;
    s.active = msg.active;
    s.fps = msg.fps || s.fps;
    s.lastBeat = performance.now();
    return true;
  }

  function due(s) {
    if (!s.active || !s.params) return false;
    const now = performance.now();
    if (now - s.lastSample < 1000 / s.fps - 4) return false;
    s.lastSample = now;
    return true;
  }

  // Lecture directe des VideoFrame : fiable même si le document n'est jamais affiché.
  async function readFrames(s) {
    const reader = new MediaStreamTrackProcessor({ track: s.track }).readable.getReader();
    s.reader = reader;
    try {
      while (!s.stopped) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        try {
          if (due(s)) process(s, frame, frame.displayWidth, frame.displayHeight);
        } finally {
          frame.close();
        }
      }
    } catch (e) {
      if (!s.stopped) stop('error');
    }
  }

  // Repli pour les versions sans MediaStreamTrackProcessor.
  function readVideo(s) {
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = s.stream;
    video.play().catch(() => {});
    s.video = video;
    const loop = () => {
      if (s.stopped) return;
      if (video.readyState >= 2 && due(s)) process(s, video, video.videoWidth, video.videoHeight);
      s.timer = setTimeout(loop, 1000 / Math.max(1, s.fps));
    };
    loop();
  }

  function process(s, source, sw, sh) {
    if (!sw || !sh) return;
    const { w, h } = sampler.targetSize(sw, sh);
    if (!work || work.canvas.width !== w || work.canvas.height !== h) {
      const canvas = new OffscreenCanvas(w, h);
      work = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
    }
    work.ctx.drawImage(source, 0, 0, w, h);
    const frame = sampler.sample(work.ctx.getImageData(0, 0, w, h).data, w, h, s.params);
    if (frame) chrome.runtime.sendMessage({ type: 'rt-frame', tabId: s.tabId, frame }).catch(() => {});
  }

  function stop(reason) {
    const s = session;
    if (!s) return;
    session = null;
    s.stopped = true;
    clearInterval(s.watchdog);
    clearTimeout(s.timer);
    if (s.reader) s.reader.cancel().catch(() => {});
    for (const track of s.stream.getTracks()) track.stop();
    if (s.video) s.video.srcObject = null;
    if (reason) chrome.runtime.sendMessage({ type: 'rt-stopped', tabId: s.tabId, reason }).catch(() => {});
  }
})();
