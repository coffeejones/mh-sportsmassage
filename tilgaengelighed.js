// tilgaengelighed.js — DELT motor for kundesiden (booking.js) og Mine tider (mine-tider.js)
//
// Hele systemet bygger på ÉN regel: en dag er LUKKET, medmindre Michael har åbnet
// et eller flere vinduer på den. Findes der ikke et dokument for datoen, er dagen
// lukket. Derfor kan systemet aldrig love tid, han ikke har.
//
// Begge sider kalder PRÆCIS de samme funktioner herfra. En forhåndsvisning, der
// regner selv, bliver før eller siden usand.
//
// Tider gemmes som MINUT-TAL fra midnat (17:00 = 1020), ikke som tekst. Så kan
// vi regne med dem, og overlap bliver til simpel talsammenligning.

(function () {
  "use strict";

  // ---------- standardindstillinger ----------
  const STANDARD_CONFIG = {
    varselTimer: 24,      // en kunde skal booke mindst så lang tid før (Michaels ønske)
    pauseMinutter: 15,    // luft mellem to behandlinger
    gitterMinutter: 30,   // starttider ligger på halve timer
    // Så langt frem kan der bookes. Michael har fuldtidsjob med skiftende
    // vagter og planlægger måneder frem, når vagtplanen kommer, så
    // horisonten skal være rundelig. Dage uden åbne vinduer er alligevel
    // lukkede, så en lang horisont koster ingenting.
    horisontDage: 365,
    lukket: false,        // nødbremse: slår online booking helt fra
    besked: "",           // vises til kunderne når den ikke er tom
    ydelser: [
      { key: "30", navn: "30 minutter", beskrivelse: "Fokuseret behandling af ét område",   minutter: 30, pris: 300 },
      { key: "60", navn: "60 minutter", beskrivelse: "Grundig behandling af flere områder", minutter: 60, pris: 500 },
      { key: "90", navn: "90 minutter", beskrivelse: "Helkropsmassage",                     minutter: 90, pris: 750 },
    ],
  };

  // ---------- små hjælpere ----------
  const pad = (n) => String(n).padStart(2, "0");
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const datoFraISO = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
  const minTilHHMM = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const hhmmTilMin = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

  const UGEDAGE      = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
  const UGEDAGE_KORT = ["søn", "man", "tir", "ons", "tor", "fre", "lør"];
  const MAANEDER     = ["jan.", "feb.", "mar.", "apr.", "maj", "jun.", "jul.", "aug.", "sep.", "okt.", "nov.", "dec."];

  const dagLabel     = (d) => `${UGEDAGE[d.getDay()]} d. ${d.getDate()}. ${MAANEDER[d.getMonth()]}`;
  const dagLabelKort = (d) => `${UGEDAGE_KORT[d.getDay()]} d. ${d.getDate()}. ${MAANEDER[d.getMonth()]}`;

  // To intervaller overlapper, hvis det ene starter før det andet slutter, begge veje.
  // Det er HELE rettelsen af den fejl, hvor en 60-minutters kl. 13:00 ikke spærrede
  // for en 30-minutters kl. 13:30. Sammenlign intervaller, aldrig starttidspunkter.
  const overlapper = (aFra, aTil, bFra, bTil) => aFra < bTil && bFra < aTil;

  // ---------- dags-dokumentet ----------
  // { dato: "2026-08-04", vinduer: [{fra: 1020, til: 1260}], optaget: { id: {fra, til} } }
  function tomDag(iso) {
    return { dato: iso, vinduer: [], optaget: {}, opdateret: null };
  }

  function optagetListe(dag) {
    const o = (dag && dag.optaget) || {};
    return Object.keys(o).map((k) => o[k]).filter((b) => b && typeof b.fra === "number");
  }

  function aabneTimer(dag) {
    if (!dag || !dag.vinduer) return 0;
    return dag.vinduer.reduce((sum, v) => sum + (v.til - v.fra), 0) / 60;
  }

  function bookedeTimer(dag) {
    return optagetListe(dag).reduce((sum, b) => sum + (b.til - b.fra), 0) / 60;
  }

  // Læsbar opsummering af en dags vinduer: "17:00 til 21:00 · 09:00 til 14:00"
  function vinduerLabel(dag) {
    if (!dag || !dag.vinduer || !dag.vinduer.length) return "";
    return dag.vinduer
      .slice()
      .sort((a, b) => a.fra - b.fra)
      .map((v) => `${minTilHHMM(v.fra)} til ${minTilHHMM(v.til)}`)
      .join(" · ");
  }

  // ---------- kernen: hvilke starttider er ledige? ----------
  // Returnerer minut-tal. `nu` gives ind, så begge sider kan regne på samme tidspunkt
  // og så det kan testes.
  function ledigeStarter(dag, config, ydelse, nu) {
    if (!dag || !dag.vinduer || !dag.vinduer.length) return [];
    if (config.lukket) return [];

    const gitter = config.gitterMinutter || 30;
    const pause  = config.pauseMinutter || 0;
    const tidligstMs = nu.getTime() + (config.varselTimer || 0) * 3600 * 1000;
    const dagsStart = datoFraISO(dag.dato);
    const optaget = optagetListe(dag);
    const set = new Set();

    dag.vinduer.forEach((v) => {
      // starttider ligger på gitteret, også hvis vinduet begynder skævt
      const foerste = Math.ceil(v.fra / gitter) * gitter;
      for (let t = foerste; t + ydelse.minutter <= v.til; t += gitter) {
        // 1) varsel: behandlingen skal starte tidligt nok ude i fremtiden
        const start = new Date(dagsStart.getFullYear(), dagsStart.getMonth(), dagsStart.getDate(),
                               Math.floor(t / 60), t % 60);
        if (start.getTime() < tidligstMs) continue;

        // 2) må ikke støde ind i noget optaget. Det optagede udvides med pausen,
        //    så der altid er luft nok til at gøre klar mellem to kunder.
        const slut = t + ydelse.minutter;
        const konflikt = optaget.some((b) => overlapper(t, slut, b.fra - pause, b.til + pause));
        if (konflikt) continue;

        set.add(t);
      }
    });

    return [...set].sort((a, b) => a - b);
  }

  // Har dagen overhovedet én ledig tid til nogen af ydelserne?
  function harLedigeTider(dag, config, nu) {
    return (config.ydelser || []).some((y) => ledigeStarter(dag, config, y, nu).length > 0);
  }

  // Kan denne konkrete tid stadig bookes? Bruges lige før der gemmes, så to kunder
  // ikke kan nå at tage den samme tid.
  function erLedig(dag, config, ydelse, startMin, nu) {
    return ledigeStarter(dag, config, ydelse, nu).indexOf(startMin) !== -1;
  }

  // ---------- datoer i horisonten ----------
  // Alle kalenderdage frem, ikke kun de åbne. Mine tider viser dem alle,
  // så en lukket dag er ét tryk fra at være åben.
  function datoerFrem(antalDage, fra) {
    const start = fra || new Date();
    const ud = [];
    for (let i = 0; i < antalDage; i++) {
      ud.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    }
    return ud;
  }

  // ---------- vinduer: tilføj/flet ----------
  // Lægger et nyt vindue ind og smelter det sammen med dem, der rører hinanden,
  // så Michael aldrig ender med "17:00 til 19:00 · 19:00 til 21:00".
  function tilfoejVindue(vinduer, fra, til) {
    const alle = (vinduer || []).concat([{ fra, til }]).sort((a, b) => a.fra - b.fra);
    const ud = [];
    alle.forEach((v) => {
      const sidste = ud[ud.length - 1];
      if (sidste && v.fra <= sidste.til) sidste.til = Math.max(sidste.til, v.til);
      else ud.push({ fra: v.fra, til: v.til });
    });
    return ud;
  }

  // Fjerner et vindue. Ligger der en aftale inde i det, siges der nej,
  // for en booket kunde må aldrig kunne forsvinde ved et uheld.
  function fjernVindue(dag, index) {
    const v = dag.vinduer[index];
    if (!v) return { ok: false, grund: "findes ikke" };
    const ramt = optagetListe(dag).filter((b) => overlapper(v.fra, v.til, b.fra, b.til));
    if (ramt.length) return { ok: false, grund: "aftale", antal: ramt.length };
    const vinduer = dag.vinduer.slice();
    vinduer.splice(index, 1);
    return { ok: true, vinduer };
  }

  window.MHTid = {
    STANDARD_CONFIG,
    pad, isoOf, datoFraISO, minTilHHMM, hhmmTilMin,
    UGEDAGE, UGEDAGE_KORT, MAANEDER, dagLabel, dagLabelKort,
    overlapper, tomDag, optagetListe, aabneTimer, bookedeTimer, vinduerLabel,
    ledigeStarter, harLedigeTider, erLedig, datoerFrem, tilfoejVindue, fjernVindue,
  };
})();
