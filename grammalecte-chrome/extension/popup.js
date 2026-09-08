/* ==========================================================================
 * Grammalecte Chrome — popup
 *
 * Affiche le nombre de fautes relevées dans l'onglet courant, la liste des
 * messages, l'état du serveur local et un interrupteur d'activation.
 * ========================================================================== */

const countElement = document.getElementById("count");
const countLabel = document.getElementById("count-label");
const countCard = document.getElementById("count-card");
const errorsList = document.getElementById("errors");
const emptyMessage = document.getElementById("empty");
const serverStatus = document.getElementById("server");
const serverUrlInput = document.getElementById("server-url");
const enabledToggle = document.getElementById("enabled");

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      void chrome.runtime.lastError;
      resolve(response);
    });
  });
}

function renderCount(count) {
  countElement.textContent = String(count);
  countLabel.textContent = count > 1 ? "fautes détectées sur cette page" : "faute détectée sur cette page";
  countCard.classList.toggle("is-clean", count === 0);
}

function renderErrors(errors) {
  errorsList.replaceChildren();
  emptyMessage.hidden = errors.length > 0;

  for (const error of errors) {
    const item = document.createElement("li");

    const word = document.createElement("span");
    word.className = "error-word";
    word.textContent = error.word || "(passage fautif)";
    item.appendChild(word);

    const message = document.createElement("span");
    message.className = "error-message";
    message.textContent = error.message || "";
    item.appendChild(message);

    const suggestions = Array.isArray(error.suggestions) ? error.suggestions : [];
    if (suggestions.length) {
      const box = document.createElement("span");
      box.className = "error-suggestions";
      for (const suggestion of suggestions) {
        const chip = document.createElement("b");
        chip.textContent = suggestion;
        box.appendChild(chip);
      }
      item.appendChild(box);
    }

    errorsList.appendChild(item);
  }
}

async function refreshTabStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== "number") {
    renderCount(0);
    renderErrors([]);
    return;
  }
  const status = (await sendMessage({ type: "GRAMMALECTE_TAB_STATUS", tabId: tab.id })) || {
    count: 0,
    errors: [],
  };
  renderCount(status.count || 0);
  renderErrors(status.errors || []);
}

async function refreshServerStatus() {
  const result = await sendMessage({ type: "GRAMMALECTE_PING_SERVER" });
  if (!result) return;

  serverStatus.classList.toggle("is-online", Boolean(result.ok));
  serverStatus.classList.toggle("is-offline", !result.ok);
  serverStatus.textContent = result.ok
    ? "Serveur local connecté."
    : "Serveur local injoignable — lancez « python server.py ».";
}

async function refreshSettings() {
  const settings = await chrome.storage.sync.get({ enabled: true, serverUrl: "http://localhost:5001" });
  enabledToggle.checked = settings.enabled !== false;
  serverUrlInput.value = settings.serverUrl;
}

enabledToggle.addEventListener("change", async () => {
  await chrome.storage.sync.set({ enabled: enabledToggle.checked });
  if (enabledToggle.checked) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && typeof tab.id === "number") {
      chrome.tabs.sendMessage(tab.id, { type: "GRAMMALECTE_RECHECK" }, () => void chrome.runtime.lastError);
    }
  } else {
    renderCount(0);
    renderErrors([]);
  }
});

serverUrlInput.addEventListener("change", async () => {
  const url = serverUrlInput.value.trim() || "http://localhost:5001";
  serverUrlInput.value = url;
  await chrome.storage.sync.set({ serverUrl: url });
  serverStatus.textContent = "Vérification du serveur…";
  serverStatus.classList.remove("is-online", "is-offline");
  refreshServerStatus();
});

refreshSettings();
refreshTabStatus();
refreshServerStatus();
