#!/usr/bin/env python3
"""Serveur local de correction orthographique et grammaticale (Grammalecte).

Petite API HTTP consommée par l'extension Chrome qui se trouve dans
``extension/`` :

    POST /check   {"text": "..."}   -> {"count": n, "errors": [...]}
    GET  /health                    -> {"status": "ok", ...}

Grammalecte analyse le texte ligne par ligne : chaque message renvoyé par
``grammalecte_text()`` porte un numéro de ligne (1-indexé) et des offsets
(``start`` / ``end``) relatifs à cette ligne uniquement. L'extension, elle,
raisonne en offsets absolus dans le texte complet du champ de saisie ; la
conversion est faite ici par :func:`_line_offsets`.
"""

from __future__ import annotations

import argparse
import logging
import threading
import time
from collections import OrderedDict
from typing import Any, Dict, List

from flask import Flask, jsonify, request
from flask_cors import CORS
from pygrammalecte import GrammalecteSpellingMessage, grammalecte_text

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5001

#: Au-delà, on refuse l'analyse : Grammalecte devient lent et l'extension
#: n'a de toute façon pas vocation à corriger un roman entier.
MAX_TEXT_LENGTH = 20_000

#: Nombre de textes déjà analysés gardés en mémoire. Le champ de saisie est
#: renvoyé en entier à chaque frappe : sans ce cache, revenir en arrière puis
#: refaire une correction relancerait Grammalecte pour rien.
CACHE_SIZE = 64

LOGGER = logging.getLogger("grammalecte-chrome")

app = Flask(__name__)

# L'extension appelle le serveur depuis n'importe quelle page web : sans CORS,
# le navigateur bloquerait la réponse.
CORS(app, resources={r"/*": {"origins": "*"}})

# Grammalecte n'est pas prévu pour être appelé depuis plusieurs threads à la
# fois, et le serveur de développement Flask est multi-thread : on sérialise.
_check_lock = threading.Lock()

_cache: "OrderedDict[str, List[Dict[str, Any]]]" = OrderedDict()
_cache_lock = threading.Lock()

_stats = {"checks": 0, "cache_hits": 0, "last_duration_ms": None}


def _normalize(text: str) -> str:
    """Uniformise les fins de ligne pour que les offsets soient prévisibles."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _line_offsets(text: str) -> List[int]:
    """Offset absolu du premier caractère de chaque ligne de ``text``."""
    offsets = [0]
    position = 0
    for line in text.split("\n")[:-1]:
        position += len(line) + 1  # +1 pour le « \n »
        offsets.append(position)
    return offsets


def _message_to_dict(message: Any, text: str, line_offsets: List[int]) -> Dict[str, Any]:
    """Convertit un message Grammalecte en dictionnaire JSON-sérialisable."""
    line = message.line if message.line >= 1 else 1
    base = line_offsets[line - 1] if line - 1 < len(line_offsets) else 0

    start = min(max(base + message.start, 0), len(text))
    end = min(max(base + message.end, start), len(text))

    is_spelling = isinstance(message, GrammalecteSpellingMessage)
    # Les messages grammaticaux ne portent pas de mot : on l'extrait du texte.
    word = getattr(message, "word", None) or text[start:end]

    error: Dict[str, Any] = {
        "type": "spelling" if is_spelling else "grammar",
        # Position absolue dans le texte envoyé (c'est elle qu'utilise
        # l'extension pour souligner le mot).
        "start": start,
        "end": end,
        "length": end - start,
        # Position d'origine, telle que renvoyée par Grammalecte.
        "line": line,
        "line_start": message.start,
        "line_end": message.end,
        "word": word,
        "message": message.message,
        "suggestions": list(getattr(message, "suggestions", None) or []),
    }

    rule = getattr(message, "rule", None)
    if rule:
        error["rule"] = rule
    url = getattr(message, "url", None)
    if url:
        error["url"] = url
    return error


def check_text(text: str) -> List[Dict[str, Any]]:
    """Analyse ``text`` avec Grammalecte et renvoie la liste des erreurs."""
    normalized = _normalize(text)

    with _cache_lock:
        cached = _cache.get(normalized)
        if cached is not None:
            _cache.move_to_end(normalized)
            _stats["cache_hits"] += 1
            return cached

    started = time.perf_counter()
    line_offsets = _line_offsets(normalized)
    with _check_lock:
        messages = list(grammalecte_text(normalized))
    errors = [_message_to_dict(message, normalized, line_offsets) for message in messages]
    duration_ms = round((time.perf_counter() - started) * 1000)

    _stats["checks"] += 1
    _stats["last_duration_ms"] = duration_ms
    LOGGER.info("%d caractère(s), %d erreur(s), %d ms", len(normalized), len(errors), duration_ms)

    with _cache_lock:
        _cache[normalized] = errors
        _cache.move_to_end(normalized)
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)

    return errors


@app.after_request
def _add_private_network_header(response):
    """Autorise les requêtes « public -> localhost » (Private Network Access).

    Chrome exige cet en-tête sur la requête de pré-vol lorsqu'une page publique
    contacte une adresse locale. L'extension passe par son service worker et
    n'en a pas besoin, mais cela rend l'API utilisable telle quelle depuis une
    page web ou un autre outil.
    """
    if request.method == "OPTIONS":
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


@app.get("/health")
def health():
    """Vérification de disponibilité, utilisée par la popup de l'extension."""
    return jsonify(
        {
            "status": "ok",
            "service": "grammalecte-chrome",
            "max_text_length": MAX_TEXT_LENGTH,
            "checks": _stats["checks"],
            "cache_hits": _stats["cache_hits"],
            "last_duration_ms": _stats["last_duration_ms"],
        }
    )


