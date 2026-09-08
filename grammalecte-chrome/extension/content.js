/* ==========================================================================
 * Grammalecte Chrome — script de contenu
 *
 * Surveille les <textarea> et les zones « contenteditable » de la page,
 * envoie leur contenu au serveur local (via le service worker) après 800 ms
 * d'inactivité, puis souligne les fautes en rouge ondulé.
 *
 * Principe d'affichage : on ne modifie jamais le champ de l'utilisateur.
 * Un calque est superposé au champ, sans interaction possible avec la souris
 * (« pointer-events: none »), et il porte les soulignements :
 *
 *   - <textarea>       : on recopie le texte dans un calque au style
 *                        identique mais en couleur transparente ; seuls les
 *                        soulignements des mots fautifs sont visibles ;
 *   - contenteditable  : impossible de recopier une mise en page riche, on
 *                        mesure donc les rectangles occupés par chaque mot
 *                        fautif (Range.getClientRects) et on dessine une
 *                        ondulation SVG dessous.
 * ========================================================================== */

(() => {
  "use strict";

  if (window.__grammalecteChromeInjected) return;
  window.__grammalecteChromeInjected = true;

  /** Délai d'inactivité avant d'interroger le serveur. */
  const DEBOUNCE_MS = 800;
  const MIN_TEXT_LENGTH = 3;
  const MAX_TEXT_LENGTH = 20000;
  const MAX_REPORTED_ERRORS = 50;

  const EDITABLE_SELECTOR =
    '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';

  /** Balises qui introduisent un saut de ligne dans le texte extrait. */
  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT",
    "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3",
    "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
    "SECTION", "TABLE", "TD", "TH", "TR", "UL",
  ]);

  /** Propriétés recopiées du <textarea> vers son calque miroir. */
  const MIRRORED_STYLES = [
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant",
    "fontStretch", "fontKerning", "lineHeight", "letterSpacing", "wordSpacing",
    "textAlign", "textIndent", "textTransform", "whiteSpace", "overflowWrap",
    "wordBreak", "tabSize", "direction", "unicodeBidi", "textRendering",
  ];

  const WAVE_HEIGHT = 4;

  let enabled = true;
  let rootElement = null;
  let tooltipElement = null;
  let hoveredArea = null;
  let animationFrame = null;
  let sweepTimer = null;
  let lastReported = -1;

  /** @type {Map<Element, FieldChecker>} */
  const checkers = new Map();

  /* ----------------------------------------------------------------------
   * Communication avec le service worker
   * ------------------------------------------------------------------- */

  function extensionAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (error) {
      return false;
    }
  }

  function sendMessage(message, callback) {
    if (!extensionAlive()) return;
    try {
      chrome.runtime.sendMessage(message, (response) => {
        // Lu pour éviter l'avertissement « Unchecked runtime.lastError ».
        void chrome.runtime.lastError;
        if (callback) callback(response);
      });
    } catch (error) {
      /* Extension rechargée ou désactivée : on abandonne silencieusement. */
    }
  }

  /* ----------------------------------------------------------------------
   * Calque d'affichage
   * ------------------------------------------------------------------- */

  function ensureRoot() {
    if (!rootElement) {
      rootElement = document.createElement("div");
      rootElement.className = "glc-root";
      // Les propriétés vitales sont aussi posées en ligne : si la feuille de
      // style de l'extension n'était pas encore appliquée, le calque resterait
      // correctement positionné et invisible au survol.
      rootElement.style.position = "absolute";
      rootElement.style.top = "0";
      rootElement.style.left = "0";
      rootElement.style.width = "0";
      rootElement.style.height = "0";
      rootElement.style.pointerEvents = "none";
      rootElement.style.zIndex = "2147483647";
    }
    if (!rootElement.isConnected) {
      (document.body || document.documentElement).appendChild(rootElement);
    }
    return rootElement;
  }

  function createWave(width) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "glc-underline");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(WAVE_HEIGHT));
    svg.setAttribute("viewBox", `0 0 ${width} ${WAVE_HEIGHT}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const middle = WAVE_HEIGHT / 2;
    const amplitude = 1.1;
    const halfPeriod = 3;
    let data = `M 0 ${middle}`;
    let x = 0;
    let up = true;
    while (x < width) {
      const next = Math.min(x + halfPeriod, width);
      const control = up ? middle - amplitude * 2 : middle + amplitude * 2;
      data += ` Q ${(x + next) / 2} ${control} ${next} ${middle}`;
      x = next;
      up = !up;
    }
    path.setAttribute("d", data);
    svg.appendChild(path);
    return svg;
  }

  /* ----------------------------------------------------------------------
   * Infobulle
   * ------------------------------------------------------------------- */

  function ensureTooltip() {
    if (!tooltipElement) {
      tooltipElement = document.createElement("div");
      tooltipElement.className = "glc-tooltip";
      tooltipElement.hidden = true;
      tooltipElement.style.position = "fixed";
      tooltipElement.style.pointerEvents = "none";
    }
    if (tooltipElement.parentNode !== ensureRoot()) {
      rootElement.appendChild(tooltipElement);
    }
    return tooltipElement;
  }

  function showTooltip(error, x, y) {
    const tooltip = ensureTooltip();
    tooltip.replaceChildren();

    if (error.word) {
      const word = document.createElement("span");
      word.className = "glc-tooltip-word";
      word.textContent = error.word;
      tooltip.appendChild(word);
    }

    const message = document.createElement("span");
    message.className = "glc-tooltip-message";
    message.textContent = error.message || "Erreur détectée.";
    tooltip.appendChild(message);

    const suggestions = Array.isArray(error.suggestions) ? error.suggestions.slice(0, 5) : [];
    if (suggestions.length) {
      const box = document.createElement("span");
      box.className = "glc-tooltip-suggestions";
      box.appendChild(document.createTextNode("Suggestions : "));
      for (const suggestion of suggestions) {
        const chip = document.createElement("span");
        chip.className = "glc-tooltip-suggestion";
        chip.textContent = suggestion;
        box.appendChild(chip);
      }
      tooltip.appendChild(box);
    }

    tooltip.hidden = false;
    tooltip.style.left = "0px";
    tooltip.style.top = "0px";

    const size = tooltip.getBoundingClientRect();
    const left = Math.max(4, Math.min(x + 12, window.innerWidth - size.width - 8));
    let top = y + 20;
    if (top + size.height > window.innerHeight - 8) top = Math.max(4, y - size.height - 12);
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  function hideTooltip() {
    if (tooltipElement) tooltipElement.hidden = true;
    if (hoveredArea && hoveredArea.node) hoveredArea.node.classList.remove("glc-mark-active");
    hoveredArea = null;
  }

  /* ----------------------------------------------------------------------
   * Extraction du texte d'une zone « contenteditable »
   * ------------------------------------------------------------------- */

  /**
   * Reconstruit le texte brut d'une zone éditable et mémorise, pour chaque
   * nœud texte, sa position dans ce texte : c'est ce qui permet de retrouver
   * ensuite le fragment correspondant à une erreur.
   */
  function readEditableText(root) {
    let text = "";
    const segments = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") {
            return NodeFilter.FILTER_REJECT;
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const data = node.data;
        if (data) {
          segments.push({ node, start: text.length, length: data.length });
          text += data;
        }
      } else if (node.tagName === "BR") {
        text += "\n";
      } else if (BLOCK_TAGS.has(node.tagName) && text.length > 0 && !text.endsWith("\n")) {
        text += "\n";
      }
      node = walker.nextNode();
    }
    return { text, segments };
  }

  function locate(segments, offset, isEnd) {
    for (const segment of segments) {
      const end = segment.start + segment.length;
      const inside = isEnd
        ? offset > segment.start && offset <= end
        : offset >= segment.start && offset < end;
      if (inside) return { node: segment.node, offset: offset - segment.start };
    }
    return null;
  }

  function rangeForError(segments, start, end) {
    const from = locate(segments, start, false);
    const to = locate(segments, end, true);
    if (!from || !to) return null;
    try {
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      return range.collapsed ? null : range;
    } catch (error) {
      return null;
    }
  }

  function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  /* ----------------------------------------------------------------------
   * Surveillance d'un champ
   * ------------------------------------------------------------------- */

  class FieldChecker {
    constructor(element) {
      this.el = element;
      this.isTextarea = element.tagName === "TEXTAREA";
      this.timer = null;
      this.requestId = 0;
      this.errors = [];
      this.checkedText = null;
      this.layer = null;
      this.mirror = null;
      this.segments = null;
      this.hitAreas = [];
      this.geometryKey = "";

      this.resizeObserver = typeof ResizeObserver === "function"
        ? new ResizeObserver(() => this.reposition())
        : null;
      if (this.resizeObserver) this.resizeObserver.observe(element);
    }

    readText() {
      if (this.isTextarea) return this.el.value || "";
      const extracted = readEditableText(this.el);
      this.segments = extracted.segments;
      return extracted.text;
    }

    schedule() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(), DEBOUNCE_MS);
    }

    run() {
      if (!enabled || !this.el.isConnected) return;

      const text = this.readText();
      if (text === this.checkedText) return;

      if (text.trim().length < MIN_TEXT_LENGTH || text.length > MAX_TEXT_LENGTH) {
        this.checkedText = text;
        this.setErrors([]);
        return;
      }

      const requestId = ++this.requestId;
      sendMessage({ type: "GRAMMALECTE_CHECK", text }, (response) => {
        // Réponse d'une requête dépassée, ou texte modifié entre-temps :
        // les positions ne correspondraient plus.
        if (requestId !== this.requestId || !this.el.isConnected) return;
        if (this.readText() !== text) return;

        if (!response || !response.ok) {
          this.checkedText = null;
          this.setErrors([]);
          return;
        }
        this.checkedText = text;
        this.setErrors(response.errors || []);
      });
    }

    setErrors(errors) {
      this.errors = errors
        .filter((error) => Number.isFinite(error.start) && error.end > error.start)
        .sort((a, b) => a.start - b.start);
      this.render();
      reportState();
    }

    ensureLayer() {
      if (!this.layer) {
        this.layer = document.createElement("div");
        this.layer.className = "glc-layer";
        this.layer.style.position = "fixed";
        this.layer.style.overflow = "hidden";
        this.layer.style.pointerEvents = "none";
      }
      const root = ensureRoot();
      if (this.layer.parentNode !== root) {
        const before = tooltipElement && tooltipElement.parentNode === root ? tooltipElement : null;
        root.insertBefore(this.layer, before);
      }
      return this.layer;
    }

    /** Place le calque exactement sur le champ ; renvoie faux s'il est masqué. */
    placeLayer() {
      const rect = this.el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        if (this.layer) this.layer.style.display = "none";
        return null;
      }
      const layer = this.ensureLayer();
      layer.style.display = "block";
      layer.style.left = `${rect.left}px`;
      layer.style.top = `${rect.top}px`;
      layer.style.width = `${rect.width}px`;
      layer.style.height = `${rect.height}px`;
      return rect;
    }

    render() {
      this.hitAreas = [];
      if (!this.errors.length) {
        this.clearLayer();
        return;
      }
      const rect = this.placeLayer();
      if (!rect) return;

      if (this.isTextarea) this.renderTextarea(rect);
      else this.renderEditable(rect);

      this.geometryKey = this.computeGeometryKey(rect);
      startTracking();
    }

    renderTextarea(rect) {
      const element = this.el;
      const style = getComputedStyle(element);

      if (!this.mirror) {
        this.mirror = document.createElement("div");
        this.mirror.className = "glc-mirror";
      }
      const mirror = this.mirror;
      for (const property of MIRRORED_STYLES) mirror.style[property] = style[property];
      mirror.style.boxSizing = "border-box";
      mirror.style.borderStyle = "solid";
      mirror.style.borderColor = "transparent";
      if (!style.whiteSpace || style.whiteSpace === "normal") mirror.style.whiteSpace = "pre-wrap";

      // clientWidth/clientHeight excluent la barre de défilement éventuelle :
      // sans cela le miroir ne couperait pas les lignes au même endroit.
      const borderX = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
      const borderY = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      mirror.style.width = `${element.clientWidth + borderX}px`;
      mirror.style.height = `${element.clientHeight + borderY}px`;

      const text = element.value || "";
      const fragment = document.createDocumentFragment();
      const marks = [];
      let cursor = 0;

      for (const error of this.errors) {
        const start = Math.max(cursor, Math.min(error.start, text.length));
        const end = Math.max(start, Math.min(error.end, text.length));
        if (end <= start) continue;
        if (start > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, start)));
        const mark = document.createElement("span");
        mark.className = "glc-mark";
        mark.textContent = text.slice(start, end);
        fragment.appendChild(mark);
        marks.push({ error, node: mark });
        cursor = end;
      }
      // Le « ​ » final préserve la hauteur si le texte finit par un saut
      // de ligne (un <div> ignore la dernière ligne vide, pas un <textarea>).
      fragment.appendChild(document.createTextNode(text.slice(cursor) + "\u200B"));

      mirror.replaceChildren(fragment);
      this.layer.replaceChildren(mirror);
      mirror.scrollTop = element.scrollTop;
      mirror.scrollLeft = element.scrollLeft;

      const layerRect = this.layer.getBoundingClientRect();
      for (const { error, node } of marks) {
        const rects = Array.from(node.getClientRects())
          .filter((r) => r.width > 0 && r.height > 0 && intersects(r, layerRect));
        if (rects.length) this.hitAreas.push({ error, node, rects });
      }
    }

    renderEditable(rect) {
      if (!this.segments || !this.segments.length || !this.segments[0].node.isConnected) {
        this.readText();
      }
      const segments = this.segments || [];
      const layer = this.layer;
      const layerRect = layer.getBoundingClientRect();
      const fragment = document.createDocumentFragment();
      this.mirror = null;

      for (const error of this.errors) {
        const range = rangeForError(segments, error.start, error.end);
        if (!range) continue;
        const kept = [];
        for (const clientRect of range.getClientRects()) {
          if (clientRect.width <= 0.5 || clientRect.height <= 0) continue;
          if (!intersects(clientRect, layerRect)) continue;
          const wave = createWave(Math.round(clientRect.width));
          wave.style.position = "absolute";
          wave.style.left = `${clientRect.left - layerRect.left}px`;
          wave.style.top = `${clientRect.bottom - layerRect.top - 1}px`;
          fragment.appendChild(wave);
          kept.push(clientRect);
        }
        if (kept.length) this.hitAreas.push({ error, node: null, rects: kept });
      }
      layer.replaceChildren(fragment);
    }

    computeGeometryKey(rect) {
      return [
        Math.round(rect.left), Math.round(rect.top),
        Math.round(rect.width), Math.round(rect.height),
        Math.round(this.el.scrollTop), Math.round(this.el.scrollLeft),
      ].join("|");
    }

    /** Suit le champ quand la page défile ou change de taille. */
    reposition() {
      if (!this.errors.length || !this.el.isConnected) return;
      const rect = this.el.getBoundingClientRect();
      const key = this.computeGeometryKey(rect);
      if (key === this.geometryKey) return;
      this.render();
    }

    clearLayer() {
      this.hitAreas = [];
      if (this.layer) {
        this.layer.replaceChildren();
        this.layer.remove();
      }
    }

    hitTest(x, y) {
      for (const area of this.hitAreas) {
        for (const rect of area.rects) {
          if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 3) {
            return area;
          }
        }
      }
      return null;
    }

    destroy() {
      clearTimeout(this.timer);
      this.requestId++;
      if (this.resizeObserver) this.resizeObserver.disconnect();
      this.clearLayer();
      this.errors = [];
      this.layer = null;
      this.mirror = null;
    }
  }

  /* ----------------------------------------------------------------------
   * Repérage des champs de saisie
   * ------------------------------------------------------------------- */

  function editableHost(target) {
    let element = target;
    if (element && element.nodeType === Node.TEXT_NODE) element = element.parentElement;
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    if (element.closest(".glc-root")) return null;

    const textarea = element.closest("textarea");
    if (textarea) {
      return textarea.disabled || textarea.readOnly ? null : textarea;
    }

    const editable = element.closest(EDITABLE_SELECTOR);
    if (editable && editable.isContentEditable) return editable;
    return null;
  }

  function checkerFor(element) {
    let checker = checkers.get(element);
    if (!checker) {
      checker = new FieldChecker(element);
      checkers.set(element, checker);
    }
    return checker;
  }

  function clearAll() {
    for (const checker of checkers.values()) checker.destroy();
    checkers.clear();
    hideTooltip();
    reportState();
  }

  function reportState() {
    let count = 0;
    const errors = [];
    for (const checker of checkers.values()) {
      count += checker.errors.length;
      for (const error of checker.errors) {
        if (errors.length >= MAX_REPORTED_ERRORS) break;
        errors.push({
          type: error.type,
          word: error.word,
          message: error.message,
          suggestions: (error.suggestions || []).slice(0, 3),
        });
      }
    }
    if (count === lastReported && count === 0) return;
    lastReported = count;
    sendMessage({ type: "GRAMMALECTE_REPORT", count, errors });
  }

  /* ----------------------------------------------------------------------
   * Suivi du champ (défilement, redimensionnement, disparition)
   *
   * Les repositionnements sont regroupés dans une seule frame d'animation, et
   * un balayage de sécurité toutes les secondes rattrape les changements de
   * mise en page qui n'émettent aucun évènement. Tout s'arrête dès qu'aucun
   * champ ne porte de faute : pas de minuterie qui tourne pour rien.
   * ------------------------------------------------------------------- */

  function repositionAll() {
    animationFrame = null;
    for (const [element, checker] of checkers) {
      if (!element.isConnected) {
        checker.destroy();
        checkers.delete(element);
        continue;
      }
      checker.reposition();
    }
  }

  function scheduleReposition() {
    if (animationFrame !== null) return;
    animationFrame = requestAnimationFrame(repositionAll);
  }

  function startTracking() {
    if (sweepTimer !== null) return;
    sweepTimer = setInterval(() => {
      let active = false;
      for (const [element, checker] of checkers) {
        if (!element.isConnected) {
          checker.destroy();
          checkers.delete(element);
          continue;
        }
        if (checker.errors.length) active = true;
      }
      if (!active) {
        clearInterval(sweepTimer);
        sweepTimer = null;
        return;
      }
      scheduleReposition();
    }, 1000);
  }

  /* ----------------------------------------------------------------------
   * Écoute des évènements
   * ------------------------------------------------------------------- */

  function onInput(event) {
    if (!enabled) return;
    const element = editableHost(event.target);
    if (!element) return;
    hideTooltip();
    checkerFor(element).schedule();
  }

  function onFocusIn(event) {
    if (!enabled) return;
    const element = editableHost(event.target);
    if (!element) return;
    checkerFor(element).schedule();
  }

  function onPointerMove(event) {
    if (!enabled) return;
    const x = event.clientX;
    const y = event.clientY;

    let area = null;
    for (const checker of checkers.values()) {
      area = checker.hitTest(x, y);
      if (area) break;
    }

    if (!area) {
      if (hoveredArea) hideTooltip();
      return;
    }
    if (area !== hoveredArea) {
      if (hoveredArea && hoveredArea.node) hoveredArea.node.classList.remove("glc-mark-active");
      hoveredArea = area;
      if (area.node) area.node.classList.add("glc-mark-active");
    }
    showTooltip(area.error, x, y);
  }

  document.addEventListener("input", onInput, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("mousemove", onPointerMove, { capture: true, passive: true });
  document.addEventListener(
    "scroll",
    () => {
      hideTooltip();
      scheduleReposition();
    },
    { capture: true, passive: true }
  );
  window.addEventListener("resize", scheduleReposition, { passive: true });
  window.addEventListener("pagehide", () => clearAll());

  /* ----------------------------------------------------------------------
   * Réglages
   * ------------------------------------------------------------------- */

  function scheduleActiveElement() {
    const element = editableHost(document.activeElement);
    if (element) checkerFor(element).schedule();
  }

  function applyEnabled(value) {
    const next = value !== false;
    if (next === enabled) return;
    enabled = next;
    if (enabled) scheduleActiveElement();
    else clearAll();
  }

  if (extensionAlive()) {
    chrome.storage.sync.get({ enabled: true }, (settings) => {
      void chrome.runtime.lastError;
      if (settings) applyEnabled(settings.enabled);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.enabled) applyEnabled(changes.enabled.newValue);
      if (area === "sync" && changes.serverUrl) {
        for (const checker of checkers.values()) {
          checker.checkedText = null;
          checker.schedule();
        }
      }
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.type === "GRAMMALECTE_RECHECK") {
        for (const checker of checkers.values()) {
          checker.checkedText = null;
          checker.schedule();
        }
        scheduleActiveElement();
        sendResponse({ ok: true });
      }
      return false;
    });
  }
})();
