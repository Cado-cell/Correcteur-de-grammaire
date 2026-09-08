/* ==========================================================================
 * Grammalecte Chrome — service worker (Manifest V3)
 *
 * Deux rôles :
 *   1. relayer les analyses vers le serveur Python local. Les requêtes
 *      partent d'ici plutôt que du script de contenu : le service worker
 *      utilise l'origine de l'extension, ce qui évite la politique CORS de la
 *      page hôte et les restrictions « Private Network Access » de Chrome ;
 *   2. mémoriser le nombre de fautes par onglet pour le badge et la popup.
 * ========================================================================== */

const DEFAULT_SETTINGS = {
  enabled: true,
  serverUrl: "http://localhost:5001",
};

const REQUEST_TIMEOUT_MS = 20000;

/** Résultats déjà obtenus, indexés par texte (le champ est renvoyé en entier
 *  à chaque frappe : beaucoup de requêtes portent sur un texte déjà analysé). */
const responseCache = new Map();
const CACHE_SIZE = 60;

/** Requêtes en vol, pour ne pas interroger deux fois le serveur en parallèle
 *  avec le même texte (plusieurs onglets, plusieurs cadres…). */
const inFlight = new Map();

/** tabId -> Map(frameId -> { count, errors, updatedAt }) */
const tabState = new Map();

/* -------------------------------------------------------------------------
 * Réglages
 * ---------------------------------------------------------------------- */

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await chrome.storage.sync.set(settings);
});

/* -------------------------------------------------------------------------
 * Appels au serveur local
 * ---------------------------------------------------------------------- */

function normalizeServerUrl(url) {
  return String(url || DEFAULT_SETTINGS.serverUrl).trim().replace(/\/+$/, "");
}

async function postJson(url, body, signal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && payload.error ? payload.error : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload;
}

/**
 * Interroge le serveur. « localhost » se résout parfois en ::1 alors que le
 * serveur n'écoute que sur 127.0.0.1 : en cas d'échec réseau on retente une
 * fois sur l'adresse IPv4.
 */
async function requestCheck(serverUrl, text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    try {
      return await postJson(`${serverUrl}/check`, { text }, controller.signal);
    } catch (error) {
      const fallback = serverUrl.replace("//localhost", "//127.0.0.1");
      if (fallback === serverUrl || controller.signal.aborted) throw error;
      return await postJson(`${fallback}/check`, { text }, controller.signal);
    }
  } finally {
    clearTimeout(timer);
  }
}

function cacheGet(text) {
  if (!responseCache.has(text)) return undefined;
  const value = responseCache.get(text);
  responseCache.delete(text); // réinsertion : garde les entrées récentes
  responseCache.set(text, value);
  return value;
}

function cacheSet(text, value) {
  responseCache.set(text, value);
  while (responseCache.size > CACHE_SIZE) {
    responseCache.delete(responseCache.keys().next().value);
  }
}

async function checkText(text) {
  const cached = cacheGet(text);
  if (cached) return { ok: true, errors: cached, cached: true };

  if (inFlight.has(text)) return inFlight.get(text);

  const settings = await getSettings();
  if (!settings.enabled) return { ok: false, error: "Correction désactivée.", disabled: true };

  const serverUrl = normalizeServerUrl(settings.serverUrl);
  const promise = requestCheck(serverUrl, text)
    .then((payload) => {
      const errors = Array.isArray(payload && payload.errors) ? payload.errors : [];
      cacheSet(text, errors);
      return { ok: true, errors, cached: false };
    })
    .catch((error) => ({
      ok: false,
      error: error && error.name === "AbortError" ? "Délai dépassé." : String((error && error.message) || error),
      offline: true,
    }))
    .finally(() => inFlight.delete(text));

  inFlight.set(text, promise);
  return promise;
}

/* -------------------------------------------------------------------------
 * Badge et état par onglet
 * ---------------------------------------------------------------------- */

function tabTotal(tabId) {
  const frames = tabState.get(tabId);
  if (!frames) return 0;
  let total = 0;
  for (const frame of frames.values()) total += frame.count;
  return total;
}

async function refreshBadge(tabId) {
  const total = tabTotal(tabId);
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#d92d20" });
    await chrome.action.setBadgeText({ tabId, text: total > 0 ? String(Math.min(total, 999)) : "" });
  } catch {
    // L'onglet a pu être fermé entre-temps.
  }
}

function recordFrameState(tabId, frameId, count, errors) {
  if (typeof tabId !== "number" || tabId < 0) return;
  let frames = tabState.get(tabId);
  if (!frames) {
    frames = new Map();
    tabState.set(tabId, frames);
  }
  frames.set(frameId, { count, errors: errors || [], updatedAt: Date.now() });
  refreshBadge(tabId);
}

function collectTabStatus(tabId) {
  const frames = tabState.get(tabId);
  if (!frames) return { count: 0, errors: [] };
  const errors = [];
  let count = 0;
  for (const frame of frames.values()) {
    count += frame.count;
    errors.push(...frame.errors);
  }
  return { count, errors: errors.slice(0, 100) };
}

chrome.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabState.delete(tabId);
    refreshBadge(tabId);
  }
});

/* -------------------------------------------------------------------------
 * Messages
 * ---------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  switch (message.type) {
    case "GRAMMALECTE_CHECK": {
      checkText(String(message.text || "")).then(sendResponse);
      return true; // réponse asynchrone
    }

    case "GRAMMALECTE_REPORT": {
      recordFrameState(
        sender.tab && sender.tab.id,
        sender.frameId || 0,
        Number(message.count) || 0,
        message.errors
      );
      sendResponse({ ok: true });
      return false;
    }

    case "GRAMMALECTE_TAB_STATUS": {
      sendResponse(collectTabStatus(message.tabId));
      return false;
    }

    case "GRAMMALECTE_PING_SERVER": {
      getSettings()
        .then((settings) => {
          const serverUrl = normalizeServerUrl(settings.serverUrl);
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 4000);
          return fetch(`${serverUrl}/health`, { signal: controller.signal })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
            .then((health) => ({ ok: true, serverUrl, health }))
            .catch((error) => ({ ok: false, serverUrl, error: String((error && error.message) || error) }))
            .finally(() => clearTimeout(timer));
        })
        .then(sendResponse);
      return true;
    }

    case "GRAMMALECTE_CLEAR_CACHE": {
      responseCache.clear();
      sendResponse({ ok: true });
      return false;
    }

    default:
      return false;
  }
});

// Un changement de serveur invalide les résultats mémorisés.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.serverUrl) responseCache.clear();
});
