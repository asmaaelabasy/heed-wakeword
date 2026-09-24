const phraseLine = document.getElementById("phrase-line");
const grantBtn = document.getElementById("grant-btn");
const toggleBtn = document.getElementById("toggle-btn");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const lastDetect = document.getElementById("last-detect");
const errorBox = document.getElementById("error");

async function checkMicPermission() {
  const status = await navigator.permissions.query({ name: "microphone" }).catch(() => null);
  return status?.state === "granted";
}

function grantMic() {
  // Requesting getUserMedia here would close this popup the instant Chrome
  // shows the permission prompt, so the grant happens on the options page
  // (a normal persistent tab) instead.
  chrome.runtime.openOptionsPage();
}

async function refresh() {
  const { listening, lastDetection, lastError } = await chrome.storage.local.get([
    "listening", "lastDetection", "lastError",
  ]);
  statusDot.classList.toggle("live", !!listening);
  statusText.textContent = listening ? "listening" : "stopped";
  toggleBtn.textContent = listening ? "Stop listening" : "Start listening";
  toggleBtn.classList.toggle("stop", !!listening);

  if (lastDetection) {
    const when = new Date(lastDetection.at).toLocaleTimeString();
    lastDetect.textContent = `Last heard: ${when} (prob ${lastDetection.prob.toFixed(2)})`;
  }
  if (lastError) {
    errorBox.textContent = lastError;
    errorBox.style.display = "block";
  }
}

async function init() {
  try {
    const meta = await fetch(chrome.runtime.getURL("models/wake.json")).then((r) => r.json());
    phraseLine.innerHTML = `Listening for: <span class="phrase">"${meta.phrase}"</span>`;
  } catch {
    phraseLine.textContent = "No model found in models/ — see README.";
  }

  const granted = await checkMicPermission();
  if (granted) {
    toggleBtn.disabled = false;
  } else {
    grantBtn.style.display = "block";
  }
  await refresh();
}

grantBtn.addEventListener("click", grantMic);

toggleBtn.addEventListener("click", async () => {
  toggleBtn.disabled = true;
  const { listening } = await chrome.storage.local.get("listening");
  await chrome.runtime.sendMessage({ type: listening ? "stop-listening" : "start-listening" });
  toggleBtn.disabled = false;
  await refresh();
});

document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener(refresh);
init();
