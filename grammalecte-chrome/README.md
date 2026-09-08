# Grammalecte Chrome

Correction orthographique et grammaticale du français dans n'importe quel champ
de saisie du navigateur, avec [Grammalecte](https://grammalecte.net/).

Le projet est en deux parties :

| Partie | Rôle |
| --- | --- |
| `server.py` | serveur HTTP local (Flask, port 5001) qui fait tourner Grammalecte |
| `extension/` | extension Chrome (Manifest V3) qui envoie le texte au serveur et souligne les fautes |

```
   page web                extension Chrome                serveur local
┌──────────────┐      ┌────────────────────────┐      ┌────────────────────┐
│  <textarea>  │      │ content.js             │      │ POST /check        │
│      ou      │─────►│  débounce 800 ms       │─────►│  grammalecte_text  │
│contenteditable│      │ background.js (fetch) │◄─────│  → [erreurs]       │
│              │◄─────│  soulignement + bulle  │      └────────────────────┘
└──────────────┘      └────────────────────────┘         127.0.0.1:5001
```

Rien ne sort de votre machine : le texte n'est envoyé qu'au serveur local.

---

## 1. Le serveur

### Prérequis

* Python 3.8 ou plus récent
* un accès réseau **au premier lancement** : `pygrammalecte` télécharge alors le
  moteur Grammalecte depuis `grammalecte.net` et l'installe dans votre
  environnement Python. Les lancements suivants fonctionnent hors ligne.

### Installation

```bash
cd grammalecte-chrome
python -m venv .venv
source .venv/bin/activate        # Windows : .venv\Scripts\activate
pip install -r requirements.txt
```

### Lancement

```bash
python server.py
```

```
Serveur Grammalecte sur http://127.0.0.1:5001 (POST /check)
Préchargement de Grammalecte (le premier lancement installe le moteur)…
Grammalecte est prêt.
```

Laissez ce terminal ouvert tant que vous utilisez l'extension.

Options :

| Option | Défaut | Description |
| --- | --- | --- |
| `--port` | `5001` | port d'écoute |
| `--host` | `127.0.0.1` | interface d'écoute |
| `--debug` | — | mode debug de Flask (rechargement automatique) |
| `--no-warm-up` | — | ne précharge pas Grammalecte au démarrage |

Si vous changez le port, indiquez la nouvelle adresse dans la popup de
l'extension (champ « Serveur » en bas).

### L'API

#### `POST /check`

```bash
curl -X POST http://localhost:5001/check \
     -H 'Content-Type: application/json' \
     -d '{"text": "Coucou, je veut du chocolat !"}'
```

```json
{
  "count": 1,
  "text_length": 28,
  "errors": [
    {
      "type": "grammar",
      "start": 11,
      "end": 15,
      "length": 4,
      "line": 1,
      "line_start": 11,
      "line_end": 15,
      "word": "veut",
      "message": "Conjugaison erronée. Accord avec « je ».",
      "suggestions": ["veux"],
      "rule": "conj_je"
    }
  ]
}
```

| Champ | Description |
| --- | --- |
| `type` | `"spelling"` (mot inconnu) ou `"grammar"` |
| `start`, `end` | **position absolue** dans le texte envoyé, en caractères |
| `length` | longueur du passage fautif |
| `line`, `line_start`, `line_end` | position d'origine renvoyée par Grammalecte (n° de ligne 1-indexé et offsets dans cette ligne) |
| `word` | le mot ou le passage concerné |
| `message` | l'explication de Grammalecte |
| `suggestions` | corrections proposées (liste, éventuellement vide) |
| `rule`, `url` | identifiant de règle et lien d'aide, pour les erreurs grammaticales |

Grammalecte raisonne ligne par ligne : il renvoie un numéro de ligne et des
offsets **relatifs à cette ligne**. Le serveur les convertit en positions
absolues (`start` / `end`) — ce sont elles qu'utilise l'extension pour souligner
le bon mot.

Réponses d'erreur : `400` (JSON ou champ `text` manquant), `413` (texte de plus
de 20 000 caractères), `500` (échec de Grammalecte).

#### `GET /health`

```bash
curl http://localhost:5001/health
```

```json
{"status": "ok", "service": "grammalecte-chrome", "max_text_length": 20000,
 "checks": 12, "cache_hits": 5, "last_duration_ms": 240}
```

C'est cet appel que fait la popup pour afficher « Serveur local connecté ».

CORS est activé pour toutes les origines : sans cela, le navigateur refuserait
la réponse du serveur.

---

## 2. L'extension

### Installation

