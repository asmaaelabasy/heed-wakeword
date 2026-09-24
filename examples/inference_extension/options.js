const input = document.getElementById("target-url");
const saveBtn = document.getElementById("save-btn");
const saved = document.getElementById("saved");
const micStatus = document.getElementById("mic-status");
const grantBtn = document.getElementById("grant-btn");

chrome.storage.local.get("targetUrl").then(({ targetUrl }) => {
  if (targetUrl) input.value = targetUrl;
});

saveBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ targetUrl: input.value.trim() });
  saved.style.display = "inline";
  setTimeout(() => (saved.style.display = "none"), 1500);
});

async function refreshMicStatus() {
  const status = await navigator.permissions.query({ name: "microphone" }).catch(() => null);
  if (status?.state === "granted") {
    micStatus.textContent = "granted ✓";
    grantBtn.style.display = "none";
  } else {
    micStatus.textContent = status?.state === "denied" ? "denied — reset it in your browser's site settings" : "not granted yet";
    grantBtn.style.display = "block";
  }
}

grantBtn.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    micStatus.textContent = `denied: ${e.message}`;
    return;
  }
  await refreshMicStatus();
});

refreshMicStatus();
