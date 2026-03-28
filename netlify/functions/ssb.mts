import type { Config, Context } from "@netlify/functions";

const SSB_STAT  = "https://data.ssb.no/api/pxwebapi/v2/tables/";
const SSB_KLASS = "https://data.ssb.no/api/klass/v1/classifications/131/codesAt?date=";

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
};

async function fetchJSON(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function getPeriod(j: unknown): string {
  try {
    const dim = (j as Record<string, unknown>).dimension as Record<string, unknown>;
    const tid = (dim?.Tid ?? dim?.tid) as Record<string, unknown>;
    const lbl = (tid?.category as Record<string, unknown>)?.label as Record<string, string>;
    return Object.values(lbl ?? {}).pop() ?? "";
  } catch { return ""; }
}

// Parse aggregated region data — uses outputValues[Region]=aggregated
// Region keys look like "K-3101", "K-4205" etc — strip the "K-" prefix
function parseAggregated(raw: unknown): Record<string, number> {
  const data = raw as Record<string, unknown>;
  const dim  = data.dimension as Record<string, unknown>;
  const reg  = (dim?.Region ?? dim?.region) as Record<string, unknown>;
  const idx  = (reg?.category as Record<string, unknown>)?.index as Record<string, number>;
  const vals = Array.isArray(data.value)
    ? (data.value as (number | null)[])
    : Object.values(data.value as Record<string, number | null>);
  const out: Record<string, number> = {};
  for (const [key, i] of Object.entries(idx ?? {})) {
    const v = vals[i as number];
    if (v != null && v > 0) {
      // Strip prefix: "K-3101" → "3101", "3101" stays "3101"
      const knr = key.startsWith("K-") ? key.slice(2) : key;
      out[knr] = v;
    }
  }
  return out;
}

// Parse single-value response
function parseSingle(j: unknown): number | null {
  const data = j as Record<string, unknown>;
  if (!data?.value) return null;
  const raw = data.value as (number | null)[] | Record<string, number | null>;
  const vals: (number | null)[] = Array.isArray(raw) ? raw : Object.values(raw);
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i] != null && (vals[i] as number) >= 0) return vals[i] as number;
  }
  return null;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: HEADERS });
}

// Base URL pattern — uses agg_KommSummer to handle municipality mergers
// and vs_AlleAldre00B to sum all age groups automatically
const BASE = (table: string, extra = "") =>
  SSB_STAT + `${table}/data?lang=no&outputFormat=json-stat2` +
  `&valueCodes[ContentsCode]=*&valueCodes[Region]=*` +
  `&codelist[Region]=agg_KommSummer&outputValues[Region]=aggregated` +
  `&codelist[Alder]=vs_AlleAldre00B` +
  extra;

// ── /api/municipalities ────────────────────────────────────────────────────
async function getMunicipalities() {
  const today = new Date().toISOString().split("T")[0];
  const data  = await fetchJSON(SSB_KLASS + today + "&language=nb") as Record<string, unknown>;
  const codes = data.codes as Array<{ code: string; name: string }>;
  if (!codes?.length) throw new Error("KLASS returnerte ingen kommuner");
  const municipalities = codes
    .filter(c => /^\d{4}$/.test(c.code))
    .map(c => ({ knr: c.code, name: c.name, fylkeNr: c.code.substring(0, 2) }));
  return json({ municipalities, count: municipalities.length, date: today });
}

// ── /api/population ────────────────────────────────────────────────────────
async function getAllPopulation() {
  // Simple URL — Kjonn and Alder are eliminated automatically (both are eliminable)
  const url = SSB_STAT + "07459/data?lang=no&outputFormat=json-stat2" +
    "&valueCodes[Region]=*&valueCodes[ContentsCode]=Personer1&valueCodes[Tid]=top(1)";
  const raw  = await fetchJSON(url) as Record<string, unknown>;
  const dim  = (raw as Record<string,unknown>).dimension as Record<string,unknown>;
  const reg  = dim?.Region as Record<string,unknown>;
  const idx  = (reg?.category as Record<string,unknown>)?.index as Record<string,number>;
  const vals = Array.isArray((raw as Record<string,unknown>).value)
    ? ((raw as Record<string,unknown>).value as (number|null)[])
    : Object.values((raw as Record<string,unknown>).value as Record<string,number|null>);
  const population: Record<string,number> = {};
  for (const [knr, i] of Object.entries(idx ?? {})) {
    const v = vals[i as number];
    if (v != null && v > 0 && /^\d{4}$/.test(knr)) population[knr] = v;
  }
  const tidL = ((dim?.Tid as Record<string,unknown>)?.category as Record<string,unknown>)?.label as Record<string,string>;
  const period = Object.values(tidL ?? {}).pop() ?? "";
  return json({ population, period, count: Object.keys(population).length });
}

