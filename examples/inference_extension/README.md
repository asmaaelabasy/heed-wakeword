# Heed Wake Word — browser extension

An installable Chromium extension that listens in the background for a
trained wake word and opens/focuses a page when it hears it. Everything runs
on-device: the microphone audio never leaves the extension.

It ships with the exported model from `heed export` (`models/wake.onnx` +
`models/wake.json`) — swap those two files to use a different trained word.

## Install (unpacked, developer mode)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `inference_extension/` folder.
4. Click the extension's toolbar icon → **Open settings to grant mic
   access**. This one-time step happens on the settings page rather than the
   popup, because a browser-action popup auto-closes the instant a
   permission prompt appears — it can't complete the request itself.
5. Still on the settings page, set the URL to open/focus when the wake word
   fires, and **Save**.
6. Click the toolbar icon and press **Start listening**.

Say the wake word your model was trained on. The toolbar badge flashes and
the configured page opens (or is brought to the front if already open).

## How it's wired together

- **`manifest.json`** — Manifest V3. `offscreen` permission lets the
  extension keep a hidden page alive for the microphone; `storage` persists
  the listening state and settings across the service worker restarting
  (Chrome can kill and restart MV3 service workers at any time — nothing
  important lives only in `background.js`'s memory); `tabs` lets it find and
  focus an already-open matching tab instead of always opening a new one.
- **`background.js`** — the service worker. Creates/destroys the offscreen
  document, relays "wake word heard" events into opening/focusing the target
  URL, and keeps a small badge/state in `chrome.storage`.
- **`offscreen.html` / `offscreen.js`** — the hidden document that actually
  holds the microphone stream and runs inference. This exists because a
  Manifest V3 service worker cannot use `getUserMedia` or keep an
  `AudioContext` open itself — Chrome's `chrome.offscreen` API is the
  supported way to keep *something* alive for that.
- **`preprocessing.js`, `audio-worklet.js`, `filter-coeffs.js`,
  `wakeword.js`** — copied unmodified from `examples/inference_browser/`.
  Same streaming mel-spectrogram preprocessor, same `WakeWordDetector`
  trigger logic (hysteresis + refractory hold), same bit-for-bit agreement
  with the Python reference in `heed/audio.py`.
- **`ort/`** — a local copy of the `onnxruntime-web` runtime
  (`ort.min.js` + the plain and SIMD `.wasm` binaries, single-threaded).
  Manifest V3 extension pages are not allowed to execute remotely-fetched
  code, so unlike the plain browser demo (which loads `ort.min.js` from a
  CDN), this runtime has to ship inside the extension.
- **`popup.html` / `popup.js`** — the toolbar popup: shows the phrase, a
  Start/Stop button, and the last detection.
- **`options.html` / `options.js`** — the one-time mic-permission grant and
  the target-URL setting.

## Watching every pipeline stage (debugging, for enhancing the model)

The popup only shows the *last* trigger, after the fact. Click **"Open
pipeline debug view"** in the popup (or open `debug.html` directly) to watch
every stage the audio actually goes through, live, at ~10 frames/sec:

1. **Raw mic** — the untouched 100ms audio chunk, as captured.
2. **Filtered** — the same chunk after the causal high-pass + 50/60Hz notch
   (`heed/audio.py`'s filter, ported bit-for-bit). Compare the two waveforms
   to see what the filter actually removes.
3. **Mel spectrogram** — the literal 40×101 picture the model looks at (see
   the "Reading a Spectrogram" walkthrough for what this represents). Stays
   blank while gated, since the model — and this computation — is skipped
   entirely on ungated-out silence.
4. **Model output** — the raw pre-sigmoid **logit**, the **probability**
   it turns into, and the smoothed **EMA** used for display.
5. **Trigger state machine** — how many consecutive frames are currently
   above `threshold` versus how many are required to fire
   (`consecutive_frames` in `wake.json`), and the **refractory** countdown
   that blocks a second trigger immediately after one just fired.

This is the level of detail you'd want for actually improving the model —
e.g. watching the mel picture to see if a false trigger's spectrogram
resembles the real phrase (more data needed) or is unrelated noise that
slipped past the gate (gate threshold needs tightening in `wake.json`), or
watching the logit directly to see how close a near-miss actually was versus
what the rounded probability suggests.

`offscreen.js` broadcasts this via `chrome.runtime.sendMessage`
(`type: "wake-frame"`); `debug.js` only listens and redraws — none of it
touches `chrome.storage` (too frequent to be worth persisting), so closing
the tab loses nothing and never affects detection, which keeps running in
the offscreen document regardless of whether a debug tab is open.

If the dot next to "no data yet" never turns teal, listening isn't actually
running — check the popup's Start/Stop state first.

## Why the mic permission works without prompting twice

`offscreen.html` runs at the same extension origin
(`chrome-extension://<id>/...`) as `options.html`. Microphone permission in
Chrome is granted per-origin, so once you grant it from the options page,
the offscreen document's own `getUserMedia` call silently succeeds — no
second prompt.

## Scope and limitations (read before relying on this)

- **Chromium only.** This targets Chrome, Edge, Brave, Opera, and other
  Chromium-based browsers via the `chrome.offscreen` API. **Firefox does not
  implement `chrome.offscreen`**, and its Manifest V3 background pages have
  a different persistence model; porting it would mean swapping the
  offscreen-document approach for a Firefox-specific persistent background
  page. **Safari** would need the whole extension converted into a native
  Safari Web Extension wrapper via Apple's `safari-web-extension-converter`,
  plus its own review of mic-permission behavior. Neither port is done here.
- **Not signed/published.** This only runs as an unpacked developer-mode
  extension. Publishing it on the Chrome Web Store would need icons/store
  listing polish and passing Google's review (in particular, the
  always-on-microphone justification gets extra scrutiny).
- **After a browser restart, listening stops** and needs a manual **Start**
  again — this is intentional so microphone access always follows an
  explicit action, not something restarting silently in the background.
- **One model, bundled at build time.** There's no in-popup model
  picker/uploader like the plain browser demo has; to use a different word,
  replace `models/wake.onnx` and `models/wake.json` and reload the unpacked
  extension.
