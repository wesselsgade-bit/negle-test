// Testforbindelse (MCP) for den opdigtede negleartist "Neglestudie Lyngblomst".
// Alt er testdata. Ingen betaling, ingen rigtige kunder.
// Endepunkter:  POST /mcp  (MCP, Streamable HTTP, stateless JSON)
//               GET  /     (side med ledige tider, live)
//               GET  /llms.txt

const NAVN = "Neglestudie Lyngblomst";
const OMRAADE = "Brøndby (2605)";
const TZ = "Europe/Copenhagen";

type Behandling = { id: string; navn: string; pris: number; minutter: number };
const BEHANDLINGER: Behandling[] = [
  { id: "gellak", navn: "Gellak på egne negle", pris: 350, minutter: 60 },
  { id: "nyt-saet", navn: "Nyt sæt gelénegle – French", pris: 450, minutter: 90 },
  { id: "opfyldning", navn: "Opfyldning af gelénegle", pris: 380, minutter: 75 },
  { id: "vippeloeft", navn: "Vippeløft med farve", pris: 400, minutter: 60 },
];

const UGEDAGE = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];
const MAANEDER = ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august",
  "september", "oktober", "november", "december"];
// Ugedag (0 = mandag) -> arbejdsvindue (start, slut) i hele timer.
const VINDUER: Record<number, [number, number]> = {
  0: [17, 21], 1: [17, 21], 2: [17, 21], 3: [16, 21], 4: [15, 20], 5: [10, 15],
};

// ---------- Lager (Deno KV hvis tilgængelig, ellers hukommelse) ----------
type Booking = {
  kode: string; dato: string; tid: string; behandling: string; navn: string;
  telefon?: string; oprettet: string;
};
let kv: Deno.Kv | null = null;
try { kv = await Deno.openKv(); } catch { kv = null; }
const mem = new Map<string, Booking>();

async function hentBookinger(dato: string): Promise<Booking[]> {
  if (kv) {
    const ud: Booking[] = [];
    for await (const e of kv.list<Booking>({ prefix: ["booking", dato] })) ud.push(e.value);
    return ud;
  }
  return [...mem.values()].filter((b) => b.dato === dato);
}
async function gemBooking(b: Booking): Promise<boolean> {
  if (kv) {
    const key = ["booking", b.dato, b.tid];
    const res = await kv.atomic().check({ key, versionstamp: null }).set(key, b)
      .set(["kode", b.kode], [b.dato, b.tid]).commit();
    return res.ok;
  }
  if ([...mem.values()].some((x) => x.dato === b.dato && x.tid === b.tid)) return false;
  mem.set(b.kode, b);
  return true;
}
async function sletBooking(kode: string): Promise<Booking | null> {
  if (kv) {
    const ref = await kv.get<[string, string]>(["kode", kode]);
    if (!ref.value) return null;
    const [dato, tid] = ref.value;
    const b = await kv.get<Booking>(["booking", dato, tid]);
    await kv.atomic().delete(["kode", kode]).delete(["booking", dato, tid]).commit();
    return b.value;
  }
  const b = mem.get(kode) ?? null;
  mem.delete(kode);
  return b;
}

