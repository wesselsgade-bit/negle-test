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
const VERSION = "0.6.0";
const env = (k: string) => Deno.env.get(k) ?? "";
const BRAND = env("BRAND") || "Bookbar (test)";
// Den ene offentlige adresse. Alt andet (fx den gamle deno.net-adresse) viderestilles hertil – undtagen /mcp, så installerede forbindelser virker videre.
const PUBLIC_ORIGIN = (env("PUBLIC_ORIGIN") || "https://bookbar.dk").replace(/\/$/, "");

// ---------- Datamodel ----------
const KATEGORIER = ["negle", "vipper", "bryn", "hud", "andet"] as const;
type Kategori = typeof KATEGORIER[number];
const SLAGS = ["nyt", "opfyldning", "fjernelse", "enkelt", "andet"] as const;
type Slags = typeof SLAGS[number];
type Behandling = {
  id: string; navn: string; kategori: Kategori; slags?: Slags; materiale?: string;
  pris: number; minutter: number; beskrivelse?: string; stikord?: string[]; billede?: number;
};
// Et billede er enten en rigtig URL (salonens eget foto) eller en indbygget illustration (motiv).
type Billede = { url?: string; motiv?: Motiv; farver?: string[]; tekst: string };
type Motiv = "glat" | "french" | "chrome" | "glimmer" | "kunst" | "vipper" | "naturlig";
type Aabning = Record<string, [string, string][]>; // "0" = mandag … "6" = søndag -> [["10:00","18:00"]]
type Salon = {
  id: string; navn: string; omraade: string; adresse: string; beskrivelse: string;
  kodePrefix: string; email?: string; kalenderId?: string; kalenderEnv?: string;
  aabning: Aabning; pauseMin: number; intervalMin: number; varselMin: number;
  behandlinger: Behandling[]; test: boolean; aktiv: boolean; oprettet: string;
  omArtisten?: string; stikord?: string[]; praktisk?: string[]; billeder?: Billede[]; dataVersion?: number;
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
      { id: "gellak", navn: "Gellak på egne negle", kategori: "negle", slags: "enkelt", materiale: "gellak", pris: 350, minutter: 60,
        beskrivelse: "Holder 2–3 uger. Vælg mellem ca. 120 farver – også stærke røde som chili og bordeaux. Inkl. neglebåndspleje og fil.", stikord: ["farve", "chili-rød", "rød", "nude", "holdbar"], billede: 0 },
      { id: "nyt-saet", navn: "Nyt sæt gelénegle", kategori: "negle", slags: "nyt", materiale: "gelé", pris: 450, minutter: 90,
        beskrivelse: "Forlængelse med gelé på skabelon. Længde og form efter ønske (mandel, kiste, firkantet). Vælg ensfarvet, French eller nail art – fx til fest, bryllup eller Halloween.", stikord: ["french", "forlængelse", "lange negle", "mandel", "kiste", "nail art", "fest", "bryllup"], billede: 1 },
      { id: "opfyldning", navn: "Opfyldning af gelénegle", kategori: "negle", slags: "opfyldning", materiale: "gelé", pris: 380, minutter: 75,
        beskrivelse: "Efter 3–4 uger. Udvoksning fyldes op, og du kan skifte farve. Nail art kan tilkøbes på stedet.", stikord: ["opfyldning", "skift farve", "nail art"] },
      { id: "vippeloeft", navn: "Vippeløft med farve", kategori: "vipper", slags: "enkelt", pris: 400, minutter: 60,
        beskrivelse: "Løfter og farver dine egne vipper. Holder 6–8 uger. Ingen extensions – naturligt look.", stikord: ["vipper", "naturligt", "løft", "farvning"], billede: 3 },
      { id: "gellak-vippeloeft", navn: "Gellak + vippeløft i ét besøg", kategori: "negle", slags: "andet", pris: 700, minutter: 120,
        beskrivelse: "Kombination: gellak og vippeløft samme besøg. Spar 50 kr og en ekstra tur.", stikord: ["kombi", "negle og vipper", "samme dag"] },
    ],
    omArtisten: "Mia har lavet negle og vipper i 6 år og arbejder fra sin lyse hjemmeklinik i Brøndby Strand. Hun elsker stærke farver og små detaljer – chili-røde negle, glimmer-French og diskret nail art – men laver også rolige, naturlige looks.",
    stikord: ["chili-røde negle", "nail art", "glimmer", "French", "bryllup", "vippeløft", "aftentider", "hjemmeklinik"],
    praktisk: ["Gratis parkering ved døren", "MobilePay eller kontant", "Taler dansk og engelsk", "Kat i hjemmet – sig til ved allergi", "Afbud senest 24 timer før"],
    billeder: [
      { motiv: "glat", farver: ["#c1121f"], tekst: "Chili-rød gellak" },
      { motiv: "french", farver: ["#f6e7e1"], tekst: "Klassisk French på gelé" },
      { motiv: "glimmer", farver: ["#e8c1c5", "#d4af37"], tekst: "Rosa med guldglimmer" },
      { motiv: "vipper", tekst: "Vippeløft med farve" },
    ],
    dataVersion: 3,
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
      { id: "gellak", navn: "Gellak på egne negle", kategori: "negle", slags: "enkelt", materiale: "gellak", pris: 299, minutter: 45,
        beskrivelse: "Hurtig og holdbar. 40 udvalgte farver, mest nude, rosa og klassisk rød. Chrome-pulver kan tilkøbes for 50 kr.", stikord: ["hurtig", "billig", "nude", "rød", "chrome"], billede: 0 },
      { id: "nyt-saet", navn: "Nyt sæt gelénegle", kategori: "negle", slags: "nyt", materiale: "gelé", pris: 420, minutter: 90,
        beskrivelse: "Naturlig forlængelse i kort til mellem længde. Ensfarvet eller chrome. Ingen lange kunstnegle.", stikord: ["forlængelse", "kort", "chrome"], billede: 1 },
      { id: "opfyldning", navn: "Opfyldning af gelénegle", kategori: "negle", slags: "opfyldning", materiale: "gelé", pris: 349, minutter: 60,
        beskrivelse: "Efter 3–4 uger. Inkl. farveskift.", stikord: ["opfyldning"] },
      { id: "manicure", navn: "Klassisk manicure uden lak", kategori: "negle", slags: "enkelt", pris: 249, minutter: 40,
        beskrivelse: "Fil, neglebånd, peeling og håndcreme. Godt til mænd og til dig, der vil have pæne negle uden farve.", stikord: ["naturligt", "uden lak", "mænd", "pleje"], billede: 2 },
    ],
    omArtisten: "Neglebaren Kastanje er en lille salon på Hvidovrevej med to stole. Sara og Amira laver hurtige, holdbare negle i dagtimerne – til dig, der vil ind og ud i frokostpausen. Rolige farver, chrome og pæne, naturlige negle. Ingen vipper.",
    stikord: ["hurtigt", "billigt", "frokostpause", "chrome", "nude", "naturlige negle", "butik"],
    praktisk: ["Salon i stueplan – kørestolsvenlig", "Bus 1A og 200S stopper ved døren", "MobilePay og kort", "Taler dansk, arabisk og engelsk", "Vegan og HEMA-fri gellak"],
    billeder: [
      { motiv: "glat", farver: ["#d8b4a0"], tekst: "Nude gellak" },
      { motiv: "chrome", farver: ["#c9ced6", "#ffffff"], tekst: "Sølv-chrome på korte negle" },
      { motiv: "naturlig", farver: ["#f3d5c8"], tekst: "Klassisk manicure uden lak" },
    ],
    dataVersion: 2,
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
async function kset(k: unknown[], v: unknown, expireIn?: number): Promise<void> {
  if (kv) await kv.set(k as Deno.KvKey, v, expireIn && expireIn > 0 ? { expireIn } : undefined);
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
for (const t of TESTSALONER) {
  const gl = await kget<Salon>(["salon", t.id]);
  if (!gl) await gemSalon(t);
  else if (gl.test && (gl.dataVersion ?? 0) < (t.dataVersion ?? 0)) await gemSalon({ ...t, aabning: gl.aabning, kalenderId: gl.kalenderId, email: gl.email }); // nye tekster, behold rettede åbningstider
}

// Bookinger
type Booking = {
  kode: string; token: string; salon: string; dato: string; tid: string; minutter: number;
  behandling: string; navn: string; telefon?: string; kilde: "ai" | "formular"; oprettet: string; eventId?: string; pris?: number;
};

// ---------- Hændelseslog – anonym: ingen navne, telefonnumre, IP-adresser eller bookingkoder ----------
type Haendelse = {
  t: string; type: string; klient: string; salon?: string; kategori?: string; behandling?: string;
  pris?: number; kilde?: string; dageFrem?: number; antal?: number; omraade?: string; grund?: string;
};
type Ctx = { klient: string; nySession?: string };
const LOG_GEMMES_DAGE = 395; // ca. 13 måneder (se /privatliv)
async function log(h: Omit<Haendelse, "t">): Promise<void> {
  const t = new Date().toISOString();
  try { await kset(["log", t + "-" + crypto.randomUUID().slice(0, 6)], { t, ...h }, LOG_GEMMES_DAGE * 86400000); } catch { /* loggen må aldrig vælte en booking */ }
}
const dageFra = (dato: string) => Math.round((lokalMs(dato, "12:00") - lokalMs(nuIKbh().dato, "12:00")) / 86400000);
function klientFraUA(ua: string): string {
  const u = ua.toLowerCase();
  if (u.includes("claude") || u.includes("anthropic")) return "Claude";
  if (u.includes("openai") || u.includes("chatgpt")) return "ChatGPT";
  if (u.includes("gemini") || u.includes("google")) return "Gemini";
  if (u.includes("grok") || u.includes("xai")) return "Grok";
  return ua ? "Andet (" + ua.slice(0, 24) + ")" : "Ukendt";
}
function klientNavn(info: unknown, ua: string): string {
  const n = String((info as { name?: string } | undefined)?.name ?? "").toLowerCase();
  if (n.includes("claude") || n.includes("anthropic")) return "Claude";
  if (n.includes("openai") || n.includes("chatgpt")) return "ChatGPT";
  if (n.includes("gemini")) return "Gemini";
  if (n.includes("grok")) return "Grok";
  if (n) return n.slice(0, 30);
  return klientFraUA(ua);
}
async function klientForRequest(req: Request): Promise<string> {
  const sid = req.headers.get("mcp-session-id");
  if (sid && /^[a-f0-9-]{36}$/.test(sid)) {
    const s = await kget<{ klient: string }>(["sess", sid]);
    if (s) return s.klient;
  }
  return klientFraUA(req.headers.get("user-agent") ?? "");
}
// Opbevaring (se /privatliv): en booking slettes automatisk 30 dage efter selve tiden.
const BOOKING_GEMMES_DAGE = 30;
async function gemBooking(b: Booking) {
  const udloeb = lokalMs(b.dato, b.tid) + (b.minutter + BOOKING_GEMMES_DAGE * 24 * 60) * 60000 - Date.now();
  const ms = Math.max(udloeb, 86400000);
  await kset(["booking", b.kode], b, ms);
  await kset(["token", b.token], b.kode, ms);
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
async function skrivHeldag(s: Salon, titel: string, dato: string): Promise<string> {
  if (brugerGoogle(s)) {
    const res = await gcal(`/calendars/${encodeURIComponent(kalenderFor(s)!)}/events`, {
      method: "POST", body: JSON.stringify({ summary: titel, start: { date: dato }, end: { date: plusDage(dato, 1) } }),
    });
    if (!res.ok) throw new Error(`Kunne ikke skrive i salonens kalender (${res.status}).`);
    return (await res.json()).id;
  }
  const id = crypto.randomUUID();
  await kset(["ev", s.id, id], { id, titel, start: lokalMs(dato, "00:00"), slut: lokalMs(plusDage(dato, 1), "00:00"), heldag: [dato, plusDage(dato, 1)] } as Ev);
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
      minutter: beh.minutter, behandling: beh.id, navn, telefon, kilde, oprettet: new Date().toISOString(), pris: beh.pris };
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
async function aflys(b: Booking, klient: string, kilde: string): Promise<void> {
  const s = await kget<Salon>(["salon", b.salon]);
  if (s && b.eventId) await sletEvent(s, b.eventId);
  await sletBooking(b);
  const pris = b.pris ?? s?.behandlinger.find((x) => x.id === b.behandling)?.pris;
  const kat = s?.behandlinger.find((x) => x.id === b.behandling)?.kategori;
  await log({ type: "aflysning", klient, kilde, salon: b.salon, behandling: b.behandling, kategori: kat, pris, dageFrem: dageFra(b.dato) });
}

// ---------- Fritekstsøgning ----------
const STOPORD = new Set(["og", "i", "til", "med", "en", "et", "jeg", "vil", "gerne", "have", "lavet", "der", "som", "for", "på", "af", "min", "mine",
  "noget", "nogle", "kan", "har", "skal", "lave", "nogen", "hvor", "hvem", "the", "a", "the", "gør", "laver", "sted", "steder", "tid"]);
const normTekst = (t: string) => t.toLowerCase().replace(/[^a-z0-9æøåéü]+/g, " ").trim();
const soegeord = (q: string) => [...new Set(normTekst(q).split(" ").filter((w) => w.length > 1 && !STOPORD.has(w)))].slice(0, 12);
function rammer(tekst: string, w: string): boolean {
  const t = " " + normTekst(tekst) + " ";
  if (t.includes(w)) return true;
  const stamme = w.length > 5 ? w.slice(0, w.length - 2) : w; // negle/neglene, røde/rød
  return stamme.length >= 4 && t.includes(" " + stamme);
}
const behTekst = (b: Behandling) => [b.navn, b.kategori, b.materiale ?? "", b.beskrivelse ?? "", ...(b.stikord ?? [])].join(" ");
const salonTekst = (s: Salon) => [s.navn, s.omraade, s.beskrivelse, s.omArtisten ?? "", ...(s.stikord ?? []), ...(s.praktisk ?? []),
  ...(s.billeder ?? []).map((b) => b.tekst), ...s.behandlinger.map(behTekst)].join(" ");
function soegSalon(s: Salon, ord: string[]): { score: number; ramt: string[] } {
  const tekst = salonTekst(s);
  const ramt = ord.filter((w) => rammer(tekst, w));
  return { score: ramt.length, ramt };
}

// ---------- Illustrationer (egne, ingen ophavsret) ----------
function illustration(b: Billede): string {
  const f = b.farver ?? ["#c1121f"];
  const W = 320, H = 240;
  const bg = `<rect width="${W}" height="${H}" rx="18" fill="#f7efe9"/>`;
  if (b.motiv === "vipper") {
    const vipper = Array.from({ length: 13 }, (_, i) => { const a = Math.PI * (0.12 + 0.76 * i / 12); const x1 = 160 - 95 * Math.cos(a), y1 = 132 - 40 * Math.sin(a); const x2 = 160 - 118 * Math.cos(a), y2 = 132 - 78 * Math.sin(a); return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} Q${((x1 + x2) / 2 - 4).toFixed(1)} ${((y1 + y2) / 2 - 6).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="#2b1d1a" stroke-width="3.2" fill="none" stroke-linecap="round"/>`; }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(b.tekst)}">${bg}<path d="M60 132 Q160 52 260 132 Q160 196 60 132Z" fill="#fff" stroke="#c9a99a" stroke-width="2"/><circle cx="160" cy="132" r="34" fill="#6b4a3a"/><circle cx="160" cy="132" r="15" fill="#1f1512"/><circle cx="150" cy="122" r="6" fill="#fff" opacity=".8"/>${vipper}<path d="M60 132 Q160 52 260 132" stroke="#2b1d1a" stroke-width="4" fill="none"/></svg>`;
  }
  // Hånd set ovenfra: fire fingre og en tommel med negle i motivets farve.
  const fingre = [[92, 70, 150], [132, 46, 168], [172, 50, 166], [212, 78, 148]];
  let negle = "", huden = "";
  const id = "g" + Math.abs([...b.tekst].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7));
  const defs = b.motiv === "chrome" ? `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".45" stop-color="${f[0]}"/><stop offset=".6" stop-color="#8a929e"/><stop offset="1" stop-color="#fff"/></linearGradient>` : "";
  for (const [x, top, h] of fingre) {
    huden += `<rect x="${x - 17}" y="${top}" width="34" height="${h}" rx="17" fill="#e9c2a6"/>`;
    const ny = top + 6, nh = 40;
    const fyld = b.motiv === "chrome" ? `url(#${id})` : b.motiv === "naturlig" ? f[0] : b.motiv === "french" ? "#f3d9d1" : f[0];
    negle += `<rect x="${x - 12}" y="${ny}" width="24" height="${nh}" rx="12" fill="${fyld}" ${b.motiv === "naturlig" ? 'stroke="#d9a892" stroke-width="1.5"' : ""}/>`;
    if (b.motiv === "french") negle += `<path d="M${x - 12} ${ny + 12} A12 12 0 0 1 ${x + 12} ${ny + 12} L${x + 12} ${ny + 16} Q${x} ${ny + 6} ${x - 12} ${ny + 16}Z" fill="#fffdfb"/><rect x="${x - 12}" y="${ny}" width="24" height="14" rx="12" fill="#fffdfb"/>`;
    if (b.motiv === "glimmer") for (let k = 0; k < 7; k++) negle += `<circle cx="${(x - 8 + ((k * 37) % 16)).toFixed(0)}" cy="${(ny + 6 + ((k * 23) % 30)).toFixed(0)}" r="${1 + (k % 3) * 0.8}" fill="${f[1] ?? "#d4af37"}"/>`;
    if (b.motiv === "kunst") negle += `<circle cx="${x}" cy="${ny + 20}" r="5" fill="${f[1] ?? "#fff"}"/>`;
    if (b.motiv !== "naturlig") negle += `<rect x="${x - 7}" y="${ny + 5}" width="4" height="16" rx="2" fill="#fff" opacity=".45"/>`;
  }
  const tommel = `<rect x="228" y="150" width="34" height="80" rx="17" fill="#e9c2a6" transform="rotate(-38 245 190)"/>`;
  const haand = `<rect x="70" y="150" width="166" height="100" rx="40" fill="#e9c2a6"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(b.tekst)}"><defs>${defs}</defs>${bg}${haand}${tommel}${huden}${negle}</svg>`;
}
const billedUrl = (s: Salon, i: number) => s.billeder?.[i]?.url ?? `${ORIGIN}/billede/${s.id}/${i}.svg`;

// ---------- Værktøjer (rene beskrivelser – ingen instrukser til assistenten) ----------
async function vaerktoejer() {
  const ids = (await alleSaloner()).map((s) => s.id);
  return [
    {
      name: "find_saloner", title: "Find saloner",
      description: `Viser de saloner, der kan bookes gennem ${BRAND}: område, kategorier, beskrivelse, om artisten, stikord for stil og specialer, praktiske forhold, prisniveau, åbningstider og billeder. Kan filtreres på kategori, område og fritekst (fx en stil, farve eller et ønske).`,
      inputSchema: { type: "object", properties: {
        soeg: { type: "string", description: "Fritekst, fx \"chili-røde negle\", \"chrome\", \"naturligt look\", \"parkering\" eller \"vegansk\"." },
        kategori: { type: "string", enum: [...KATEGORIER], description: "Vis kun saloner med behandlinger i denne kategori." },
        omraade: { type: "string", description: "Bynavn eller postnummer, fx Brøndby eller 2650." },
      }, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "vis_behandlinger", title: "Vis behandlinger og priser",
      description: "Viser behandlinger med kategori, pris, varighed, salonens egen beskrivelse, stikord og billede. Uden salon vises alle saloner. Kan filtreres med fritekst.",
      inputSchema: { type: "object", properties: {
        salon: { type: "string", enum: ids, description: "Salonens id fra find_saloner." },
        kategori: { type: "string", enum: [...KATEGORIER] },
        soeg: { type: "string", description: "Fritekst, der matches mod behandlingernes navn, beskrivelse og stikord." },
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
const behLinje = (b: Behandling, s?: Salon) => `- ${b.navn} (id: ${b.id}) · ${b.kategori}${b.slags && b.slags !== "andet" ? ", " + b.slags : ""}${b.materiale ? ", " + b.materiale : ""} · ${b.pris} kr · ${b.minutter} min${b.beskrivelse ? ` · ${b.beskrivelse}` : ""}${b.stikord?.length ? ` · Stikord: ${b.stikord.join(", ")}` : ""}${s && b.billede !== undefined && s.billeder?.[b.billede] ? ` · Billede: ${billedUrl(s, b.billede)}` : ""}`;

async function kald(navn: string, a: Record<string, unknown>, ctx: Ctx = { klient: "Ukendt" }) {
  const k = ctx.klient;
  const saloner = await alleSaloner();
  const ids = saloner.map((s) => s.id).join(", ");
  if (navn === "find_saloner") {
    const kat = a.kategori ? String(a.kategori) : null;
    const omr = a.omraade ? String(a.omraade).toLowerCase() : null;
    const q = a.soeg ? String(a.soeg).slice(0, 120) : "";
    const ord = soegeord(q);
    let liste = saloner.filter((s) => (!kat || s.behandlinger.some((b) => b.kategori === kat)) && (!omr || s.omraade.toLowerCase().includes(omr)));
    const traef = new Map(liste.map((s) => [s.id, soegSalon(s, ord)]));
    if (ord.length) liste = liste.filter((s) => traef.get(s.id)!.score > 0).sort((x, y) => traef.get(y.id)!.score - traef.get(x.id)!.score);
    await log({ type: "find_saloner", klient: k, kategori: kat ?? undefined, omraade: omr ? String(a.omraade).slice(0, 40) : undefined, antal: liste.length, grund: ord.length ? "fritekst: " + ord.join(" ").slice(0, 40) : undefined });
    if (!liste.length) return tekst(`Ingen saloner fundet${kat ? ` med ${kat}` : ""}${omr ? ` i ${a.omraade}` : ""}${q ? ` der matcher "${q}"` : ""}.`);
    return tekst(liste.map((s) => {
      const t = traef.get(s.id)!;
      return `- ${s.navn} (id: ${s.id})${testMaerke(s)} – ${s.omraade}.${ord.length ? ` Matcher: ${t.ramt.join(", ")}.` : ""} Kategorier: ${kategorierAf(s).join(", ")}. ${s.beskrivelse}` +
        `${s.omArtisten ? `\n  Om artisten: ${s.omArtisten}` : ""}${s.stikord?.length ? `\n  Stil og specialer: ${s.stikord.join(", ")}.` : ""}${s.praktisk?.length ? `\n  Praktisk: ${s.praktisk.join("; ")}.` : ""}` +
        `\n  Priser: ${prisSpand(s)}. Åbent: ${aabningTekst(s)}.${s.billeder?.length ? `\n  Billeder: ${s.billeder.map((b, i) => `${b.tekst} (${billedUrl(s, i)})`).join("; ")}.` : ""}\n  Salonens side: ${ORIGIN}/s/${s.id}`;
    }).join("\n"));
  }
  if (navn === "vis_behandlinger") {
    const valgt = a.salon ? saloner.find((s) => s.id === a.salon) : null;
    if (a.salon && !valgt) return tekst(`Ukendt salon. Gyldige: ${ids}.`, true);
    const kat = a.kategori ? String(a.kategori) : null;
    const ord = soegeord(a.soeg ? String(a.soeg).slice(0, 120) : "");
    await log({ type: "vis_behandlinger", klient: k, salon: valgt?.id ?? "alle", kategori: kat ?? undefined, grund: ord.length ? "fritekst: " + ord.join(" ").slice(0, 40) : undefined });
    return tekst((valgt ? [valgt] : saloner).map((s) => {
      const bh = s.behandlinger.filter((b) => (!kat || b.kategori === kat) && (!ord.length || ord.some((w) => rammer(behTekst(b), w))));
      return `${s.navn} (id: ${s.id})${testMaerke(s)} – ${s.omraade}\n${bh.length ? bh.map((b) => behLinje(b, s)).join("\n") : `- ingen behandlinger${kat ? " i kategorien" : ""}${ord.length ? " der matcher søgningen" : ""}`}`;
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
    let ialt = 0;
    for (const s of valgt ? [valgt] : saloner) {
      const beh = behId ? s.behandlinger.find((b) => b.id === behId) : null;
      if (behId && !beh) { if (valgt) afsnit.push(`${s.navn}: har ikke behandlingen "${behId}".`); continue; }
      const min = beh ? beh.minutter : korteste(s);
      const linjer: string[] = [];
      for (const [d, dag] of await dage(s, fra, n)) {
        const t = startTider(s, dag, min).map((m) => iKbh(m).tid);
        ialt += t.length;
        linjer.push(`  - ${danskDato(d)} (${d})${d === nu.dato ? ", i dag" : ""}: ${t.length ? t.join(", ") : "ingen ledige tider"}`);
      }
      afsnit.push(`${s.navn} (id: ${s.id}, ${s.omraade})${testMaerke(s)} – ${beh ? `${beh.navn}, ${beh.minutter} min, ${beh.pris} kr` : `korteste behandling, ${min} min`}:\n${linjer.join("\n")}`);
    }
    const behKat = behId ? saloner.flatMap((s) => s.behandlinger).find((b) => b.id === behId)?.kategori : undefined;
    await log({ type: "vis_ledige_tider", klient: k, salon: valgt?.id ?? "alle", behandling: behId ?? undefined, kategori: behKat, dageFrem: dageFra(fra), antal: ialt });
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
    if (!r.ok) {
      await log({ type: "booking_afvist", klient: k, kilde: "ai", salon: s.id, behandling: beh.id, kategori: beh.kategori, pris: beh.pris, dageFrem: dageFra(dato), grund: r.fejl.includes("taget") ? "taget lige før" : r.fejl.includes("bookes lige nu") ? "optaget" : "tid ikke ledig" });
      return tekst(r.fejl, true);
    }
    await log({ type: "booking", klient: k, kilde: "ai", salon: s.id, behandling: beh.id, kategori: beh.kategori, pris: beh.pris, dageFrem: dageFra(dato) });
    return tekst(`Booket: ${beh.navn} hos ${s.navn} (${s.omraade})${testMaerke(s)}, ${danskDato(dato)} kl. ${tid}–${iKbh(lokalMs(dato, tid) + beh.minutter * 60000).tid}. ` +
      `Pris ${beh.pris} kr, betales i salonen.\nKunde: ${kunde}. Bookingkode: ${r.b.kode}.\nSe eller aflys: ${ORIGIN}/booking/${r.b.token}\nAdresse: ${s.adresse}.`);
  }
  if (navn === "aflys_booking") {
    const kode = String(a.bookingkode ?? "").trim().toUpperCase();
    const b = await findKode(kode);
    if (!b) { await log({ type: "aflysning_ukendt_kode", klient: k }); return tekst(`Fandt ingen booking med koden ${kode}.`, true); }
    await aflys(b, k, "ai");
    const s = await kget<Salon>(["salon", b.salon]);
    return tekst(`Bookingen ${kode} hos ${s?.navn ?? b.salon} (${danskDato(b.dato)} kl. ${b.tid}) er aflyst. Tiden er ledig igen.`);
  }
  return tekst(`Ukendt værktøj: ${navn}`, true);
}

// ---------- MCP (JSON-RPC over HTTP) ----------
const PROTOKOLLER = ["2025-06-18", "2025-03-26", "2024-11-05"];
async function haandter(msg: { id?: unknown; method?: string; params?: Record<string, unknown> }, ctx: Ctx) {
  const svar = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize": {
      const oensket = String(msg.params?.protocolVersion ?? "");
      const sid = crypto.randomUUID();
      const klient = klientNavn(msg.params?.clientInfo, ctx.klient);
      ctx.klient = klient; ctx.nySession = sid;
      try {
        if (kv) await kv.set(["sess", sid], { klient, start: new Date().toISOString() }, { expireIn: 7 * 86400000 });
        else mem.set(memKey(["sess", sid]), { klient });
      } catch { /* ignorér */ }
      await log({ type: "forbindelse", klient });
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
      try { return svar(await kald(String(p.name), (p.arguments as Record<string, unknown>) ?? {}, ctx)); }
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
      beskrivelse: r.beskrivelse ? String(r.beskrivelse).slice(0, 500) : undefined,
      stikord: Array.isArray(r.stikord) ? r.stikord.map((x) => String(x).slice(0, 40)).slice(0, 12) : undefined,
      billede: typeof r.billede === "number" ? r.billede : undefined });
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
    omArtisten: String(inp.omArtisten ?? g?.omArtisten ?? "").slice(0, 1500) || undefined,
    stikord: (Array.isArray(inp.stikord) ? inp.stikord : g?.stikord ?? []).map((x: unknown) => String(x).slice(0, 40)).slice(0, 20),
    praktisk: (Array.isArray(inp.praktisk) ? inp.praktisk : g?.praktisk ?? []).map((x: unknown) => String(x).slice(0, 120)).slice(0, 12),
    billeder: (Array.isArray(inp.billeder) ? inp.billeder as Billede[] : g?.billeder ?? []).slice(0, 12)
      .map((b) => ({ url: b.url && /^https:\/\//.test(b.url) ? String(b.url).slice(0, 500) : undefined, motiv: b.motiv, farver: b.farver, tekst: String(b.tekst ?? "").slice(0, 80) })),
    dataVersion: g?.dataVersion,
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
let ORIGIN = PUBLIC_ORIGIN;
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
  `<!doctype html><html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${ekstra}<title>${esc(titel)}</title><style>${CSS}</style></head><body>${krop}<footer class="muted" style="margin:32px 0 8px;font-size:.85rem;border-top:1px solid var(--line);padding-top:12px"><a href="/privatliv">Privatlivspolitik</a> · <a href="/privacy" lang="en">Privacy policy</a></footer></body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const testBanner = (s?: Salon) => (s ? s.test : true) ? `<p class="test"><strong>Test.</strong> ${s ? `${esc(s.navn)} er opdigtet.` : "Saloner markeret som test er opdigtede."}</p>` : "";

const SALON_CSS = `.salon{display:grid;grid-template-columns:140px 1fr;gap:14px;align-items:start}.salon img{width:140px;border-radius:12px;display:block}
@media (max-width:480px){.salon{grid-template-columns:1fr}.salon img{width:100%}}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0}.chips span{font-size:.8rem;padding:2px 10px;border:1px solid var(--line);border-radius:999px;color:var(--muted)}
.galleri{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin:12px 0}.galleri figure{margin:0}.galleri img{width:100%;border-radius:12px;display:block}.galleri figcaption{font-size:.8rem;color:var(--muted);margin-top:4px}
.beh{border-top:1px solid var(--line);padding:8px 0}.beh:first-of-type{border-top:0}`;
async function forside(forsideUrl?: URL): Promise<Response> {
  const saloner = await alleSaloner();
  const q = (forsideUrl?.searchParams.get("q") ?? "").slice(0, 120);
  const ord = soegeord(q);
  const vis = ord.length ? saloner.map((s) => ({ s, t: soegSalon(s, ord) })).filter((x) => x.t.score > 0).sort((a, b) => b.t.score - a.t.score) : saloner.map((s) => ({ s, t: { score: 0, ramt: [] as string[] } }));
  if (ord.length) await log({ type: "sidesoegning", klient: "Bookingside", antal: vis.length, grund: "fritekst: " + ord.join(" ").slice(0, 40) });
  return html(BRAND, `${faner("/")}${saloner.some((s) => s.test) ? testBanner() : ""}<h1>${esc(BRAND)}</h1><p class="muted">Ledige tider og booking hos uafhængige saloner – også via din AI-assistent.</p>
<form method="get" class="kort" role="search" style="display:flex;gap:8px;align-items:center"><input name="q" value="${esc(q)}" placeholder="Søg efter stil, farve eller ønske – fx chili-røde negle" aria-label="Søg"><button style="width:auto;margin:0">Søg</button></form>` +
    (ord.length && !vis.length ? `<p class="test">Ingen saloner matcher "${esc(q)}".</p>` : "") +
    vis.map(({ s, t }) => `<div class="kort salon">${s.billeder?.length ? `<a href="/s/${s.id}"><img src="${esc(billedUrl(s, 0))}" alt="${esc(s.billeder[0].tekst)}" loading="lazy"></a>` : ""}<div><h2 style="margin:0"><a href="/s/${s.id}">${esc(s.navn)}</a>${s.test ? " <small class='muted'>(test)</small>" : ""}</h2><p style="margin:4px 0">${esc(s.omraade)} · ${kategorierAf(s).join(", ")} · ${prisSpand(s)}</p>${t.ramt.length ? `<p style="margin:4px 0">Matcher: <strong>${t.ramt.map(esc).join(", ")}</strong></p>` : ""}<p class="muted" style="margin:4px 0">${esc(s.beskrivelse)}</p>${s.stikord?.length ? `<p class="chips">${s.stikord.map((x) => `<span>${esc(x)}</span>`).join("")}</p>` : ""}</div></div>`).join(""),
    `<style>${SALON_CSS}</style>`);
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
  const galleri = s.billeder?.length ? `<div class="galleri">${s.billeder.map((b, i) => `<figure><img src="${esc(billedUrl(s, i))}" alt="${esc(b.tekst)}" loading="lazy"><figcaption>${esc(b.tekst)}</figcaption></figure>`).join("")}</div>` : "";
  const om = `${s.omArtisten ? `<div class="kort"><h2 style="margin-top:0">Om ${s.test ? "artisten" : "os"}</h2><p>${esc(s.omArtisten)}</p>${s.stikord?.length ? `<p class="chips">${s.stikord.map((x) => `<span>${esc(x)}</span>`).join("")}</p>` : ""}</div>` : ""}` +
    `<div class="kort"><h2 style="margin-top:0">Behandlinger</h2>${s.behandlinger.map((b) => `<div class="beh"><strong>${esc(b.navn)}</strong> – ${b.pris} kr · ${b.minutter} min${b.beskrivelse ? `<br><span class="muted">${esc(b.beskrivelse)}</span>` : ""}</div>`).join("")}</div>` +
    `${s.praktisk?.length ? `<div class="kort"><h2 style="margin-top:0">Praktisk</h2><ul>${s.praktisk.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}`;
  return html(`${s.navn} – book tid`, `${faner("/")}${testBanner(s)}<p><a href="/">← Alle saloner</a></p><h1>${esc(s.navn)}</h1>
<p>${esc(s.omraade)}</p><p class="muted">${esc(s.beskrivelse)}</p>${galleri}${besked}
<form method="get" class="kort"><label for="b">Behandling</label><select id="b" name="b" onchange="this.form.submit()">${valg}</select><noscript><button>Vis tider</button></noscript></form>
<form method="post" action="/s/${s.id}/book" class="kort"><input type="hidden" name="behandling" value="${beh.id}">
<h2 style="margin-top:0">Ledige tider til ${esc(beh.navn)}</h2>${tider || "<p>Ingen ledige tider de næste 7 dage.</p>"}
<label for="navn">Dit navn</label><input id="navn" name="navn" required maxlength="60" autocomplete="name">
<label for="tlf">Telefon (valgfrit)</label><input id="tlf" name="telefon" maxlength="20" autocomplete="tel" inputmode="tel">
<button type="submit">Book tiden</button><p class="muted">Betaling sker hos salonen. Du får en bookingkode og et link til at aflyse.</p></form>${om}`, `<style>${SALON_CSS}</style>`);
}

// ---------- "Book via din AI": kundens første ja ----------
const AI_CSS = `.ai .btn{display:block;text-align:center;padding:14px 16px;border-radius:12px;font-weight:600;text-decoration:none;margin-top:8px}
.ai .primaer{background:var(--accent);color:#fff}.ai .sekundaer{background:var(--card);border:1px solid var(--line);color:var(--fg)}
.ai .proev{display:flex;gap:8px;align-items:center;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-top:8px}
.ai .proev span{flex:1;font-size:.95rem;word-break:break-word}.ai .kopi{width:auto;margin:0;padding:6px 10px;font-size:.85rem;background:var(--card);color:var(--fg);border:1px solid var(--line)}
.ai details{margin-top:10px}.ai summary{cursor:pointer;color:var(--muted)}.ai .qr{text-align:center}.ai .qr img{background:#fff;padding:10px;border-radius:12px;width:200px;height:200px;image-rendering:pixelated}`;
async function aiSide(url: URL): Promise<Response> {
  const s = url.searchParams.get("salon") ? await hentSalon(url.searchParams.get("salon")) : null;
  const navn = s ? s.navn : BRAND.replace(/ \(test\)$/, "");
  const mcp = `${ORIGIN}/mcp`;
  const claudeLink = `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent(BRAND)}&connectorUrl=${encodeURIComponent(mcp)}`;
  const proev = s ? `Jeg vil gerne booke ${s.behandlinger[0]?.navn.toLowerCase() ?? "en tid"} hos ${s.navn} i næste uge. Hvad er ledigt?` : "Jeg skal have lavet negle i næste uge. Kan du finde og booke en ledig tid?";
  const selv = `${ORIGIN}/ai${s ? "?salon=" + s.id : ""}`;
  await log({ type: "ai_side", klient: "Bookingside", salon: s?.id });
  const titel = s ? `Book ${navn} via din AI` : "Book negle og vipper via din AI";
  return html(titel, `${faner("")}${testBanner(s ?? undefined)}<div class="ai"><h1>${esc(titel)}</h1>
<p class="muted">Tilføj ${esc(BRAND.replace(/ \(test\)$/, ""))} én gang. Bagefter kan du bare skrive "book negle i næste uge" til din assistent – så finder den ledige tider${s ? "" : " hos alle vores saloner"} og booker for dig.</p>
<div class="kort"><h2 style="margin:0">Claude</h2><p class="muted">Virker i Claude-appen og på claude.ai. Den gratis plan kan have én egen forbindelse.</p>
<a class="btn primaer" href="${esc(claudeLink)}">Tilføj til Claude</a>
<details><summary>Hvad sker der, når jeg trykker?</summary><ol><li>Claude åbner med navn og adresse udfyldt. Du ser en advarsel om, at forbindelsen kommer fra et link – det er normalt, fordi vi endnu ikke er i Claudes katalog.</li><li>Tryk <strong>Fortsæt</strong>, så <strong>Tilføj</strong>, så <strong>Opret forbindelse</strong>.</li><li>Første gang Claude bruger os, spørger den om lov. Vælg <strong>Tillad altid</strong>, så slipper du for at blive spurgt igen.</li></ol></details></div>
<div class="kort"><h2 style="margin:0">ChatGPT</h2><p class="muted">Kommer, når vi er godkendt i ChatGPTs app-katalog. Indtil da kan du bruge Claude eller booke direkte her på siden.</p></div>
<div class="kort"><h2 style="margin:0">Gemini, Grok og andre</h2><p class="muted">Tilføjes under indstillinger som egen forbindelse (custom connector). Indsæt denne adresse:</p>
<div class="proev"><span id="mcpurl">${esc(mcp)}</span><button class="kopi" data-kopi="mcpurl">Kopiér</button></div></div>
<div class="kort"><h2 style="margin:0">Prøv bagefter</h2><p class="muted">Start en ny samtale og skriv fx:</p><div class="proev"><span id="p1">${esc(proev)}</span><button class="kopi" data-kopi="p1">Kopiér</button></div></div>
<div class="kort"><h2 style="margin:0">Uden AI</h2><p class="muted">Se ledige tider og book direkte.</p><a class="btn sekundaer" href="${s ? `/s/${s.id}` : "/"}">Se ledige tider</a></div>
<div class="kort qr"><h2 style="margin:0">Del siden</h2><p class="muted">Scan med telefonens kamera.</p><img id="qr" alt="QR-kode til denne side" width="200" height="200"><p class="muted" style="font-size:.85rem">${esc(selv.replace(/^https:\/\//, ""))}</p></div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>
<script>document.querySelectorAll('.kopi').forEach(b=>b.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(document.getElementById(b.dataset.kopi).textContent.trim());b.textContent='Kopieret';setTimeout(()=>b.textContent='Kopiér',1500)}catch(e){}}));
try{const q=qrcode(0,'M');q.addData(${JSON.stringify(selv)});q.make();document.getElementById('qr').src=q.createDataURL(8,4)}catch(e){}</script>`, `<style>${AI_CSS}</style>`);
}
const aiKort = (s?: Salon | null) => `<div class="kort"><h2 style="margin-top:0">Næste gang: spørg bare din AI</h2><p class="muted">Tilføj ${esc(BRAND.replace(/ \(test\)$/, ""))} til Claude én gang, så kan du booke${s ? ` hos ${esc(s.navn)}` : ""} ved at skrive eller sige det. Del gerne linket med en veninde.</p><p><a href="/ai${s ? "?salon=" + s.id : ""}"><strong>Book via din AI →</strong></a></p></div>`;

// ---------- Privatlivspolitik (/privatliv og /privacy) ----------
// Teksten skal passe til det, koden faktisk gør. Ret begge, hvis du ændrer dataene.
const KONTAKT = env("KONTAKT_EMAIL") ?? "kontakt@bookbar.dk";
const PRIVATLIV_OPDATERET = "10. oktober 2026";
const PRIVACY_UPDATED = "10 October 2026";
function privatlivSide(sprog: "da" | "en"): Response {
  const k = `<a href="mailto:${esc(KONTAKT)}">${esc(KONTAKT)}</a>`;
  if (sprog === "en") return html(`${BRAND} – privacy policy`, `<div lang="en">
<h1>Privacy policy</h1>
<p class="muted">Last updated ${PRIVACY_UPDATED}. <a href="/privatliv" lang="da">Dansk udgave</a> (the Danish version applies if the two differ).</p>
<p class="test"><strong>Test phase.</strong> ${esc(BRAND)} is under development. Salons marked as test salons are fictional.</p>

<h2>Who we are</h2>
<p>${esc(BRAND)} lets you find treatments, prices and free times at independent salons and book a time – on bookbar.dk or through an AI assistant such as ChatGPT or Claude. ${esc(BRAND)} is run by Torben Quaade, a private individual in Copenhagen, Denmark, who is the data controller. Contact: ${k}.</p>

<h2>What we collect and why</h2>
<ul>
<li><strong>When you book:</strong> your name, your phone number if you give it, the salon, treatment, date and time, and whether you booked on our website or through an AI assistant. We use this to make the booking, to show it to you and to let you cancel it. Legal basis: performing the booking you ask for (GDPR art. 6(1)(b)).</li>
<li><strong>The salon gets your booking:</strong> the booking, with your name and phone number if given, is written into the salon's own calendar so the salon knows you are coming. From then on the salon is responsible for its calendar.</li>
<li><strong>When you search or look up times:</strong> we keep an anonymous event log: what kind of lookup it was, salon, category, treatment, price, how many days ahead, which assistant asked (for example "ChatGPT" or "Claude"), and up to 40 characters of free-text search words. The log has no names, phone numbers, IP addresses, booking codes or account information. We use it to see what people look for and to improve the service. Legal basis: our legitimate interest (art. 6(1)(f)). Please do not write personal information in search words.</li>
<li><strong>Connection sessions:</strong> when an AI assistant connects, we store a random session number and the assistant's name for 7 days, so we know which assistant sent a request.</li>
</ul>
<p>We do <strong>not</strong> receive your chat history or conversation with the AI assistant – only the information the assistant sends to our tools (for example the salon, treatment, time and your name when you book). We do not ask for your location, payment details, passwords or ID numbers. We do not use cookies for tracking or advertising, and we do not sell or share your data for marketing.</p>

<h2>How long we keep it</h2>
<ul>
<li>Bookings are deleted automatically 30 days after the booked time, and right away if you cancel.</li>
<li>The anonymous event log is deleted automatically after about 13 months.</li>
<li>Connection sessions are deleted after 7 days.</li>
<li>The salon keeps the appointment in its own calendar according to its own rules.</li>
</ul>

<h2>Who processes the data</h2>
<ul>
<li><strong>Deno Land Inc.</strong> (USA) hosts our server and database. During the test phase the database is located in the USA. We will move it to the EU before the first real salon joins.</li>
<li><strong>Google</strong> (Google Calendar) stores the salon's calendar where the booking is written.</li>
<li><strong>The AI assistant you use</strong> (for example OpenAI or Anthropic) handles your conversation under its own privacy policy.</li>
</ul>

<h2>Your rights and choices</h2>
<p>You can cancel a booking at any time with the link you receive when you book, or by asking your AI assistant to cancel it with your booking code – the booking is then deleted. You have the right to access, correct and delete your data, to object to our use of it and to data portability. Write to ${k}. You can also complain to the Danish Data Protection Agency (Datatilsynet, datatilsynet.dk).</p>

<h2>Changes</h2>
<p>If we change how we handle data, we update this page and the date at the top.</p>
</div>`);

  return html(`${BRAND} – privatlivspolitik`, `
<h1>Privatlivspolitik</h1>
<p class="muted">Sidst opdateret ${PRIVATLIV_OPDATERET}. <a href="/privacy" lang="en">English version</a>.</p>
<p class="test"><strong>Testfase.</strong> ${esc(BRAND)} er under opbygning. Saloner markeret som test er opdigtede.</p>

<h2>Hvem vi er</h2>
<p>${esc(BRAND)} gør det muligt at finde behandlinger, priser og ledige tider hos uafhængige saloner og booke en tid – på bookbar.dk eller gennem en AI-assistent som ChatGPT eller Claude. ${esc(BRAND)} drives af Torben Quaade, privatperson i København, som er dataansvarlig. Kontakt: ${k}.</p>

<h2>Hvad vi indsamler, og hvorfor</h2>
<ul>
<li><strong>Når du booker:</strong> dit navn, dit telefonnummer hvis du oplyser det, salon, behandling, dato og tidspunkt, og om du bookede på vores side eller gennem en AI-assistent. Vi bruger det til at lave bookingen, vise den for dig og lade dig aflyse den. Grundlag: at gennemføre den booking, du beder om (databeskyttelsesforordningen art. 6, stk. 1, litra b).</li>
<li><strong>Salonen får din booking:</strong> bookingen skrives med dit navn og eventuelt telefonnummer ind i salonens egen kalender, så salonen ved, at du kommer. Derfra er salonen ansvarlig for sin kalender.</li>
<li><strong>Når du søger eller ser tider:</strong> vi fører en anonym hændelseslog: hvilken slags opslag, salon, kategori, behandling, pris, hvor mange dage frem, hvilken assistent der spurgte (fx "ChatGPT" eller "Claude") og højst 40 tegn af fritekst-søgeord. Loggen indeholder ikke navne, telefonnumre, IP-adresser, bookingkoder eller kontooplysninger. Vi bruger den til at se, hvad folk leder efter, og til at forbedre tjenesten. Grundlag: vores legitime interesse (art. 6, stk. 1, litra f). Skriv venligst ikke personlige oplysninger i søgeord.</li>
<li><strong>Forbindelser:</strong> når en AI-assistent forbinder sig, gemmer vi et tilfældigt sessionsnummer og assistentens navn i 7 dage, så vi ved, hvilken assistent der spørger.</li>
</ul>
<p>Vi modtager <strong>ikke</strong> din chathistorik eller samtale med AI-assistenten – kun de oplysninger, assistenten sender til vores værktøjer (fx salon, behandling, tidspunkt og dit navn, når du booker). Vi spørger ikke efter din position, betalingsoplysninger, adgangskoder eller cpr-nummer. Vi bruger ikke cookies til sporing eller annoncer, og vi sælger eller deler ikke dine data til markedsføring.</p>

<h2>Hvor længe vi gemmer</h2>
<ul>
<li>Bookinger slettes automatisk 30 dage efter den bookede tid – og med det samme, hvis du aflyser.</li>
<li>Den anonyme hændelseslog slettes automatisk efter ca. 13 måneder.</li>
<li>Forbindelser (sessioner) slettes efter 7 dage.</li>
<li>Salonen gemmer aftalen i sin egen kalender efter sine egne regler.</li>
</ul>

<h2>Hvem der behandler data for os</h2>
<ul>
<li><strong>Deno Land Inc.</strong> (USA) driver vores server og database. I testfasen ligger databasen i USA. Vi flytter den til EU, før den første rigtige salon kommer med.</li>
<li><strong>Google</strong> (Google Kalender) opbevarer salonens kalender, hvor bookingen skrives ind.</li>
<li><strong>Den AI-assistent, du bruger</strong> (fx OpenAI eller Anthropic), behandler din samtale efter sin egen privatlivspolitik.</li>
</ul>

<h2>Dine rettigheder og valg</h2>
<p>Du kan altid aflyse en booking med linket, du får, når du booker, eller ved at bede din AI-assistent aflyse den med bookingkoden – så slettes bookingen. Du har ret til indsigt, berigtigelse og sletning, til at gøre indsigelse mod vores brug af dine data og til dataportabilitet. Skriv til ${k}. Du kan også klage til Datatilsynet (datatilsynet.dk).</p>

<h2>Ændringer</h2>
<p>Hvis vi ændrer, hvordan vi behandler data, opdaterer vi denne side og datoen øverst.</p>`);
}

// ---------- Faneblade ----------
const NAV_CSS = `.faner{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--line);margin:0 0 16px;padding-bottom:8px}
.faner a{padding:8px 14px;border-radius:999px;text-decoration:none;color:var(--fg);font-weight:600}.faner a.valgt{background:var(--accent);color:#fff}.faner a:not(.valgt):hover{background:var(--card)}`;
const faner = (aktiv: string) => `<style>${NAV_CSS}</style><nav class="faner" aria-label="Sider">` +
  [["/", "Saloner"], ["/kalender", "Kalender"], ["/dashboard", "Dashboard"], ["/intern", "Intern"], ["/status", "Status"]]
    .map(([h, t]) => `<a href="${h}"${h === aktiv ? ' class="valgt" aria-current="page"' : ""}>${t}</a>`).join("") + "</nav>";

// ---------- Kalender: se og ret salonernes kalender ----------
// Testsaloner kan rettes af alle (kun opdigtede data). Rigtige saloner kræver ADMIN_TOKEN som kode.
function maaRette(s: Salon, kode: string): boolean {
  if (s.test) return true;
  const t = env("ADMIN_TOKEN");
  return !!t && kode === t;
}
const mandagI = (dato: string) => plusDage(dato, -ugedag(dato));
const KAL_CSS = `html body{max-width:960px}.uge{display:grid;gap:10px}.dag{background:var(--card);border-radius:12px;padding:10px 14px}
.dag h3{margin:0 0 4px;font-size:1rem}.ev{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--line)}.ev:first-of-type{border-top:0}
.ev .t{font-variant-numeric:tabular-nums;white-space:nowrap;min-width:96px}.ev .x{flex:1}.ev form{margin:0}.ev button,.mini{width:auto;margin:0;padding:6px 10px;font-size:.85rem;border-radius:8px}
.mrk{display:inline-block;font-size:.75rem;padding:1px 8px;border-radius:999px;border:1px solid var(--line);margin-left:6px;color:var(--muted)}
.mrk.b{border-color:var(--accent);color:var(--accent)}.lukket{color:var(--muted);font-style:italic}.raekke{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
.vaelg a{display:inline-block;padding:6px 12px;border:1px solid var(--line);border-radius:999px;margin:0 4px 4px 0;text-decoration:none;color:var(--fg)}.vaelg a.valgt{background:var(--accent);border-color:var(--accent);color:#fff}
details summary{cursor:pointer;font-weight:600}`;
async function kalenderside(url: URL, besked = ""): Promise<Response> {
  const saloner = await alleSaloner(true);
  const s = saloner.find((x) => x.id === url.searchParams.get("salon")) ?? saloner[0];
  const iDag = nuIKbh().dato;
  const uge = mandagI(datoOk(url.searchParams.get("uge") ?? "") ? url.searchParams.get("uge")! : iDag);
  const fra = lokalMs(uge, "00:00"), til = lokalMs(plusDage(uge, 7), "00:00");
  let evs: Ev[] = [];
  let fejl = "";
  try { evs = await hentEvents(s, fra, til); } catch (e) { fejl = (e as Error).message; }
  const bookinger = (await klist<Booking>(["booking"])).filter((b) => b.salon === s.id);
  const efterEvent = new Map(bookinger.filter((b) => b.eventId).map((b) => [b.eventId!, b]));
  const korteste = Math.min(...s.behandlinger.map((b) => b.minutter));
  const ledigt = await dage(s, uge, 7).catch(() => new Map<string, Dag>());
  const q = (u: string) => `/kalender?salon=${s.id}&uge=${u}`;
  const skjult = `<input type="hidden" name="salon" value="${s.id}"><input type="hidden" name="uge" value="${uge}">${s.test ? "" : '<input type="password" name="kode" placeholder="Kode" required style="max-width:140px">'}`;
  let dagHtml = "";
  for (let i = 0; i < 7; i++) {
    const d = plusDage(uge, i);
    const aab = s.aabning[String(i)] ?? [];
    const dagEvs = evs.filter((e) => e.heldag ? (e.heldag[0] <= d && d < e.heldag[1]) : (iKbh(e.start).dato === d)).sort((a, b) => a.start - b.start);
    const lukket = dagEvs.some((e) => e.heldag && erLukket(e.titel));
    const tider = ledigt.get(d) ? startTider(s, ledigt.get(d)!, korteste).length : 0;
    const linjer = dagEvs.map((e) => {
      const b = efterEvent.get(e.id);
      const tid = e.heldag ? "Hele dagen" : `${iKbh(e.start).tid}–${iKbh(e.slut).tid}`;
      const beh = b ? s.behandlinger.find((x) => x.id === b.behandling) : undefined;
      const tekstDel = b ? `${esc(beh?.navn ?? b.behandling)} – ${esc(b.navn)}<span class="mrk b">${b.kilde === "ai" ? "booket via AI" : "booket på siden"}</span>`
        : `${esc(e.titel || "(uden titel)")}<span class="mrk">${e.heldag ? (erLukket(e.titel) ? "lukket" : "heldag") : erFri(e.titel) || e.fri ? "ledig" : "blokering"}</span>`;
      const knap = b ? `<form method="post" action="/kalender/aflys">${skjult}<input type="hidden" name="kode_b" value="${b.kode}"><button class="mini" onclick="return confirm('Aflys ${b.kode}?')">Aflys</button></form>`
        : `<form method="post" action="/kalender/slet">${skjult}<input type="hidden" name="id" value="${esc(e.id)}"><button class="mini" onclick="return confirm('Slet aftalen?')">Slet</button></form>`;
      return `<div class="ev"><span class="t">${tid}</span><span class="x">${tekstDel}</span>${knap}</div>`;
    }).join("");
    dagHtml += `<div class="dag"><h3>${danskDato(d)}${d === iDag ? " · i dag" : ""}</h3><p class="muted" style="margin:0 0 6px">${lukket ? '<span class="lukket">Lukket</span>' : aab.length ? "Åbent " + aab.map(([a, b]) => `${a}–${b}`).join(", ") + ` · ${tider} ledige starttider (${korteste} min)` : '<span class="lukket">Ingen åbningstid</span>'}</p>${linjer || '<p class="muted" style="margin:0">Ingen aftaler.</p>'}</div>`;
  }
  const aabForm = UGEDAGE.map((navn, i) => { const [a, b] = (s.aabning[String(i)] ?? [])[0] ?? ["", ""]; return `<div><label for="a${i}">${navn}</label><div style="display:flex;gap:4px"><input id="a${i}" name="fra${i}" type="time" value="${a}" step="900"><input name="til${i}" type="time" value="${b}" step="900" aria-label="${navn} til"></div></div>`; }).join("");
  const krop = `${faner("/kalender")}${testBanner(s)}<h1>Kalender</h1>
<p class="muted">Det samme, som AI-assistenterne ser. Ledige tider = åbningstid minus alle aftaler i kalenderen.${brugerGoogle(s) ? " Kalenderen ligger hos Google – ændringer her slår igennem dér og omvendt." : " Intern testkalender."}</p>
<nav class="vaelg" aria-label="Salon">${saloner.map((x) => `<a href="/kalender?salon=${x.id}&uge=${uge}" class="${x.id === s.id ? "valgt" : ""}">${esc(x.navn)}${x.test ? "" : " 🔒"}</a>`).join("")}</nav>
<nav class="vaelg" aria-label="Uge"><a href="${q(plusDage(uge, -7))}">← Forrige uge</a><a href="${q(mandagI(iDag))}" class="${uge === mandagI(iDag) ? "valgt" : ""}">Denne uge</a><a href="${q(plusDage(uge, 7))}">Næste uge →</a></nav>
${besked}${fejl ? `<p class="test">${esc(fejl)}</p>` : ""}
<div class="uge">${dagHtml}</div>
<div class="kort"><h2 style="margin-top:0">Bloker en tid</h2><form method="post" action="/kalender/bloker">${skjult}
<div class="raekke"><div><label for="bd">Dato</label><input id="bd" name="dato" type="date" value="${uge < iDag && plusDage(uge, 7) > iDag ? iDag : uge}" required></div>
<div><label for="bf">Fra</label><input id="bf" name="fra" type="time" step="900"></div><div><label for="bt">Til</label><input id="bt" name="til" type="time" step="900"></div>
<div><label for="bn">Tekst</label><input id="bn" name="titel" value="Optaget" maxlength="60"></div></div>
<label style="font-weight:400"><input type="checkbox" name="heldag" value="1" style="width:auto"> Luk hele dagen (ignorerer fra/til)</label>
<button type="submit">Gem i kalenderen</button></form></div>
<details class="kort"><summary>Ret åbningstider</summary><form method="post" action="/kalender/aabning">${skjult}<div class="raekke">${aabForm}</div>
<p class="muted">Tomt felt = lukket den dag. Én åbningsperiode pr. dag.</p><button type="submit">Gem åbningstider</button></form></details>`;
  return html(`${BRAND} – kalender`, krop, `<style>${KAL_CSS}</style><meta name="robots" content="noindex">`);
}
async function kalenderPost(req: Request, url: URL): Promise<Response> {
  const f = await req.formData();
  const s = await kget<Salon>(["salon", String(f.get("salon") ?? "")]);
  const uge = String(f.get("uge") ?? "");
  const tilbage = (besked: string) => { const u = new URL(url); u.pathname = "/kalender"; u.search = ""; if (s) u.searchParams.set("salon", s.id); if (datoOk(uge)) u.searchParams.set("uge", uge); return kalenderside(u, besked); };
  if (!s) return tilbage(`<p class="test">Ukendt salon.</p>`);
  if (!maaRette(s, String(f.get("kode") ?? ""))) return tilbage(`<p class="test">Forkert kode – rigtige saloner kan kun rettes med administrationskoden.</p>`);
  const ok = (t: string) => tilbage(`<p class="kort" role="status">✓ ${esc(t)}</p>`);
  try {
    if (url.pathname === "/kalender/bloker") {
      const dato = String(f.get("dato") ?? ""), titel = String(f.get("titel") ?? "").trim().slice(0, 60) || "Optaget";
      if (!datoOk(dato)) return tilbage(`<p class="test">Vælg en dato.</p>`);
      if (f.get("heldag")) { await skrivHeldag(s, "Lukket", dato); return ok(`${danskDato(dato)} er lukket.`); }
      const a = normTid(f.get("fra")), b = normTid(f.get("til"));
      if (!tidOk(a) || !tidOk(b) || a >= b) return tilbage(`<p class="test">Angiv fra og til, fx 12:00 og 13:00.</p>`);
      await skrivEvent(s, titel, `Lagt ind via ${BRAND}s kalenderside.`, lokalMs(dato, a), lokalMs(dato, b));
      return ok(`${titel} ${danskDato(dato)} kl. ${a}–${b} er lagt i kalenderen.`);
    }
    if (url.pathname === "/kalender/slet") {
      const id = String(f.get("id") ?? "");
      const b = (await klist<Booking>(["booking"])).find((x) => x.eventId === id);
      if (b) { await aflys(b, "Kalenderside", "salon"); return ok(`Bookingen ${b.kode} er aflyst.`); }
      await sletEvent(s, id);
      return ok("Aftalen er slettet.");
    }
    if (url.pathname === "/kalender/aflys") {
      const b = await findKode(String(f.get("kode_b") ?? ""));
      if (!b || b.salon !== s.id) return tilbage(`<p class="test">Bookingen findes ikke længere.</p>`);
      await aflys(b, "Kalenderside", "salon");
      return ok(`Bookingen ${b.kode} er aflyst, og tiden er ledig igen.`);
    }
    if (url.pathname === "/kalender/aabning") {
      const ny: Aabning = {};
      for (let i = 0; i < 7; i++) {
        const a = normTid(f.get("fra" + i)), b = normTid(f.get("til" + i));
        if (!a && !b) continue;
        if (!tidOk(a) || !tidOk(b) || a >= b) return tilbage(`<p class="test">${UGEDAGE[i]}: angiv både fra og til, og fra skal være før til.</p>`);
        ny[String(i)] = [[a, b]];
      }
      await gemSalon({ ...s, aabning: ny });
      return ok("Åbningstiderne er gemt.");
    }
  } catch (e) { return tilbage(`<p class="test">Fejl: ${esc((e as Error).message)}</p>`); }
  return tilbage("");
}

// ---------- Intern: projektets egne analyser, krypteret med en kode (repoet er offentligt) ----------
type Krypt = { iv: string; data: string };
type InternPakke = { salt: string; iter: number; tjek: Krypt; sider: Record<string, Krypt> };
const INTERN_SIDER: { id: string; titel: string; tekst: string }[] = [
  { id: "projektkort", titel: "Projektkort", tekst: "Status, kæden af ubeviste led, spor, tests og åbne spørgsmål." },
  { id: "investorcase", titel: "Investorcase og realiserbarhed", tekst: "Bevistrappe, Lean Canvas, antagelser, markedsberegner, aktører, voldgrav, risici og plan." },
  { id: "rute", titel: "Ruten fra kunde til salon", tekst: "Flowdiagram over hvert led – hvad er bevist, og hvad mangler." },
];
let internPakke: InternPakke | null = null;
const noegler = new Map<string, CryptoKey>();
const fraB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function hentPakke(): Promise<InternPakke | null> {
  if (internPakke) return internPakke;
  try { internPakke = JSON.parse(await Deno.readTextFile(new URL("./intern/analyser.json", import.meta.url))); } catch { internPakke = null; }
  return internPakke;
}
async function dekrypter(kode: string, k: Krypt): Promise<string | null> {
  const p = await hentPakke();
  if (!p || !kode) return null;
  try {
    let key = noegler.get(kode);
    if (!key) {
      const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(kode), "PBKDF2", false, ["deriveKey"]);
      key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: fraB64(p.salt), iterations: p.iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    }
    const ud = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fraB64(k.iv) }, key, fraB64(k.data)));
    if (noegler.size < 20) noegler.set(kode, key);
    return ud;
  } catch { return null; }
}
const internKode = (req: Request) => decodeURIComponent((req.headers.get("cookie") ?? "").match(/(?:^|;\s*)bb_intern=([^;]+)/)?.[1] ?? "");
async function kodeOk(kode: string): Promise<boolean> {
  const p = await hentPakke();
  return !!p && (await dekrypter(kode, p.tjek)) === "bookbar-intern-ok";
}
async function intern(req: Request, url: URL): Promise<Response> {
  const p = await hentPakke();
  if (url.pathname === "/intern/log-ind" && req.method === "POST") {
    const kode = String((await req.formData()).get("kode") ?? "").trim().toLowerCase();
    if (!(await kodeOk(kode))) return internLogin("Forkert kode.");
    return new Response(null, { status: 303, headers: { location: "/intern", "set-cookie": `bb_intern=${encodeURIComponent(kode)}; Path=/intern; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax` } });
  }
  if (url.pathname === "/intern/log-ud") return new Response(null, { status: 303, headers: { location: "/intern", "set-cookie": "bb_intern=; Path=/intern; Max-Age=0; HttpOnly; Secure; SameSite=Lax" } });
  const kode = internKode(req);
  if (!p) return html("Intern", `${faner("/intern")}<h1>Intern</h1><p>Analyserne er ikke lagt op endnu.</p>`);
  if (!(await kodeOk(kode))) return internLogin("");
  const m = url.pathname.match(/^\/intern\/([a-z-]+)$/);
  if (m && p.sider[m[1]]) {
    const side = await dekrypter(kode, p.sider[m[1]]);
    if (!side) return internLogin("Koden virker ikke længere.");
    const bar = `<div style="position:sticky;top:0;z-index:99;background:#b8476b;color:#fff;font:600 14px system-ui,sans-serif;padding:8px 16px"><a href="/intern" style="color:#fff">← Intern</a> · kun til internt brug</div>`;
    return new Response(side.replace(/<body([^>]*)>/i, (t) => t + bar).replace(/<head>/i, '<head><meta name="robots" content="noindex">'),
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "x-robots-tag": "noindex" } });
  }
  return html(`${BRAND} – intern`, `${faner("/intern")}<h1>Intern</h1><p class="muted">Projektets egne analyser. Kun for os – siderne er krypterede og åbnes med koden.</p>` +
    INTERN_SIDER.filter((s) => p.sider[s.id]).map((s) => `<div class="kort"><h2 style="margin:0"><a href="/intern/${s.id}">${esc(s.titel)}</a></h2><p class="muted" style="margin:4px 0 0">${esc(s.tekst)}</p></div>`).join("") +
    `<div class="kort"><h2 style="margin:0"><a href="https://claude.ai/code/artifact/94a932a0-bb84-4e6e-91d5-4655ba4f9e07" rel="noopener">Forretningsoplæg – Veninde-platformen</a></h2><p class="muted" style="margin:4px 0 0">Claude-dokument fra 8. oktober. Åbnes i Claude med din konto. Bemærk: betalingsmodellen er genåbnet siden.</p></div>` +
    `<p><a href="/intern/log-ud">Log ud</a></p>`, `<meta name="robots" content="noindex">`);
}
const internLogin = (fejl: string) => html(`${BRAND} – intern`, `${faner("/intern")}<h1>Intern</h1><p class="muted">Projektets egne analyser. Skriv koden for at åbne dem.</p>${fejl ? `<p class="test">${esc(fejl)}</p>` : ""}
<form method="post" action="/intern/log-ind" class="kort"><label for="k">Kode</label><input id="k" name="kode" type="password" autocomplete="current-password" required><button type="submit">Åbn</button></form>`, `<meta name="robots" content="noindex">`, fejl ? 401 : 200);

// ---------- Dashboard (kun anonyme tal fra hændelsesloggen) ----------
const OPSLAG = ["find_saloner", "vis_behandlinger", "vis_ledige_tider"];
async function salonNavne(): Promise<Map<string, string>> {
  return new Map((await alleSaloner(true)).map((s) => [s.id, s.navn]));
}
async function hentLog(url: URL): Promise<{ log: Haendelse[]; periode: string; dage: number | null }> {
  const p = url.searchParams.get("periode") ?? "30";
  const dage = p === "alle" ? null : Math.max(1, Math.min(365, Number(p) || 30));
  const alle = await klist<Haendelse>(["log"]);
  const graense = dage ? Date.now() - dage * 86400000 : 0;
  return { log: alle.filter((h) => Date.parse(h.t) >= graense).sort((a, b) => a.t.localeCompare(b.t)), periode: dage ? String(dage) : "alle", dage };
}
function opsummer(log: Haendelse[], dage: number | null, navne: Map<string, string> = new Map()) {
  const sn = (id?: string) => (id ? navne.get(id) ?? id : "");
  const tael = (f: (h: Haendelse) => boolean) => log.filter(f).length;
  const kr = (f: (h: Haendelse) => boolean) => log.filter(f).reduce((s, h) => s + (h.pris ?? 0), 0);
  const bookinger = tael((h) => h.type === "booking");
  const aflysninger = tael((h) => h.type === "aflysning");
  const samtaler = tael((h) => h.type === "forbindelse");
  const aiBook = tael((h) => h.type === "booking" && h.kilde === "ai");
  const tidSoeg = tael((h) => h.type === "vis_ledige_tider");
  const grp = (noegle: (h: Haendelse) => string | undefined, filter: (h: Haendelse) => boolean = () => true) => {
    const m = new Map<string, Haendelse[]>();
    for (const h of log.filter(filter)) { const n = noegle(h); if (!n) continue; m.set(n, [...(m.get(n) ?? []), h]); }
    return m;
  };
  const raekke = (l: Haendelse[]) => ({
    opslag: l.filter((h) => OPSLAG.includes(h.type)).length,
    tidssoegninger: l.filter((h) => h.type === "vis_ledige_tider").length,
    bookinger: l.filter((h) => h.type === "booking").length,
    aflysninger: l.filter((h) => h.type === "aflysning").length,
    afvist: l.filter((h) => h.type === "booking_afvist").length,
    kr: l.filter((h) => h.type === "booking").reduce((s, h) => s + (h.pris ?? 0), 0) - l.filter((h) => h.type === "aflysning").reduce((s, h) => s + (h.pris ?? 0), 0),
  });
  const pr = (m: Map<string, Haendelse[]>) => [...m.entries()].map(([navn, l]) => ({ navn, ...raekke(l), samtaler: l.filter((h) => h.type === "forbindelse").length }))
    .sort((a, b) => b.bookinger - a.bookinger || b.opslag - a.opslag);
  // Pr. dag
  const n = dage ?? Math.max(1, Math.ceil((Date.now() - Date.parse(log[0]?.t ?? new Date().toISOString())) / 86400000) + 1);
  const dagliste: { dato: string; opslag: number; bookinger: number }[] = [];
  for (let i = Math.min(n, 60) - 1; i >= 0; i--) {
    const d = iKbh(Date.now() - i * 86400000).dato;
    const l = log.filter((h) => iKbh(Date.parse(h.t)).dato === d);
    dagliste.push({ dato: d, opslag: l.filter((h) => OPSLAG.includes(h.type)).length, bookinger: l.filter((h) => h.type === "booking").length });
  }
  const ubesvaret = [
    ...log.filter((h) => h.type === "find_saloner" && h.antal === 0).map((h) => `Søgte salon${h.kategori ? " med " + h.kategori : ""}${h.omraade ? " i " + h.omraade : ""}${h.grund?.startsWith("fritekst") ? ` ("${h.grund.slice(10)}")` : ""} – ingen fundet`),
    ...log.filter((h) => h.type === "vis_ledige_tider" && h.antal === 0).map((h) => `Ingen ledige tider${h.behandling ? " til " + h.behandling : ""} hos ${h.salon === "alle" ? "alle saloner" : sn(h.salon)}${h.dageFrem !== undefined ? `, ${h.dageFrem} dage frem` : ""}`),
    ...log.filter((h) => h.type === "booking_afvist").map((h) => `Booking afvist hos ${sn(h.salon)} (${h.grund ?? "ukendt"})`),
  ];
  const leadtider = log.filter((h) => h.type === "booking" && typeof h.dageFrem === "number").map((h) => h.dageFrem!);
  return {
    samtaler, opslag: tael((h) => OPSLAG.includes(h.type)), tidssoegninger: tidSoeg, bookinger, aiBookinger: aiBook, aflysninger,
    afvist: tael((h) => h.type === "booking_afvist"), sidevisninger: tael((h) => h.type === "sidevisning"),
    bookingKr: kr((h) => h.type === "booking"), aflystKr: kr((h) => h.type === "aflysning"),
    nettoKr: kr((h) => h.type === "booking") - kr((h) => h.type === "aflysning"),
    soegTilBooking: tidSoeg ? Math.round((aiBook / tidSoeg) * 100) : null,
    aflysningsandel: bookinger ? Math.round((aflysninger / bookinger) * 100) : null,
    dageFremMedian: leadtider.length ? leadtider.sort((a, b) => a - b)[Math.floor(leadtider.length / 2)] : null,
    prAssistent: pr(grp((h) => h.klient, (h) => h.klient !== "Bookingside")),
    prSalon: pr(grp((h) => h.salon && h.salon !== "alle" ? sn(h.salon) : undefined)),
    prKategori: pr(grp((h) => h.kategori)),
    dage: dagliste, ubesvaret: ubesvaret.slice(-15).reverse(),
    seneste: log.slice(-25).reverse().map(({ t, type, klient, salon, behandling, pris, antal }) => ({ t, type, klient, salon: salon === "alle" ? "alle" : sn(salon), behandling, pris, antal })),
  };
}
async function dashboardJson(url: URL): Promise<Response> {
  const { log, periode, dage } = await hentLog(url);
  return Response.json({ periode, ...opsummer(log, dage, await salonNavne()) }, { headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
}
const TYPENAVN: Record<string, string> = {
  ai_side: "\"Book via din AI\" vist", sidesoegning: "Søgning på siden", forbindelse: "Ny samtale", find_saloner: "Søgte saloner", vis_behandlinger: "Så behandlinger", vis_ledige_tider: "Søgte ledige tider",
  booking: "Booking", booking_afvist: "Booking afvist", aflysning: "Aflysning", aflysning_ukendt_kode: "Aflysning – ukendt kode", sidevisning: "Bookingside vist",
};
const DASH_CSS = `html body{max-width:960px}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0}
.tile{background:var(--card);border-radius:12px;padding:12px 14px}.tile .v{font-size:1.7rem;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.2}.tile .l{color:var(--muted);font-size:.85rem}
.periode a{display:inline-block;padding:6px 12px;border:1px solid var(--line);border-radius:999px;margin:0 4px 4px 0;text-decoration:none;color:var(--fg)}.periode a.valgt{background:var(--accent);border-color:var(--accent);color:#fff}
.bars{display:flex;align-items:flex-end;gap:2px;height:120px;border-bottom:1px solid var(--line);margin-top:8px}.bars div{flex:1;background:var(--accent);border-radius:4px 4px 0 0;min-height:0}.bars div:hover{opacity:.75}
.akse{display:flex;justify-content:space-between;color:var(--muted);font-size:.75rem;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:.9rem;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600}td.n,th.n{text-align:right}
.tabwrap{overflow-x:auto}`;
async function dashboard(url: URL): Promise<Response> {
  const { log, periode, dage } = await hentLog(url);
  const o = opsummer(log, dage, await salonNavne());
  const tal = (n: number) => n.toLocaleString("da-DK");
  const tile = (v: string, l: string) => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  const bars = (felt: "opslag" | "bookinger", titel: string) => {
    const max = Math.max(1, ...o.dage.map((d) => d[felt]));
    return `<div class="kort"><h2 style="margin:0">${titel}</h2><div class="bars" role="img" aria-label="${titel} pr. dag">` +
      o.dage.map((d) => `<div style="height:${Math.round((d[felt] / max) * 100)}%" title="${danskDato(d.dato)}: ${d[felt]}"></div>`).join("") +
      `</div><div class="akse"><span>${danskDato(o.dage[0].dato)}</span><span>i dag</span></div></div>`;
  };
  const tabel = (titel: string, raekker: ReturnType<typeof opsummer>["prSalon"], medSamtaler = false) => !raekker.length ? "" :
    `<div class="kort tabwrap"><h2 style="margin-top:0">${titel}</h2><table><thead><tr><th></th>${medSamtaler ? '<th class="n">Samtaler</th>' : ""}<th class="n">Opslag</th><th class="n">Bookinger</th><th class="n">Aflyst</th><th class="n">Afvist</th><th class="n">Netto kr</th></tr></thead><tbody>` +
    raekker.map((r) => `<tr><td>${esc(r.navn)}</td>${medSamtaler ? `<td class="n">${r.samtaler}</td>` : ""}<td class="n">${r.opslag}</td><td class="n">${r.bookinger}</td><td class="n">${r.aflysninger}</td><td class="n">${r.afvist}</td><td class="n">${tal(r.kr)}</td></tr>`).join("") + "</tbody></table></div>";
  const vaelg = ["7", "30", "alle"].map((p) => `<a href="?periode=${p}" class="${p === periode ? "valgt" : ""}">${p === "alle" ? "Alt" : p + " dage"}</a>`).join("");
  const krop = `${faner("/dashboard")}${testBanner()}<h1>Dashboard</h1>
<p class="muted">Anonyme tal fra forbindelsen: hvad AI-assistenterne slår op, booker og aflyser. Ingen navne, telefonnumre eller IP-adresser gemmes.</p>
<nav class="periode" aria-label="Periode">${vaelg}</nav>
<div class="tiles">${tile(tal(o.samtaler), "Nye tilkoblinger (tallet er for lavt)")}${tile(tal(o.opslag), "Opslag (saloner, priser, tider)")}${tile(tal(o.bookinger), `Bookinger (${o.aiBookinger} via AI)`)}${tile(tal(o.aflysninger), "Aflysninger" + (o.aflysningsandel !== null ? ` (${o.aflysningsandel} %)` : ""))}
${tile(tal(o.nettoKr) + " kr", `Booket for netto (brutto ${tal(o.bookingKr)} kr)`)}${tile(o.soegTilBooking !== null ? o.soegTilBooking + " %" : "–", "Tidssøgninger der blev til en AI-booking")}${tile(tal(o.afvist), "Bookinger afvist (tid ikke ledig)")}${tile(o.dageFremMedian !== null ? o.dageFremMedian + " dage" : "–", "Typisk booket så langt frem")}</div>
${bars("opslag", "Opslag pr. dag")}${bars("bookinger", "Bookinger pr. dag")}
${tabel("Pr. assistent", o.prAssistent, true)}${tabel("Pr. salon", o.prSalon)}${tabel("Pr. kategori", o.prKategori)}
${o.ubesvaret.length ? `<div class="kort"><h2 style="margin-top:0">Efterspørgsel uden svar</h2><ul>${o.ubesvaret.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></div>` : ""}
<div class="kort tabwrap"><h2 style="margin-top:0">Seneste hændelser</h2>${o.seneste.length ? `<table><thead><tr><th>Tid</th><th>Hvad</th><th>Hvem</th><th>Salon</th><th class="n">Pris</th></tr></thead><tbody>` +
    o.seneste.map((h) => { const k = iKbh(Date.parse(h.t)); return `<tr><td style="white-space:nowrap">${k.dato.slice(8)}/${k.dato.slice(5,7)} ${k.tid}</td><td>${esc(TYPENAVN[h.type] ?? h.type)}${h.behandling ? " · " + esc(h.behandling) : ""}${typeof h.antal === "number" ? ` (${h.antal})` : ""}</td><td>${esc(h.klient)}</td><td>${esc(h.salon ?? "")}</td><td class="n">${h.pris && (h.type === "booking" || h.type === "aflysning") ? tal(h.pris) : ""}</td></tr>`; }).join("") + "</tbody></table>" : "<p>Ingen hændelser endnu.</p>"}</div>
<p class="muted">Tallene starter 10. oktober 2026. "Samtaler" tælles kun, når en assistent kobler forfra på forbindelsen – Claude genbruger ofte forbindelsen, så tallet er for lavt. Opslag og bookinger er de pålidelige tal. Rå tal: <a href="/dashboard.json?periode=${periode}">dashboard.json</a>.</p>`;
  return html(`${BRAND} – dashboard`, krop, `<style>${DASH_CSS}</style><meta http-equiv="refresh" content="60">`);
}

if (typeof Deno.serve === "function") Deno.serve(async (req) => {
  const url = new URL(req.url);
  const lokal = /^(localhost|127\.)/.test(url.hostname);
  ORIGIN = lokal ? url.origin : PUBLIC_ORIGIN;
  if (!lokal && url.origin !== PUBLIC_ORIGIN && url.pathname !== "/mcp" && (req.method === "GET" || req.method === "HEAD"))
    return new Response(null, { status: 301, headers: { location: PUBLIC_ORIGIN + url.pathname + url.search } });
  try {
    if (url.pathname === "/mcp") {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      let body: unknown;
      try { body = await req.json(); } catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 }); }
      const batch = Array.isArray(body) ? body : [body];
      const ctx: Ctx = { klient: await klientForRequest(req) };
      const res = [];
      for (const m of batch) { const r = await haandter(m, ctx); if (r !== null) res.push(r); }
      const hdr: Record<string, string> = ctx.nySession ? { "Mcp-Session-Id": ctx.nySession } : {};
      if (!res.length) return new Response(null, { status: 202, headers: hdr });
      return Response.json(Array.isArray(body) ? res : res[0], { headers: hdr });
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
        if (!r.ok) {
          await log({ type: "booking_afvist", klient: "Bookingside", kilde: "formular", salon: s.id, behandling: beh.id, kategori: beh.kategori, pris: beh.pris, dageFrem: dageFra(dato), grund: "tid ikke ledig" });
          return salonside(s, beh.id, `<p class="test">${esc(r.fejl)}</p>`);
        }
        await log({ type: "booking", klient: "Bookingside", kilde: "formular", salon: s.id, behandling: beh.id, kategori: beh.kategori, pris: beh.pris, dageFrem: dageFra(dato) });
        return html("Booket", `${testBanner(s)}<h1>Du er booket</h1><div class="kort"><p><strong>${esc(beh.navn)}</strong><br>${esc(s.navn)}, ${esc(s.omraade)}<br>${danskDato(dato)} kl. ${tid}<br>${beh.pris} kr, betales i salonen<br>Bookingkode: <strong>${r.b.kode}</strong></p></div><p><a href="/booking/${r.b.token}">Se eller aflys din booking</a> – gem linket.</p>${aiKort(s)}`);
      }
      if (!url.searchParams.get("b")) await log({ type: "sidevisning", klient: "Bookingside", salon: s.id });
      return await salonside(s, url.searchParams.get("b"));
    }
    const bm = url.pathname.match(/^\/booking\/([a-f0-9]{24})$/);
    if (bm) {
      const b = await findToken(bm[1]);
      if (!b) return html("Booking", `<h1>Bookingen findes ikke</h1><p>Den er måske allerede aflyst.</p>`);
      const s = await kget<Salon>(["salon", b.salon]);
      if (req.method === "POST") {
        await aflys(b, "Bookingside", "link");
        return html("Aflyst", `${testBanner(s ?? undefined)}<h1>Aflyst</h1><p>Din tid hos ${esc(s?.navn ?? b.salon)} ${danskDato(b.dato)} kl. ${b.tid} er aflyst. Husk at slette aftalen i din egen kalender.</p>`);
      }
      const beh = s?.behandlinger.find((x) => x.id === b.behandling);
      return html("Din booking", `${testBanner(s ?? undefined)}<h1>Din booking</h1><div class="kort"><p><strong>${esc(beh?.navn ?? b.behandling)}</strong><br>${esc(s?.navn ?? "")}, ${esc(s?.omraade ?? "")}<br>${danskDato(b.dato)} kl. ${b.tid}<br>${beh?.pris ?? ""} kr, betales i salonen<br>Bookingkode: ${b.kode}<br>Adresse: ${esc(s?.adresse ?? "")}</p></div><form method="post"><button type="submit">Aflys bookingen</button></form>${s && s.aktiv ? aiKort(s) : ""}`, `<meta name="robots" content="noindex">`);
    }
    if (url.pathname === "/status") {
      const linjer: string[] = [];
      for (const s of await alleSaloner(true)) {
        let st = brugerGoogle(s) ? "Google-kalender" : "intern testkalender";
        if (brugerGoogle(s)) { try { await hentEvents(s, Date.now(), Date.now() + 86400000); st += " – forbundet og læsbar"; } catch (e) { st += " – FEJL: " + (e as Error).message; } }
        linjer.push(`${s.navn}${s.test ? " (test)" : ""}${s.aktiv ? "" : " (inaktiv)"}: ${st}`);
      }
      const txt = `${BRAND} ${VERSION}\n${saKey ? "Robotkonto: " + saKey.client_email : "Ingen robotkonto – intern testkalender"}\nAdmin: ${env("ADMIN_TOKEN") ? "slået til" : "lukket (ADMIN_TOKEN mangler)"}\nDatabase: ${kv ? "Deno KV" : "hukommelse"}\n${linjer.join("\n")}\n`;
      if (url.searchParams.has("tekst") || !(req.headers.get("accept") ?? "").includes("text/html"))
        return new Response(txt, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      return html(`${BRAND} – status`, `${faner("/status")}<h1>Status</h1><div class="kort"><pre style="white-space:pre-wrap;margin:0">${esc(txt)}</pre></div><p class="muted">MCP-forbindelse: ${esc(ORIGIN)}/mcp</p>`);
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
    if (url.pathname === "/ai" || url.pathname === "/ai.html") return await aiSide(url);
    if (url.pathname === "/intern" || url.pathname.startsWith("/intern/")) return await intern(req, url);
    if (url.pathname === "/privatliv") return privatlivSide("da");
    if (url.pathname === "/privacy") return privatlivSide("en");
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /intern\nDisallow: /kalender\nDisallow: /booking/\n", { headers: { "content-type": "text/plain" } });
    if (url.pathname === "/kalender") return await kalenderside(url);
    if (url.pathname.startsWith("/kalender/") && req.method === "POST") return await kalenderPost(req, url);
    if (url.pathname === "/dashboard") return await dashboard(url);
    if (url.pathname === "/dashboard.json") return await dashboardJson(url);
    const bil = url.pathname.match(/^\/billede\/([a-z0-9-]+)\/(\d+)\.svg$/);
    if (bil) {
      const s = await hentSalon(bil[1]); const b = s?.billeder?.[Number(bil[2])];
      if (!s || !b || b.url) return new Response("Ikke fundet", { status: 404 });
      return new Response(illustration(b), { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
    }
    if (url.pathname === "/") return await forside(url);
    return new Response("Ikke fundet", { status: 404 });
  } catch (e) {
    return new Response("Fejl: " + (e as Error).message, { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
});