1. ouvrez `chrome://extensions` ;
2. activez le **Mode développeur** (interrupteur en haut à droite) ;
3. cliquez sur **Charger l'extension non empaquetée** ;
4. sélectionnez le dossier `grammalecte-chrome/extension`.

L'icône apparaît dans la barre d'outils. Épinglez-la pour voir le badge qui
affiche le nombre de fautes de la page courante.

### Utilisation

Écrivez dans un `<textarea>` ou une zone `contenteditable` de n'importe quelle
page. 800 ms après la dernière frappe, le texte est envoyé au serveur et les
fautes sont soulignées en rouge ondulé. Survolez un mot souligné pour voir le
message de Grammalecte et les suggestions.

Le champ n'est jamais modifié : les soulignements sont dessinés sur un calque
superposé qui n'intercepte ni les clics ni la sélection.

La popup (clic sur l'icône) affiche :

* le nombre de fautes détectées sur la page ;
* la liste des messages avec leurs suggestions ;
* l'état du serveur local ;
* un interrupteur pour désactiver la correction ;
* l'adresse du serveur, modifiable.

---

## Structure du projet

```
grammalecte-chrome/
├── server.py              serveur Flask + conversion des positions
├── requirements.txt
├── tools/
│   └── make_icons.py      régénère les icônes (python tools/make_icons.py)
└── extension/
    ├── manifest.json      Manifest V3
    ├── background.js      service worker : appels au serveur, cache, badge
    ├── content.js         détection des champs, débounce, calque de soulignement
    ├── content.css        soulignement rouge ondulé + infobulle
    ├── popup.html/.css/.js
    └── icons/             icônes 16 / 48 / 128 px (placeholders)
```

### Pourquoi un service worker au milieu ?

Les requêtes partent de `background.js` et non du script de contenu : le
service worker utilise l'origine de l'extension, ce qui évite à la fois la
politique CORS de la page visitée et les restrictions « Private Network
Access » de Chrome sur les adresses locales.

### Permissions demandées

| Permission | Pourquoi |
| --- | --- |
| `<all_urls>` (script de contenu) | corriger les champs de n'importe quelle page |
| `http://localhost/*`, `http://127.0.0.1/*` | joindre le serveur local, quel que soit le port choisi |
| `storage` | mémoriser l'activation et l'adresse du serveur |
| `activeTab` | permettre à la popup de parler à l'onglet courant |

---

## Dépannage

**« Serveur local injoignable » dans la popup**
Vérifiez que `python server.py` tourne, puis `curl http://localhost:5001/health`.
Si vous avez changé de port, corrigez l'adresse dans la popup.

**Rien ne se passe dans un champ**
Les extensions ne s'exécutent pas sur `chrome://`, le Chrome Web Store ni les
pages d'autres extensions. Rechargez la page après avoir installé l'extension :
les scripts de contenu ne sont pas injectés dans les onglets déjà ouverts.

**Le premier lancement du serveur est très long**
C'est le téléchargement puis l'installation du moteur Grammalecte (une seule
fois). La console affiche « Grammalecte est prêt. » quand c'est terminé.

**`localhost` ne répond pas mais `127.0.0.1` oui**
Sur certains systèmes `localhost` se résout en IPv6 (`::1`) alors que le serveur
n'écoute qu'en IPv4. L'extension retente automatiquement en `127.0.0.1` ; vous
pouvez aussi lancer `python server.py --host ::1`.

**Voir les erreurs de l'extension**
`chrome://extensions` → carte de l'extension → « Inspecter les vues :
service worker » pour `background.js`, console de la page pour `content.js`.

---

## Limites connues

* **Pas de suggestions pour les fautes d'orthographe.** `pygrammalecte` appelle
  Grammalecte sans la génération de suggestions orthographiques ; seules les
  erreurs *grammaticales* en proposent. Les mots inconnus sont signalés avec le
  message « Mot inconnu : … ».
* **Suggestions non applicables en un clic** : l'infobulle est informative, elle
  ne modifie pas le texte.
* Seuls les `<textarea>` et les zones `contenteditable` sont surveillés — pas
  les `<input type="text">`, qui n'acceptent qu'une ligne.
* Les éditeurs qui dessinent leur texte eux-mêmes (Google Docs et son canevas,
  éditeurs de code type CodeMirror/Monaco) ne sont pas pris en charge.
* Textes limités à 20 000 caractères par requête.
* Grammalecte recharge son dictionnaire à chaque analyse : comptez quelques
  centaines de millisecondes par requête. Un cache mémoire (serveur et
  extension) évite de réanalyser un texte déjà vu.
* Testé sur Chromium/Chrome. Firefox utilise un autre modèle d'extension et
  n'est pas visé ici — Grammalecte y dispose d'ailleurs d'un module officiel.