@app.post("/check")
def check():
    """Analyse le texte reçu et renvoie la liste des fautes détectées."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": 'Corps JSON attendu, par exemple {"text": "..."}'}), 400

    text = payload.get("text")
    if not isinstance(text, str):
        return jsonify({"error": "Le champ « text » est obligatoire et doit être une chaîne."}), 400

    if len(text) > MAX_TEXT_LENGTH:
        return (
            jsonify(
                {
                    "error": f"Texte trop long ({len(text)} caractères, maximum {MAX_TEXT_LENGTH}).",
                    "max_text_length": MAX_TEXT_LENGTH,
                }
            ),
            413,
        )

    if not text.strip():
        return jsonify({"count": 0, "errors": [], "text_length": len(text)})

    try:
        errors = check_text(text)
    except Exception:  # pragma: no cover - dépend de l'installation locale
        LOGGER.exception("Échec de l'analyse Grammalecte")
        return jsonify({"error": "Grammalecte n'a pas pu analyser ce texte."}), 500

    return jsonify({"count": len(errors), "errors": errors, "text_length": len(text)})


def warm_up() -> None:
    """Force le chargement de Grammalecte au démarrage.

    Au tout premier appel, pygrammalecte télécharge puis installe le moteur
    Grammalecte : autant payer ce coût maintenant plutôt que sur la première
    frappe de l'utilisateur.
    """
    try:
        LOGGER.info("Préchargement de Grammalecte (le premier lancement installe le moteur)…")
        check_text("Ceci est une phrase de test.")
        LOGGER.info("Grammalecte est prêt.")
    except Exception:  # pragma: no cover - dépend de l'installation locale
        LOGGER.exception("Préchargement impossible ; le moteur sera chargé à la première requête")


def main() -> None:
    parser = argparse.ArgumentParser(description="Serveur local Grammalecte pour l'extension Chrome.")
    parser.add_argument("--host", default=DEFAULT_HOST, help="interface d'écoute (défaut : %(default)s)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="port d'écoute (défaut : %(default)s)")
    parser.add_argument("--debug", action="store_true", help="active le mode debug de Flask")
    parser.add_argument("--no-warm-up", action="store_true", help="ne précharge pas Grammalecte au démarrage")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-7s %(message)s")

    if not args.no_warm_up:
        threading.Thread(target=warm_up, name="warm-up", daemon=True).start()

    LOGGER.info("Serveur Grammalecte sur http://%s:%d (POST /check)", args.host, args.port)
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
