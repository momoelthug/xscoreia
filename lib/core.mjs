// xScore IA — logique partagée : récupération API-Football, stockage, modèle de prono.
// Aucune dépendance au runtime Netlify ici : le stockage est passé en paramètre
// (Netlify Blobs en production, un faux stockage pour les tests).

import { runHL, mergeHL, nameSim } from "./hl.mjs";

export const TZ = "Europe/Paris";
export const HISTORY_DAYS = 240;      // historique utilisé par le modèle (inclut la fin de la saison précédente)
export const AHEAD_DAYS = 6;          // pronos de aujourd'hui à J+6
export const DAILY_BUDGET = 90;       // l'offre gratuite donne 100 req/jour, on garde une marge
const API = "https://v3.football.api-sports.io";
const FINISHED = new Set(["FT", "AET", "PEN"]);
const HALF_LIFE = 90;                 // jours : un match vieux de 90 j compte moitié moins
const MAX_GOALS = 10;
const RHO = -0.08;                    // correction Dixon-Coles des petits scores (0-0, 1-1…)
const PER_RUN = 9;                    // requêtes max par passage (offre gratuite : 10/minute)
const STANDINGS_RESERVE = 25;         // requêtes gardées pour les matchs du jour
const STANDINGS_MAX_AGE_H = 48;       // un classement est rafraîchi tous les 2 jours
// grands championnats et coupes, servis en premier
export const TOP = [2, 3, 848, 1, 4, 5, 39, 140, 135, 78, 61, 94, 88, 203, 40, 62, 144, 179, 71, 253, 307];
export const WEEK_AHEAD = 7;          // la semaine affichée : jusqu'au même jour la semaine suivante
// championnats dont on va chercher toute la semaine (une requête chacun par jour)
const WEEK_LEAGUES = [2, 3, 848, 39, 140, 135, 78, 61, 94, 88, 203, 40, 62, 144, 179, 71, 253, 307];

// ---------- dates (toujours en heure de Paris) ----------
export function parisDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
export function addDays(ymd, n) {
  const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dayDiff = (a, b) => Math.round((new Date(a + "T12:00:00Z") - new Date(b + "T12:00:00Z")) / 864e5);

// ---------- API-Football ----------
function compact(r) {
  const ft = r.score?.fulltime;
  const useFt = ft && ft.home != null && ["AET", "PEN"].includes(r.fixture.status.short);
  return {
    id: r.fixture.id, t: r.fixture.date, st: r.fixture.status.short,
    lg: { id: r.league.id, name: r.league.name, country: r.league.country, season: r.league.season, round: r.league.round },
    h: { id: r.teams.home.id, name: r.teams.home.name },
    a: { id: r.teams.away.id, name: r.teams.away.name },
    gh: useFt ? ft.home : r.goals.home, ga: useFt ? ft.away : r.goals.away,
  };
}

export async function fetchDay(date, apiKey, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}/fixtures?date=${date}&timezone=${encodeURIComponent(TZ)}`, {
    headers: { "x-apisports-key": apiKey },
  });
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  const j = await res.json();
  const errs = j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
  if (errs && errs.length) throw new Error("API : " + errs.join(" | "));
  const remaining = Number(res.headers.get?.("x-ratelimit-requests-remaining"));
  return { fixtures: (j.response || []).map(compact), remaining: Number.isFinite(remaining) ? remaining : null };
}

export async function fetchStandings(leagueId, season, apiKey, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}/standings?league=${leagueId}&season=${season}`, { headers: { "x-apisports-key": apiKey } });
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  const j = await res.json();
  const errs = j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
  if (errs && errs.length) throw new Error("API : " + errs.join(" | "));
  const L = j.response?.[0]?.league || {};
  const teams = {}, rows = [];
  for (const group of L.standings || []) for (const r of group) {
    const g = s => [s?.played || 0, s?.goals?.for || 0, s?.goals?.against || 0];
    rows.push({
      id: r.team.id, name: r.team.name, rank: r.rank, pts: r.points ?? 0, pl: r.all?.played ?? 0,
      w: r.all?.win ?? 0, d: r.all?.draw ?? 0, l: r.all?.lose ?? 0,
      gf: r.all?.goals?.for ?? 0, ga: r.all?.goals?.against ?? 0, gd: r.goalsDiff ?? 0,
      form: r.form || "", group: r.group || "", desc: r.description || "",
    });
    const prev = teams[r.team.id];
    if (prev && prev[0] + prev[3] >= (r.home?.played || 0) + (r.away?.played || 0)) continue; // équipe présente dans plusieurs groupes
    teams[r.team.id] = [...g(r.home), ...g(r.away)]; // [jH, butsH, encH, jA, butsA, encA]
  }
  return { league: { id: L.id ?? leagueId, name: L.name || "", country: L.country || "", season: L.season ?? season }, rows, teams };
}

