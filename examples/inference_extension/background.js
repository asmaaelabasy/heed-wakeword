// Service worker: owns the offscreen document's lifecycle, persists
// listening state, and reacts to wake-word detections by opening/focusing
// the configured URL. Manifest V3 service workers are non-persistent (Chrome
// can kill and restart this file at any time), so all state that must survive
// a restart lives in chrome.storage, not in module-level variables here.

const OFFSCREEN_URL = "offscreen.html";

// Same plain-English log as offscreen.js keeps, so a single "Extension log"
// panel on debug.html can show both what background.js did (create/close the
// offscreen doc) and what offscreen.js did (mic/model steps) in one timeline.
async function log(message, level = "info") {
  const entry = { at: Date.now(), message, level };
  console[level === "error" ? "error" : "log"]("[heed background]", message);
  const { logs = [] } = await chrome.storage.local.get("logs");
  logs.push(entry);
  while (logs.length > 100) logs.shift();
  await chrome.storage.local.set({ logs });
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function startListening() {
  try {
    if (!(await hasOffscreenDocument())) {
      log("creating offscreen document…");
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA"],
        justification: "Keeps the microphone open to listen for the trained wake word.",
      });
      log("offscreen document created.");
    } else {
      log("offscreen document already exists, reusing it.");
    }
  } catch (err) {
    log(`could not create offscreen document: ${err?.message || err}`, "error");
    throw err;
  }
  await chrome.storage.local.set({ listening: true, lastError: null });
  updateBadge(true);
}

async function stopListening() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
  await chrome.storage.local.set({ listening: false });
  updateBadge(false);
}

function updateBadge(listening) {
  chrome.action.setBadgeText({ text: listening ? "on" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#2f6f6a" });
}

async function focusOrOpenUrl(url) {
  if (!url) return;
  let target;
  try {
    target = new URL(url);
  } catch {
    return; // invalid URL saved in options; nothing to do
  }
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => {
    try {
      return new URL(t.url).origin === target.origin && new URL(t.url).pathname === target.pathname;
    } catch {
      return false;
    }
  });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "wake-detected") {
    chrome.storage.local.set({
      lastDetection: { at: Date.now(), prob: msg.prob },
    });
    chrome.storage.local.get("targetUrl").then(({ targetUrl }) => {
      focusOrOpenUrl(targetUrl);
    });
    // Brief visual pulse on the toolbar icon.
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#d15b3c" });
    setTimeout(() => updateBadge(true), 1200);
  } else if (msg?.type === "start-listening") {
    startListening().then(() => sendResponse({ ok: true }));
    return true; // async response
  } else if (msg?.type === "stop-listening") {
    stopListening().then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg?.type === "offscreen-error") {
    chrome.storage.local.set({ listening: false, lastError: msg.message });
    updateBadge(false);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const { listening } = await chrome.storage.local.get("listening");
  updateBadge(!!listening);
  // Mic access does not survive a browser restart implicitly; require the
  // user to press Start again so the permission/gesture story stays honest.
  if (listening) await chrome.storage.local.set({ listening: false });
});