// ── /api/national ──────────────────────────────────────────────────────────
async function getNational() {
  const url = SSB_STAT + "07459/data?lang=no&outputFormat=json-stat2" +
    "&valueCodes[Region]=0&valueCodes[ContentsCode]=Personer1&valueCodes[Tid]=top(1)";
  const raw = await fetchJSON(url);
  return json({ value: parseSingle(raw), period: getPeriod(raw) });
}

// ── /api/gender ────────────────────────────────────────────────────────────
// Kjonn="2"=Kvinner, Kjonn="1"=Menn, siste år
async function getAllGender() {
  const [wRaw, mRaw] = await Promise.all([
    fetchJSON(BASE("07459", "&valueCodes[Tid]=top(1)&valueCodes[Kjonn]=2")),
    fetchJSON(BASE("07459", "&valueCodes[Tid]=top(1)&valueCodes[Kjonn]=1")),
  ]);
  const women = parseAggregated(wRaw);
  const men   = parseAggregated(mRaw);
  return json({ women, men, period: getPeriod(wRaw), count: Object.keys(women).length });
}

// ── /api/education ─────────────────────────────────────────────────────────
// SSB 09429: Nivaa="03a" (kort høyere) + "04a" (lang høyere), PersonerProsent
async function getAllEducation() {
  const b = (nivaa: string) =>
    SSB_STAT + `09429/data?lang=no&outputFormat=json-stat2` +
    `&valueCodes[Region]=*&valueCodes[Kjonn]=0` +
    `&valueCodes[Nivaa]=${nivaa}&valueCodes[ContentsCode]=PersonerProsent` +
    `&valueCodes[Tid]=top(1)`;

  const [shortRaw, longRaw] = await Promise.all([fetchJSON(b("03a")), fetchJSON(b("04a"))]);
  const short  = parseAggregated(shortRaw);
  const long_  = parseAggregated(longRaw);

  // Also try standard region parse if aggregated returns nothing
  const shortFallback = parseRegionStandard(shortRaw);
  const longFallback  = parseRegionStandard(longRaw);

  const s = Object.keys(short).length > 0 ? short : shortFallback;
  const l = Object.keys(long_).length > 0 ? long_ : longFallback;

  const education: Record<string, number> = {};
  for (const knr of new Set([...Object.keys(s), ...Object.keys(l)])) {
    const v = (s[knr] ?? 0) + (l[knr] ?? 0);
    if (v > 0) education[knr] = Math.round(v * 10) / 10;
  }
  return json({ education, period: getPeriod(shortRaw), count: Object.keys(education).length });
}

function parseRegionStandard(raw: unknown): Record<string, number> {
  const data = raw as Record<string, unknown>;
  const dim  = data.dimension as Record<string, unknown>;
  const reg  = (dim?.Region ?? dim?.region) as Record<string, unknown>;
  const idx  = (reg?.category as Record<string, unknown>)?.index as Record<string, number>;
  const vals = Array.isArray(data.value)
    ? (data.value as (number | null)[])
    : Object.values(data.value as Record<string, number | null>);
  const out: Record<string, number> = {};
  for (const [knr, i] of Object.entries(idx ?? {})) {
    const v = vals[i as number];
    if (v != null && v > 0 && /^\d{4}$/.test(knr)) out[knr] = v;
  }
  return out;
}