// Matchs à venir d'un championnat sur une période (sert à afficher la semaine entière).
export async function fetchLeagueRange(leagueId, season, from, to, apiKey, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}/fixtures?league=${leagueId}&season=${season}&from=${from}&to=${to}&timezone=${encodeURIComponent(TZ)}`,
    { headers: { "x-apisports-key": apiKey } });
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  const j = await res.json();
  const errs = j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
  if (errs && errs.length) throw new Error("API : " + errs.join(" | "));
  return (j.response || []).map(compact);
}

// Saison API-Football d'un championnat à une date donnée (saisons à cheval sur deux années en Europe).
const CALENDAR_YEAR = new Set([71, 253, 98, 128, 113, 103, 244, 292, 169]); // Brésil, MLS, Japon, Argentine, Suède, Norvège, Finlande, Corée, Chine
export function guessSeason(leagueId, today) {
  const [y, m] = today.split("-").map(Number);
  return CALENDAR_YEAR.has(leagueId) ? y : (m >= 7 ? y : y - 1);
}

// ---------- classement prédit (simulation de la fin de saison) ----------
function poissonSample(l, rnd) { let k = 0, p = Math.exp(-l), s = p; const u = rnd(); while (u > s && k < 15) { k++; p *= l / k; s += p; } return k; }
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export function projectTable(st, sims = 2000) {
  const R = standingsRatings(st.teams, 10); // plus prudent sur une saison entière
  const groups = new Map();
  for (const r of st.rows) { if (!groups.has(r.group)) groups.set(r.group, []); groups.get(r.group).push(r); }
  const out = [];
  const rnd = rng(st.rows.length * 7919 + (st.rows[0]?.id || 1));
  for (const [group, rows] of groups) {
    const total = Math.max(2 * (rows.length - 1), ...rows.map(r => r.pl));
    const sim = rows.map(r => {
      const t = R.teams.get(r.id) || { att: 1, def: 1 };
      const left = Math.max(0, total - r.pl);
      return { r, t, left, sum: 0, titles: 0 };
    });
    for (let s = 0; s < sims; s++) {
      const pts = sim.map(x => {
        let p = x.r.pts;
        for (let g = 0; g < x.left; g++) {
          const home = g % 2 === 0;
          const lf = (home ? R.muH : R.muA) * x.t.att, la = (home ? R.muA : R.muH) * x.t.def;
          const a = poissonSample(lf, rnd), b = poissonSample(la, rnd);
          p += a > b ? 3 : a === b ? 1 : 0;
        }
        x.sum += p; return p + rnd() * 0.01; // départage aléatoire des égalités
      });
      let best = 0; for (let i = 1; i < pts.length; i++) if (pts[i] > pts[best]) best = i;
      sim[best].titles++;
    }
    const proj = sim.map(x => ({ id: x.r.id, name: x.r.name, pts: x.r.pts, pl: x.r.pl, left: x.left,
      proj: Math.round(x.sum / sims), title: Math.round((x.titles / sims) * 1000) / 10 }))
      .sort((a, b) => b.proj - a.proj || b.title - a.title);
    out.push({ group, total, teams: proj });
  }
  return out;
}

// ---------- cotes (API-Football, offre gratuite : hier à demain) ----------
const ODDS_PER_RUN = 3, ODDS_MIN_BUDGET = 30, ODDS_MAX_AGE_H = 8;
export async function fetchOdds(fixtureId, apiKey, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}/odds?fixture=${fixtureId}`, { headers: { "x-apisports-key": apiKey } });
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  const j = await res.json();
  const errs = j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
  if (errs && errs.length) throw new Error("API : " + errs.join(" | "));
  const books = (j.response?.[0]?.bookmakers || []).map(b => {
    const bet = (b.bets || []).find(x => /^match winner$/i.test(x.name));
    const v = k => Number(bet?.values?.find(x => x.value === k)?.odd);
    const o = [v("Home"), v("Draw"), v("Away")];
    return o.every(x => x > 1) ? { name: b.name, o } : null;
  }).filter(Boolean);
  if (!books.length) return null;
  const uni = books.find(b => /unibet/i.test(b.name));
  if (uni) return { book: "Unibet", o: uni.o };
  const avg = [0, 1, 2].map(i => Math.round(books.reduce((s, b) => s + b.o[i], 0) / books.length * 100) / 100);
  return { book: `Moyenne de ${books.length} bookmakers`, o: avg };
}

// ---------- football-data.org (offre gratuite : saison en cours de 12 compétitions) ----------
const FD_API = "https://api.football-data.org/v4";
// code football-data -> identifiant API-Football (pour éviter les doublons et garder le même classement de priorité)
export const FD_COMPS = { CL: 2, PL: 39, PD: 140, SA: 135, BL1: 78, FL1: 61, PPL: 94, DED: 88, ELC: 40, BSA: 71, WC: 1, EC: 4 };
const FD_MAX_AGE_H = 6;
const FD_TEAM = 9_000_000, FD_MATCH = 900_000_000; // décalages d'identifiants pour ne pas croiser ceux d'API-Football
const FD_STATUS = { FINISHED: "FT", AWARDED: "FT", IN_PLAY: "LIVE", PAUSED: "HT", POSTPONED: "PST", CANCELLED: "CANC", SUSPENDED: "SUSP" };

