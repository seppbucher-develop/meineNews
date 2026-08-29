#!/usr/bin/env node
// Lädt genau eine RSS-Quelle und gibt die rohen Items als JSON auf stdout aus.
// Läuft absichtlich als eigenständiger Kindprozess (aufgerufen von fetch-news.mjs
// via child_process.execFile mit einem harten Timeout): ein XML-Parser kann bei
// kaputtem/bösartigem Markup synchron (CPU-gebunden) hängen bleiben — das lässt
// sich innerhalb desselben Prozesses nicht per Promise/Timer unterbrechen, weil
// Node währenddessen den Event-Loop blockiert. Nur ein OS-Level-Kill (SIGKILL
// des Kindprozesses durch den aufrufenden Prozess) garantiert eine harte Grenze.
//
// Aufruf: node fetch-one-source.mjs '<source-json>'
// Ausgabe (stdout, ein JSON-Objekt): { ok: true, items: [...] } oder { ok: false, error: "..." }

import Parser from "rss-parser";

async function main() {
  const source = JSON.parse(process.argv[2]);
  const parser = new Parser({ timeout: 15000 });
  const feed = await parser.parseURL(source.rss);
  const items = (feed.items || []).map((it) => ({
    title: it.title ?? null,
    link: it.link ?? null,
    isoDate: it.isoDate ?? null,
    pubDate: it.pubDate ?? null,
    contentSnippet: it.contentSnippet ?? null,
    summary: it.summary ?? null,
  }));
  process.stdout.write(JSON.stringify({ ok: true, items }));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: err?.message || String(err) }));
});
