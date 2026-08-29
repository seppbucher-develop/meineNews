# meineNews

Eine eigenständige, statische Webapp, die News zu frei konfigurierbaren Themen
(Standard: **Gleitschirm**, **Goms**) aus mehreren Quellen (Standard: NZZ, Finanz
und Wirtschaft, 20 Minuten, Pomona) sammelt und pro Thema eine KI-Zusammenfassung
über alle Quellen hinweg erstellt — für die Standard-Zeiträume Heute, Gestern,
Diese Woche, Letzte Woche und Letzte 30 Tage, sowie einen frei wählbaren Zeitraum.

## Architektur

- **`scripts/fetch-news.mjs`** — läuft periodisch (siehe unten), lädt die RSS-Feeds
  aus `config/sources.json`, taggt Artikel nach `config/topics.json`, erstellt via
  Anthropic API eine deutsche Zusammenfassung pro Thema & Zeitraum und schreibt
  alles nach `data/news.json`.
- **`.github/workflows/fetch-news.yml`** — GitHub-Actions-Job, der das Skript
  periodisch (Standard: alle 4 Stunden) ausführt und `data/news.json` committet.
- **`index.html`** — die eigentliche Webapp (reines HTML/CSS/JS, keine Abhängigkeiten).
  Liest nur `data/news.json`, ruft selbst keine externen Dienste live auf.

Es gibt bewusst keinen eigenen Server: Der Browser kann NZZ/FuW/20min/Pomona wegen
CORS nicht direkt live abfragen, und eine echte KI-Zusammenfassung braucht einen
API-Key, der niemals im Browser stehen darf. Deshalb übernimmt GitHub Actions das
Laden + Zusammenfassen im Hintergrund; gehostet wird rein statisch über GitHub Pages.

**Einschränkung beim frei wählbaren Zeitraum:** Nur für die fünf Standard-Zeiträume
gibt es eine echte KI-Zusammenfassung (die wird bei jedem Workflow-Lauf neu
berechnet). Für einen frei gewählten Zeitraum zeigt die App stattdessen automatisch
gruppierte Original-Überschriften ohne KI — eine On-Demand-Zusammenfassung würde
einen Live-Server mit Zugriff auf den API-Key erfordern.

## Einrichtung

### 1. GitHub Pages aktivieren

**Settings → Pages → Source: "Deploy from a branch" → Branch `main` / `(root)`.**
Danach ist die App unter `https://seppbucher-develop.github.io/meinenews/` erreichbar.

### 2. Anthropic-API-Key hinterlegen (für die KI-Zusammenfassung)

Ein **Claude Pro-Abo (claude.ai)** enthält **keinen** API-Zugang — das ist ein
separates Produkt mit eigener Abrechnung (Pay-as-you-go, nicht im Pro-Abo enthalten).
So kommst du an einen API-Key:

1. Auf [console.anthropic.com](https://console.anthropic.com) einloggen/registrieren
   (kann dieselbe E-Mail-Adresse wie bei Claude Pro sein, ist aber ein separates Konto).
2. Zahlungsmittel/Guthaben hinterlegen (Rechnung nach Verbrauch; bei den hier
   verwendeten kurzen Zusammenfassungen und moderater Lauf-Frequenz sehr günstig).
3. Unter **Settings → API Keys** einen neuen Key erstellen.
4. Im GitHub-Repo: **Settings → Secrets and variables → Actions → New repository
   secret**, Name `ANTHROPIC_API_KEY`, Wert = der Key.

Ohne hinterlegten Key sammelt die App trotzdem alle Artikel und zeigt sie an — nur
die KI-Zusammenfassung bleibt leer ("kein API-Key hinterlegt").

### 3. Ersten Lauf auslösen

**Actions-Tab → "Fetch News" → "Run workflow"**, oder einfach auf den nächsten
automatischen Lauf warten (Standard: alle 4 Stunden).

## Konfiguration ändern

- **Quellen** (`config/sources.json`): Liste aus `id`, `name`, `rss` (RSS/Atom-Feed-URL).
  Einfach Einträge hinzufügen/entfernen/ändern.
- **Themen** (`config/topics.json`): Liste aus `id`, `name`, `keywords`. Ein Artikel
  wird einem Thema zugeordnet, sobald Titel oder Kurztext eines der Stichworte
  enthält (Gross-/Kleinschreibung egal).

Nach einer Änderung reicht ein Commit — beim nächsten Workflow-Lauf werden die
neuen Quellen/Themen automatisch verwendet.

⚠️ **Status der Standard-Feed-URLs (Stand: erster echter Workflow-Lauf):**

| Quelle | Status | Bemerkung |
|---|---|---|
| NZZ | ✅ funktioniert | `https://www.nzz.ch/recent.rss` liefert Artikel |
| 20 Minuten | ✅ funktioniert | `https://partner-feeds.20min.ch/rss/20minuten` liefert Artikel |
| Finanz und Wirtschaft | ❌ falsch | `https://www.fuw.ch/feed/` führt in eine Redirect-Schlaufe — die echte Feed-URL muss noch gefunden werden (z.B. direkt auf fuw.ch nach einem RSS-Symbol suchen) |
| Pomona (Wallis) | ❌ falsch | `https://pomona.ch/rss` liefert kein gültiges XML — evtl. bietet Pomona gar kein öffentliches RSS an (App-fokussiertes Angebot); Alternative wäre ggf. ein RSS-Feed von Walliser Bote oder RRO direkt |

Eine nicht erreichbare Quelle blockiert die anderen nicht (siehe `sources`-Abschnitt
in `data/news.json` bzw. Actions-Log für den aktuellen Status). Sobald du eine
korrekte Feed-URL für FuW/Pomona gefunden hast, einfach in `config/sources.json`
eintragen und committen — beim nächsten Lauf wird sie automatisch verwendet.

## Lokal testen

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm run fetch-news   # optional ohne Key (dann ohne KI-Text)
npx http-server .                                  # oder: python3 -m http.server
```

## Datenmodell (`data/news.json`)

```jsonc
{
  "generatedAt": "2026-08-28T14:00:00.000Z",
  "archiveDays": 90,               // wie lange Artikel im Archiv bleiben
  "sources": [ { "id", "name", "rss", "status": { "ok", "error", "itemCount" } } ],
  "topics": [ { "id", "name", "keywords" } ],
  "periods": [ { "id", "label", "from", "to" } ],  // Standard-Zeiträume dieses Laufs
  "articles": [ { "title", "link", "publishedAt", "snippet", "sourceId", "sourceName", "topics" } ],
  "summaries": {
    "<topicId>": {
      "<periodId>": { "text", "model", "generatedAt", "articleCount" } // oder { "text": null, "reason" }
    }
  }
}
```
