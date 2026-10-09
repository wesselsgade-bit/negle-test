# negle-test

Testside for en opdigtet negleartist (Neglestudie Lyngblomst). Bruges til at teste, om AI-assistenter kan læse ledige tider. Der kan ikke bookes.

## Version 0.2 – to saloner, én forbindelse (9/10-2026)
`server.ts` er nu "Negle-korridoren (test)" med to opdigtede saloner:
Neglestudie Lyngblomst (Brøndby, negle og vipper) og Neglebaren Kastanje (Hvidovre, kun negle).
Uden Google-opsætning kører den med faste testtider. Med miljøvariablerne
`GOOGLE_SA_KEY`, `CAL_LYNGBLOMST` og `CAL_KASTANJE` læser den "Ledig"-blokke fra
salonernes Google-kalendere og skriver bookinger direkte ind. Tjek opsætningen på `/status`.