// ── /api/kommune ───────────────────────────────────────────────────────────
async function getKommune(knr: string) {
  const b07 = SSB_STAT + `07459/data?lang=no&outputFormat=json-stat2` +
    `&valueCodes[Region]=${knr}&valueCodes[ContentsCode]=Personer1&valueCodes[Tid]=top(1)`;
  const b09 = SSB_STAT + `09429/data?lang=no&outputFormat=json-stat2` +
    `&valueCodes[Region]=${knr}&valueCodes[Kjonn]=0&valueCodes[ContentsCode]=PersonerProsent&valueCodes[Tid]=top(1)`;

  const [popR, wR, mR, esR, elR] = await Promise.allSettled([
    fetchJSON(b07),
    fetchJSON(b07 + "&valueCodes[Kjonn]=2"),
    fetchJSON(b07 + "&valueCodes[Kjonn]=1"),
    fetchJSON(b09 + "&valueCodes[Nivaa]=03a"),
    fetchJSON(b09 + "&valueCodes[Nivaa]=04a"),
  ]);

  const pop   = popR.status === "fulfilled" ? parseSingle(popR.value) : null;
  const women = wR.status   === "fulfilled" ? parseSingle(wR.value)   : null;
  const men   = mR.status   === "fulfilled" ? parseSingle(mR.value)   : null;
  const es    = esR.status  === "fulfilled" ? (parseSingle(esR.value) ?? 0) : 0;
  const el    = elR.status  === "fulfilled" ? (parseSingle(elR.value) ?? 0) : 0;
  const edu   = es + el > 0 ? Math.round((es + el) * 10) / 10 : null;

  return json({
    knr, population: pop, women, men, education: edu,
    womenPct: (pop && women) ? Math.round(women / pop * 1000) / 10 : null,
    menPct:   (pop && men)   ? Math.round(men   / pop * 1000) / 10 : null,
    period_pop: popR.status === "fulfilled" ? getPeriod(popR.value) : "",
    period_edu: esR.status  === "fulfilled" ? getPeriod(esR.value)  : "",
  });
}


// ── /api/trend ─────────────────────────────────────────────────────────────
// Real population history for one kommune — last 15 years from SSB 07459
async function getTrend(knr: string) {
  const url = SSB_STAT + `07459/data?lang=no&outputFormat=json-stat2` +
    `&valueCodes[Region]=${knr}&valueCodes[ContentsCode]=Personer1` +
    `&valueCodes[Tid]=from(2010)`;
  const raw  = await fetchJSON(url) as Record<string, unknown>;
  const dim  = raw.dimension as Record<string, unknown>;
  const tidD = dim?.Tid as Record<string, unknown>;
  const tidC = tidD?.category as Record<string, unknown>;
  const tidIdx = tidC?.index as Record<string, number>;
  const tidLbl = tidC?.label as Record<string, string>;
  const vals = Array.isArray(raw.value)
    ? (raw.value as (number | null)[])
    : Object.values(raw.value as Record<string, number | null>);
  const years: string[] = [];
  const values: number[] = [];
  for (const [yr, i] of Object.entries(tidIdx ?? {})) {
    const v = vals[i as number];
    if (v != null && v > 0) { years.push(yr); values.push(v); }
  }
  return json({ knr, years, values });
}

// ── router ─────────────────────────────────────────────────────────────────
export default async (req: Request, _ctx: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  const { pathname, searchParams } = new URL(req.url);
  try {
    if (pathname === "/api/municipalities") return await getMunicipalities();
    if (pathname === "/api/population")     return await getAllPopulation();
    if (pathname === "/api/national")       return await getNational();
    if (pathname === "/api/gender")         return await getAllGender();
    if (pathname === "/api/education")      return await getAllEducation();
    if (pathname === "/api/trend") {
      const knr = searchParams.get("knr");
      if (!knr) return json({ error: "mangler ?knr=" }, 400);
      return await getTrend(knr);
    }
    if (pathname === "/api/kommune") {
      const knr = searchParams.get("knr");
      if (!knr) return json({ error: "mangler ?knr=" }, 400);
      return await getKommune(knr);
    }
    return json({ error: `ukjent endepunkt: ${pathname}` }, 404);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[SSB]", pathname, msg);
    return json({ error: msg }, 502);
  }
};

export const config: Config = {
  path: ["/api/municipalities","/api/population","/api/national","/api/gender","/api/education","/api/trend","/api/kommune"],
};