// ---------- Tid og ledige tider ----------
function nuIKbh(): { dato: string; tid: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const hh = p.hour === "24" ? "00" : p.hour;
  return { dato: `${p.year}-${p.month}-${p.day}`, tid: `${hh}:${p.minute}` };
}
function plusDage(dato: string, n: number): string {
  const d = new Date(dato + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function ugedag(dato: string): number { // 0 = mandag
  return (new Date(dato + "T12:00:00Z").getUTCDay() + 6) % 7;
}
function danskDato(dato: string): string {
  const d = new Date(dato + "T12:00:00Z");
  return `${UGEDAGE[ugedag(dato)]} ${d.getUTCDate()}. ${MAANEDER[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
// Samme pseudo-tilfældige tider som testsiden (Python random er ikke genskabt; egen seed).
function seedRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
function grundTider(dato: string): string[] {
  const wd = ugedag(dato);
  const v = VINDUER[wd];
  if (!v) return [];
  const alle: string[] = [];
  for (let h = v[0]; h < v[1]; h++) for (const m of [0, 30]) alle.push(`${String(h).padStart(2, "0")}:${m === 0 ? "00" : "30"}`);
  const rng = seedRng(Number(dato.replaceAll("-", "")));
  const k = Math.min(alle.length, 2 + Math.floor(rng() * 4)); // 2–5 tider
  const valgt = new Set<string>();
  while (valgt.size < k) valgt.add(alle[Math.floor(rng() * alle.length)]);
  return [...valgt].sort();
}
async function ledigeTider(dato: string): Promise<string[]> {
  const nu = nuIKbh();
  if (dato < nu.dato) return [];
  const optaget = new Set((await hentBookinger(dato)).map((b) => b.tid));
  return grundTider(dato).filter((t) => !optaget.has(t) && !(dato === nu.dato && t <= nu.tid));
}

// ---------- Værktøjer ----------
const TEST = "TESTDATA: Neglestudie Lyngblomst er opdigtet. Ingen rigtig behandling finder sted.";
const tools = [
  {
    name: "vis_behandlinger",
    title: "Vis behandlinger og priser",
    description: `Viser behandlinger, priser og varighed hos ${NAVN}, en (opdigtet) negle- og vippeartist med hjemmeklinik i ${OMRAADE}.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "vis_ledige_tider",
    title: "Vis ledige tider",
    description: `Viser ledige starttider hos ${NAVN} i ${OMRAADE} for en eller flere dage frem (højst 14 dage). Datoer i formatet ÅÅÅÅ-MM-DD.`,
    inputSchema: {
      type: "object",
      properties: {
        fra_dato: { type: "string", description: "Første dato, ÅÅÅÅ-MM-DD. Udelades = i dag." },
        antal_dage: { type: "integer", minimum: 1, maximum: 14, description: "Antal dage at vise. Standard 1." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "book_tid",
    title: "Book en tid",
    description: `Booker en ledig tid hos ${NAVN}. Kræver behandling, dato, starttid og kundens navn. Returnerer en bookingkode, som bruges til aflysning.`,
    inputSchema: {
      type: "object",
      properties: {
        behandling: { type: "string", enum: BEHANDLINGER.map((b) => b.id), description: "Behandlingens id fra vis_behandlinger." },
        dato: { type: "string", description: "ÅÅÅÅ-MM-DD" },
        tidspunkt: { type: "string", description: "Starttid TT:MM, fx 18:30" },
        navn: { type: "string", description: "Kundens fornavn" },
        telefon: { type: "string", description: "Valgfrit telefonnummer" },
      },
      required: ["behandling", "dato", "tidspunkt", "navn"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "aflys_booking",
    title: "Aflys en booking",
    description: `Aflyser en booking hos ${NAVN} ud fra bookingkoden. Tiden bliver ledig igen.`,
    inputSchema: {
      type: "object",
      properties: { bookingkode: { type: "string", description: "Koden fra book_tid, fx LB-4K7Q" } },
      required: ["bookingkode"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

function tekst(t: string, fejl = false) {
  return { content: [{ type: "text", text: t }], isError: fejl };
}
const datoOk = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + "T12:00:00Z"));

async function kald(navn: string, a: Record<string, unknown>) {
  if (navn === "vis_behandlinger") {
    return tekst(`${NAVN} – ${OMRAADE}\n` + BEHANDLINGER.map((b) =>
      `- ${b.navn} (id: ${b.id}): ${b.pris} kr, ${b.minutter} min`).join("\n") +
      "\nAdressen oplyses ved booking. Betaling sker hos artisten.\n" + TEST);
  }
  if (navn === "vis_ledige_tider") {
    const nu = nuIKbh();
    const fra = typeof a.fra_dato === "string" && a.fra_dato ? a.fra_dato : nu.dato;
    if (!datoOk(fra)) return tekst("Ugyldig dato. Brug ÅÅÅÅ-MM-DD.", true);
    const n = Math.min(14, Math.max(1, Number(a.antal_dage ?? 1) || 1));
    const linjer: string[] = [];
    for (let i = 0; i < n; i++) {
      const d = plusDage(fra, i);
      const t = await ledigeTider(d);
      linjer.push(`- ${danskDato(d)} (${d})${d === nu.dato ? " – i dag" : ""}: ${t.length ? t.join(", ") : "ingen ledige tider"}`);
    }
    return tekst(`Ledige starttider hos ${NAVN} (klokken nu i København: ${nu.tid}):\n${linjer.join("\n")}\n${TEST}`);
  }
  if (navn === "book_tid") {
    const b = BEHANDLINGER.find((x) => x.id === a.behandling);
    const dato = String(a.dato ?? ""), tid = String(a.tidspunkt ?? "").padStart(5, "0");
    const kunde = String(a.navn ?? "").trim().slice(0, 60);
    if (!b) return tekst(`Ukendt behandling. Gyldige: ${BEHANDLINGER.map((x) => x.id).join(", ")}.`, true);
    if (!datoOk(dato)) return tekst("Ugyldig dato. Brug ÅÅÅÅ-MM-DD.", true);
    if (!kunde) return tekst("Kundens navn mangler.", true);
    const ledige = await ledigeTider(dato);
    if (!ledige.includes(tid)) {
      return tekst(`Kl. ${tid} ${danskDato(dato)} er ikke ledig. Ledige tider den dag: ${ledige.join(", ") || "ingen"}.`, true);
    }
    const kode = "LB-" + crypto.randomUUID().replaceAll("-", "").slice(0, 4).toUpperCase();
    const ok = await gemBooking({
      kode, dato, tid, behandling: b.id, navn: kunde,
      telefon: typeof a.telefon === "string" ? a.telefon.slice(0, 20) : undefined,
      oprettet: new Date().toISOString(),
    });
    if (!ok) return tekst("Tiden blev taget lige før. Vælg en anden tid.", true);
    return tekst(`Booket! ${b.navn} hos ${NAVN}, ${danskDato(dato)} kl. ${tid} (${b.minutter} min, ${b.pris} kr).\n` +
      `Kunde: ${kunde}. Bookingkode: ${kode}.\nAdresse: hjemmeklinik i Brøndby – den præcise adresse sendes af artisten.\n${TEST}`);
  }
  if (navn === "aflys_booking") {
    const kode = String(a.bookingkode ?? "").trim().toUpperCase();
    const b = await sletBooking(kode);
    if (!b) return tekst(`Fandt ingen booking med koden ${kode}.`, true);
    return tekst(`Bookingen ${kode} (${danskDato(b.dato)} kl. ${b.tid}) er aflyst. Tiden er ledig igen.\n${TEST}`);
  }
  return tekst(`Ukendt værktøj: ${navn}`, true);
}

// ---------- MCP (JSON-RPC over HTTP) ----------
const PROTOKOLLER = ["2025-06-18", "2025-03-26", "2024-11-05"];
async function haandter(msg: { id?: unknown; method?: string; params?: Record<string, unknown> }) {
  const svar = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fejl = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  switch (msg.method) {
    case "initialize": {
      const ønsket = String(msg.params?.protocolVersion ?? "");
      return svar({
        protocolVersion: PROTOKOLLER.includes(ønsket) ? ønsket : PROTOKOLLER[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "lyngblomst-test", title: "Neglestudie Lyngblomst (test)", version: "0.1.0" },
        instructions: `Testforbindelse for ${NAVN}, en opdigtet negleartist i ${OMRAADE}. Brug den til at vise behandlinger, ledige tider og booke eller aflyse tider. Alt er testdata.`,
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
      if (msg.id === undefined) return null; // notifikation
      return fejl(-32601, `Metoden findes ikke: ${msg.method}`);
  }
}

// ---------- Live side ----------
async function side(): Promise<string> {
  const nu = nuIKbh();
  let li = "";
  for (let i = 0; i < 14; i++) {
    const d = plusDage(nu.dato, i);
    const t = await ledigeTider(d);
    li += `<li><strong>${danskDato(d)}${i === 0 ? " (i dag)" : ""}:</strong> ${t.length ? "ledig kl. " + t.join(", ") : "ingen ledige tider"}</li>`;
  }
  const beh = BEHANDLINGER.map((b) => `<li>${b.navn} – ${b.pris} kr – ${b.minutter} minutter</li>`).join("");
  return `<!doctype html><html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${NAVN} – ledige tider (testside, live)</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:16px;line-height:1.5;color:#222;background:#fff}.test{background:#fff3cd;border:1px solid #e0c060;padding:12px;border-radius:8px}</style></head><body>
<p class="test"><strong>Dette er en testside.</strong> ${NAVN} er opdigtet, og tiderne er testdata.</p>
<h1>${NAVN} – negle og vipper i ${OMRAADE}</h1>
<h2>Behandlinger</h2><ul>${beh}</ul>
<h2>Ledige tider (live)</h2><p>Opdateret ${nu.dato} kl. ${nu.tid}.</p><ul>${li}</ul>
<p>AI-assistenter kan booke via MCP-forbindelsen på <code>/mcp</code>.</p></body></html>`;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/mcp") {
    if (req.method === "GET" || req.method === "DELETE") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    if (req.method !== "POST") return new Response(null, { status: 405 });
    let body: unknown;
    try { body = await req.json(); } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
    }
    const batch = Array.isArray(body) ? body : [body];
    const res = (await Promise.all(batch.map(haandter))).filter((x) => x !== null);
    if (res.length === 0) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? res : res[0]);
  }
  if (url.pathname === "/llms.txt") {
    const nu = nuIKbh();
    let t = `# ${NAVN} (testside)\n\n> ${TEST}\n\nMCP-forbindelse: ${url.origin}/mcp\n\n## Ledige tider\n`;
    for (let i = 0; i < 14; i++) {
      const d = plusDage(nu.dato, i);
      const l = await ledigeTider(d);
      t += `- ${danskDato(d)}: ${l.length ? l.join(", ") : "ingen"}\n`;
    }
    return new Response(t, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (url.pathname === "/") return new Response(await side(), { headers: { "content-type": "text/html; charset=utf-8" } });
  return new Response("Ikke fundet", { status: 404 });
});
