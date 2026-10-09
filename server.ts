// Bookbar – én MCP-forbindelse til ledige tider og booking hos uafhængige saloner.
// Version 0.3: saloner ligger i databasen, robotten opretter og deler en kalender med hver salon,
// og ledige tider regnes ud fra åbningstider, behandlingens varighed og pause mellem kunder.
//
// Kalenderregler (salonens delte Google-kalender):
//   - Alt, der står i kalenderen i åbningstiden, er optaget (undtagen aftaler markeret "Ledig" eller "fri").
//   - Heldagsaftale med titlen "Lukket" lukker dagen.
//   - Bookinger skrives ind som "Booket: <behandling> – <navn> (<kode>)".
// Uden Google-nøgle bruges en indbygget testkalender, så alt kan prøves lokalt.
//
// Miljøvariabler:
//   GOOGLE_SA_KEY   hele JSON-nøglen for robotkontoen (service account)
//   CAL_LYNGBLOMST  kalender-id for testsalonen Lyngblomst (valgfri)
//   CAL_KASTANJE    kalender-id for testsalonen Kastanje (valgfri)
//   ADMIN_TOKEN     adgangskode til /admin (opret og ret saloner). Uden den er /admin lukket.
//   BRAND           navnet udadtil. Standard "Bookbar (test)".
//
// Endepunkter:
//   POST /mcp                  MCP (Streamable HTTP, stateless JSON)
//   GET  /                     oversigt over saloner
//   GET  /s/<id>               salonside med ledige tider og bookingformular
//   POST /s/<id>/book          bookingformular
//   GET  /booking/<token>      se eller aflys en booking
//   GET  /llms.txt             ledige tider som ren tekst
//   GET  /status               forbindelser og kalendere
//   GET|POST|PUT /admin/saloner[/<id>]   administration (kræver ADMIN_TOKEN)

const TZ = "Europe/Copenhagen";
const VERSION = "0.3.0";
const env = (k: string) => Deno.env.get(k) ?? "";
const BRAND = env("BRAND") || "Bookbar (test)";

// ---------- Datamodel ----------
const KATEGORIER = ["negle", "vipper", "bryn", "hud", "andet"] as const;
type Kategori = typeof KATEGORIER[number];
const SLAGS = ["nyt", "opfyldning", "fjernelse", "enkelt", "andet"] as const;
type Slags = typeof SLAGS[number];
type Behandling = {
  id: string; navn: string; kategori: Kategori; slags?: Slags; materiale?: string;
  pris: number; minutter: number; beskrivelse?: string;
};
type Aabning = Record<string, [string, string][]>; // "0" = mandag … "6" = søndag -> [["10:00","18:00"]]
type Salon = {
  id: string; navn: string; omraade: string; adresse: string; beskrivelse: string;
  kodePrefix: string; email?: string; kalenderId?: string; kalenderEnv?: string;
  aabning: Aabning; pauseMin: number; intervalMin: number; varselMin: number;
  behandlinger: Behandling[]; test: boolean; aktiv: boolean; oprettet: string;
};

const TESTSALONER: Salon[] = [
  {
    id: "lyngblomst", navn: "Neglestudie Lyngblomst", omraade: "Brøndby (2605)", kodePrefix: "LB",
    adresse: "Hjemmeklinik i Brøndby – præcis adresse sendes af artisten",
    beskrivelse: "Hjemmeklinik med negle og vipper. Kan lave negle og vipper i samme besøg. Åbent hverdagsaftener og lørdag.",
    kalenderEnv: "CAL_LYNGBLOMST",
    aabning: { "0": [["17:00", "21:00"]], "1": [["17:00", "21:00"]], "2": [["17:00", "21:00"]], "3": [["16:00", "21:00"]], "4": [["15:00", "20:00"]], "5": [["10:00", "15:00"]] },
    pauseMin: 0, intervalMin: 30, varselMin: 0,
    behandlinger: [
      { id: "gellak", navn: "Gellak på egne negle", kategori: "negle", slags: "enkelt", materiale: "gellak", pris: 350, minutter: 60 },
      { id: "nyt-saet", navn: "Nyt sæt gelénegle – French", kategori: "negle", slags: "nyt", materiale: "gelé", pris: 450, minutter: 90 },
      { id: "opfyldning", navn: "Opfyldning af gelénegle", kategori: "negle", slags: "opfyldning", materiale: "gelé", pris: 380, minutter: 75 },
      { id: "vippeloeft", navn: "Vippeløft med farve", kategori: "vipper", slags: "enkelt", pris: 400, minutter: 60 },
      { id: "gellak-vippeloeft", navn: "Gellak + vippeløft i ét besøg", kategori: "negle", slags: "andet", pris: 700, minutter: 120, beskrivelse: "Kombination: gellak og vippeløft samme besøg." },
    ],
    test: true, aktiv: true, oprettet: "2026-10-09",
  },
  {
    id: "kastanje", navn: "Neglebaren Kastanje", omraade: "Hvidovre (2650)", kodePrefix: "NK",
    adresse: "Neglebaren Kastanje, Hvidovre – præcis adresse sendes ved booking",
    beskrivelse: "Lille neglesalon med fokus på hurtige, holdbare negle. Laver kun negle, ikke vipper. Åbent i dagtimerne på hverdage.",
    kalenderEnv: "CAL_KASTANJE",
    aabning: { "0": [["09:00", "16:00"]], "1": [["09:00", "16:00"]], "2": [["09:00", "13:00"]], "3": [["10:00", "18:00"]], "4": [["09:00", "15:00"]] },
    pauseMin: 0, intervalMin: 30, varselMin: 0,
    behandlinger: [
      { id: "gellak", navn: "Gellak på egne negle", kategori: "negle", slags: "enkelt", materiale: "gellak", pris: 299, minutter: 45 },
      { id: "nyt-saet", navn: "Nyt sæt gelénegle", kategori: "negle", slags: "nyt", materiale: "gelé", pris: 420, minutter: 90 },
      { id: "opfyldning", navn: "Opfyldning af gelénegle", kategori: "negle", slags: "opfyldning", materiale: "gelé", pris: 349, minutter: 60 },
      { id: "manicure", navn: "Klassisk manicure uden lak", kategori: "negle", slags: "enkelt", pris: 249, minutter: 40 },
    ],
    test: true, aktiv: true, oprettet: "2026-10-09",
  },
];

