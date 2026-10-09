// Negle-korridoren (test) – én MCP-forbindelse med to opdigtede saloner.
//   Neglestudie Lyngblomst (Brøndby): negle OG vipper, aftener + lørdag.
//   Neglebaren Kastanje (Hvidovre):   KUN negle, dagtimer, lidt billigere.
// Alt er testdata. Ingen betaling, ingen rigtige kunder.
//
// Ledighed kommer fra salonens Google-kalender, hvis den er sat op:
//   - Klinikken lægger aftaler med titlen "Ledig" ind = åbne blokke.
//   - Alle andre aftaler i kalenderen = optaget.
//   - Bookinger skrives ind som aftaler: "Booket: <behandling> – <navn> (<kode>)".
// Uden Google-opsætning bruges faste testblokke og Deno KV (som før).
//
// Miljøvariabler (Deno Deploy → Settings → Environment variables):
//   GOOGLE_SA_KEY        hele JSON-nøglen for Google-robotkontoen (service account)
//   CAL_LYNGBLOMST       kalender-id for Lyngblomst  (fx abc123@group.calendar.google.com)
//   CAL_KASTANJE         kalender-id for Kastanje
//
// Endepunkter:  POST /mcp      MCP (Streamable HTTP, stateless JSON)
//               GET  /         live-side med begge saloner
//               GET  /llms.txt ledige tider som ren tekst
//               GET  /booking/<token>  se/aflys en booking
//               GET  /status   viser om Google-kalenderne er forbundet

const TZ = "Europe/Copenhagen";
const VERSION = "0.2.0";

type Behandling = { id: string; navn: string; pris: number; minutter: number; type: "negle" | "vipper" | "negle+vipper" };
type Salon = {
  id: string; navn: string; kort: string; omraade: string; kodePrefix: string;
  beskrivelse: string; tilbyder: string; adresse: string;
  behandlinger: Behandling[];
  testVinduer: Record<number, [number, number][]>; // ugedag (0 = mandag) -> åbne blokke i hele timer
  kalenderEnv: string;
};

const SALONER: Salon[] = [
  {
    id: "lyngblomst", navn: "Neglestudie Lyngblomst", kort: "Lyngblomst", omraade: "Brøndby (2605)", kodePrefix: "LB",
    beskrivelse: "Hjemmeklinik med negle OG vipper. Kan lave negle og vipper i samme besøg. Åbent hverdagsaftener og lørdag.",
    tilbyder: "negle og vipper",
    adresse: "Hjemmeklinik i Brøndby – præcis adresse sendes af artisten",
    behandlinger: [
      { id: "gellak", navn: "Gellak på egne negle", pris: 350, minutter: 60, type: "negle" },
      { id: "nyt-saet", navn: "Nyt sæt gelénegle – French", pris: 450, minutter: 90, type: "negle" },
      { id: "opfyldning", navn: "Opfyldning af gelénegle", pris: 380, minutter: 75, type: "negle" },
      { id: "vippeloeft", navn: "Vippeløft med farve", pris: 400, minutter: 60, type: "vipper" },
      { id: "gellak-vippeloeft", navn: "Gellak + vippeløft i ét besøg", pris: 700, minutter: 120, type: "negle+vipper" },
    ],
    testVinduer: { 0: [[17, 21]], 1: [[17, 21]], 2: [[17, 21]], 3: [[16, 21]], 4: [[15, 20]], 5: [[10, 15]] },
    kalenderEnv: "CAL_LYNGBLOMST",
  },
  {
    id: "kastanje", navn: "Neglebaren Kastanje", kort: "Kastanje", omraade: "Hvidovre (2650)", kodePrefix: "NK",
    beskrivelse: "Lille neglesalon med fokus på hurtige, holdbare negle. Laver KUN negle – ingen vipper. Åbent i dagtimerne på hverdage.",
    tilbyder: "kun negle",
    adresse: "Neglebaren Kastanje, Hvidovre – præcis adresse sendes ved booking",
    behandlinger: [
      { id: "gellak", navn: "Gellak på egne negle", pris: 299, minutter: 45, type: "negle" },
      { id: "nyt-saet", navn: "Nyt sæt gelénegle", pris: 420, minutter: 90, type: "negle" },
      { id: "opfyldning", navn: "Opfyldning af gelénegle", pris: 349, minutter: 60, type: "negle" },
      { id: "manicure", navn: "Klassisk manicure uden lak", pris: 249, minutter: 40, type: "negle" },
    ],
    testVinduer: { 0: [[9, 16]], 1: [[9, 16]], 2: [[9, 13]], 3: [[10, 18]], 4: [[9, 15]] },
    kalenderEnv: "CAL_KASTANJE",
  },
];
const salonById = (id: unknown) => SALONER.find((s) => s.id === String(id ?? "").toLowerCase().trim());