async function fdGet(path, fdKey, fetchImpl) {
  const res = await fetchImpl(FD_API + path, { headers: { "X-Auth-Token": fdKey } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`football-data ${res.status} : ${j.message || "erreur"}`);
  return j;
}

export async function fetchFD(code, fdKey, fetchImpl = fetch) {
  const apiId = FD_COMPS[code];
  const m = await fdGet(`/competitions/${code}/matches`, fdKey, fetchImpl);
  const comp = m.competition || {};
  const season = Number((m.filters?.season ?? m.matches?.[0]?.season?.startDate ?? "").toString().slice(0, 4)) || null;
  const lg = { id: apiId, name: comp.name || code, country: m.matches?.[0]?.area?.name || comp.area?.name || "", season };
  const goals = x => {
    const s = x.score || {};
    if (s.regularTime && s.regularTime.home != null) return [s.regularTime.home + (s.extraTime?.home || 0), s.regularTime.away + (s.extraTime?.away || 0)];
    return [s.fullTime?.home ?? null, s.fullTime?.away ?? null];
  };
  const matches = (m.matches || []).filter(x => x.homeTeam?.id && x.awayTeam?.id && x.utcDate).map(x => {
    const [gh, ga] = goals(x);
    return {
      id: FD_MATCH + x.id, t: x.utcDate, st: FD_STATUS[x.status] || "NS",
      lg: { ...lg, round: x.matchday ? `Journée ${x.matchday}` : (x.stage || "") },
      h: { id: FD_TEAM + x.homeTeam.id, name: x.homeTeam.shortName || x.homeTeam.name || "?" },
      a: { id: FD_TEAM + x.awayTeam.id, name: x.awayTeam.shortName || x.awayTeam.name || "?" },
      gh, ga,
    };
  });

  let table = null;
  try {
    const s = await fdGet(`/competitions/${code}/standings`, fdKey, fetchImpl);
    const byType = t => (s.standings || []).filter(g => g.type === t);
    const side = new Map();
    for (const [t, k] of [["HOME", 0], ["AWAY", 3]]) for (const g of byType(t)) for (const r of g.table || []) {
      const v = side.get(r.team.id) || [0, 0, 0, 0, 0, 0];
      v[k] = r.playedGames || 0; v[k + 1] = r.goalsFor || 0; v[k + 2] = r.goalsAgainst || 0;
      side.set(r.team.id, v);
    }
    const rows = [], teams = {};
    for (const g of byType("TOTAL")) for (const r of g.table || []) {
      rows.push({
        id: FD_TEAM + r.team.id, name: r.team.shortName || r.team.name, rank: r.position, pts: r.points ?? 0, pl: r.playedGames ?? 0,
        w: r.won ?? 0, d: r.draw ?? 0, l: r.lost ?? 0, gf: r.goalsFor ?? 0, ga: r.goalsAgainst ?? 0, gd: r.goalDifference ?? 0,
        form: (r.form || "").replace(/,/g, ""), group: (g.group || "").replace(/_/g, " ").replace(/^GROUP/, "Groupe"), desc: "",
      });
      // sans tableaux domicile/extérieur, on répartit les buts à moitié
      teams[FD_TEAM + r.team.id] = side.get(r.team.id) || [Math.ceil((r.playedGames || 0) / 2), (r.goalsFor || 0) / 2, (r.goalsAgainst || 0) / 2,
        Math.floor((r.playedGames || 0) / 2), (r.goalsFor || 0) / 2, (r.goalsAgainst || 0) / 2];
    }
    if (rows.length) table = { league: { id: apiId, name: lg.name, country: lg.country, season: s.season?.startDate ? Number(s.season.startDate.slice(0, 4)) : season }, rows, teams };
  } catch (e) { if (!/404/.test(e.message)) throw e; } // compétition sans classement (phase finale) : pas grave
  return { lg, matches, table };
}

// ---------- mise à jour (appelée par la fonction programmée) ----------
// Offre gratuite d'API-Football : seulement hier, aujourd'hui et demain sont accessibles.
// Avec une offre payante, mettre la variable API_PLAN=paid pour J+6 et le remplissage de l'historique.
export function planLimits(apiPlan = "free") {
  return apiPlan === "paid" ? { ahead: AHEAD_DAYS, backfill: true, windowEveryH: 6 }
                            : { ahead: 1, backfill: false, windowEveryH: 3 };
}

export async function runUpdate({ store, apiKey, fdKey = "", hlKey = "", apiPlan = "free", now = new Date(), fetchImpl = fetch, force = false, light = false, log = () => {} }) {
  const today = parisDate(now);
  const lim = planLimits(apiPlan);
  const state = (await store.get("state", { type: "json" })) || {};
  const utcDay = now.toISOString().slice(0, 10);
  if (state.usage?.day !== utcDay) state.usage = { day: utcDay, count: 0 };
  const budgetLeft = () => DAILY_BUDGET - state.usage.count;
  const errors = [];

  const plan = [today];
  const windowStale = force || !state.windowAt || now - new Date(state.windowAt) > lim.windowEveryH * 3600e3 || state.windowDay !== today;
  if (windowStale) {
    plan.push(addDays(today, -1));
    for (let i = 1; i <= lim.ahead; i++) plan.push(addDays(today, i));
  } else if (lim.backfill) {
    // remplissage progressif de l'historique : les jours manquants les plus récents d'abord
    const have = new Set((await store.list({ prefix: "days/" })).blobs.map(b => b.key.slice(5)));
    let n = 0;
    for (let i = 2; i <= HISTORY_DAYS && n < 6; i++) {
      const d = addDays(today, -i);
      if (!have.has(d)) { plan.push(d); n++; }
    }
  }

  let fetched = 0;
  for (const d of plan) {
    if (budgetLeft() <= 0) { errors.push("Quota quotidien atteint, reprise demain."); break; }
    try {
      const { fixtures, remaining } = await fetchDay(d, apiKey, fetchImpl);
      state.usage.count++; fetched++;
      if (remaining != null) state.apiRemaining = remaining;
      await store.setJSON("days/" + d, { fetchedAt: now.toISOString(), fixtures });
      log(`${d} : ${fixtures.length} matchs`);
      if (!process.env.XS_TEST) await new Promise(r => setTimeout(r, 250)); // offre gratuite : 10 requêtes/minute
    } catch (e) {
      state.usage.count++;
      errors.push(`${d} : ${e.message}`);
      if (/key|token|subscription/i.test(e.message)) break; // clé invalide : inutile d'insister
    }
  }
  // la fenêtre est considérée à jour même si un jour hors offre a échoué, pour ne pas gaspiller le quota
  if (windowStale) { state.windowAt = now.toISOString(); state.windowDay = today; }

  // le reste de la semaine (J+2 à J+7) pour les grands championnats, une fois par jour
  // (réparti sur plusieurs passages : 30 s max par passage et 10 requêtes/minute sur l'offre gratuite)
  let weekFetched = 0;
  const runLeft = () => PER_RUN - fetched - weekFetched - stFetched;
  let stFetched = 0;
  if (!light && !fdKey && lim.ahead < WEEK_AHEAD) {
    if (state.week?.day !== today) state.week = { day: today, done: [], blocked: null };
    const from = addDays(today, lim.ahead + 1), to = addDays(today, WEEK_AHEAD);
    const seasons = state.seasons || {};
    const byDay = new Map();
    for (const lid of WEEK_LEAGUES) {
      if (state.week.blocked || runLeft() <= 4 || budgetLeft() <= STANDINGS_RESERVE) break; // garde de la place pour les classements
      if (state.week.done.includes(lid)) continue;
      try {
        const fx = await fetchLeagueRange(lid, seasons[lid] || guessSeason(lid, today), from, to, apiKey, fetchImpl);
        state.usage.count++; weekFetched++;
        state.week.done.push(lid);
        for (const f of fx) { const d = parisDate(new Date(f.t)); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(f); }
      } catch (e) {
        state.usage.count++; weekFetched++;
        if (/plan|date|access|season/i.test(e.message)) { state.week.blocked = e.message; break; }
        state.week.done.push(lid);
        errors.push(`Semaine (${lid}) : ${e.message}`);
      }
    }
    for (const [d, fx] of byDay) {
      const old = (await store.get("days/" + d, { type: "json" })) || { fixtures: [] };
      const ids = new Set(fx.map(f => f.id));
      await store.setJSON("days/" + d, { fetchedAt: now.toISOString(), partial: true, fixtures: [...old.fixtures.filter(f => !ids.has(f.id)), ...fx] });
    }
    state.weekBlocked = state.week.blocked;
  }

  // classements des championnats qui jouent bientôt : buts pour/contre depuis le début de saison
  const upcoming = new Map();
  for (let i = 0; i <= WEEK_AHEAD; i++) {
    const day = await store.get("days/" + addDays(today, i), { type: "json" });
    for (const f of day?.fixtures || []) {
      const k = `${f.lg.id}-${f.lg.season}`;
      const u = upcoming.get(k) || { id: f.lg.id, season: f.lg.season, n: 0 };
      u.n++; upcoming.set(k, u);
    }
  }
  const have = new Map((await store.list({ prefix: "standings/" })).blobs.map(b => [b.key.slice(10), true]));
  const order = [...upcoming.entries()].sort((x, y) => (TOP.indexOf(x[1].id) + 1 || 999) - (TOP.indexOf(y[1].id) + 1 || 999) || y[1].n - x[1].n);
  const fdIds = new Set(Object.values(FD_COMPS));
  for (const [k, u] of light || state.stBlocked === today ? [] : order) {
    if (fdKey && fdIds.has(u.id)) continue; // fourni par football-data
    if (runLeft() <= 0 || budgetLeft() <= STANDINGS_RESERVE) break;
    if (have.has(k)) {
      const old = await store.get("standings/" + k, { type: "json" });
      if (old && (old.rows || old.error) && now - new Date(old.fetchedAt) < STANDINGS_MAX_AGE_H * 3600e3) continue; // ancien format : à redemander
    }
    try {
      const st = await fetchStandings(u.id, u.season, apiKey, fetchImpl);
      state.usage.count++; stFetched++;
      (state.seasons ||= {})[u.id] = u.season;
      await store.setJSON("standings/" + k, { fetchedAt: now.toISOString(), ...st });
      if (!process.env.XS_TEST) await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      state.usage.count++; stFetched++;
      await store.setJSON("standings/" + k, { fetchedAt: now.toISOString(), teams: {}, error: e.message });
      if (/season|plan/i.test(e.message)) { state.stBlocked = today; break; } // offre gratuite : saison en cours refusée
      if (!errors.some(x => x.startsWith("Classements"))) errors.push("Classements : " + e.message);
      if (/key|token|subscription/i.test(e.message)) break;
    }
  }

  let fdFetched = 0;
  if (fdKey) {
    const fdMax = light ? 2 : 4;
    const ages = await Promise.all(Object.keys(FD_COMPS).map(async c => [c, (await store.get("fd/" + c, { type: "json" }))?.fetchedAt]));
    const stale = ages.filter(([, at]) => !at || now - new Date(at) > FD_MAX_AGE_H * 3600e3)
      .sort((a, b) => (a[1] ? new Date(a[1]) : 0) - (b[1] ? new Date(b[1]) : 0));
    for (const [code] of stale.slice(0, fdMax)) {
      try {
        const r = await fetchFD(code, fdKey, fetchImpl);
        fdFetched++;
        await store.setJSON("fd/" + code, { fetchedAt: now.toISOString(), lg: r.lg, matches: r.matches });
        if (r.table) await store.setJSON(`standings/${r.table.league.id}-${r.table.league.season}`, { fetchedAt: now.toISOString(), source: "football-data", ...r.table });
      } catch (e) {
        // 403 = compétition hors offre : on la met de côté pour la journée
        await store.setJSON("fd/" + code, { fetchedAt: now.toISOString(), matches: [], error: e.message });
        if (/401|invalid|token/i.test(e.message)) { errors.push("football-data : clé refusée"); break; }
        if (!/403/.test(e.message)) errors.push(`football-data ${code} : ${e.message}`);
        if (/429/.test(e.message)) break;
      }
    }
  }

  // cotes des grands championnats, aujourd'hui et demain (quelques matchs par passage)
  let oddsFetched = 0;
  if (!light && budgetLeft() > ODDS_MIN_BUDGET) {
    const cand = [];
    for (const d of [today, addDays(today, 1)]) {
      const day = await store.get("days/" + d, { type: "json" });
      for (const f of day?.fixtures || []) if (TOP.includes(f.lg.id) && f.st === "NS") cand.push(f);
    }
    cand.sort((a, b) => TOP.indexOf(a.lg.id) - TOP.indexOf(b.lg.id) || a.t.localeCompare(b.t));
    for (const f of cand) {
      if (oddsFetched >= ODDS_PER_RUN || budgetLeft() <= ODDS_MIN_BUDGET) break;
      const old = await store.get("odds/" + f.id, { type: "json" });
      if (old && now - new Date(old.fetchedAt) < ODDS_MAX_AGE_H * 3600e3) continue;
      try {
        const o = await fetchOdds(f.id, apiKey, fetchImpl);
        await store.setJSON("odds/" + f.id, { fetchedAt: now.toISOString(), t: f.t, h: f.h.name, a: f.a.name, ...(o || { none: true }) });
      } catch (e) {
        await store.setJSON("odds/" + f.id, { fetchedAt: now.toISOString(), t: f.t, h: f.h.name, a: f.a.name, none: true, error: e.message });
      }
      state.usage.count++; oddsFetched++;
    }
  }

  // Highlightly : la semaine et les classements des autres championnats
  let hlInfo = null;
  if (hlKey && !light) hlInfo = await runHL({ store, hlKey, today, now, addDays, fetchImpl, errors });

  const fdOn = (fdKey && (await store.list({ prefix: "fd/" })).blobs.length > 0) || !!hlKey;
  const showAhead = lim.ahead >= WEEK_AHEAD || fdOn || !state.weekBlocked ? WEEK_AHEAD : lim.ahead;
  const summary = await computeAndStore({ store, today, now, ahead: WEEK_AHEAD });
  summary.standingsFetched = stFetched;
  summary.weekFetched = weekFetched;
  summary.oddsFetched = oddsFetched;
  summary.highlightly = hlKey ? (hlInfo ? `${hlInfo.requests} requête(s) ce passage, ${hlInfo.today} aujourd'hui` : "non utilisé pendant la mise à jour rapide") : "non branché (variable HIGHLIGHTLY_KEY absente)";
  summary.footballData = fdKey ? `${fdFetched} compétition(s) mise(s) à jour` : "non branché (variable FOOTBALL_DATA_KEY absente)";
  summary.weekBlocked = state.weekBlocked || null;
  summary.days = Array.from({ length: showAhead + 2 }, (_, i) => addDays(today, i - 1));
  summary.plan = apiPlan;
  Object.assign(state, { lastRun: now.toISOString(), lastErrors: errors, lastFetched: fetched, ...summary });
  await store.setJSON("state", state);
  return state;
}

// ---------- modèle ----------
async function loadHistory(store, today) {
  const keys = (await store.list({ prefix: "days/" })).blobs.map(b => b.key)
    .filter(k => { const d = k.slice(5); return dayDiff(today, d) <= HISTORY_DAYS && dayDiff(d, today) <= WEEK_AHEAD; });
  const days = Object.fromEntries((await Promise.all(keys.map(async k => [k.slice(5), await store.get(k, { type: "json" })]))).filter(([, v]) => v));
  const afDays = new Set(Object.keys(days));
  const fdKeys = (await store.list({ prefix: "fd/" })).blobs.map(b => b.key);
  const fd = (await Promise.all(fdKeys.map(k => store.get(k, { type: "json" })))).filter(x => x?.matches?.length);
  if (fd.length) {
    const covered = new Set(fd.map(x => x.lg.id));
    for (const d of Object.values(days)) d.fixtures = d.fixtures.filter(f => !covered.has(f.lg.id));
    for (const x of fd) for (const m of x.matches) {
      const d = parisDate(new Date(m.t));
      if (dayDiff(today, d) > HISTORY_DAYS || dayDiff(d, today) > WEEK_AHEAD) continue;
      (days[d] ||= { fixtures: [] }).fixtures.push(m);
    }
  }
  const inWindow = d => dayDiff(today, d) <= HISTORY_DAYS && dayDiff(d, today) <= WEEK_AHEAD;
  const hl = await mergeHL({ store, days, today, inWindow, afDays });
  const hs = (await store.get("hlstate", { type: "json" })) || {};
  if (JSON.stringify(hs.fdLeagues || []) !== JSON.stringify(hl.fdLeagues)) { hs.fdLeagues = hl.fdLeagues; await store.setJSON("hlstate", hs); }
  days.__mapped = hl.mapped;
  return days;
}

export function fitLeague(matches, today) {
  // matches : [{h, a, gh, ga, date}] — ajustement attaque/défense (Maher) avec pondération temporelle
  let W = 0, SH = 0, SA = 0;
  const teams = new Map();
  const T = id => { if (!teams.has(id)) teams.set(id, { att: 1, def: 1, n: 0 }); return teams.get(id); };
  const ms = matches.map(m => ({ ...m, w: Math.pow(0.5, Math.max(0, dayDiff(today, m.date)) / HALF_LIFE) }));
  for (const m of ms) { W += m.w; SH += m.w * m.gh; SA += m.w * m.ga; T(m.h).n += m.w; T(m.a).n += m.w; }
  const K = 12; // rétrécissement des moyennes de ligue vers les valeurs typiques
  const muH = (SH + K * 1.45) / (W + K), muA = (SA + K * 1.15) / (W + K);
  const PRIOR = 3; // matchs « fictifs » qui tirent chaque équipe vers la moyenne
  for (let it = 0; it < 25; it++) {
    const num = new Map(), den = new Map();
    const add = (map, id, v) => map.set(id, (map.get(id) || 0) + v);
    for (const m of ms) {
      const H = teams.get(m.h), A = teams.get(m.a);
      add(num, "a" + m.h, m.w * m.gh); add(den, "a" + m.h, m.w * muH * A.def);
      add(num, "a" + m.a, m.w * m.ga); add(den, "a" + m.a, m.w * muA * H.def);
    }
    for (const [id, t] of teams) t.att = (num.get("a" + id) + PRIOR) / (den.get("a" + id) + PRIOR);
    const num2 = new Map(), den2 = new Map();
    const add2 = (map, id, v) => map.set(id, (map.get(id) || 0) + v);
    for (const m of ms) {
      const H = teams.get(m.h), A = teams.get(m.a);
      add2(num2, m.a, m.w * m.gh); add2(den2, m.a, m.w * muH * H.att);
      add2(num2, m.h, m.w * m.ga); add2(den2, m.h, m.w * muA * A.att);
    }
    for (const [id, t] of teams) t.def = (num2.get(id) + PRIOR) / (den2.get(id) + PRIOR);
    let ma = 0; for (const t of teams.values()) ma += t.att; ma /= teams.size || 1;
    for (const t of teams.values()) { t.att /= ma; t.def *= ma; }
  }
  return { muH, muA, teams, n: W };
}

const pois = (k, l) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
export function matchProbs(lh, la) {
  let p1 = 0, px = 0, p2 = 0, o25 = 0, btts = 0, best = [0, 0, -1], tot = 0;
  for (let i = 0; i <= MAX_GOALS; i++) for (let j = 0; j <= MAX_GOALS; j++) {
    let p = pois(i, lh) * pois(j, la);
    if (i === 0 && j === 0) p *= 1 - lh * la * RHO;
    else if (i === 0 && j === 1) p *= 1 + lh * RHO;
    else if (i === 1 && j === 0) p *= 1 + la * RHO;
    else if (i === 1 && j === 1) p *= 1 - RHO;
    tot += p;
    if (i > j) p1 += p; else if (i === j) px += p; else p2 += p;
    if (i + j > 2) o25 += p; if (i > 0 && j > 0) btts += p;
    if (p > best[2]) best = [i, j, p];
  }
  const r = x => Math.round((x / tot) * 1000) / 1000;
  return { p: [r(p1), r(px), r(p2)], score: [best[0], best[1]], o25: r(o25), btts: r(btts) };
}

function formOf(teamId, finished, beforeIso) {
  return finished.filter(m => (m.h.id === teamId || m.a.id === teamId) && m.t < beforeIso)
    .sort((x, y) => (x.t < y.t ? 1 : -1)).slice(0, 5)
    .map(m => { const s = m.h.id === teamId ? m.gh - m.ga : m.ga - m.gh; return s > 0 ? "V" : s < 0 ? "D" : "N"; })
    .reverse().join("");
}

// Notes attaque/défense tirées d'un classement : buts pour/contre à domicile et à l'extérieur.
export function standingsRatings(teams, priorGames = 3) {
  let jH = 0, gH = 0, jA = 0, gA = 0;
  for (const t of Object.values(teams)) { jH += t[0]; gH += t[1]; jA += t[3]; gA += t[4]; }
  const K = 12;
  const muH = (gH + K * 1.45) / (jH + K), muA = (gA + K * 1.15) / (jA + K);
  const P = priorGames * (muH + muA) / 2; // matchs « moyens » ajoutés pour éviter les extrêmes en début de saison
  const out = new Map();
  for (const [id, t] of Object.entries(teams)) {
    const [h, fh, ah, a, fa, aa] = t;
    out.set(String(id).startsWith("h") ? id : Number(id), {
      att: (fh + fa + P) / (h * muH + a * muA + P),
      def: (ah + aa + P) / (h * muA + a * muH + P),
      n: h + a,
    });
  }
  return { muH, muA, teams: out, n: jH + jA };
}

export function predictAll(days, today, standings = new Map()) {
  const all = Object.entries(days).filter(([d]) => d !== "__mapped").flatMap(([d, v]) => v.fixtures.map(f => ({ ...f, date: d })));
  const finished = all.filter(f => FINISHED.has(f.st) && f.gh != null && f.ga != null && f.date <= today);
  // un ajustement par ligue
  const byLeague = new Map();
  for (const f of finished) {
    if (!byLeague.has(f.lg.id)) byLeague.set(f.lg.id, []);
    byLeague.get(f.lg.id).push({ h: f.h.id, a: f.a.id, gh: f.gh, ga: f.ga, date: f.date });
  }
  const fits = new Map();
  for (const [id, ms] of byLeague) fits.set(id, fitLeague(ms, today));
  // ligue « principale » de chaque équipe (celle où elle a le plus joué)
  const home = new Map();
  for (const [lid, fit] of fits) for (const [tid, t] of fit.teams) {
    if (!home.has(tid) || home.get(tid).n < t.n) home.set(tid, { lid, n: t.n, t, fit });
  }
  // classement « principal » de chaque équipe (celui où elle a joué le plus de matchs)
  const teamStand = new Map();
  for (const [lid, s] of standings) for (const [tid, t] of s.teams) {
    if (!teamStand.has(tid) || teamStand.get(tid).t.n < t.n) teamStand.set(tid, { lid, t });
  }
  const out = {};
  for (const f of all.filter(f => f.date >= addDays(today, -1))) {
    const lf = fits.get(f.lg.id), ls = standings.get(f.lg.id);
    const rate = id => {
      const st = ls?.teams.get(id);
      if (st && st.n >= 3) return { ...st, same: true };
      const own = lf?.teams.get(id);
      if (own && own.n >= 2) return { ...own, same: true };
      const ts = teamStand.get(id);
      if (ts && ts.t.n >= 3) return { ...ts.t, same: false };
      const h = home.get(id);
      return h ? { ...h.t, same: false } : { att: 1, def: 1, n: 0, same: false };
    };
    const H = rate(f.h.id), A = rate(f.a.id);
    const base = ls && ls.n >= 15 ? ls : lf && lf.n >= 15 ? lf : null;
    const muH = base ? base.muH : 1.45, muA = base ? base.muA : 1.15;
    const n = Math.min(H.n, A.n);
    let conf = n >= 6 ? 3 : n >= 3 ? 2 : n >= 1 ? 1 : 0;
    if (!(H.same && A.same)) conf = Math.min(conf, 1);
    const row = {
      id: f.id, t: f.t, st: f.st, gh: f.gh, ga: f.ga,
      lg: { id: f.lg.id, name: f.lg.name, country: f.lg.country, round: f.lg.round },
      h: f.h, a: f.a, conf,
      form: { h: formOf(f.h.id, finished, f.t), a: formOf(f.a.id, finished, f.t) },
    };
    if (conf === 0) { // pas assez de données sur au moins une équipe : match affiché sans prono
      (out[f.date] ||= []).push({ ...row, p: null, score: null, xg: null, o25: null, btts: null });
      continue;
    }
    const lh = Math.min(6, Math.max(0.15, muH * H.att * A.def));
    const la = Math.min(6, Math.max(0.15, muA * A.att * H.def));
    (out[f.date] ||= []).push({ ...row, xg: [Math.round(lh * 100) / 100, Math.round(la * 100) / 100], ...matchProbs(lh, la) });
  }
  return { byDate: out, leagues: new Set([...fits.keys(), ...standings.keys()]).size, finished: finished.length };
}

async function computeAndStore({ store, today, now, ahead = AHEAD_DAYS }) {
  const days = await loadHistory(store, today);
  const standings = new Map();
  const index = new Map(); // liste des championnats qui ont un classement, pour l'onglet Classements
  const stKeys = (await store.list({ prefix: "standings/" })).blobs.map(b => b.key);
  const hlFd = new Set(((await store.get("hlstate", { type: "json" })) || {}).fdLeagues || []); // doublons de football-data
  for (const k of stKeys) {
    const s = await store.get(k, { type: "json" });
    if (!s || !Object.keys(s.teams || {}).length) continue;
    const raw = k.slice(10).split("-")[0];
    const id = raw.startsWith("h") ? raw : Number(raw);
    if (raw.startsWith("h") && hlFd.has(raw.slice(1))) continue;
    const r = standingsRatings(s.teams);
    if (!standings.has(id) || standings.get(id).n < r.n) standings.set(id, r);
    if (s.rows?.length >= 4 && (!index.has(id) || index.get(id).season < s.league.season))
      index.set(id, { key: k.slice(10), id, season: s.league.season, name: s.league.name, country: s.league.country, teams: s.rows.length });
  }
  const rank = id => { const i = TOP.indexOf(id); return i === -1 ? 999 : i; };
  await store.setJSON("leagues", { updatedAt: now.toISOString(),
    leagues: [...index.values()].sort((a, b) => rank(a.id) - rank(b.id) || a.country.localeCompare(b.country) || a.name.localeCompare(b.name)) });
  const { byDate, leagues, finished } = predictAll(days, today, standings);
  const fdCovered = new Set();
  for (const b of (await store.list({ prefix: "fd/" })).blobs) {
    const x = await store.get(b.key, { type: "json" });
    if (x?.matches?.length) fdCovered.add(x.lg.id);
  }
  const odds = [];
  for (const b of (await store.list({ prefix: "odds/" })).blobs) {
    const o = await store.get(b.key, { type: "json" });
    if (o && !o.none && o.o) odds.push({ id: Number(b.key.slice(5)), ...o });
  }
  const findOdds = m => {
    const x = odds.find(o => o.id === m.id) ||
      odds.find(o => Math.abs(new Date(o.t) - new Date(m.t)) <= 15 * 60e3 && nameSim(o.h, m.h.name) >= 0.6 && nameSim(o.a, m.a.name) >= 0.6);
    return x ? { book: x.book, o: x.o, at: x.fetchedAt } : undefined;
  };
  for (let i = -1; i <= ahead; i++) {
    const d = addDays(today, i);
    const fresh = byDate[d] || [];
    if (i <= 1 && odds.length) for (const m of fresh) { const o = findOdds(m); if (o) m.odds = o; }
    // un prono déjà publié n'est plus modifié une fois le match commencé (pour un bilan honnête)
    const old = (await store.get("pred/" + d, { type: "json" }))?.matches || [];
    const oldById = new Map(old.map(m => [m.id, m]));
    const matches = fresh.map(m => {
      const o = oldById.get(m.id);
      const started = m.st !== "NS" && m.st !== "TBD";
      if (o && started && o.p) return { ...o, st: m.st, gh: m.gh, ga: m.ga, odds: o.odds || m.odds };
      // calculé après le coup d'envoi : affiché mais exclu du bilan des pronos
      return started ? { ...m, late: true } : m;
    });
    // anciens pronos absents du nouveau calcul : gardés, sauf doublons API-Football d'une compétition désormais fournie par football-data
    for (const o of old) if (!fresh.some(m => m.id === o.id) && !(o.id < FD_MATCH && fdCovered.has(o.lg.id))) matches.push(o);
    await store.setJSON("pred/" + d, { date: d, updatedAt: now.toISOString(), matches });
  }
  return { historyDays: Object.keys(days).length - 1, leaguesModelled: leagues, finishedMatches: finished, teamsLinked: days.__mapped || 0 };
}