const UGEDAGE = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];
const MAANEDER = ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august",
  "september", "oktober", "november", "december"];

// ---------- Tid ----------
function tzOffsetMin(utcMs: number): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(new Date(utcMs)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = s.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}
function lokalMs(dato: string, tid: string): number {
  const [y, mo, d] = dato.split("-").map(Number);
  const [h, mi] = tid.split(":").map(Number);
  const gaet = Date.UTC(y, mo - 1, d, h, mi);
  let ms = gaet - tzOffsetMin(gaet) * 60000;
  ms = gaet - tzOffsetMin(ms) * 60000;
  return ms;
}
function iKbh(ms: number): { dato: string; tid: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const hh = p.hour === "24" ? "00" : p.hour;
  return { dato: `${p.year}-${p.month}-${p.day}`, tid: `${hh}:${p.minute}` };
}
const nuIKbh = () => iKbh(Date.now());
function plusDage(dato: string, n: number): string {
  const d = new Date(dato + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const ugedag = (dato: string) => (new Date(dato + "T12:00:00Z").getUTCDay() + 6) % 7;
function danskDato(dato: string): string {
  const d = new Date(dato + "T12:00:00Z");
  return `${UGEDAGE[ugedag(dato)]} ${d.getUTCDate()}. ${MAANEDER[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const datoOk = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + "T12:00:00Z"));
const tidOk = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
function normTid(t: unknown): string {
  const s = String(t ?? "").trim().replace(".", ":");
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?$/);
  return m ? `${m[1].padStart(2, "0")}:${m[2] ?? "00"}` : s;
}
const slug = (s: string) => s.toLowerCase().replaceAll("æ", "ae").replaceAll("ø", "oe").replaceAll("å", "aa")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

// ---------- Lager (Deno KV, ellers hukommelse) ----------
let kv: Deno.Kv | null = null;
try { kv = await Deno.openKv(); } catch { kv = null; }
const mem = new Map<string, unknown>();
const memKey = (k: unknown[]) => JSON.stringify(k);
async function kget<T>(k: unknown[]): Promise<T | null> {
  if (kv) return (await kv.get<T>(k as Deno.KvKey)).value;
  return (mem.get(memKey(k)) as T) ?? null;
}
async function kset(k: unknown[], v: unknown): Promise<void> {
  if (kv) await kv.set(k as Deno.KvKey, v);
  else mem.set(memKey(k), v);
}
async function kdel(k: unknown[]): Promise<void> {
  if (kv) await kv.delete(k as Deno.KvKey);
  else mem.delete(memKey(k));
}
async function klist<T>(prefix: unknown[]): Promise<T[]> {
  if (kv) {
    const ud: T[] = [];
    for await (const e of kv.list<T>({ prefix: prefix as Deno.KvKey })) ud.push(e.value);
    return ud;
  }
  const p = memKey(prefix).slice(0, -1);
  return [...mem.entries()].filter(([k]) => k.startsWith(p + ",") || k === p + "]").map(([, v]) => v as T);
}

// Saloner
async function alleSaloner(medInaktive = false): Promise<Salon[]> {
  const l = await klist<Salon>(["salon"]);
  return l.filter((s) => medInaktive || s.aktiv).sort((a, b) => Number(a.test) - Number(b.test) || a.navn.localeCompare(b.navn, "da"));
}
async function hentSalon(id: unknown): Promise<Salon | null> {
  const s = await kget<Salon>(["salon", String(id ?? "").toLowerCase().trim()]);
  return s && s.aktiv ? s : null;
}
const gemSalon = (s: Salon) => kset(["salon", s.id], s);
for (const t of TESTSALONER) if (!(await kget<Salon>(["salon", t.id]))) await gemSalon(t);

// Bookinger
type Booking = {
  kode: string; token: string; salon: string; dato: string; tid: string; minutter: number;
  behandling: string; navn: string; telefon?: string; kilde: "ai" | "formular"; oprettet: string; eventId?: string;
};
async function gemBooking(b: Booking) {
  await kset(["booking", b.kode], b);
  await kset(["token", b.token], b.kode);
}
const findKode = (kode: string) => kget<Booking>(["booking", kode]);
async function findToken(token: string): Promise<Booking | null> {
  if (!/^[a-f0-9]{24}$/.test(token)) return null;
  const k = await kget<string>(["token", token]);
  return k ? await findKode(k) : null;
}
async function sletBooking(b: Booking) {
  await kdel(["booking", b.kode]);
  await kdel(["token", b.token]);
}

// ---------- Google Kalender (robotkonto, JWT RS256) ----------
type SaKey = { client_email: string; private_key: string; token_uri?: string };
let saKey: SaKey | null = null;
try { if (env("GOOGLE_SA_KEY")) saKey = JSON.parse(env("GOOGLE_SA_KEY")); } catch { saKey = null; }

const b64url = (data: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data)
    : data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
let tokenCache: { token: string; udloeber: number } | null = null;
async function googleToken(): Promise<string> {
  if (!saKey) throw new Error("Google er ikke sat op");
  if (tokenCache && tokenCache.udloeber > Date.now() + 60000) return tokenCache.token;
  const pem = saKey.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const nu = Math.floor(Date.now() / 1000);
  const tokenUri = saKey.token_uri ?? "https://oauth2.googleapis.com/token";
  const usigneret = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64url(JSON.stringify({
    iss: saKey.client_email, scope: "https://www.googleapis.com/auth/calendar",
    aud: tokenUri, iat: nu, exp: nu + 3600,
  }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(usigneret));
  const res = await fetch(tokenUri, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: usigneret + "." + b64url(sig) }),
  });
  const j = await res.json();
  if (!res.ok || !j.access_token) throw new Error("Google-login fejlede: " + (j.error_description ?? j.error ?? res.status));
  tokenCache = { token: j.access_token, udloeber: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return j.access_token;
}
async function gcal(path: string, init: RequestInit = {}): Promise<Response> {
  const t = await googleToken();
  return fetch("https://www.googleapis.com/calendar/v3" + path, {
    ...init, headers: { authorization: "Bearer " + t, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

// ---------- Kalender-lag: Google eller indbygget testkalender ----------
type Ev = { id: string; titel: string; start: number; slut: number; heldag?: [string, string]; fri?: boolean };
const kalenderFor = (s: Salon): string | null => s.kalenderId || (s.kalenderEnv ? env(s.kalenderEnv) || null : null);
const brugerGoogle = (s: Salon) => !!saKey && !!kalenderFor(s) && !kalenderFor(s)!.startsWith("intern:");

async function hentEvents(s: Salon, fra: number, til: number): Promise<Ev[]> {
  if (brugerGoogle(s)) {
    const cal = kalenderFor(s)!;
    const q = new URLSearchParams({ timeMin: new Date(fra).toISOString(), timeMax: new Date(til).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
    const res = await gcal(`/calendars/${encodeURIComponent(cal)}/events?${q}`);
    if (!res.ok) throw new Error(`Kunne ikke læse salonens kalender (${res.status}).`);
    const j = await res.json();
    const ud: Ev[] = [];
    for (const e of j.items ?? []) {
      if (e.status === "cancelled") continue;
      const titel = e.summary ?? "";
      if (e.start?.date) {
        ud.push({ id: e.id, titel, start: lokalMs(e.start.date, "00:00"), slut: lokalMs(e.end?.date ?? plusDage(e.start.date, 1), "00:00"), heldag: [e.start.date, e.end?.date ?? plusDage(e.start.date, 1)] });
      } else if (e.start?.dateTime && e.end?.dateTime) {
        ud.push({ id: e.id, titel, start: Date.parse(e.start.dateTime), slut: Date.parse(e.end.dateTime), fri: e.transparency === "transparent" });
      }
    }
    return ud;
  }
  const alle = await klist<Ev>(["ev", s.id]);
  return alle.filter((e) => e.start < til && e.slut > fra);
}
async function skrivEvent(s: Salon, titel: string, beskrivelse: string, start: number, slut: number): Promise<string> {
  if (brugerGoogle(s)) {
    const res = await gcal(`/calendars/${encodeURIComponent(kalenderFor(s)!)}/events`, {
      method: "POST",
      body: JSON.stringify({ summary: titel, description: beskrivelse, colorId: "10",
        start: { dateTime: new Date(start).toISOString(), timeZone: TZ }, end: { dateTime: new Date(slut).toISOString(), timeZone: TZ } }),
    });
    if (!res.ok) throw new Error(`Kunne ikke skrive i salonens kalender (${res.status}).`);
    return (await res.json()).id;
  }
  const id = crypto.randomUUID();
  await kset(["ev", s.id, id], { id, titel, start, slut } as Ev);
  return id;
}
async function sletEvent(s: Salon, id: string): Promise<void> {
  if (brugerGoogle(s)) await gcal(`/calendars/${encodeURIComponent(kalenderFor(s)!)}/events/${encodeURIComponent(id)}`, { method: "DELETE" });
  else await kdel(["ev", s.id, id]);
}
// Opretter en ny kalender hos robotten og deler den med salonens mail med ret til at ændre.
async function opretOgDelKalender(navn: string, email: string): Promise<{ kalenderId: string; delt: string }> {
  if (!saKey) return { kalenderId: "intern:" + crypto.randomUUID(), delt: "testtilstand – ingen Google-nøgle, kalenderen er intern" };
  const res = await gcal("/calendars", { method: "POST", body: JSON.stringify({ summary: `${navn} – bookinger`, timeZone: TZ }) });
  if (!res.ok) throw new Error(`Kunne ikke oprette kalender (${res.status}): ${await res.text()}`);
  const kalenderId = (await res.json()).id as string;
  if (!email) return { kalenderId, delt: "ikke delt – ingen mail angivet" };
  const acl = await gcal(`/calendars/${encodeURIComponent(kalenderId)}/acl?sendNotifications=true`, {
    method: "POST", body: JSON.stringify({ role: "writer", scope: { type: "user", value: email } }),
  });
  return { kalenderId, delt: acl.ok ? `delt med ${email} (kan se og ændre)` : `FEJL ved deling (${acl.status}): ${await acl.text()}` };
}

// ---------- Ledighed ----------
type Interval = [number, number];
type Dag = { aabne: Interval[]; optaget: Interval[] };
const erFri = (titel: string) => /^\s*(ledig|fri)\b/i.test(titel);
const erLukket = (titel: string) => /^\s*lukket/i.test(titel);

async function dage(s: Salon, fra: string, antal: number): Promise<Map<string, Dag>> {
  const ud = new Map<string, Dag>();
  for (let i = 0; i < antal; i++) {
    const d = plusDage(fra, i);
    ud.set(d, { aabne: (s.aabning[String(ugedag(d))] ?? []).map(([a, b]) => [lokalMs(d, a), lokalMs(d, b)] as Interval), optaget: [] });
  }
  for (const e of await hentEvents(s, lokalMs(fra, "00:00"), lokalMs(plusDage(fra, antal), "00:00"))) {
    if (e.heldag) {
      if (!erLukket(e.titel)) continue;
      for (let d = e.heldag[0]; d < e.heldag[1]; d = plusDage(d, 1)) ud.get(d)?.aabne.splice(0);
      continue;
    }
    if (e.fri || erFri(e.titel)) continue;
    for (const [d, dag] of ud) if (e.start < lokalMs(plusDage(d, 1), "00:00") && e.slut > lokalMs(d, "00:00")) dag.optaget.push([e.start, e.slut]);
  }
  return ud;
}
// Starttider, hvor behandlingen kan ligge i åbningstiden uden at ramme andre aftaler,
// med salonens pause før og efter andre aftaler.
function startTider(s: Salon, dag: Dag, minutter: number, nu = Date.now()): number[] {
  const step = Math.max(5, s.intervalMin) * 60000, varighed = minutter * 60000, pause = s.pauseMin * 60000;
  const tidligst = nu + s.varselMin * 60000;
  const ud: number[] = [];
  for (const [a, b] of dag.aabne) {
    for (let t = Math.ceil(a / step) * step; t + varighed <= b; t += step) {
      if (t <= tidligst) continue;
      if (dag.optaget.some(([x, y]) => t < y + pause && t + varighed + pause > x)) continue;
      ud.push(t);
    }
  }
  return [...new Set(ud)].sort((x, y) => x - y);
}
const korteste = (s: Salon) => Math.min(...s.behandlinger.map((b) => b.minutter));

// ---------- Booking ----------
type Resultat = { ok: true; b: Booking } | { ok: false; fejl: string };
const laase = new Set<string>();
async function opretBooking(s: Salon, beh: Behandling, dato: string, tid: string, navn: string, telefon: string | undefined, kilde: Booking["kilde"]): Promise<Resultat> {
  const start = lokalMs(dato, tid);
  if (laase.has(s.id)) return { ok: false, fejl: "Der bookes lige nu hos salonen. Prøv igen om et øjeblik." };
  laase.add(s.id);
  try {
    const mulige = startTider(s, (await dage(s, dato, 1)).get(dato)!, beh.minutter);
    if (!mulige.includes(start)) {
      const alt = mulige.map((m) => iKbh(m).tid).join(", ") || "ingen";
      return { ok: false, fejl: `Kl. ${tid} ${danskDato(dato)} er ikke ledig hos ${s.navn} til ${beh.navn} (${beh.minutter} min). Ledige starttider den dag: ${alt}.` };
    }
    const kode = s.kodePrefix + "-" + crypto.randomUUID().replaceAll("-", "").slice(0, 4).toUpperCase();
    const b: Booking = { kode, token: crypto.randomUUID().replaceAll("-", "").slice(0, 24), salon: s.id, dato, tid,
      minutter: beh.minutter, behandling: beh.id, navn, telefon, kilde, oprettet: new Date().toISOString() };
    const nu = iKbh(Date.now());
    b.eventId = await skrivEvent(s, `Booket: ${beh.navn} – ${navn} (${kode})`,
      `Booket ${kilde === "ai" ? "via AI-assistent" : "via bookingsiden"} gennem ${BRAND}.\nKunde: ${navn}${telefon ? `\nTelefon: ${telefon}` : ""}\n` +
      `Behandling: ${beh.navn}, ${beh.pris} kr, ${beh.minutter} min\nBookingkode: ${kode}\nOprettet: ${nu.dato} kl. ${nu.tid}`,
      start, start + beh.minutter * 60000);
    // Dobbeltbookingskontrol efter skrivning.
    const efter = await hentEvents(s, start - s.pauseMin * 60000, start + (beh.minutter + s.pauseMin) * 60000);
    if (efter.some((e) => e.id !== b.eventId && !e.heldag && !e.fri && !erFri(e.titel))) {
      await sletEvent(s, b.eventId);
      return { ok: false, fejl: "Tiden blev taget lige før. Vælg en anden tid." };
    }
    await gemBooking(b);
    return { ok: true, b };
  } finally { laase.delete(s.id); }
}
async function aflys(b: Booking): Promise<void> {
  const s = await kget<Salon>(["salon", b.salon]);
  if (s && b.eventId) await sletEvent(s, b.eventId);
  await sletBooking(b);
}

// ---------- Værktøjer (rene beskrivelser – ingen instrukser til assistenten) ----------
async function vaerktoejer() {
  const ids = (await alleSaloner()).map((s) => s.id);
  return [
    {
      name: "find_saloner", title: "Find saloner",
      description: `Viser de saloner, der kan bookes gennem ${BRAND}: område, kategorier (negle, vipper, bryn m.fl.), beskrivelse, prisniveau og åbningstider. Kan filtreres på kategori og område.`,
      inputSchema: { type: "object", properties: {
        kategori: { type: "string", enum: [...KATEGORIER], description: "Vis kun saloner med behandlinger i denne kategori." },
        omraade: { type: "string", description: "Bynavn eller postnummer, fx Brøndby eller 2650." },
      }, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "vis_behandlinger", title: "Vis behandlinger og priser",
      description: "Viser behandlinger med kategori, pris, varighed og salonens egen beskrivelse. Uden salon vises alle saloner.",
      inputSchema: { type: "object", properties: {
        salon: { type: "string", enum: ids, description: "Salonens id fra find_saloner." },
        kategori: { type: "string", enum: [...KATEGORIER] },
      }, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "vis_ledige_tider", title: "Vis ledige tider",
      description: "Viser ledige starttider i 1–14 dage, grupperet efter salon. Med en behandling vises kun tider, hvor hele behandlingen kan nås. Uden salon vises alle saloner.",
      inputSchema: { type: "object", properties: {
        salon: { type: "string", enum: ids, description: "Salonens id. Udelades for alle saloner." },
        behandling: { type: "string", description: "Behandlingens id fra vis_behandlinger." },
        fra_dato: { type: "string", description: "Første dato, ÅÅÅÅ-MM-DD. Standard: i dag." },
        antal_dage: { type: "integer", minimum: 1, maximum: 14, description: "Antal dage. Standard 1." },
      }, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "book_tid", title: "Book en tid",
      description: "Opretter en booking hos en salon og skriver den i salonens kalender. Returnerer en bookingkode og et link, hvor kunden kan se og aflyse bookingen. Betaling sker hos salonen.",
      inputSchema: { type: "object", properties: {
        salon: { type: "string", enum: ids }, behandling: { type: "string", description: "Behandlingens id fra vis_behandlinger." },
        dato: { type: "string", description: "ÅÅÅÅ-MM-DD" }, tidspunkt: { type: "string", description: "Starttid TT:MM" },
        navn: { type: "string", description: "Kundens navn" }, telefon: { type: "string", description: "Kundens telefonnummer (valgfrit)" },
      }, required: ["salon", "behandling", "dato", "tidspunkt", "navn"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "aflys_booking", title: "Aflys en booking",
      description: "Aflyser en booking ud fra bookingkoden. Aftalen fjernes fra salonens kalender, og tiden bliver ledig.",
      inputSchema: { type: "object", properties: { bookingkode: { type: "string", description: "Koden fra book_tid, fx LB-4K7Q" } },
        required: ["bookingkode"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
  ];
}

const tekst = (t: string, fejl = false) => ({ content: [{ type: "text", text: t }], isError: fejl });
const testMaerke = (s: Salon) => (s.test ? " [TESTSALON – opdigtet]" : "");
const kategorierAf = (s: Salon) => [...new Set(s.behandlinger.map((b) => b.kategori))];
const prisSpand = (s: Salon) => { const p = s.behandlinger.map((b) => b.pris); return `${Math.min(...p)}–${Math.max(...p)} kr`; };
const aabningTekst = (s: Salon) => Object.entries(s.aabning).filter(([, v]) => v.length)
  .map(([d, v]) => `${UGEDAGE[Number(d)].slice(0, 3)} ${v.map(([a, b]) => `${a}–${b}`).join(", ")}`).join("; ") || "ingen faste åbningstider";
const behLinje = (b: Behandling) => `- ${b.navn} (id: ${b.id}) · ${b.kategori}${b.slags && b.slags !== "andet" ? ", " + b.slags : ""}${b.materiale ? ", " + b.materiale : ""} · ${b.pris} kr · ${b.minutter} min${b.beskrivelse ? ` · ${b.beskrivelse}` : ""}`;

async function kald(navn: string, a: Record<string, unknown>) {
  const saloner = await alleSaloner();
  const ids = saloner.map((s) => s.id).join(", ");
  if (navn === "find_saloner") {
    const kat = a.kategori ? String(a.kategori) : null;
    const omr = a.omraade ? String(a.omraade).toLowerCase() : null;
    const liste = saloner.filter((s) => (!kat || s.behandlinger.some((b) => b.kategori === kat)) && (!omr || s.omraade.toLowerCase().includes(omr)));
    if (!liste.length) return tekst(`Ingen saloner fundet${kat ? ` med ${kat}` : ""}${omr ? ` i ${a.omraade}` : ""}.`);
    return tekst(liste.map((s) => `- ${s.navn} (id: ${s.id})${testMaerke(s)} – ${s.omraade}. Kategorier: ${kategorierAf(s).join(", ")}. ${s.beskrivelse} Priser: ${prisSpand(s)}. Åbent: ${aabningTekst(s)}.`).join("\n"));
  }
  if (navn === "vis_behandlinger") {
    const valgt = a.salon ? saloner.find((s) => s.id === a.salon) : null;
    if (a.salon && !valgt) return tekst(`Ukendt salon. Gyldige: ${ids}.`, true);
    const kat = a.kategori ? String(a.kategori) : null;
    return tekst((valgt ? [valgt] : saloner).map((s) => {
      const bh = s.behandlinger.filter((b) => !kat || b.kategori === kat);
      return `${s.navn} (id: ${s.id})${testMaerke(s)} – ${s.omraade}\n${bh.length ? bh.map(behLinje).join("\n") : "- ingen behandlinger i kategorien"}`;
    }).join("\n\n") + "\nBetaling sker hos salonen.");
  }
  if (navn === "vis_ledige_tider") {
    const nu = nuIKbh();
    const fra = typeof a.fra_dato === "string" && a.fra_dato ? a.fra_dato : nu.dato;
    if (!datoOk(fra)) return tekst("Ugyldig dato. Brug ÅÅÅÅ-MM-DD.", true);
    const n = Math.min(14, Math.max(1, Number(a.antal_dage ?? 1) || 1));
    const valgt = a.salon ? saloner.find((s) => s.id === a.salon) : null;
    if (a.salon && !valgt) return tekst(`Ukendt salon. Gyldige: ${ids}.`, true);
    const behId = a.behandling ? String(a.behandling) : null;
    const afsnit: string[] = [];
    for (const s of valgt ? [valgt] : saloner) {
      const beh = behId ? s.behandlinger.find((b) => b.id === behId) : null;
      if (behId && !beh) { if (valgt) afsnit.push(`${s.navn}: har ikke behandlingen "${behId}".`); continue; }
      const min = beh ? beh.minutter : korteste(s);
      const linjer: string[] = [];
      for (const [d, dag] of await dage(s, fra, n)) {
        const t = startTider(s, dag, min).map((m) => iKbh(m).tid);
        linjer.push(`  - ${danskDato(d)} (${d})${d === nu.dato ? ", i dag" : ""}: ${t.length ? t.join(", ") : "ingen ledige tider"}`);
      }
      afsnit.push(`${s.navn} (id: ${s.id}, ${s.omraade})${testMaerke(s)} – ${beh ? `${beh.navn}, ${beh.minutter} min, ${beh.pris} kr` : `korteste behandling, ${min} min`}:\n${linjer.join("\n")}`);
    }
    if (!afsnit.length) return tekst(`Ingen saloner har behandlingen "${behId}".`, true);
    return tekst(`Ledige starttider (klokken i København er ${nu.tid}):\n${afsnit.join("\n\n")}`);
  }
  if (navn === "book_tid") {
    const s = saloner.find((x) => x.id === a.salon);
    if (!s) return tekst(`Ukendt salon. Gyldige: ${ids}.`, true);
    const beh = s.behandlinger.find((x) => x.id === a.behandling);
    if (!beh) return tekst(`${s.navn} har ikke behandlingen "${a.behandling}". Gyldige: ${s.behandlinger.map((x) => x.id).join(", ")}.`, true);
    const dato = String(a.dato ?? ""), tid = normTid(a.tidspunkt), kunde = String(a.navn ?? "").trim().slice(0, 60);
    if (!datoOk(dato)) return tekst("Ugyldig dato. Brug ÅÅÅÅ-MM-DD.", true);
    if (!tidOk(tid)) return tekst("Ugyldigt tidspunkt. Brug TT:MM.", true);
    if (!kunde) return tekst("Kundens navn mangler.", true);
    const tlf = typeof a.telefon === "string" && a.telefon.trim() ? a.telefon.trim().slice(0, 20) : undefined;
    const r = await opretBooking(s, beh, dato, tid, kunde, tlf, "ai");
    if (!r.ok) return tekst(r.fejl, true);
    return tekst(`Booket: ${beh.navn} hos ${s.navn} (${s.omraade})${testMaerke(s)}, ${danskDato(dato)} kl. ${tid}–${iKbh(lokalMs(dato, tid) + beh.minutter * 60000).tid}. ` +
      `Pris ${beh.pris} kr, betales i salonen.\nKunde: ${kunde}. Bookingkode: ${r.b.kode}.\nSe eller aflys: ${ORIGIN}/booking/${r.b.token}\nAdresse: ${s.adresse}.`);
  }
  if (navn === "aflys_booking") {
    const kode = String(a.bookingkode ?? "").trim().toUpperCase();
    const b = await findKode(kode);
    if (!b) return tekst(`Fandt ingen booking med koden ${kode}.`, true);
    await aflys(b);
    const s = await kget<Salon>(["salon", b.salon]);
    return tekst(`Bookingen ${kode} hos ${s?.navn ?? b.salon} (${danskDato(b.dato)} kl. ${b.tid}) er aflyst. Tiden er ledig igen.`);
  }
  return tekst(`Ukendt værktøj: ${navn}`, true);
}

// ---------- MCP (JSON-RPC over HTTP) ----------
const PROTOKOLLER = ["2025-06-18", "2025-03-26", "2024-11-05"];
async function haandter(msg: { id?: unknown; method?: string; params?: Record<string, unknown> }) {
  const svar = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize": {
      const oensket = String(msg.params?.protocolVersion ?? "");
      return svar({
        protocolVersion: PROTOKOLLER.includes(oensket) ? oensket : PROTOKOLLER[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "bookbar", title: BRAND, version: VERSION },
        instructions: `${BRAND} giver adgang til behandlinger, priser, ledige tider og booking hos uafhængige saloner. Hver tid hører til én salon. Saloner markeret som testsalon er opdigtede.`,
      });
    }
    case "ping": return svar({});
    case "tools/list": return svar({ tools: await vaerktoejer() });
    case "tools/call": {
      const p = msg.params ?? {};
      try { return svar(await kald(String(p.name), (p.arguments as Record<string, unknown>) ?? {})); }
      catch (e) { return svar(tekst(`Intern fejl: ${(e as Error).message}`, true)); }
    }
    default:
      if (msg.id === undefined) return null;
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Metoden findes ikke: ${msg.method}` } };
  }
}