const UGEDAGE = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];
const MAANEDER = ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august",
  "september", "oktober", "november", "december"];
const TEST = "TESTDATA: Begge saloner er opdigtede. Ingen rigtig behandling finder sted.";

// ---------- Tid ----------
function tzOffsetMin(utcMs: number): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(new Date(utcMs)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = s.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}
// Lokal dansk tid -> UTC-millisekunder.
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
const ugedag = (dato: string) => (new Date(dato + "T12:00:00Z").getUTCDay() + 6) % 7; // 0 = mandag
function danskDato(dato: string): string {
  const d = new Date(dato + "T12:00:00Z");
  return `${UGEDAGE[ugedag(dato)]} ${d.getUTCDate()}. ${MAANEDER[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const datoOk = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + "T12:00:00Z"));
const tidOk = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
function normTid(t: unknown): string {
  const s = String(t ?? "").trim().replace(".", ":");
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?$/);
  return m ? `${m[1].padStart(2, "0")}:${m[2] ?? "00"}` : s;
}

// ---------- Lager (Deno KV hvis tilgængelig, ellers hukommelse) ----------
type Booking = {
  kode: string; token: string; salon: string; dato: string; tid: string; minutter: number;
  behandling: string; navn: string; telefon?: string; oprettet: string; googleEventId?: string;
};
let kv: Deno.Kv | null = null;
try { kv = await Deno.openKv(); } catch { kv = null; }
const mem = new Map<string, Booking>();

async function gemBookingKv(b: Booking): Promise<void> {
  if (kv) {
    await kv.atomic()
      .set(["b2", b.salon, b.dato, b.kode], b)
      .set(["b2kode", b.kode], [b.salon, b.dato])
      .set(["b2token", b.token], b.kode).commit();
  } else mem.set(b.kode, b);
}
async function bookingerKv(salon: string, dato: string): Promise<Booking[]> {
  if (kv) {
    const ud: Booking[] = [];
    for await (const e of kv.list<Booking>({ prefix: ["b2", salon, dato] })) ud.push(e.value);
    return ud;
  }
  return [...mem.values()].filter((b) => b.salon === salon && b.dato === dato);
}
async function findKode(kode: string): Promise<Booking | null> {
  if (kv) {
    const ref = await kv.get<[string, string]>(["b2kode", kode]);
    if (!ref.value) return null;
    return (await kv.get<Booking>(["b2", ref.value[0], ref.value[1], kode])).value;
  }
  return mem.get(kode) ?? null;
}
async function findToken(token: string): Promise<Booking | null> {
  if (!/^[a-f0-9]{24}$/.test(token)) return null;
  if (kv) {
    const k = await kv.get<string>(["b2token", token]);
    return k.value ? await findKode(k.value) : null;
  }
  return [...mem.values()].find((b) => b.token === token) ?? null;
}
async function sletKv(b: Booking): Promise<void> {
  if (kv) {
    await kv.atomic().delete(["b2", b.salon, b.dato, b.kode]).delete(["b2kode", b.kode])
      .delete(["b2token", b.token]).commit();
  } else mem.delete(b.kode);
}

// ---------- Google Kalender (service account, JWT RS256) ----------
type SaKey = { client_email: string; private_key: string; token_uri?: string };
let saKey: SaKey | null = null;
try {
  const raw = Deno.env.get("GOOGLE_SA_KEY");
  if (raw) saKey = JSON.parse(raw);
} catch { saKey = null; }
const kalenderId = (s: Salon) => (saKey ? Deno.env.get(s.kalenderEnv) || null : null);

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
    iss: saKey.client_email, scope: "https://www.googleapis.com/auth/calendar.events",
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
type GEvent = { id: string; summary?: string; status?: string; transparency?: string;
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> } };
async function gcalEvents(calId: string, fraMs: number, tilMs: number): Promise<GEvent[]> {
  const q = new URLSearchParams({
    timeMin: new Date(fraMs).toISOString(), timeMax: new Date(tilMs).toISOString(),
    singleEvents: "true", orderBy: "startTime", maxResults: "250",
  });
  const res = await gcal(`/calendars/${encodeURIComponent(calId)}/events?${q}`);
  if (!res.ok) throw new Error(`Kunne ikke læse kalenderen (${res.status}). Er den delt med robotkontoen?`);
  const j = await res.json();
  return (j.items ?? []).filter((e: GEvent) => e.status !== "cancelled");
}

// ---------- Ledighed (samme logik for Google og testtilstand) ----------
type Interval = [number, number]; // UTC-ms
type Dagsbillede = { aabne: Interval[]; optaget: Interval[] };
const erLedig = (titel?: string) => /^\s*ledig/i.test(titel ?? "");
const erLukket = (titel?: string) => /^\s*lukket/i.test(titel ?? "");

// Henter åbne blokke og optagede tidsrum for en række dage på én gang.
async function dagsbilleder(s: Salon, fra: string, antal: number): Promise<Map<string, Dagsbillede>> {
  const ud = new Map<string, Dagsbillede>();
  const datoer = Array.from({ length: antal }, (_, i) => plusDage(fra, i));
  for (const d of datoer) ud.set(d, { aabne: [], optaget: [] });
  const cal = kalenderId(s);
  if (cal) {
    const events = await gcalEvents(cal, lokalMs(fra, "00:00"), lokalMs(plusDage(fra, antal), "00:00"));
    for (const e of events) {
      if (e.start?.date) { // heldagsaftale: "Lukket" lukker dagen(e)
        if (!erLukket(e.summary)) continue;
        for (let d = e.start.date; d < (e.end?.date ?? plusDage(e.start.date, 1)); d = plusDage(d, 1)) {
          ud.get(d)?.optaget.push([lokalMs(d, "00:00"), lokalMs(plusDage(d, 1), "00:00")]);
        }
        continue;
      }
      if (!e.start?.dateTime || !e.end?.dateTime) continue;
      const a = Date.parse(e.start.dateTime), b = Date.parse(e.end.dateTime);
      const dag = ud.get(iKbh(a).dato);
      if (!dag) continue;
      if (erLedig(e.summary)) dag.aabne.push([a, b]);
      else if (e.transparency !== "transparent") dag.optaget.push([a, b]);
    }
    return ud;
  }
  for (const d of datoer) {
    const dag = ud.get(d)!;
    for (const [h1, h2] of s.testVinduer[ugedag(d)] ?? []) dag.aabne.push([lokalMs(d, hhmm(h1 * 60)), lokalMs(d, hhmm(h2 * 60))]);
    for (const b of await bookingerKv(s.id, d)) {
      const a = lokalMs(b.dato, b.tid);
      dag.optaget.push([a, a + b.minutter * 60000]);
    }
    // Lidt forudbestemt "optaget" i testtilstand, så kalenderen ikke ser tom ud.
    const seed = Number(d.replaceAll("-", "")) + s.id.length * 7;
    if (dag.aabne.length && seed % 3 !== 0) {
      const [a, b] = dag.aabne[0];
      const slots = Math.floor((b - a) / 1800000);
      const start = a + (seed % Math.max(1, slots - 2)) * 1800000;
      dag.optaget.push([start, start + 3600000]);
    }
  }
  return ud;
}
// Starttider (hver halve time), hvor behandlingen kan være inden for en åben blok uden overlap.
function startTider(dag: Dagsbillede, minutter: number, efterMs: number): number[] {
  const varighed = minutter * 60000, ud: number[] = [];
  for (const [a, b] of dag.aabne) {
    let t = Math.ceil(a / 1800000) * 1800000;
    for (; t + varighed <= b; t += 1800000) {
      if (t <= efterMs) continue;
      if (dag.optaget.some(([x, y]) => t < y && t + varighed > x)) continue;
      ud.push(t);
    }
  }
  return [...new Set(ud)].sort((x, y) => x - y);
}
const minimumVarighed = (s: Salon) => Math.min(...s.behandlinger.map((b) => b.minutter));

// ---------- Booking ----------
async function opretBooking(s: Salon, beh: Behandling, dato: string, tid: string, navn: string, telefon?: string)
  : Promise<{ ok: true; b: Booking } | { ok: false; fejl: string }> {
  const start = lokalMs(dato, tid);
  const dag = (await dagsbilleder(s, dato, 1)).get(dato)!;
  const mulige = startTider(dag, beh.minutter, Date.now());
  if (!mulige.includes(start)) {
    const alt = mulige.map((m) => iKbh(m).tid).join(", ") || "ingen";
    return { ok: false, fejl: `Kl. ${tid} ${danskDato(dato)} er ikke ledig hos ${s.navn} til ${beh.navn} (${beh.minutter} min). Ledige starttider den dag: ${alt}.` };
  }
  const kode = s.kodePrefix + "-" + crypto.randomUUID().replaceAll("-", "").slice(0, 4).toUpperCase();
  const b: Booking = {
    kode, token: crypto.randomUUID().replaceAll("-", "").slice(0, 24), salon: s.id, dato, tid,
    minutter: beh.minutter, behandling: beh.id, navn, telefon, oprettet: new Date().toISOString(),
  };
  const cal = kalenderId(s);
  if (cal) {
    const res = await gcal(`/calendars/${encodeURIComponent(cal)}/events`, {
      method: "POST",
      body: JSON.stringify({
        summary: `Booket: ${beh.navn} – ${navn} (${kode})`,
        description: `Booket via AI-assistent gennem Negle-korridoren (test).\nKunde: ${navn}${telefon ? `\nTelefon: ${telefon}` : ""}\nBehandling: ${beh.navn}, ${beh.pris} kr\nBookingkode: ${kode}\nOprettet: ${iKbh(Date.now()).dato} kl. ${iKbh(Date.now()).tid}`,
        start: { dateTime: new Date(start).toISOString(), timeZone: TZ },
        end: { dateTime: new Date(start + beh.minutter * 60000).toISOString(), timeZone: TZ },
        colorId: "10",
        extendedProperties: { private: { korridorKode: kode } },
      }),
    });
    if (!res.ok) return { ok: false, fejl: `Kunne ikke skrive i salonens kalender (${res.status}).` };
    b.googleEventId = (await res.json()).id;
    // Dobbeltbookingskontrol: findes der en anden aftale i samme tidsrum, trækker vi vores tilbage.
    const efter = await gcalEvents(cal, start, start + beh.minutter * 60000);
    const konflikt = efter.some((e) => e.id !== b.googleEventId && !erLedig(e.summary) && e.start?.dateTime
      && e.transparency !== "transparent"
      && Date.parse(e.start.dateTime) < start + beh.minutter * 60000 && Date.parse(e.end!.dateTime!) > start);
    if (konflikt) {
      await gcal(`/calendars/${encodeURIComponent(cal)}/events/${b.googleEventId}`, { method: "DELETE" });
      return { ok: false, fejl: "Tiden blev taget lige før. Vælg en anden tid." };
    }
  } else if (kv) {
    // Testtilstand: lås per salon i et kort øjeblik for at undgå dobbeltbooking.
    const laas = ["laas", s.id];
    const r = await kv.atomic().check({ key: laas, versionstamp: null }).set(laas, 1, { expireIn: 5000 }).commit();
    if (!r.ok) return { ok: false, fejl: "Der bookes lige nu hos salonen. Prøv igen om et øjeblik." };
    try {
      const igen = startTider((await dagsbilleder(s, dato, 1)).get(dato)!, beh.minutter, Date.now());
      if (!igen.includes(start)) return { ok: false, fejl: "Tiden blev taget lige før. Vælg en anden tid." };
      await gemBookingKv(b);
    } finally { await kv.delete(laas); }
    return { ok: true, b };
  }
  await gemBookingKv(b);
  return { ok: true, b };
}
async function aflys(b: Booking): Promise<void> {
  const s = salonById(b.salon);
  const cal = s ? kalenderId(s) : null;
  if (cal && b.googleEventId) {
    await gcal(`/calendars/${encodeURIComponent(cal)}/events/${b.googleEventId}`, { method: "DELETE" });
  }
  await sletKv(b);
}

// ---------- Værktøjer ----------
const salonEnum = SALONER.map((s) => s.id);
const alleBehIds = [...new Set(SALONER.flatMap((s) => s.behandlinger.map((b) => b.id)))];
const tools = [
  {
    name: "find_saloner",
    title: "Find saloner",
    description: "Viser de saloner, der kan bookes gennem denne forbindelse: hvad de tilbyder (negle, vipper), område, åbningsmønster og prisniveau. Brug den først, når kunden ikke har nævnt en bestemt salon, så du kan rådgive om valget.",
    inputSchema: {
      type: "object",
      properties: { behandlingstype: { type: "string", enum: ["negle", "vipper", "negle+vipper"], description: "Valgfrit: vis kun saloner, der tilbyder denne type." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "vis_behandlinger",
    title: "Vis behandlinger og priser",
    description: "Viser behandlinger, priser og varighed. Udelad salon for at se begge saloner side om side.",
    inputSchema: {
      type: "object",
      properties: { salon: { type: "string", enum: salonEnum, description: "Salonens id. Udelades = alle saloner." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "vis_ledige_tider",
    title: "Vis ledige tider",
    description: "Viser ledige starttider for 1–14 dage. Angiv gerne behandling, så kun tider hvor hele behandlingen kan nås vises. Udelad salon for at sammenligne begge saloner. Sig altid til kunden, hvilken salon en tid er hos.",
    inputSchema: {
      type: "object",
      properties: {
        salon: { type: "string", enum: salonEnum, description: "Salonens id. Udelades = alle saloner." },
        behandling: { type: "string", enum: alleBehIds, description: "Behandlingens id fra vis_behandlinger (valgfrit)." },
        fra_dato: { type: "string", description: "Første dato, ÅÅÅÅ-MM-DD. Udelades = i dag." },
        antal_dage: { type: "integer", minimum: 1, maximum: 14, description: "Antal dage. Standard 1." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "book_tid",
    title: "Book en tid",
    description: "Booker en ledig tid hos en bestemt salon. Bekræft salon, behandling, dato og tid med kunden først. Returnerer en bookingkode. Bookingen skrives direkte ind i salonens kalender.",
    inputSchema: {
      type: "object",
      properties: {
        salon: { type: "string", enum: salonEnum, description: "Salonens id fra find_saloner." },
        behandling: { type: "string", enum: alleBehIds, description: "Behandlingens id fra vis_behandlinger for den salon." },
        dato: { type: "string", description: "ÅÅÅÅ-MM-DD" },
        tidspunkt: { type: "string", description: "Starttid TT:MM, fx 18:30" },
        navn: { type: "string", description: "Kundens fornavn" },
        telefon: { type: "string", description: "Valgfrit telefonnummer" },
      },
      required: ["salon", "behandling", "dato", "tidspunkt", "navn"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "aflys_booking",
    title: "Aflys en booking",
    description: "Aflyser en booking ud fra bookingkoden (fx LB-4K7Q eller NK-9P2X). Tiden bliver ledig igen, og aftalen fjernes fra salonens kalender.",
    inputSchema: {
      type: "object",
      properties: { bookingkode: { type: "string", description: "Koden fra book_tid" } },
      required: ["bookingkode"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

const tekst = (t: string, fejl = false) => ({ content: [{ type: "text", text: t }], isError: fejl });
const prisSpand = (s: Salon) => {
  const p = s.behandlinger.map((b) => b.pris);
  return `${Math.min(...p)}–${Math.max(...p)} kr`;
};
const aabningsTekst = (s: Salon) => s.kalenderEnv && kalenderId(s)
  ? "efter salonens kalender"
  : Object.entries(s.testVinduer).map(([d, v]) => `${UGEDAGE[Number(d)].slice(0, 3)} ${v.map(([a, b]) => `${a}–${b}`).join(", ")}`).join("; ");

async function kald(navn: string, a: Record<string, unknown>) {
  if (navn === "find_saloner") {
    const type = a.behandlingstype ? String(a.behandlingstype) : null;
    const liste = SALONER.filter((s) => !type || s.behandlinger.some((b) => b.type === type || b.type.split("+").includes(type)));
    if (!liste.length) return tekst(`Ingen saloner i forbindelsen tilbyder ${type}.`);
    return tekst(`Saloner i Negle-korridoren${type ? ` med ${type}` : ""}:\n` + liste.map((s) =>
      `- ${s.navn} (id: ${s.id}) – ${s.omraade}. Tilbyder: ${s.tilbyder}. ${s.beskrivelse} Priser: ${prisSpand(s)}. Åbent: ${aabningsTekst(s)}.`).join("\n") +
      "\nSammenlign gerne priser og ledige tider med vis_behandlinger og vis_ledige_tider uden salon.\n" + TEST);
  }
  if (navn === "vis_behandlinger") {
    const valgt = a.salon ? salonById(a.salon) : null;
    if (a.salon && !valgt) return tekst(`Ukendt salon. Gyldige: ${salonEnum.join(", ")}.`, true);
    return tekst((valgt ? [valgt] : SALONER).map((s) => `${s.navn} (id: ${s.id}) – ${s.omraade} – ${s.tilbyder}\n` +
      s.behandlinger.map((b) => `- ${b.navn} (id: ${b.id}): ${b.pris} kr, ${b.minutter} min`).join("\n")).join("\n\n") +
      "\nBetaling sker hos salonen.\n" + TEST);
  }
  if (navn === "vis_ledige_tider") {
    const nu = nuIKbh();
    const fra = typeof a.fra_dato === "string" && a.fra_dato ? a.fra_dato : nu.dato;
    if (!datoOk(fra)) return tekst("Ugyldig dato. Brug ÅÅÅÅ-MM-DD.", true);
    const n = Math.min(14, Math.max(1, Number(a.antal_dage ?? 1) || 1));
    const valgt = a.salon ? salonById(a.salon) : null;
    if (a.salon && !valgt) return tekst(`Ukendt salon. Gyldige: ${salonEnum.join(", ")}.`, true);
    const behId = a.behandling ? String(a.behandling) : null;
    const afsnit: string[] = [];
    for (const s of valgt ? [valgt] : SALONER) {
      const beh = behId ? s.behandlinger.find((b) => b.id === behId) : null;
      if (behId && !beh) { afsnit.push(`${s.navn}: tilbyder ikke "${behId}" (${s.tilbyder}).`); continue; }
      const min = beh ? beh.minutter : minimumVarighed(s);
      const billeder = await dagsbilleder(s, fra, n);
      const linjer: string[] = [];
      for (const [d, dag] of billeder) {
        const t = startTider(dag, min, Date.now()).map((m) => iKbh(m).tid);
        linjer.push(`  - ${danskDato(d)} (${d})${d === nu.dato ? " – i dag" : ""}: ${t.length ? t.join(", ") : "ingen ledige tider"}`);
      }
      afsnit.push(`${s.navn} (id: ${s.id}, ${s.omraade}, ${s.tilbyder})${beh ? ` – starttider til ${beh.navn}, ${beh.minutter} min, ${beh.pris} kr` : ` – starttider til den korteste behandling (${min} min)`}:\n${linjer.join("\n")}`);
    }
    return tekst(`Ledige starttider (klokken nu i København: ${nu.tid}):\n${afsnit.join("\n\n")}\n` +
      "Fortæl kunden, hvilken salon hver tid er hos.\n" + TEST);
  }
  if (navn === "book_tid") {
    const s = salonById(a.salon);
    if (!s) return tekst(`Angiv salon. Gyldige: ${salonEnum.join(", ")}.`, true);
    const beh = s.behandlinger.find((x) => x.id === a.behandling);
    if (!beh) return tekst(`${s.navn} tilbyder ikke "${a.behandling}". Gyldige her: ${s.behandlinger.map((x) => x.id).join(", ")}.`, true);
    const dato = String(a.dato ?? ""), tid = normTid(a.tidspunkt);
    const kunde = String(a.navn ?? "").trim().slice(0, 60);
    if (!datoOk(dato)) return tekst("Ugyldig dato. Brug ÅÅÅÅ-MM-DD.", true);
    if (!tidOk(tid)) return tekst("Ugyldigt tidspunkt. Brug TT:MM.", true);
    if (!kunde) return tekst("Kundens navn mangler.", true);
    const tlf = typeof a.telefon === "string" ? a.telefon.slice(0, 20) : undefined;
    const r = await opretBooking(s, beh, dato, tid, kunde, tlf);
    if (!r.ok) return tekst(r.fejl, true);
    return tekst(`Booket! ${beh.navn} hos ${s.navn} (${s.omraade}), ${danskDato(dato)} kl. ${tid}–${iKbh(lokalMs(dato, tid) + beh.minutter * 60000).tid} (${beh.pris} kr, betales i salonen).\n` +
      `Kunde: ${kunde}. Bookingkode: ${r.b.kode}.\n` +
      `${kalenderId(s) ? "Bookingen står nu i salonens kalender." : "Bookingen er registreret hos salonen."}\n` +
      `Se eller aflys: ${ORIGIN}/booking/${r.b.token}\nAdresse: ${s.adresse}.\n` +
      `Lægger du aftalen i kundens kalender, så skriv salonens navn, bookingkoden og linket i noten.\n${TEST}`);
  }
  if (navn === "aflys_booking") {
    const kode = String(a.bookingkode ?? "").trim().toUpperCase();
    const b = await findKode(kode);
    if (!b) return tekst(`Fandt ingen booking med koden ${kode}.`, true);
    await aflys(b);
    return tekst(`Bookingen ${kode} hos ${salonById(b.salon)?.navn ?? b.salon} (${danskDato(b.dato)} kl. ${b.tid}) er aflyst. Tiden er ledig igen.\n${TEST}`);
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
        serverInfo: { name: "negle-korridoren-test", title: "Negle-korridoren (test)", version: VERSION },
        instructions: "Testforbindelse med to opdigtede saloner: Neglestudie Lyngblomst i Brøndby (negle og vipper) og Neglebaren Kastanje i Hvidovre (kun negle). " +
          "Når kunden ikke har valgt salon, så brug find_saloner og sammenlign ledige tider på tværs, rådgiv kort om valget og sig altid, hvilken salon en tid er hos. Alt er testdata.",
      });
    }
    case "ping": return svar({});
    case "tools/list": return svar({ tools });
    case "tools/call": {
      const p = msg.params ?? {};
      try {
        return svar(await kald(String(p.name), (p.arguments as Record<string, unknown>) ?? {}));
      } catch (e) {
        return svar(tekst(`Intern fejl: ${(e as Error).message}`, true));
      }
    }
    default:
      if (msg.id === undefined) return null;
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Metoden findes ikke: ${msg.method}` } };
  }
}

