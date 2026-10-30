// xScore IA — Highlightly : les championnats que football-data ne couvre pas.
// Matchs de J+2 à J+7, classements, et quelques jours passés pour la forme.
// Quota gratuit : 100 requêtes/jour. On en garde quelques-unes de côté.

const HL_API = "https://soccer.highlightly.net";
export const HL_BUDGET = 92;
const HL_PER_RUN = 14;          // requêtes max par passage (30 s max par passage sur Netlify)
const HL_DAY_MAX_AGE_H = 20;    // un jour de matchs est rechargé une fois par jour
const HL_STAND_MAX_AGE_H = 72;  // un classement est rechargé tous les 3 jours
const HL_BACKFILL_DAYS = 21;    // jours passés récupérés pour la forme des équipes
const PAGE = 100;

// ---------- rapprochement des noms d'équipes entre sources ----------
const STOP = new Set(["fc", "cf", "sc", "ac", "afc", "sk", "fk", "cd", "ud", "sd", "club", "de", "del", "la", "le", "the", "and",
  "sv", "vfb", "vfl", "tsg", "bk", "if", "ff", "ca", "cs", "as", "us", "ss", "calcio", "football", "futbol", "sporting", "fbc", "kv", "kaa", "rc"]);
const YOUTH = /^(u\d{2}|w|women|ii|b|reserves?|youth|feminin[ea]?|fem)$/;
export function tokens(name) {
  return String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/ı/g, "i").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(t => t && !STOP.has(t));
}
export function nameSim(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return 0;
  // équipe de jeunes / féminine / réserve d'un côté seulement : jamais la même équipe
  if (A.some(t => YOUTH.test(t)) !== B.some(t => YOUTH.test(t))) return 0;
  if (A.join(" ") === B.join(" ")) return 1;
  let inter = 0;
  for (const x of A) if (B.some(y => x === y || (x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x))))) inter++;
  return inter / Math.min(A.length, B.length);
}
const normCountry = c => tokens(c).join(" ").replace("turkiye", "turkey").replace("czechia", "czech republic");

