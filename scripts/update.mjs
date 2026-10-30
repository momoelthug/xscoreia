// Mise à jour lancée toutes les heures par GitHub Actions.
// 1) récupère les données et calcule les pronos (même code que la version Netlify)
// 2) écrit le site statique dans le dossier "site/" (page + fichiers JSON), publié sur GitHub Pages.
import { promises as fs } from "node:fs";
import path from "node:path";
import { runUpdate, projectTable } from "../lib/core.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const STORE = path.join(ROOT, "data", "store");   // gardé entre deux passages par le cache de GitHub
const SITE = path.join(ROOT, "site");

// Stockage sur disque, avec la même interface que Netlify Blobs
const file = k => path.join(STORE, k + ".json");
const store = {
  async get(k) { try { return JSON.parse(await fs.readFile(file(k), "utf8")); } catch { return null; } },
  async setJSON(k, v) { await fs.mkdir(path.dirname(file(k)), { recursive: true }); await fs.writeFile(file(k), JSON.stringify(v)); },
  async list({ prefix }) {
    const out = [];
    async function walk(dir, rel) {
      let entries = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const r = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), r);
        else if (e.name.endsWith(".json")) out.push(r.slice(0, -5));
      }
    }
    await walk(STORE, "");
    return { blobs: out.filter(k => k.startsWith(prefix)).map(key => ({ key })) };
  },
};

const env = k => (process.env[k] || "").trim();
if (!env("API_FOOTBALL_KEY")) { console.error("Secret API_FOOTBALL_KEY manquant"); process.exit(1); }

const state = await runUpdate({
  store, apiKey: env("API_FOOTBALL_KEY"), fdKey: env("FOOTBALL_DATA_KEY"), hlKey: env("HIGHLIGHTLY_KEY"),
  apiPlan: env("API_PLAN") || "free", force: env("FORCE") === "1", log: console.log,
});
console.log("Mise à jour :", JSON.stringify({ lastErrors: state.lastErrors, footballData: state.footballData, highlightly: state.highlightly, odds: state.oddsFetched }));

// ---------- export du site statique ----------
const write = async (rel, data) => {
  const f = path.join(SITE, rel);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, typeof data === "string" ? data : JSON.stringify(data));
};
await fs.rm(SITE, { recursive: true, force: true });
await fs.mkdir(SITE, { recursive: true });
await fs.copyFile(path.join(ROOT, "public", "index.html"), path.join(SITE, "index.html"));
await write(".nojekyll", "");
if (env("CUSTOM_DOMAIN")) await write("CNAME", env("CUSTOM_DOMAIN"));

for (const { key } of (await store.list({ prefix: "pred/" })).blobs) await write(`api/predictions/${key.slice(5)}.json`, await store.get(key));

const { lastRun, lastErrors, historyDays, leaguesModelled, finishedMatches, usage, days, plan, footballData, highlightly, teamsLinked, oddsFetched } = state;
await write("api/status.json", { lastRun, lastErrors, historyDays, leaguesModelled, finishedMatches, requestsToday: usage?.count, days, plan, footballData, highlightly, teamsLinked, oddsFetched });

const leagues = (await store.get("leagues")) || { leagues: [] };
await write("api/leagues.json", leagues);
for (const l of leagues.leagues) {
  const st = await store.get("standings/" + l.key);
  if (!st?.rows?.length) continue;
  await write(`api/table/${l.key}.json`, { key: l.key, league: st.league, fetchedAt: st.fetchedAt, rows: st.rows, projection: projectTable(st) });
}
console.log(`Site exporté : ${leagues.leagues.length} classement(s).`);