// ---------- Administration ----------
function validerSalon(inp: Record<string, unknown>, gammel?: Salon): { ok: true; s: Salon } | { ok: false; fejl: string } {
  const g = gammel;
  const navn = String(inp.navn ?? g?.navn ?? "").trim();
  if (!navn) return { ok: false, fejl: "navn mangler" };
  const aabning = (inp.aabning ?? g?.aabning ?? {}) as Aabning;
  for (const [d, v] of Object.entries(aabning)) {
    if (!/^[0-6]$/.test(d) || !Array.isArray(v)) return { ok: false, fejl: `aabning: ugedag ${d} er ugyldig (brug "0" = mandag … "6" = søndag)` };
    for (const blok of v) if (!Array.isArray(blok) || !tidOk(normTid(blok[0])) || !tidOk(normTid(blok[1])) || normTid(blok[0]) >= normTid(blok[1])) return { ok: false, fejl: `aabning: ugyldig blok ${JSON.stringify(blok)}` };
    aabning[d] = v.map(([a, b]) => [normTid(a), normTid(b)]);
  }
  const raa = (inp.behandlinger ?? g?.behandlinger ?? []) as Record<string, unknown>[];
  if (!Array.isArray(raa) || !raa.length) return { ok: false, fejl: "mindst én behandling kræves" };
  const brugte = new Set<string>();
  const behandlinger: Behandling[] = [];
  for (const r of raa) {
    const bn = String(r.navn ?? "").trim();
    const kat = String(r.kategori ?? "andet") as Kategori;
    const pris = Number(r.pris), min = Number(r.minutter);
    if (!bn) return { ok: false, fejl: "en behandling mangler navn" };
    if (!KATEGORIER.includes(kat)) return { ok: false, fejl: `${bn}: kategori skal være en af ${KATEGORIER.join(", ")}` };
    if (!(pris >= 0)) return { ok: false, fejl: `${bn}: pris mangler` };
    if (!(min >= 5 && min <= 600)) return { ok: false, fejl: `${bn}: varighed i minutter mangler (5–600)` };
    let id = slug(String(r.id ?? bn)) || "behandling";
    while (brugte.has(id)) id += "-2";
    brugte.add(id);
    const sl = r.slags ? String(r.slags) as Slags : undefined;
    behandlinger.push({ id, navn: bn.slice(0, 80), kategori: kat, slags: sl && SLAGS.includes(sl) ? sl : undefined,
      materiale: r.materiale ? String(r.materiale).slice(0, 40) : undefined, pris: Math.round(pris), minutter: Math.round(min),
      beskrivelse: r.beskrivelse ? String(r.beskrivelse).slice(0, 300) : undefined });
  }
  const id = g?.id ?? slug(String(inp.id ?? navn));
  const kodePrefix = (String(inp.kodePrefix ?? g?.kodePrefix ?? navn.split(/\s+/).map((w) => w[0]).join("").slice(0, 3)))
    .toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || "BB";
  const tal = (k: string, std: number, min: number, max: number) => {
    const v = Number(inp[k] ?? (g as Record<string, unknown> | undefined)?.[k] ?? std);
    return Math.min(max, Math.max(min, isFinite(v) ? Math.round(v) : std));
  };
  return { ok: true, s: {
    id, navn: navn.slice(0, 80), omraade: String(inp.omraade ?? g?.omraade ?? "").slice(0, 80),
    adresse: String(inp.adresse ?? g?.adresse ?? "").slice(0, 160), beskrivelse: String(inp.beskrivelse ?? g?.beskrivelse ?? "").slice(0, 1000),
    kodePrefix, email: String(inp.email ?? g?.email ?? "").trim() || undefined,
    kalenderId: g?.kalenderId, kalenderEnv: g?.kalenderEnv, aabning,
    pauseMin: tal("pauseMin", 10, 0, 120), intervalMin: tal("intervalMin", 15, 5, 60), varselMin: tal("varselMin", 60, 0, 2880),
    behandlinger, test: Boolean(inp.test ?? g?.test ?? false), aktiv: Boolean(inp.aktiv ?? g?.aktiv ?? true),
    oprettet: g?.oprettet ?? new Date().toISOString(),
  } };
}
async function admin(req: Request, url: URL): Promise<Response> {
  const token = env("ADMIN_TOKEN");
  if (!token || req.headers.get("authorization") !== "Bearer " + token) return Response.json({ fejl: "Ingen adgang" }, { status: 401 });
  const m = url.pathname.match(/^\/admin\/saloner(?:\/([a-z0-9-]+))?$/);
  if (!m) return Response.json({ fejl: "Ukendt" }, { status: 404 });
  if (req.method === "GET") return Response.json(m[1] ? await kget<Salon>(["salon", m[1]]) : await alleSaloner(true));
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return Response.json({ fejl: "Ugyldig JSON" }, { status: 400 }); }
  if (req.method === "POST" && !m[1]) {
    const v = validerSalon(body);
    if (!v.ok) return Response.json({ fejl: v.fejl }, { status: 400 });
    if (await kget<Salon>(["salon", v.s.id])) return Response.json({ fejl: `Salonen ${v.s.id} findes allerede. Brug PUT /admin/saloner/${v.s.id}.` }, { status: 409 });
    const k = await opretOgDelKalender(v.s.navn, v.s.email ?? "");
    v.s.kalenderId = k.kalenderId;
    await gemSalon(v.s);
    return Response.json({ salon: v.s, kalender: k.delt, side: `${ORIGIN}/s/${v.s.id}` }, { status: 201 });
  }
  if (req.method === "PUT" && m[1]) {
    const gammel = await kget<Salon>(["salon", m[1]]);
    if (!gammel) return Response.json({ fejl: "Findes ikke" }, { status: 404 });
    const v = validerSalon(body, gammel);
    if (!v.ok) return Response.json({ fejl: v.fejl }, { status: 400 });
    await gemSalon(v.s);
    return Response.json({ salon: v.s });
  }
  return Response.json({ fejl: "Metoden er ikke tilladt" }, { status: 405 });
}