// ---------- Sider ----------
let ORIGIN = "https://lyngblomst.wesselsgade-bit.deno.net";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const CSS = `:root{--bg:#fff;--fg:#222;--muted:#666;--card:#faf7f8;--accent:#b8476b;--warn:#fff3cd;--warnb:#e0c060}
@media (prefers-color-scheme:dark){:root{--bg:#161416;--fg:#eee;--muted:#aaa;--card:#221e21;--accent:#e07fa0;--warn:#3a3218;--warnb:#806a20}}
body{font-family:system-ui,sans-serif;max-width:720px;margin:0 auto;padding:16px;line-height:1.5;color:var(--fg);background:var(--bg)}
.test{background:var(--warn);border:1px solid var(--warnb);padding:10px 12px;border-radius:8px}
.salon{background:var(--card);border-radius:12px;padding:12px 16px;margin:16px 0}.muted{color:var(--muted)}
button{width:100%;padding:14px;border:0;border-radius:12px;background:var(--accent);color:#fff;font-size:1rem;font-weight:600}`;
const html = (titel: string, krop: string, ekstra = "") => new Response(
  `<!doctype html><html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${ekstra}<title>${esc(titel)}</title><style>${CSS}</style></head><body>${krop}</body></html>`,
  { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

async function forside(): Promise<Response> {
  const nu = nuIKbh();
  let krop = `<p class="test"><strong>Testside.</strong> Begge saloner er opdigtede, og tiderne er testdata.</p>
<h1>Negle-korridoren – to saloner, én forbindelse</h1><p class="muted">Opdateret ${nu.dato} kl. ${nu.tid}. Siden genindlæses hvert 20. sekund.</p>`;
  for (const s of SALONER) {
    const billeder = await dagsbilleder(s, nu.dato, 7);
    let li = "";
    for (const [d, dag] of billeder) {
      const t = startTider(dag, minimumVarighed(s), Date.now()).map((m) => iKbh(m).tid);
      li += `<li><strong>${danskDato(d)}${d === nu.dato ? " (i dag)" : ""}:</strong> ${t.length ? t.join(", ") : "ingen ledige tider"}</li>`;
    }
    krop += `<section class="salon"><h2>${esc(s.navn)}</h2><p>${esc(s.omraade)} · ${esc(s.tilbyder)} · ${kalenderId(s) ? "Google-kalender forbundet" : "testtider"}</p>
<p class="muted">${esc(s.beskrivelse)}</p><ul>${s.behandlinger.map((b) => `<li>${esc(b.navn)} – ${b.pris} kr – ${b.minutter} min</li>`).join("")}</ul>
<h3>Ledige starttider (korteste behandling)</h3><ul>${li}</ul></section>`;
  }
  krop += `<p class="muted">AI-assistenter kan booke via MCP-forbindelsen på <code>/mcp</code>.</p>`;
  return html("Negle-korridoren (test)", krop, `<meta http-equiv="refresh" content="20">`);
}

if (typeof Deno.serve === "function") Deno.serve(async (req) => {
  const url = new URL(req.url);
  ORIGIN = url.origin.replace(/^http:/, "https:");
  if (url.pathname === "/mcp") {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    let body: unknown;
    try { body = await req.json(); } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
    }
    const batch = Array.isArray(body) ? body : [body];
    const res = (await Promise.all(batch.map(haandter))).filter((x) => x !== null);
    if (res.length === 0) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? res : res[0]);
  }
  const m = url.pathname.match(/^\/booking\/([a-f0-9]{24})$/);
  if (m) {
    const b = await findToken(m[1]);
    if (!b) return html("Booking", `<p class="test">Testside.</p><h1>Bookingen findes ikke</h1><p>Den er måske allerede aflyst.</p>`);
    const s = salonById(b.salon)!;
    if (req.method === "POST") {
      await aflys(b);
      return html("Aflyst", `<p class="test">Testside.</p><h1>Aflyst</h1><p>Din tid hos ${esc(s.navn)} ${danskDato(b.dato)} kl. ${b.tid} er aflyst og ledig igen. Husk at slette aftalen i din egen kalender.</p>`);
    }
    const beh = s.behandlinger.find((x) => x.id === b.behandling);
    return html("Din booking", `<p class="test">Testside. ${esc(s.navn)} er opdigtet.</p><h1>Din booking</h1><p><strong>${esc(beh?.navn ?? b.behandling)}</strong><br>${esc(s.navn)}, ${esc(s.omraade)}<br>${danskDato(b.dato)} kl. ${b.tid}<br>${beh?.pris ?? ""} kr, betales i salonen<br>Bookingkode: ${b.kode}</p><form method="post"><button type="submit">Aflys bookingen</button></form>`, `<meta name="robots" content="noindex">`);
  }
  if (url.pathname === "/status") {
    const linjer = [];
    for (const s of SALONER) {
      const cal = kalenderId(s);
      let st = cal ? "kalender angivet" : (saKey ? `mangler ${s.kalenderEnv}` : "testtilstand (ingen Google-nøgle)");
      if (cal) {
        try { await gcalEvents(cal, Date.now(), Date.now() + 86400000); st = "Google-kalender forbundet og læsbar"; }
        catch (e) { st = "FEJL: " + (e as Error).message; }
      }
      linjer.push(`${s.navn}: ${st}`);
    }
    return new Response(`Negle-korridoren ${VERSION}\n${saKey ? "Robotkonto: " + saKey.client_email : "Ingen robotkonto"}\n${linjer.join("\n")}\n`,
      { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  if (url.pathname === "/llms.txt") {
    const nu = nuIKbh();
    let t = `# Negle-korridoren (testside)\n\n> ${TEST}\n\nMCP-forbindelse: ${url.origin}/mcp\n`;
    for (const s of SALONER) {
      t += `\n## ${s.navn} – ${s.omraade} – ${s.tilbyder}\n`;
      for (const [d, dag] of await dagsbilleder(s, nu.dato, 14)) {
        const l = startTider(dag, minimumVarighed(s), Date.now()).map((x) => iKbh(x).tid);
        t += `- ${danskDato(d)}: ${l.length ? l.join(", ") : "ingen"}\n`;
      }
    }
    return new Response(t, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (url.pathname === "/") return await forside();
  return new Response("Ikke fundet", { status: 404 });
});
