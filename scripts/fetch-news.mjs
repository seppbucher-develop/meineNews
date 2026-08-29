#!/usr/bin/env node
// Holt RSS-Feeds der konfigurierten Quellen (config/sources.json), taggt Artikel
// nach Themen (config/topics.json) und erstellt pro Thema & Standard-Zeitraum eine
// KI-Zusammenfassung über alle Quellen hinweg (Anthropic API, sofern
// ANTHROPIC_API_KEY gesetzt ist). Das Ergebnis wird nach data/news.json
// geschrieben und von der statischen Webapp (index.html) gelesen.
//
// Läuft periodisch via .github/workflows/fetch-news.yml. Lokal ausführbar mit:
//   ANTHROPIC_API_KEY=sk-ant-... npm run fetch-news

import Anthropic from "@anthropic-ai/sdk";
import Parser from "rss-parser";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CONFIG_DIR = path.join(ROOT, "config");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "news.json");

const ARCHIVE_DAYS = 90; // wie lange Artikel im Archiv (data/news.json) bleiben
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";
const TIMEZONE = "Europe/Zurich";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const client = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;

// ---------- Hilfsfunktionen: Datum in Zeitzone Europe/Zurich ----------

function zurichYMD(date) {
  // liefert "YYYY-MM-DD" in der Zeitzone Europe/Zurich
  return date.toLocaleDateString("sv-SE", { timeZone: TIMEZONE });
}

function ymdToUTCDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDaysYMD(ymd, days) {
  const dt = ymdToUTCDate(ymd);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function weekdayIndexMon0(ymd) {
  // Montag=0 ... Sonntag=6
  const jsDay = ymdToUTCDate(ymd).getUTCDay(); // Sonntag=0 .. Samstag=6
  return (jsDay + 6) % 7;
}

// ---------- Quellen laden ----------

const parser = new Parser({ timeout: 15000 });

async function fetchSource(source) {
  try {
    const feed = await parser.parseURL(source.rss);
    const items = (feed.items || [])
      .map((it) => {
        // Datum robust parsen: ein einzelnes Item mit unbrauchbarem Datum darf nicht
        // die ganze Quelle zum Absturz bringen (new Date(...).toISOString() wirft bei
        // ungültigem Datum eine Exception).
        let publishedAt = null;
        const candidate = it.isoDate || it.pubDate;
        if (candidate) {
          const parsed = new Date(candidate);
          if (!Number.isNaN(parsed.getTime())) publishedAt = parsed.toISOString();
        }
        if (!it.link || !publishedAt) return null;
        return {
          title: (it.title || "(ohne Titel)").trim(),
          link: it.link,
          publishedAt,
          snippet: (it.contentSnippet || it.summary || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 400),
          sourceId: source.id,
          sourceName: source.name,
        };
      })
      .filter(Boolean);
    console.log(`[ok] ${source.name}: ${items.length} Artikel geladen`);
    return { ok: true, items };
  } catch (err) {
    console.warn(`[warn] Quelle "${source.name}" (${source.rss}) fehlgeschlagen: ${err.message}`);
    return { ok: false, error: err.message, items: [] };
  }
}

// ---------- Themen-Zuordnung ----------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Wortgrenzen-Match statt reinem Teilstring-Vergleich: verhindert Fehltreffer wie
// das Stichwort "ernen" (Ort Ernen), das sonst auch in "lernen"/"Fernen" matchen würde.
function keywordMatches(haystack, keyword) {
  const pattern = new RegExp(`(?:^|[^a-zäöüß0-9])${escapeRegExp(keyword.toLowerCase())}(?:$|[^a-zäöüß0-9])`, "i");
  return pattern.test(haystack);
}

function tagTopics(article, topics) {
  const haystack = ` ${article.title} ${article.snippet} `.toLowerCase();
  return topics
    .filter((t) => t.keywords.some((k) => keywordMatches(haystack, k)))
    .map((t) => t.id);
}

// ---------- KI-Zusammenfassung pro Thema & Zeitraum ----------

async function summarizeTopicPeriod(topic, periodLabel, articles) {
  if (!client) return { text: null, reason: "kein ANTHROPIC_API_KEY hinterlegt" };
  if (articles.length === 0) return { text: null, reason: "keine Artikel im Zeitraum" };

  const articleList = articles
    .map(
      (a) =>
        `- [${a.sourceName}] ${a.title}${a.snippet ? " — " + a.snippet : ""} (${a.publishedAt.slice(0, 10)})`,
    )
    .join("\n");

  const system = [
    "Du bist Redaktor:in eines privaten News-Dashboards.",
    "Du bekommst Überschriften und kurze Auszüge (aus RSS-Feeds, nicht die vollständigen Artikel)",
    "mehrerer Schweizer Medien zu einem Thema.",
    "Fasse daraus eine kurze, sachliche Zusammenfassung auf Deutsch zusammen (3-6 Sätze oder Stichpunkte).",
    "Wenn Quellen sich widersprechen oder unterschiedlich gewichten, weise kurz darauf hin.",
    "Erfinde keine Details, die nicht in den Auszügen stehen.",
    "Antworte NUR mit der Zusammenfassung, ohne Einleitungssatz.",
  ].join(" ");

  const userText = `Thema: ${topic.name}\nZeitraum: ${periodLabel}\nQuellen-Auszüge:\n${articleList}`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content: userText }],
    });

    if (response.stop_reason === "refusal") {
      return {
        text: null,
        reason: `Anfrage abgelehnt (${response.stop_details?.category ?? "unbekannt"})`,
      };
    }

    const textBlock = response.content.find((b) => b.type === "text");
    return {
      text: textBlock?.text?.trim() || null,
      model: MODEL,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.warn("[warn] Ungültiger ANTHROPIC_API_KEY — Zusammenfassungen werden übersprungen.");
      return { text: null, reason: "ungültiger API-Key" };
    }
    if (err instanceof Anthropic.RateLimitError) {
      return { text: null, reason: "Rate-Limit erreicht, später erneut versuchen" };
    }
    console.warn(`[warn] Zusammenfassung für ${topic.id}/${periodLabel} fehlgeschlagen: ${err.message}`);
    return { text: null, reason: `Fehler: ${err.message}` };
  }
}