// ---------- Sider ----------
let ORIGIN = "https://lyngblomst.wesselsgade-bit.deno.net";
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const CSS = `:root{--bg:#fff;--fg:#222;--muted:#666;--card:#faf7f8;--accent:#b8476b;--line:#e6dde1;--warn:#fff3cd;--warnb:#e0c060}
@media (prefers-color-scheme:dark){:root{--bg:#161416;--fg:#eee;--muted:#aaa;--card:#221e21;--accent:#e07fa0;--line:#3a3337;--warn:#3a3218;--warnb:#806a20}}
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;max-width:720px;margin:0 auto;padding:16px;line-height:1.5;color:var(--fg);background:var(--bg)}
a{color:var(--accent)}.test{background:var(--warn);border:1px solid var(--warnb);padding:8px 12px;border-radius:8px}
.kort{background:var(--card);border-radius:12px;padding:12px 16px;margin:14px 0}.muted{color:var(--muted)}
label{display:block;margin:10px 0 4px;font-weight:600}input,select{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;font-size:1rem;background:var(--bg);color:var(--fg)}
.tider{display:flex;flex-wrap:wrap;gap:6px}.tider label{display:inline-block;margin:0;font-weight:400}
.tider input{position:absolute;opacity:0;width:1px}.tider span{display:inline-block;padding:8px 12px;border:1px solid var(--line);border-radius:999px;cursor:pointer}
.tider input:checked+span{background:var(--accent);color:#fff;border-color:var(--accent)}.tider input:focus-visible+span{outline:2px solid var(--accent)}
button{width:100%;margin-top:16px;padding:14px;border:0;border-radius:12px;background:var(--accent);color:#fff;font-size:1rem;font-weight:600;cursor:pointer}`;
const html = (titel: string, krop: string, ekstra = "", status = 200) => new Response(
  `<!doctype html><html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${ekstra}<title>${esc(titel)}</title><style>${CSS}</style></head><body>${krop}</body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const testBanner = (s?: Salon) => (s ? s.test : true) ? `<p class="test"><strong>Test.</strong> ${s ? `${esc(s.navn)} er opdigtet.` : "Saloner markeret som test er opdigtede."}</p>` : "";

async function forside(): Promise<Response> {
  const saloner = await alleSaloner();
  return html(BRAND, `${saloner.some((s) => s.test) ? testBanner() : ""}<h1>${esc(BRAND)}</h1><p class="muted">Ledige tider og booking hos uafhængige saloner – også via din AI-assistent.</p>` +
    saloner.map((s) => `<div class="kort"><h2><a href="/s/${s.id}">${esc(s.navn)}</a>${s.test ? " <small class='muted'>(test)</small>" : ""}</h2><p>${esc(s.omraade)} · ${kategorierAf(s).join(", ")} · ${prisSpand(s)}</p><p class="muted">${esc(s.beskrivelse)}</p></div>`).join(""));
}
async function salonside(s: Salon, behId: string | null, besked = ""): Promise<Response> {
  const beh = s.behandlinger.find((b) => b.id === behId) ?? s.behandlinger[0];
  const nu = nuIKbh();
  let tider = "";
  for (const [d, dag] of await dage(s, nu.dato, 7)) {
    const t = startTider(s, dag, beh.minutter);
    if (!t.length) continue;
    tider += `<p style="margin:12px 0 6px"><strong>${danskDato(d)}${d === nu.dato ? " (i dag)" : ""}</strong></p><div class="tider">` +
      t.map((m) => { const k = iKbh(m); return `<label><input type="radio" name="tid" value="${k.dato}T${k.tid}" required><span>${k.tid}</span></label>`; }).join("") + "</div>";
  }
  const valg = s.behandlinger.map((b) => `<option value="${b.id}"${b.id === beh.id ? " selected" : ""}>${esc(b.navn)} – ${b.pris} kr – ${b.minutter} min</option>`).join("");
  return html(`${s.navn} – book tid`, `${testBanner(s)}<p><a href="/">← Alle saloner</a></p><h1>${esc(s.navn)}</h1>
<p>${esc(s.omraade)}</p><p class="muted">${esc(s.beskrivelse)}</p>${besked}
<form method="get" class="kort"><label for="b">Behandling</label><select id="b" name="b" onchange="this.form.submit()">${valg}</select><noscript><button>Vis tider</button></noscript></form>
<form method="post" action="/s/${s.id}/book" class="kort"><input type="hidden" name="behandling" value="${beh.id}">
<h2 style="margin-top:0">Ledige tider til ${esc(beh.navn)}</h2>${tider || "<p>Ingen ledige tider de næste 7 dage.</p>"}
<label for="navn">Dit navn</label><input id="navn" name="navn" required maxlength="60" autocomplete="name">
<label for="tlf">Telefon (valgfrit)</label><input id="tlf" name="telefon" maxlength="20" autocomplete="tel" inputmode="tel">
<button type="submit">Book tiden</button><p class="muted">Betaling sker hos salonen. Du får en bookingkode og et link til at aflyse.</p></form>`);
}

if (typeof Deno.serve === "function") Deno.serve(async (req) => {
  const url = new URL(req.url);
  ORIGIN = url.origin.replace(/^http:\/\/(?!localhost|127\.)/, "https://");
  try {
    if (url.pathname === "/mcp") {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      let body: unknown;
      try { body = await req.json(); } catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 }); }
      const batch = Array.isArray(body) ? body : [body];
      const res = (await Promise.all(batch.map(haandter))).filter((x) => x !== null);
      if (!res.length) return new Response(null, { status: 202 });
      return Response.json(Array.isArray(body) ? res : res[0]);
    }
    if (url.pathname.startsWith("/admin/")) return await admin(req, url);
    const sm = url.pathname.match(/^\/s\/([a-z0-9-]+)(\/book)?$/);
    if (sm) {
      const s = await hentSalon(sm[1]);
      if (!s) return html("Ikke fundet", "<h1>Salonen findes ikke</h1>", "", 404);
      if (sm[2] && req.method === "POST") {
        const f = await req.formData();
        const beh = s.behandlinger.find((b) => b.id === String(f.get("behandling")));
        const [dato, tid] = String(f.get("tid") ?? "").split("T");
        const kunde = String(f.get("navn") ?? "").trim().slice(0, 60);
        if (!beh || !datoOk(dato ?? "") || !tidOk(tid ?? "") || !kunde) return salonside(s, beh?.id ?? null, `<p class="test">Vælg en tid og skriv dit navn.</p>`);
        const r = await opretBooking(s, beh, dato, tid, kunde, String(f.get("telefon") ?? "").trim().slice(0, 20) || undefined, "formular");
        if (!r.ok) return salonside(s, beh.id, `<p class="test">${esc(r.fejl)}</p>`);
        return html("Booket", `${testBanner(s)}<h1>Du er booket</h1><div class="kort"><p><strong>${esc(beh.navn)}</strong><br>${esc(s.navn)}, ${esc(s.omraade)}<br>${danskDato(dato)} kl. ${tid}<br>${beh.pris} kr, betales i salonen<br>Bookingkode: <strong>${r.b.kode}</strong></p></div><p><a href="/booking/${r.b.token}">Se eller aflys din booking</a> – gem linket.</p>`);
      }
      return await salonside(s, url.searchParams.get("b"));
    }
    const bm = url.pathname.match(/^\/booking\/([a-f0-9]{24})$/);
    if (bm) {
      const b = await findToken(bm[1]);
      if (!b) return html("Booking", `<h1>Bookingen findes ikke</h1><p>Den er måske allerede aflyst.</p>`);
      const s = await kget<Salon>(["salon", b.salon]);
      if (req.method === "POST") {
        await aflys(b);
        return html("Aflyst", `${testBanner(s ?? undefined)}<h1>Aflyst</h1><p>Din tid hos ${esc(s?.navn ?? b.salon)} ${danskDato(b.dato)} kl. ${b.tid} er aflyst. Husk at slette aftalen i din egen kalender.</p>`);
      }
      const beh = s?.behandlinger.find((x) => x.id === b.behandling);
      return html("Din booking", `${testBanner(s ?? undefined)}<h1>Din booking</h1><div class="kort"><p><strong>${esc(beh?.navn ?? b.behandling)}</strong><br>${esc(s?.navn ?? "")}, ${esc(s?.omraade ?? "")}<br>${danskDato(b.dato)} kl. ${b.tid}<br>${beh?.pris ?? ""} kr, betales i salonen<br>Bookingkode: ${b.kode}<br>Adresse: ${esc(s?.adresse ?? "")}</p></div><form method="post"><button type="submit">Aflys bookingen</button></form>`, `<meta name="robots" content="noindex">`);
    }
    if (url.pathname === "/status") {
      const linjer: string[] = [];
      for (const s of await alleSaloner(true)) {
        let st = brugerGoogle(s) ? "Google-kalender" : "intern testkalender";
        if (brugerGoogle(s)) { try { await hentEvents(s, Date.now(), Date.now() + 86400000); st += " – forbundet og læsbar"; } catch (e) { st += " – FEJL: " + (e as Error).message; } }
        linjer.push(`${s.navn}${s.test ? " (test)" : ""}${s.aktiv ? "" : " (inaktiv)"}: ${st}`);
      }
      return new Response(`${BRAND} ${VERSION}\n${saKey ? "Robotkonto: " + saKey.client_email : "Ingen robotkonto – intern testkalender"}\nAdmin: ${env("ADMIN_TOKEN") ? "slået til" : "lukket (ADMIN_TOKEN mangler)"}\nDatabase: ${kv ? "Deno KV" : "hukommelse"}\n${linjer.join("\n")}\n`,
        { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/llms.txt") {
      const nu = nuIKbh();
      let t = `# ${BRAND}\n\n> Ledige tider og booking hos uafhængige saloner. Testsaloner er opdigtede.\n\nMCP-forbindelse: ${ORIGIN}/mcp\n`;
      for (const s of await alleSaloner()) {
        t += `\n## ${s.navn}${s.test ? " (test)" : ""} – ${s.omraade}\nBook: ${ORIGIN}/s/${s.id}\n`;
        for (const [d, dag] of await dage(s, nu.dato, 14)) {
          const l = startTider(s, dag, korteste(s)).map((x) => iKbh(x).tid);
          t += `- ${danskDato(d)}: ${l.length ? l.join(", ") : "ingen"}\n`;
        }
      }
      return new Response(t, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/") return await forside();
    return new Response("Ikke fundet", { status: 404 });
  } catch (e) {
    return new Response("Fejl: " + (e as Error).message, { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
});