// ---------- appels API ----------
async function hlGet(path, key, fetchImpl) {
  const res = await fetchImpl(HL_API + path, { headers: { "x-rapidapi-key": key } });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Highlightly ${res.status} : ${j?.message || "erreur"}`);
  return j;
}

function hlStatus(desc = "") {
  const d = desc.toLowerCase();
  if (d.includes("finished")) return "FT";
  if (d.includes("not started") || d === "tbd" || d.includes("to be")) return "NS";
  if (d.includes("postpon")) return "PST";
  if (d.includes("cancel") || d.includes("abandon")) return "CANC";
  if (d.includes("half time") || d.includes("break")) return "HT";
  return "LIVE";
}
function compactHL(m) {
  const sc = String(m.state?.score?.current || "").match(/(\d+)\s*-\s*(\d+)/);
  const st = hlStatus(m.state?.description);
  return {
    id: "h" + m.id, t: m.date, st,
    lg: { id: "h" + m.league?.id, name: m.league?.name || "", country: m.country?.name || "", season: m.league?.season, round: m.round || "" },
    h: { id: "h" + m.homeTeam?.id, name: m.homeTeam?.name || "?" },
    a: { id: "h" + m.awayTeam?.id, name: m.awayTeam?.name || "?" },
    gh: sc && st !== "NS" ? Number(sc[1]) : null, ga: sc && st !== "NS" ? Number(sc[2]) : null,
  };
}

export async function hlStandings(leagueId, season, key, fetchImpl = fetch) {
  const j = await hlGet(`/standings?leagueId=${leagueId}&season=${season}`, key, fetchImpl);
  const rows = [], teams = {};
  for (const g of j?.groups || []) for (const r of g.standings || []) {
    const T = r.total || {}, H = r.home, A = r.away;
    const id = "h" + r.team?.id;
    rows.push({ id, name: r.team?.name || "?", rank: r.position, pts: r.points ?? 0, pl: T.games ?? 0, w: T.wins ?? 0, d: T.draws ?? 0, l: T.loses ?? 0,
      gf: T.scoredGoals ?? 0, ga: T.receivedGoals ?? 0, gd: (T.scoredGoals ?? 0) - (T.receivedGoals ?? 0), form: "", group: g.name || "", desc: "" });
    teams[id] = H && A ? [H.games || 0, H.scoredGoals || 0, H.receivedGoals || 0, A.games || 0, A.scoredGoals || 0, A.receivedGoals || 0]
      : [Math.ceil((T.games || 0) / 2), (T.scoredGoals || 0) / 2, (T.receivedGoals || 0) / 2, Math.floor((T.games || 0) / 2), (T.scoredGoals || 0) / 2, (T.receivedGoals || 0) / 2];
  }
  return { league: { id: "h" + leagueId, name: j?.league?.name || "", country: "", season }, rows, teams };
}

// ---------- mise à jour (appelée à chaque passage horaire) ----------
// Stockage : "hld/AAAA-MM-JJ/N" = page N des matchs du jour, "standings/hID-SAISON" = classement.
export async function runHL({ store, hlKey, today, now, addDays, fetchImpl = fetch, errors = [] }) {
  const st = (await store.get("hlstate", { type: "json" })) || {};
  const utcDay = now.toISOString().slice(0, 10);
  if (st.usage?.day !== utcDay) st.usage = { day: utcDay, count: 0 };
  let run = 0;
  const can = (reserve = 0) => run < HL_PER_RUN && st.usage.count < HL_BUDGET - reserve;
  const fresh = (at, h) => at && now - new Date(at) < h * 3600e3;
  const pages = new Map((await store.list({ prefix: "hld/" })).blobs.map(b => [b.key, true]));

  async function loadDay(d, maxAge) {
    // page 0 d'abord : elle donne le nombre total de matchs du jour
    const p0 = pages.has(`hld/${d}/0`) ? await store.get(`hld/${d}/0`, { type: "json" }) : null;
    let total = p0?.total;
    for (let i = 0; total == null || i * PAGE < total; i++) {
      const k = `hld/${d}/${i}`;
      if (pages.has(k)) {
        const p = i === 0 ? p0 : await store.get(k, { type: "json" });
        if (p && fresh(p.fetchedAt, maxAge)) { total ??= p.total; continue; }
      }
      if (!can()) return false;
      const j = await hlGet(`/matches?date=${d}&timezone=Europe%2FParis&limit=${PAGE}&offset=${i * PAGE}`, hlKey, fetchImpl);
      run++; st.usage.count++;
      total = j?.pagination?.totalCount ?? (j?.data?.length || 0);
      await store.setJSON(k, { fetchedAt: now.toISOString(), total, matches: (j?.data || []).map(compactHL) });
      if (i > 40) break;
    }
    return true;
  }

  try {
    // 1) la semaine : J+2 à J+7 (hier, aujourd'hui et demain viennent d'API-Football)
    for (let i = 2; i <= 7; i++) if (!(await loadDay(addDays(today, i), HL_DAY_MAX_AGE_H))) break;

    // 2) classements des championnats qui jouent cette semaine, les plus actifs d'abord
    const count = new Map();
    for (const b of (await store.list({ prefix: "hld/" })).blobs) {
      const d = b.key.slice(4, 14);
      if (d < today) continue;
      const p = await store.get(b.key, { type: "json" });
      for (const m of p?.matches || []) {
        const k = `${m.lg.id.slice(1)}-${m.lg.season}`;
        const c = count.get(k) || { n: 0, name: m.lg.name, country: m.lg.country }; c.n++; count.set(k, c);
      }
    }
    const skip = new Set(st.fdLeagues || []); // championnats déjà fournis par football-data
    for (const [k, c] of [...count.entries()].sort((a, b) => b[1].n - a[1].n)) {
      if (skip.has(k.split("-")[0]) || c.n < 2) continue;
      const old = await store.get("standings/h" + k, { type: "json" });
      if (old && fresh(old.fetchedAt, HL_STAND_MAX_AGE_H)) continue;
      if (!can(8)) break;
      const [lid, season] = k.split("-");
      try {
        const s = await hlStandings(lid, season, hlKey, fetchImpl);
        s.league.name ||= c.name; s.league.country = c.country;
        await store.setJSON("standings/h" + k, { fetchedAt: now.toISOString(), source: "highlightly", ...s });
      } catch (e) {
        await store.setJSON("standings/h" + k, { fetchedAt: now.toISOString(), teams: {}, rows: [], error: e.message });
      }
      run++; st.usage.count++;
    }

    // 3) jours passés pour la forme des équipes, avec ce qui reste du quota
    for (let i = 2; i <= HL_BACKFILL_DAYS; i++) if (!can(20) || !(await loadDay(addDays(today, -i), 24 * 365))) break;
  } catch (e) {
    errors.push(e.message);
  }
  st.lastRun = now.toISOString();
  await store.setJSON("hlstate", st);
  return { requests: run, today: st.usage.count };
}

// ---------- fusion des sources ----------
// days : { date: { fixtures } } déjà rempli par API-Football et football-data.
// Ajoute les matchs Highlightly (sans doublons) et rattache les équipes API-Football aux identifiants Highlightly.
export async function mergeHL({ store, days, today, inWindow, afDays }) {
  const keys = (await store.list({ prefix: "hld/" })).blobs.map(b => b.key);
  const hl = [];
  for (const k of keys) {
    const d = k.slice(4, 14);
    if (!inWindow(d) || afDays.has(d)) continue; // hier/aujourd'hui/demain : API-Football fait foi
    const p = await store.get(k, { type: "json" });
    for (const m of p?.matches || []) hl.push({ d, m });
  }
  // doublons avec football-data : même jour, même heure (±15 min), mêmes équipes
  const fdLeagues = new Set();
  const byDay = new Map();
  for (const [d, v] of Object.entries(days)) byDay.set(d, v.fixtures.filter(f => typeof f.id === "number" && f.id >= 900_000_000));
  for (const { d, m } of hl) {
    const dup = (byDay.get(d) || []).find(f => Math.abs(new Date(f.t) - new Date(m.t)) <= 15 * 60e3 && nameSim(f.h.name, m.h.name) >= 0.6 && nameSim(f.a.name, m.a.name) >= 0.6);
    if (dup) fdLeagues.add(m.lg.id.slice(1));
  }
  for (const { d, m } of hl) {
    if (fdLeagues.has(m.lg.id.slice(1))) continue;
    (days[d] ||= { fixtures: [] }).fixtures.push(m);
  }

  // équipes API-Football -> équipes Highlightly (même pays, nom proche), pour profiter des classements
  const stands = [];
  for (const b of (await store.list({ prefix: "standings/h" })).blobs) {
    const s = await store.get(b.key, { type: "json" });
    if (s?.rows?.length) stands.push({ lid: s.league.id, country: normCountry(s.league.country), name: s.league.name, rows: s.rows });
  }
  const leagueMap = new Map();
  let mapped = 0;
  for (const d of afDays) for (const f of days[d]?.fixtures || []) {
    if (typeof f.id !== "number" || f.id >= 900_000_000) continue; // seulement API-Football
    if (!leagueMap.has(f.lg.id)) {
      const c = normCountry(f.lg.country);
      let best = null, bestScore = 0;
      for (const s of stands) {
        if (s.country && c && s.country !== c) continue;
        const score = nameSim(f.lg.name, s.name) * 0.5 + (s.rows.some(r => nameSim(r.name, f.h.name) >= 0.8) ? 1 : 0) + (s.rows.some(r => nameSim(r.name, f.a.name) >= 0.8) ? 1 : 0);
        if (score > bestScore) { best = s; bestScore = score; }
      }
      leagueMap.set(f.lg.id, bestScore >= 2 ? best : null);
    }
    const s = leagueMap.get(f.lg.id);
    if (!s) continue;
    const find = n => { let b = null, sc = 0.8; for (const r of s.rows) { const x = nameSim(r.name, n); if (x > sc || (x === sc && !b)) { b = r; sc = x; } } return b; };
    const H = find(f.h.name), A = find(f.a.name);
    if (H && A) { f.h = { id: H.id, name: f.h.name }; f.a = { id: A.id, name: f.a.name }; f.lg = { ...f.lg, id: s.lid }; mapped++; }
  }
  return { fdLeagues: [...fdLeagues], mapped };
}
