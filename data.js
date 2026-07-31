// data.js — datalaget, med en tynd søm (seam) omkring sig.
//
// I DAG: alt ligger i browserens localStorage. Det betyder, at Mine tider og
// bookingsiden deler data, så længe de åbnes i SAMME browser. Det er nok til at
// vise hele idéen frem og til at lade Michael prøve det, uden at der er oprettet
// et Firebase-projekt eller brugt en krone.
//
// I FASE 2: kun funktionerne herunder skiftes ud med Firestore. Hverken
// bookingsiden, Mine tider eller motoren i tilgaengelighed.js ændrer sig.
//
// ⚠️ Fordi det er localStorage, gælder det KUN den enkelte browser. Åbner en
// rigtig kunde siden på sin egen telefon, ser han ingen tider. Det er med vilje:
// demoen skal ikke kunne forveksles med et system, der virker udadtil.

(function () {
  "use strict";

  const NOEGLE = "mh.tider.v1";
  const T = window.MHTid;

  function laes() {
    try {
      const raw = localStorage.getItem(NOEGLE);
      if (!raw) return { dage: {}, aftaler: {}, config: {} };
      const d = JSON.parse(raw);
      return { dage: d.dage || {}, aftaler: d.aftaler || {}, config: d.config || {} };
    } catch {
      // Ødelagt data må aldrig vælte siden. Vi falder tilbage til "lukket",
      // hvilket er den sikre tilstand: ingen kunde får tilbudt en tid, vi ikke
      // kan stå inde for.
      return { dage: {}, aftaler: {}, config: {} };
    }
  }

  function skriv(d) {
    try {
      localStorage.setItem(NOEGLE, JSON.stringify(d));
      return true;
    } catch {
      return false;
    }
  }

  const nytId = () => "bk_" + Math.random().toString(36).slice(2, 10);

  const Store = {
    // ---------- indstillinger ----------
    async config() {
      const gemt = laes().config || {};
      return Object.assign({}, T.STANDARD_CONFIG, gemt);
    },

    async gemConfig(delvis) {
      const d = laes();
      d.config = Object.assign({}, d.config, delvis);
      skriv(d);
      return this.config();
    },

    // ---------- dage ----------
    async dag(iso) {
      const d = laes();
      return d.dage[iso] ? JSON.parse(JSON.stringify(d.dage[iso])) : T.tomDag(iso);
    },

    // Alle dags-dokumenter i et interval. Dage uden dokument returneres som tomme
    // (altså lukkede), så kaldere aldrig skal skelne mellem "lukket" og "findes ikke".
    async dage(isoListe) {
      const d = laes();
      const ud = {};
      isoListe.forEach((iso) => {
        ud[iso] = d.dage[iso] ? JSON.parse(JSON.stringify(d.dage[iso])) : T.tomDag(iso);
      });
      return ud;
    },

    // Gemmer KUN vinduerne. `optaget` røres aldrig herfra, præcis som
    // Firestore-reglen vil kræve det: Michael kan ikke komme til at
    // overskrive en kundes aftale ved at gemme sine tider.
    async gemVinduer(iso, vinduer) {
      const d = laes();
      const eksisterende = d.dage[iso] || T.tomDag(iso);
      d.dage[iso] = {
        dato: iso,
        vinduer: vinduer.map((v) => ({ fra: v.fra, til: v.til })),
        optaget: eksisterende.optaget || {},
        opdateret: new Date().toISOString(),
      };
      // en dag uden vinduer og uden aftaler behøver vi ikke gemme
      if (!d.dage[iso].vinduer.length && !Object.keys(d.dage[iso].optaget).length) {
        delete d.dage[iso];
      }
      skriv(d);
      return true;
    },

    // ---------- aftaler ----------
    async aftaler() {
      const d = laes();
      return Object.keys(d.aftaler)
        .map((id) => Object.assign({ id }, d.aftaler[id]))
        .sort((a, b) => (a.dato + T.pad(a.fra)).localeCompare(b.dato + T.pad(b.fra)));
    },

    // Den atomare booking. I dag er den bare "læs, tjek, skriv" i localStorage,
    // men den har PRÆCIS samme kontrakt som Cloud Function'en får i fase 2:
    // den tjekker selv, at tiden stadig er ledig, og siger nej hvis ikke.
    // Kundesiden må aldrig være det eneste sted, reglen håndhæves.
    async book(oensket) {
      const { dato, startMin, ydelseKey, navn, telefon, email, besked } = oensket;
      const config = await this.config();
      const ydelse = (config.ydelser || []).find((y) => y.key === ydelseKey);
      if (!ydelse) return { ok: false, grund: "ukendt-ydelse" };

      const d = laes();
      const dag = d.dage[dato] || T.tomDag(dato);

      // Serveren regner selv efter. Klienten bliver ikke troet på.
      if (!T.erLedig(dag, config, ydelse, startMin, new Date())) {
        return { ok: false, grund: "optaget" };
      }

      const id = nytId();
      dag.optaget = dag.optaget || {};
      dag.optaget[id] = { fra: startMin, til: startMin + ydelse.minutter };
      d.dage[dato] = dag;
      d.aftaler[id] = {
        dato,
        fra: startMin,
        til: startMin + ydelse.minutter,
        ydelseKey,
        minutter: ydelse.minutter,
        pris: ydelse.pris,
        navn: navn || "",
        telefon: telefon || "",
        email: email || "",
        besked: besked || "",
        kilde: "web",
        status: "booket",
        oprettet: new Date().toISOString(),
      };
      if (!skriv(d)) return { ok: false, grund: "kunne-ikke-gemme" };
      return { ok: true, id };
    },

    async aflys(id) {
      const d = laes();
      const a = d.aftaler[id];
      if (!a) return { ok: false };
      a.status = "aflyst";
      const dag = d.dage[a.dato];
      if (dag && dag.optaget) delete dag.optaget[id];
      skriv(d);
      return { ok: true };
    },

    // ---------- demo ----------
    // Lægger et par åbne dage og en enkelt aftale ind, så siden kan vises frem
    // uden at Michael først skal sidde og trykke. Kun til fremvisning.
    async saetDemoOp() {
      const d = laes();
      const nu = new Date();
      const dage = T.datoerFrem(14, nu);
      // find to dage der er mindst 2 og 4 døgn ude, så 24-timers varslet er opfyldt
      const a = dage[2], b = dage[4], c = dage[6];
      const put = (dato, vinduer) => {
        d.dage[T.isoOf(dato)] = {
          dato: T.isoOf(dato), vinduer, optaget: {}, opdateret: new Date().toISOString(),
        };
      };
      put(a, [{ fra: 17 * 60, til: 21 * 60 }]);
      put(b, [{ fra: 9 * 60, til: 14 * 60 }]);
      put(c, [{ fra: 8 * 60, til: 12 * 60 }, { fra: 17 * 60, til: 20 * 60 }]);
      // én booket tid, så bookinglisten ikke står tom
      const id = nytId();
      const isoA = T.isoOf(a);
      d.dage[isoA].optaget[id] = { fra: 18 * 60, til: 19 * 60 };
      d.aftaler[id] = {
        dato: isoA, fra: 18 * 60, til: 19 * 60, ydelseKey: "60", minutter: 60, pris: 500,
        navn: "Anne Sørensen", telefon: "20123456", email: "", besked: "",
        kilde: "web", status: "booket", oprettet: new Date().toISOString(),
      };
      skriv(d);
      return true;
    },

    async nulstil() {
      try { localStorage.removeItem(NOEGLE); } catch { /* ignorer */ }
      return true;
    },

    async erTom() {
      const d = laes();
      return Object.keys(d.dage).length === 0;
    },
  };

  window.MHStore = Store;
})();