// ---------- Hauptablauf ----------

async function loadJson(p, fallback) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const sources = await loadJson(path.join(CONFIG_DIR, "sources.json"), []);
  const topics = await loadJson(path.join(CONFIG_DIR, "topics.json"), []);
  const previous = await loadJson(DATA_FILE, null);

  if (!client) {
    console.warn(
      "[warn] ANTHROPIC_API_KEY ist nicht gesetzt — es werden nur Artikel gesammelt, keine KI-Zusammenfassungen erstellt.",
    );
  }

  const sourceStatus = {};
  const freshArticles = [];
  for (const source of sources) {
    const result = await fetchSource(source);
    sourceStatus[source.id] = {
      ok: result.ok,
      error: result.error ?? null,
      itemCount: result.items.length,
      checkedAt: new Date().toISOString(),
    };
    freshArticles.push(...result.items);
  }

  const taggedFresh = freshArticles
    .map((a) => ({ ...a, topics: tagTopics(a, topics) }))
    .filter((a) => a.topics.length > 0);

  // Mit Archiv zusammenführen (dedupe nach Link, neue Version gewinnt)
  const byLink = new Map();
  for (const a of previous?.articles ?? []) byLink.set(a.link, a);
  for (const a of taggedFresh) byLink.set(a.link, a);

  const cutoffISO = new Date(Date.now() - ARCHIVE_DAYS * 86400000).toISOString();
  const archive = [...byLink.values()]
    .filter((a) => a.publishedAt >= cutoffISO)
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));

  // Standard-Zeiträume (Europe/Zurich)
  const now = new Date();
  const todayYMD = zurichYMD(now);
  const yesterdayYMD = addDaysYMD(todayYMD, -1);
  const mondayThisWeekYMD = addDaysYMD(todayYMD, -weekdayIndexMon0(todayYMD));
  const mondayLastWeekYMD = addDaysYMD(mondayThisWeekYMD, -7);
  const sundayLastWeekYMD = addDaysYMD(mondayThisWeekYMD, -1);
  const last30StartYMD = addDaysYMD(todayYMD, -29);

  const periodDefs = [
    { id: "heute", label: "Heute", from: todayYMD, to: todayYMD },
    { id: "gestern", label: "Gestern", from: yesterdayYMD, to: yesterdayYMD },
    { id: "diese_woche", label: "Diese Woche", from: mondayThisWeekYMD, to: todayYMD },
    { id: "letzte_woche", label: "Letzte Woche", from: mondayLastWeekYMD, to: sundayLastWeekYMD },
    { id: "letzte_30_tage", label: "Letzte 30 Tage", from: last30StartYMD, to: todayYMD },
  ];

  function articleYMD(a) {
    return zurichYMD(new Date(a.publishedAt));
  }

  const summaries = {};
  for (const topic of topics) {
    summaries[topic.id] = {};
    for (const period of periodDefs) {
      const matching = archive.filter(
        (a) => a.topics.includes(topic.id) && articleYMD(a) >= period.from && articleYMD(a) <= period.to,
      );
      const result = await summarizeTopicPeriod(topic, period.label, matching);
      summaries[topic.id][period.id] = { ...result, articleCount: matching.length };
    }
  }

  const output = {
    generatedAt: now.toISOString(),
    timezone: TIMEZONE,
    archiveDays: ARCHIVE_DAYS,
    sources: sources.map((s) => ({ id: s.id, name: s.name, rss: s.rss, status: sourceStatus[s.id] })),
    topics,
    periods: periodDefs,
    articles: archive,
    summaries,
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(
    `news.json geschrieben: ${archive.length} Artikel im Archiv, ${topics.length} Themen, ${sources.length} Quellen.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
