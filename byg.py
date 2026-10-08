#!/usr/bin/env python3
"""Bygger testsiden for en opdigtet negleartist.

Ledige tider genereres deterministisk for de næste 14 dage, så siden kan
genbygges dagligt (fx af en GitHub Action) og altid vise aktuelle tider.
Alt står som ren tekst i HTML'en, så AI-agenter kan læse det uden JavaScript.
"""
import datetime as dt
import json
import random
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Copenhagen")
UD = Path(__file__).parent / "docs"

NAVN = "Neglestudie Lyngblomst"
OMRAADE = "Brøndby (2605)"
BEHANDLINGER = [
    ("Gellak på egne negle", 350, 60),
    ("Nyt sæt gelénegle – French", 450, 90),
    ("Opfyldning af gelénegle", 380, 75),
    ("Vippeløft med farve", 400, 60),
]
UGEDAGE = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"]
MAANEDER = ["januar", "februar", "marts", "april", "maj", "juni", "juli",
            "august", "september", "oktober", "november", "december"]
# Arbejdstider som hobby-artist: hverdage efter arbejde, lørdag formiddag.
VINDUER = {0: (17, 21), 1: (17, 21), 2: (17, 21), 3: (16, 21), 4: (15, 20), 5: (10, 15)}


def dansk_dato(d: dt.date) -> str:
    return f"{UGEDAGE[d.weekday()]} {d.day}. {MAANEDER[d.month - 1]} {d.year}"


def ledige_tider(d: dt.date) -> list[str]:
    if d.weekday() not in VINDUER:
        return []
    start, slut = VINDUER[d.weekday()]
    rng = random.Random(d.toordinal())  # samme tider hver gang for samme dag
    alle = [f"{h:02d}:{m:02d}" for h in range(start, slut) for m in (0, 30)]
    return sorted(rng.sample(alle, k=min(len(alle), rng.randint(1, 4))))


def main() -> None:
    nu = dt.datetime.now(TZ)
    idag = nu.date()
    dage = [idag + dt.timedelta(days=i) for i in range(14)]
    if nu.hour >= 20:
        dage = dage[1:]

    dag_html, dag_tekst, schema_slots = [], [], []
    for d in dage:
        tider = ledige_tider(d)
        if d == idag:
            tider = [t for t in tider if t > nu.strftime("%H:%M")]
        label = dansk_dato(d) + (" (i dag)" if d == idag else "")
        if tider:
            dag_html.append(f"<li><strong>{label}:</strong> ledig kl. {', '.join(tider)}</li>")
            dag_tekst.append(f"- {label}: ledig kl. {', '.join(tider)}")
            for t in tider:
                schema_slots.append(f"{d.isoformat()}T{t}:00+02:00")
        else:
            dag_html.append(f"<li><strong>{label}:</strong> ingen ledige tider</li>")
            dag_tekst.append(f"- {label}: ingen ledige tider")

    beh_html = "".join(
        f"<li>{n} – {p} kr – {m} minutter</li>" for n, p, m in BEHANDLINGER)
    beh_tekst = "\n".join(f"- {n}: {p} kr, {m} minutter" for n, p, m in BEHANDLINGER)
    opdateret = nu.strftime("%d.%m.%Y kl. %H:%M")

    schema = {
        "@context": "https://schema.org",
        "@type": "NailSalon",
        "name": f"{NAVN} (testside)",
        "description": "TESTSIDE. Opdigtet negleartist brugt til at teste, om AI-assistenter kan læse ledige tider. Der kan ikke bookes.",
        "areaServed": OMRAADE,
        "address": {"@type": "PostalAddress", "addressLocality": "Brøndby",
                    "postalCode": "2605", "addressCountry": "DK"},
        "makesOffer": [
            {"@type": "Offer", "price": p, "priceCurrency": "DKK",
             "itemOffered": {"@type": "Service", "name": n,
                             "duration": f"PT{m}M"}}
            for n, p, m in BEHANDLINGER],
        "potentialAction": {"@type": "ReserveAction",
                            "description": "Ledige starttider (testdata)",
                            "startTime": schema_slots[:40]},
    }

    html = f"""<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{NAVN} – negle og vipper i Brøndby – ledige tider (testside)</title>
<meta name="description" content="Ledige tider til negle og vipper hos {NAVN} i Brøndby. TESTSIDE med opdigtede tider – der kan ikke bookes.">
<script type="application/ld+json">{json.dumps(schema, ensure_ascii=False)}</script>
<style>
body{{font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:16px;line-height:1.5;color:#222;background:#fff}}
.test{{background:#fff3cd;border:1px solid #e0c060;padding:12px;border-radius:8px}}
h1{{font-size:1.6rem}} li{{margin:4px 0}}
</style>
</head>
<body>
<p class="test"><strong>Dette er en testside.</strong> {NAVN} er opdigtet, og tiderne er testdata.
Siden bruges til at undersøge, om AI-assistenter kan læse ledige tider. Der kan ikke bookes.</p>

<h1>{NAVN} – negle og vipper i {OMRAADE}</h1>
<p>Hjemmeklinik i Brøndby. Den præcise adresse oplyses ved booking.</p>

<h2>Behandlinger og priser</h2>
<ul>{beh_html}</ul>

<h2>Ledige tider de næste 14 dage</h2>
<p>Sidst opdateret {opdateret}.</p>
<ul>{''.join(dag_html)}</ul>

<h2>Sådan booker du</h2>
<p>Booking er ikke åben – dette er en test.</p>
</body>
</html>
"""

    llms = f"""# {NAVN} (testside)

> TESTSIDE. Opdigtet negleartist i {OMRAADE}. Tiderne er testdata, og der kan ikke bookes.

Sidst opdateret: {opdateret}

## Behandlinger
{beh_tekst}

## Ledige tider
{chr(10).join(dag_tekst)}
"""

    UD.mkdir(exist_ok=True)
    (UD / "index.html").write_text(html, encoding="utf-8")
    (UD / "llms.txt").write_text(llms, encoding="utf-8")
    (UD / "robots.txt").write_text("User-agent: *\nAllow: /\n", encoding="utf-8")


if __name__ == "__main__":
    main()
