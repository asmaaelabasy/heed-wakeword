// Runs inside the hidden offscreen document. Owns the actual microphone
// stream, the streaming preprocessor, and the ONNX Runtime session — the
// same WakeWordDetector used by examples/inference_browser, unmodified.
import { WakeWordDetector } from "./wakeword.js";

// Local wasm runtime only — Manifest V3 extension pages cannot execute
// remotely-fetched code, so onnxruntime-web's .wasm binaries must ship
// inside the extension (see ort/ next to this file) rather than being
// pulled from a CDN the way the plain browser demo does.
ort.env.wasm.wasmPaths = chrome.runtime.getURL("ort/");
ort.env.wasm.numThreads = 1; // avoids the cross-origin-isolation headers
ort.env.wasm.simd = true;    // threaded wasm needs (COOP/COEP), which an
                              // extension page can't set for itself.

// Plain-English step-by-step log, sent to any open debug.html AND kept in
// chrome.storage, so failures are visible without ever needing Chrome's own
// DevTools "Inspect views" (which navigate instead of opening DevTools for
// some users/versions, in an already-confirmed-flaky way for offscreen
// pages). This is the primary way to see why startup failed.
async function log(message, level = "info") {
  const entry = { at: Date.now(), message, level };
  console[level === "error" ? "error" : "log"]("[heed offscreen]", message);
  chrome.runtime.sendMessage({ type: "offscreen-log", ...entry }).catch(() => {});
  try {
    const { logs = [] } = await chrome.storage.local.get("logs");
    logs.push(entry);
    while (logs.length > 100) logs.shift();
    await chrome.storage.local.set({ logs });
  } catch {
    // storage can fail if the document is being torn down; the console line
    // above already has the message, so this is not the only record of it.
  }
}

let detector = null;
let audioCtx = null;
let micStream = null;
let workletNode = null;

async function loadModel() {
  log("loading model files (models/wake.onnx + models/wake.json)…");
  const meta = await fetch(chrome.runtime.getURL("models/wake.json")).then((r) => r.json());
  const sess = await ort.InferenceSession.create(
    chrome.runtime.getURL("models/wake.onnx"),
    { executionProviders: ["wasm"] },
  );
  detector = new WakeWordDetector(sess, meta);
  log(`model loaded — phrase="${meta.phrase}" threshold=${meta.threshold}`);
  return meta;
}

async function start() {
  const meta = await loadModel();

  log("requesting microphone…");
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  log("microphone granted, setting up audio pipeline…");

  audioCtx = new AudioContext({ sampleRate: 16000 });
  await audioCtx.audioWorklet.addModule("audio-worklet.js");
  const src = audioCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(audioCtx, "wake-word-capture");

  // If the mic device disappears/is revoked mid-session, this fires — without
  // it, capture just silently stops and nothing ever explains why.
  micStream.getAudioTracks()[0]?.addEventListener("ended", () => {
    log("microphone track ended (device disconnected, permission revoked, or taken by another app) — capture has stopped.", "error");
  });

  let frameCount = 0;
  workletNode.port.onmessage = async (e) => {
    frameCount++;
    if (frameCount === 1) log("first audio frame received — pipeline is live.");
    // debug:true costs a few extra typed-array copies per frame (raw chunk,
    // filtered chunk, the 40x101 mel picture) — negligible at ~10 frames/sec,
    // and it's the only way a debug view can show every pipeline stage
    // instead of just the final probability.
    let out;
    try {
      out = await detector.step(e.data, { debug: true });
    } catch (err) {
      log(`inference step threw: ${err?.message || err}`, "error");
      return;
    }
    // Broadcast every frame (~10/sec), not just triggers, so a debug view can
    // show the live score. Any open extension page (debug.html) picks this up
    // via its own chrome.runtime.onMessage listener — nothing is persisted to
    // chrome.storage for this, it's too frequent to be worth writing to disk.
    chrome.runtime.sendMessage({
      type: "wake-frame",
      phrase: meta.phrase,
      threshold: meta.threshold,
      ...out,
    }).catch(() => {}); // no listener open (no debug tab) — fine, ignore
    if (out.triggered) {
      chrome.runtime.sendMessage({ type: "wake-detected", prob: out.prob, phrase: meta.phrase });
    }
  };
  src.connect(workletNode);
  // Not connected to destination: we never want the mic played back out loud.
}

// Catches anything start() misses, including errors thrown outside the
// promise chain (e.g. inside the AudioWorklet's own registerProcessor code).
self.addEventListener("error", (e) => log(`uncaught error: ${e.message}`, "error"));
self.addEventListener("unhandledrejection", (e) => log(`unhandled rejection: ${e.reason?.message || e.reason}`, "error"));

start().catch((err) => {
  log(`failed to start: ${err?.message || err}`, "error");
  chrome.runtime.sendMessage({ type: "offscreen-error", message: String(err?.message || err) });
});
