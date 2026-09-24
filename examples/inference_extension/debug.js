const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const phraseVal = document.getElementById("phrase-val");
const logitVal = document.getElementById("logit-val");
const probVal = document.getElementById("prob-val");
const emaVal = document.getElementById("ema-val");
const gateVal = document.getElementById("gate-val");
const aboveVal = document.getElementById("above-val");
const probBar = document.getElementById("prob-bar");
const threshMarker = document.getElementById("thresh-marker");
const threshLabel = document.getElementById("thresh-label");
const refractoryBar = document.getElementById("refractory-bar");
const refractoryLabel = document.getElementById("refractory-label");
const triggerLog = document.getElementById("trigger-log");

const rawCtx = document.getElementById("raw-wave").getContext("2d");
const filtCtx = document.getElementById("filt-wave").getContext("2d");
const melCtx = document.getElementById("mel-canvas").getContext("2d");

let markerPlaced = false;
let staleTimer = null;

function markStale() {
  statusDot.classList.remove("live");
  statusText.textContent = "no recent frames — extension may not be listening";
}

function drawWave(ctx, samples, color) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  if (!samples || samples.length === 0) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const n = samples.length;
  const midY = height / 2;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * width;
    // Raw/filtered mic samples are roughly in [-1, 1]; clamp so an occasional
    // loud spike doesn't blow the trace off the canvas.
    const s = Math.max(-1, Math.min(1, samples[i]));
    const y = midY - s * midY * 0.95;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// Same 4-stop colormap as the "Reading a Spectrogram" explainer, so the live
// view and that walkthrough read as the same picture.
function colorFor(t) {
  const stops = [[13, 15, 26], [42, 26, 82], [122, 47, 110], [209, 91, 60], [244, 201, 86]];
  const tt = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(tt));
  const f = tt - i;
  const a = stops[i], b = stops[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

const N_MELS = 40, N_FRAMES = 101;

function drawMel(ctx, mel) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  if (!mel) return; // gated frame: nothing to show, this IS the point
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < mel.length; i++) {
    if (mel[i] < min) min = mel[i];
    if (mel[i] > max) max = mel[i];
  }
  const range = max - min || 1;
  const cellW = width / N_FRAMES, cellH = height / N_MELS;
  for (let mi = 0; mi < N_MELS; mi++) {
    const base = mi * N_FRAMES;
    const y = height - (mi + 1) * cellH; // low mel bin at the bottom, like the explainer figure
    for (let fi = 0; fi < N_FRAMES; fi++) {
      const v = (mel[base + fi] - min) / range;
      ctx.fillStyle = colorFor(v);
      ctx.fillRect(fi * cellW, y, cellW + 1, cellH + 1);
    }
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "wake-frame") return;

  statusDot.classList.add("live");
  statusText.textContent = "receiving live frames";
  clearTimeout(staleTimer);
  staleTimer = setTimeout(markStale, 2000);

  phraseVal.textContent = `"${msg.phrase}"`;
  if (!markerPlaced) {
    threshLabel.textContent = msg.threshold.toFixed(3);
    threshMarker.style.left = `${msg.threshold * 100}%`;
    markerPlaced = true;
  }

  // Stage 1 + 2: raw vs. filtered audio, same chunk, side by side.
  drawWave(rawCtx, msg.rawChunk, "#9aa6a6");
  drawWave(filtCtx, msg.filteredChunk, "#5fb3ab");

  // Stage 3: the mel picture the model actually consumes. Null while gated.
  drawMel(melCtx, msg.mel);

  // Stage 4: model output.
  logitVal.textContent = msg.logit == null ? "— (gated, model not run)" : msg.logit.toFixed(3);
  probVal.textContent = msg.prob.toFixed(3);
  emaVal.textContent = msg.ema.toFixed(3);
  probBar.style.width = `${Math.min(100, msg.prob * 100).toFixed(0)}%`;
  probBar.classList.toggle("triggered", msg.triggered);

  // Stage 5: the trigger state machine.
  const rms = msg.rmsDbfs == null || !isFinite(msg.rmsDbfs) ? "-∞" : msg.rmsDbfs.toFixed(0);
  const bf = msg.bandFrac != null ? msg.bandFrac.toFixed(2) : "-";
  gateVal.textContent = msg.gated ? `skipped (${rms} dBFS, band ${bf})` : `passed (${rms} dBFS, band ${bf})`;
  aboveVal.textContent = `${msg.aboveCount ?? 0} / ${msg.consecutiveFrames ?? "?"} needed to fire`;

  const refr = msg.refractoryRemaining ?? 0;
  if (refr > 0) {
    // refractorySeconds isn't sent every frame, but the bar only needs to
    // read "counting down"; a fixed 1s scale is a fine visual proxy.
    refractoryBar.style.width = `${Math.min(100, (refr / 1.0) * 100).toFixed(0)}%`;
    refractoryLabel.textContent = `refractory: ${refr.toFixed(2)}s left (new triggers blocked)`;
  } else {
    refractoryBar.style.width = "0%";
    refractoryLabel.textContent = "refractory: idle (can fire)";
  }

  if (msg.triggered) {
    const ts = new Date().toLocaleTimeString();
    const line = document.createElement("div");
    line.className = "pulse";
    line.textContent = `${ts}  TRIGGER  (logit=${msg.logit?.toFixed(3)} prob=${msg.prob.toFixed(3)} ema=${msg.ema.toFixed(3)})`;
    triggerLog.prepend(line);
  }
});

// ---- extension log panel: plain-English steps + errors from background.js
// and offscreen.js, so failures are visible without Chrome's own DevTools. ----
const extLog = document.getElementById("ext-log");

function renderLogs(logs) {
  if (!logs || logs.length === 0) return;
  extLog.innerHTML = "";
  for (const entry of logs) {
    const line = document.createElement("div");
    if (entry.level === "error") line.style.color = "#d15b3c";
    const ts = new Date(entry.at).toLocaleTimeString();
    line.textContent = `${ts}  ${entry.message}`;
    extLog.appendChild(line);
  }
  extLog.scrollTop = extLog.scrollHeight;
}

chrome.storage.local.get("logs").then(({ logs }) => renderLogs(logs));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.logs) renderLogs(changes.logs.newValue);
});

markStale();
