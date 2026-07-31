// MH Sportsmassage — Cloud Functions.
//
// Der er ÉN vigtig funktion her: bookAppointment. Den er den ENESTE, der må
// skrive en aftale, og den gør "tjek at tiden er ledig" og "tag tiden" til ét
// udeleligt skridt. Derfor kan to kunder aldrig få den samme tid.
//
// Alt hvad klienten sender, bliver regnet efter her. Varslet, vinduerne,
// prisen og varigheden hentes fra Firestore, ikke fra browseren. Ellers kunne
// enhver med udviklerværktøjerne booke Michael om ti minutter til 0 kr.

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const nodemailer = require("nodemailer");

initializeApp();
const db = getFirestore();

setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

// Et menneske kan booke rigeligt med tre tider om dagen. Ti anonyme bookinger
// fra samme identitet kunne æde det meste af en måned for en enmandsklinik.
const MAX_BOOKINGER_PR_UID_PR_DAG = 3;

// Michaels konto. Står også i firestore.rules. Det er ikke en hemmelighed
// (et bruger-id er ikke en adgangskode), men det er det ENESTE id, der må
// aflyse en aftale.
const MICHAEL_UID = "2BAO7nBB1UUIUyARu6d3RVgKLW03";

// Standardværdier, så funktionen virker selv før indstillingerne er gemt
// første gang. Findes /config/booking, vinder den over disse.
const STANDARD = {
  varselTimer: 24,
  pauseMinutter: 15,
  gitterMinutter: 30,
  horisontDage: 365,
  lukket: false,
  ydelser: [
    { key: "30", navn: "30 minutter", minutter: 30, pris: 300 },
    { key: "60", navn: "60 minutter", minutter: 60, pris: 500 },
    { key: "90", navn: "90 minutter", minutter: 90, pris: 750 },
  ],
};

const pad = (n) => String(n).padStart(2, "0");
const overlapper = (aFra, aTil, bFra, bTil) => aFra < bTil && bFra < aTil;

// Tidszone, ét sted og ordentligt. Functions kører i UTC, browseren i lokal
// tid. Uden det her ville en booking kl. 17:00 blive gemt som 15:00, og
// SMS'en til Michael ville fortælle ham det forkerte klokkeslæt.
function startTidspunkt(datoISO, startMin) {
  const [y, m, d] = datoISO.split("-").map(Number);
  const hh = Math.floor(startMin / 60);
  const mm = startMin % 60;
  // Find UTC-forskydningen for Europe/Copenhagen på præcis den dato, så både
  // sommertid og vintertid rammer rigtigt.
  const proeve = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const somDK = new Date(proeve.toLocaleString("en-US", { timeZone: "Europe/Copenhagen" }));
  const somUTC = new Date(proeve.toLocaleString("en-US", { timeZone: "UTC" }));
  const forskydning = somDK.getTime() - somUTC.getTime();
  return new Date(proeve.getTime() - forskydning);
}

const erGyldigDato = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

exports.bookAppointment = onCall({ enforceAppCheck: false }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Kunne ikke bekræfte din browser. Prøv igen.");

  const d = request.data || {};
  const datoISO = d.dato;
  const startMin = Number(d.startMin);
  const ydelseKey = String(d.ydelseKey || "");
  const navn = String(d.navn || "").trim().slice(0, 80);
  const telefon = String(d.telefon || "").trim().slice(0, 30);
  const email = String(d.email || "").replace(/[\r\n\t]+/g, " ").trim().toLowerCase().slice(0, 120);
  const besked = String(d.besked || "").trim().slice(0, 300);

  if (!erGyldigDato(datoISO)) throw new HttpsError("invalid-argument", "Ugyldig dato.");
  if (!Number.isInteger(startMin) || startMin < 0 || startMin >= 24 * 60) {
    throw new HttpsError("invalid-argument", "Ugyldigt tidspunkt.");
  }
  if (!navn || !telefon) throw new HttpsError("invalid-argument", "Navn og telefon skal udfyldes.");

  const dagRef = db.doc(`dage/${datoISO}`);
  const configRef = db.doc("config/booking");
  const taellerRef = db.doc(`bookingTaellere/${uid}`);
  const aftaleRef = db.collection("aftaler").doc(); // id'et laves HER, aldrig i browseren
  const iDag = new Date().toISOString().slice(0, 10);

  await db.runTransaction(async (tx) => {
    // ----- alle læsninger før nogen skrivning -----
    const [configSnap, dagSnap, taellerSnap] = await Promise.all([
      tx.get(configRef), tx.get(dagRef), tx.get(taellerRef),
    ]);

    const config = Object.assign({}, STANDARD, configSnap.exists ? configSnap.data() : {});
    if (config.lukket) throw new HttpsError("failed-precondition", "Online booking er lukket lige nu.");

    const ydelse = (config.ydelser || []).find((y) => y.key === ydelseKey);
    if (!ydelse) throw new HttpsError("invalid-argument", "Behandlingen findes ikke.");

    if (!dagSnap.exists) throw new HttpsError("failed-precondition", "Der er ikke åbent den dag.");
    const dag = dagSnap.data();
    const vinduer = Array.isArray(dag.vinduer) ? dag.vinduer : [];
    const optaget = dag.optaget || {};

    const slut = startMin + Number(ydelse.minutter);

    // 1) Ligger tiden inden for et af Michaels åbne vinduer?
    const iVindue = vinduer.some((v) => startMin >= Number(v.fra) && slut <= Number(v.til));
    if (!iVindue) throw new HttpsError("failed-precondition", "Tiden ligger uden for åbningstiden.");

    // 2) Ligger den på gitteret? (ellers kunne man booke kl. 17:07)
    if (startMin % Number(config.gitterMinutter || 30) !== 0) {
      throw new HttpsError("failed-precondition", "Ugyldigt starttidspunkt.");
    }

    // 3) Overlapper den noget, der allerede er booket? Intervaller, ikke
    //    starttidspunkter. Det optagede udvides med pausen, så der er luft
    //    nok til at gøre klar mellem to kunder.
    const pause = Number(config.pauseMinutter || 0);
    const konflikt = Object.keys(optaget).some((k) => {
      const b = optaget[k];
      return overlapper(startMin, slut, Number(b.fra) - pause, Number(b.til) + pause);
    });
    if (konflikt) throw new HttpsError("aborted", "Tiden blev desværre lige booket. Vælg en anden tid.");

    // 4) Varslet. Det fandtes før KUN i browserens JavaScript, så enhver med
    //    udviklerværktøjerne kunne booke ham om ti minutter.
    const start = startTidspunkt(datoISO, startMin);
    const tidligst = Date.now() + Number(config.varselTimer || 0) * 3600 * 1000;
    if (start.getTime() < tidligst) {
      throw new HttpsError("failed-precondition", "Den tid kan ikke bookes så kort tid før.");
    }

    // 5) Spam-loft pr. anonym identitet
    const t = taellerSnap.exists ? taellerSnap.data() : null;
    const brugtIDag = t && t.dag === iDag ? Number(t.antal) || 0 : 0;
    if (brugtIDag >= MAX_BOOKINGER_PR_UID_PR_DAG) {
      throw new HttpsError("resource-exhausted", "Du har booket flere tider i dag. Ring 23 90 60 68.");
    }

    // ----- skrivninger -----
    tx.set(aftaleRef, {
      dato: datoISO,
      fra: startMin,
      til: slut,
      startAt: Timestamp.fromDate(start),
      ydelseKey,
      minutter: Number(ydelse.minutter),
      pris: Number(ydelse.pris),
      navn, telefon, email, besked,
      kilde: "web",
      status: "booket",
      kundeUID: uid,
      oprettet: FieldValue.serverTimestamp(),
      // `udloeber` ER en TTL-politik: Firestore sletter hele aftalen 12
      // måneder efter behandlingen. Sat i firestore.indexes.json.
      //
      // ⚠️ `beskedUdloeber` er IKKE en TTL-politik og må ALDRIG blive det.
      // En TTL sletter HELE dokumentet, ikke ét felt, så den ville fjerne
      // aftalen 30 dage efter behandlingen. Feltet står som en påmindelse om,
      // at fritekstbeskeden bør ryddes efter 30 dage, og det kræver en lille
      // planlagt kørsel med FieldValue.delete() på `besked`, ikke en TTL.
      // Indtil den findes, bliver beskeden liggende i de 12 måneder.
      beskedUdloeber: Timestamp.fromDate(new Date(start.getTime() + 30 * 864e5)),
      udloeber: Timestamp.fromDate(new Date(start.getTime() + 365 * 864e5)),
    });
    tx.set(dagRef, { optaget: { [aftaleRef.id]: { fra: startMin, til: slut } } }, { merge: true });
    tx.set(taellerRef, {
      dag: iDag,
      antal: brugtIDag + 1,
      udloeber: Timestamp.fromDate(new Date(Date.now() + 48 * 3600 * 1000)),
    }, { merge: true });
  });

  return { ok: true, id: aftaleRef.id };
});

// Aflysning. Frigiver tiden igen, så den kan sælges til en anden.
// Kun Michael må aflyse.
exports.aflysAftale = onCall({ enforceAppCheck: false }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid || uid !== MICHAEL_UID) throw new HttpsError("permission-denied", "Kun Michael kan aflyse.");

  const id = String((request.data || {}).id || "");
  if (!id) throw new HttpsError("invalid-argument", "Mangler id.");

  const aftaleRef = db.doc(`aftaler/${id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(aftaleRef);
    if (!snap.exists) throw new HttpsError("not-found", "Aftalen findes ikke.");
    const a = snap.data();
    tx.update(aftaleRef, { status: "aflyst", aflystAt: FieldValue.serverTimestamp() });
    tx.set(db.doc(`dage/${a.dato}`), { optaget: { [id]: FieldValue.delete() } }, { merge: true });
  });
  return { ok: true };
});

// ===========================================================================
//  MAIL. Bekræftelse til kunden OG til Michael.
// ===========================================================================
//
// Mailen sendes gennem RESEND, fra MH's eget domæne. Valgt frem for one.coms
// egen SMTP af én grund, der vejer tungt netop her: bookingen er
// AUTO-BEKRÆFTET, så tiden er kundens i det sekund hun trykker. Hos one.com
// findes der ingen leveringslog, og en afvist mail skulle opdages af et
// menneske, der åbnede en postkasse, ingen åbner. Resend viser leveret,
// afvist eller markeret som spam.
//
// Der skal derfor IKKE oprettes nogen postkasse. Afsenderadressen skal bare
// ligge på et domæne, der er verificeret i Resend, og afvisninger opsamles
// af dem. Hemmeligheden er en API-nøgle, som kan trækkes tilbage uden at
// røre nogens mail, i modsætning til en menneskelig postkasses adgangskode,
// der også ville åbne indbakken via IMAP.
//
// ⚠️ PRISEN, og den skal stå i persondatapolitikken: Resend kan sende fra en
// EU-region, men konto, metadata og LOGFILER ligger i USA. Logfilerne
// indeholder kundens mailadresse og emnelinjen, som indeholder kundens navn.
// Det kræver en databehandleraftale. Gratisplanen sletter logfiler efter
// 30 dage. Ingen helbredsoplysninger er i spil: formularen beder udtrykkeligt
// om at lade være, og kundens besked står aldrig i emnet.
//
// Kunden svarer til michael@, fordi vi sætter Reply-To. Kunden ser aldrig
// afsenderadressen.
//
// Mailen sendes ALDRIG inde i bookingens transaktion. En Firestore-transaktion
// kan køres om af sig selv, hvis to skrivninger støder sammen, og så ville
// kunden få mailen én gang pr. omkørsel. Og fejler mailen, skal tiden stadig
// være booket. Derfor: en udløser, der reagerer på den kendsgerning, at
// aftalen findes.

// Resend taler SMTP, så nodemailer-koden herunder er uændret. Brugernavnet er
// altid den faste streng "resend", og adgangskoden er API-nøglen. Derfor ÉN
// hemmelighed i stedet for to, og ingen postkasses adgangskode i systemet:
// en API-nøgle kan trækkes tilbage uden at røre nogens mail.
const RESEND_NOEGLE = defineSecret("RESEND_NOEGLE");

// Port 587 med STARTTLS: Google Cloud spærrer udgående port 25, men lader
// 587 være i fred.
const SMTP_VAERT = "smtp.resend.com";
const SMTP_PORT = 587;
const SMTP_BRUGERNAVN = "resend";   // Resend kræver præcis denne streng

// Afsenderen. Adressen skal ligge på et domæne, der er verificeret i Resend.
// Der skal IKKE oprettes en postkasse: afvisninger opsamles af Resend og kan
// ses i deres oversigt, hvilket er hele grunden til at vi valgte dem.
// ⚠️ Vær enig med det domæne, du faktisk fik verificeret. Vælger du Resends
// anbefalede underdomæne, skal her stå fx booking@send.mhsportsmassage.dk.
const AFSENDER = "booking@mhsportsmassage.dk";

// ⚠️ TJEK FØR UDRULNING: Firestore-udløsere i 2. generation skal ligge samme
// sted som databasen. Slå placeringen op i konsollen under Firestore og
// Databaseplacering. Står der europe-west1, er linjen herunder rigtig. Står
// der eur3 eller noget andet, skal den rettes, ellers fejler deployet med
// "unsupported Cloud Firestore region".
const UDLOESER_REGION = "europe-west1";

// ⚠️ SPØRG MICHAEL FØRST: hvilken indbakke åbner han faktisk på telefonen?
// Hans Google-konto er en gmail-adresse. Sæt den adresse ind, han rent
// faktisk læser. Der må gerne stå to i listen, men hver ekstra adresse er
// endnu en kopi af kundens navn og nummer.
// Jonas har bekræftet, at det er gmail-adressen, Michael faktisk åbner på
// telefonen. michael@mhsportsmassage.dk er IKKE verificeret som en postkasse,
// der kan modtage, og en notifikation, der hardbouncer, er værre end ingen.
const MICHAEL_MODTAGERE = ["jonas0504hansen@gmail.com"];

// Kundens "Svar" skal lande et sted, han LÆSER. Derfor samme adresse.
// ⚠️ Virker michael@mhsportsmassage.dk en dag som rigtig postkasse, så sæt
// den ind her igen: den ser mere professionel ud i kundens indbakke.
const SVAR_TIL = "jonas0504hansen@gmail.com";

const KLINIK = {
  navn: "MH Sportsmassage",
  behandler: "Michael Hansen",
  // ⚠️ SKAL rettes til vej og husnummer, før mailen slås til. "Bjæverskov"
  // er en by, ikke en adresse, og den samme streng ryger i kalenderfilens
  // LOCATION, så kunden heller ikke kan navigere efter den.
  adresse: "Bjæverskov",
  telefon: "23 90 60 68",
  telefonLink: "+4523906068",
};

// Ingen links i mailene endnu. mhsportsmassage.dk viser one.coms
// parkeringsside, og mine-tider.html findes ikke på den adresse, siden
// faktisk ligger på. Et dødt link i en bekræftelse er værre end ingen link.
// Sæt dem ind, når domænet peger på den rigtige side.

const FARVE = {
  groen: "#2c6244", moerk: "#234f37", bloed: "#e0eadd",
  tekst: "#4a544c", blaek: "#1b2a22", kant: "#d7dfd3",
};

const LAAS_MS = 90 * 1000;   // kortere end platformens pause mellem genforsøg
const MAX_FORSOEG = 20;      // vagten kører hvert kvarter, så det er ca. 5 timer
const MAX_ALDER_MS = 48 * 3600 * 1000;

// En adresse er kun gyldig, hvis den hverken indeholder mellemrum, komma,
// semikolon, vinkelparenteser eller linjeskift. Det er ikke pedanteri:
// strengen ender i et mailhoved, og et linjeskift der er header-injection.
const MAIL_MOENSTER = /^[^\s@<>,;:"'\\]+@[^\s@<>,;:"'\\]+\.[a-zA-Z]{2,}$/;
const erGyldigMail = (s) => typeof s === "string" && s.length <= 120 && MAIL_MOENSTER.test(s);

// ---------------------------------------------------------------------------
// Dansk dato og klokkeslæt. Regnet ud af ISO-strengen, ikke af serverens ur:
// functions kører i UTC, og en dato må aldrig kunne skride en dag, fordi
// koden tilfældigvis kørte kl. 23:40.
// ---------------------------------------------------------------------------
const UGEDAGE = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
const UGEDAGE_K = ["søn.", "man.", "tir.", "ons.", "tor.", "fre.", "lør."];
const MAANEDER = ["januar", "februar", "marts", "april", "maj", "juni",
  "juli", "august", "september", "oktober", "november", "december"];

function dagDele(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return { y, m, d, ugedag: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}
const datoLang = (iso) => {
  const p = dagDele(iso);
  return `${UGEDAGE[p.ugedag]} den ${p.d}. ${MAANEDER[p.m - 1]} ${p.y}`;
};
const datoKort = (iso) => {
  const p = dagDele(iso);
  return `${UGEDAGE_K[p.ugedag]} den ${p.d}. ${MAANEDER[p.m - 1]}`;
};
const klok = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

// Fjerner styretegn fra alt, kunden har skrevet. En emnelinje må aldrig kunne
// bære et linjeskift med sig ind i et mailhoved.
const enLinje = (s) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
// Kundens besked er skrevet i et tekstfelt med linjeskift. De skal overleve,
// ellers bliver "Jeg kommer lidt foer" og "jeg parkerer bagved" til en klump.
// Alt ANDET end almindeligt linjeskift ryger stadig ud.
const flereLinjer = (s) => String(s == null ? "" : s)
  .replace(/\r\n?/g, "\n")
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Kundens besked er et tekstfelt med linjeskift. De skal overleve til HTML.
const escFlere = (s) => esc(s).replace(/\r?\n/g, "<br>");
const fornavnAf = (navn) => enLinje(navn).split(/\s+/)[0] || "";

// ---------------------------------------------------------------------------
// Kalenderfilen
// ---------------------------------------------------------------------------
// Tiderne skrives som lokal tid med TZID og en rigtig VTIMEZONE. Skrev vi
// dem om til UTC, ville klokkeslættet stå fast i forhold til Greenwich, og
// blev sommertiden afskaffet, mens tiden lå i kundens kalender, ville en
// aftale kl. 17:00 rykke sig til kl. 16:00. Med TZID bliver 17:00 ved med
// at være 17:00.
//
// METHOD:PUBLISH, ikke REQUEST. REQUEST er en INDBYDELSE: kunden får
// Ja, Nej og Måske, og svaret sendes til en postkasse, ingen læser. PUBLISH
// betyder "her er en begivenhed, læg den i kalenderen", og det er det, vi mener.
const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Copenhagen",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const icsEsc = (s) => String(s == null ? "" : s)
  .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

// iCalendar tillader højst 75 oktetter pr. linje. Længere linjer foldes med
// CRLF og ét mellemrum, og vi tæller oktetter, ikke tegn, så foldningen
// aldrig klipper midt i et æ eller ø.
function fold(linje) {
  const b = Buffer.from(linje, "utf8");
  if (b.length <= 75) return linje;
  const dele = [];
  let i = 0;
  while (i < b.length) {
    let n = Math.min(dele.length ? 74 : 75, b.length - i);
    while (n > 1 && i + n < b.length && (b[i + n] & 0xc0) === 0x80) n--;
    dele.push((dele.length ? " " : "") + b.slice(i, i + n).toString("utf8"));
    i += n;
  }
  return dele.join("\r\n");
}

// Michael kan åbne et vindue, der slutter kl. 24:00, så en sluttid på 1440
// er en gyldig booking. "T240000" er ugyldig iCalendar og kan få hele filen
// afvist. Den skal rulle til næste dags 00:00.
function icsLokal(iso, minutter) {
  const p = dagDele(iso);
  let dag = new Date(Date.UTC(p.y, p.m - 1, p.d));
  let min = Number(minutter) || 0;
  while (min >= 1440) { min -= 1440; dag = new Date(dag.getTime() + 864e5); }
  return `${dag.getUTCFullYear()}${pad(dag.getUTCMonth() + 1)}${pad(dag.getUTCDate())}` +
    `T${pad(Math.floor(min / 60))}${pad(min % 60)}00`;
}
const icsNu = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function byggIcs(a, id, ydelseNavn, aflyst) {
  const linjer = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MH Sportsmassage//Booking//DA",
    "CALSCALE:GREGORIAN",
    `METHOD:${aflyst ? "CANCEL" : "PUBLISH"}`,
  ].concat(VTIMEZONE, [
    "BEGIN:VEVENT",
    // Aftalens eget id. Så rammer en senere aflysning præcis den begivenhed,
    // og to bookinger på samme klokkeslæt kan ikke overskrive hinanden.
    `UID:${id}@mhsportsmassage.dk`,
    `SEQUENCE:${aflyst ? 1 : 0}`,
    `DTSTAMP:${icsNu()}`,
    `DTSTART;TZID=Europe/Copenhagen:${icsLokal(a.dato, a.fra)}`,
    `DTEND;TZID=Europe/Copenhagen:${icsLokal(a.dato, a.til)}`,
    `STATUS:${aflyst ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    // ORGANIZER og ATTENDEE er krævet af RFC 5546 for at en CANCEL kan
    // matches. De giver aflysningen en chance. De giver ikke en garanti.
    fold(`ORGANIZER;CN="${KLINIK.navn.replace(/"/g, "")}":mailto:${SVAR_TIL}`),
  ]);
  if (erGyldigMail(a.email)) {
    linjer.push(fold(`ATTENDEE;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${a.email}`));
  }
  linjer.push(
    fold(`SUMMARY:${icsEsc((aflyst ? "Aflyst: " : "") + ydelseNavn + " hos " + KLINIK.navn)}`),
    fold(`LOCATION:${icsEsc(KLINIK.navn + ", " + KLINIK.adresse)}`),
    fold(`DESCRIPTION:${icsEsc(
      `${ydelseNavn}, ${a.pris} kr. Betaling med MobilePay eller kontant i klinikken. ` +
      `Skal du flytte eller aflyse, så ring ${KLINIK.telefon}.`)}`)
  );
  if (!aflyst) {
    // En påmindelse to timer før. Den er den billigste måde at undgå en
    // glemt tid på, og den koster ingenting.
    linjer.push(
      "BEGIN:VALARM", "ACTION:DISPLAY",
      fold(`DESCRIPTION:${icsEsc(`Tid hos ${KLINIK.navn} om 2 timer`)}`),
      "TRIGGER:-PT2H", "END:VALARM");
  }
  linjer.push("END:VEVENT", "END:VCALENDAR");
  return linjer.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// HTML. Tabeller og inline-stil, ingen webfonte, ingen billeder, ingen
// medieforespørgsler der SKAL virke. width="520" fanger Outlook, som ignorerer
// max-width, og style-max-width fanger alle andre.
// ---------------------------------------------------------------------------
const AFSNIT = `margin:0 0 14px;font-size:15px;line-height:1.6;color:${FARVE.tekst};`;

function skal(o) {
  const raekker = (o.fakta || []).map(([label, vaerdi], i) =>
    `<tr>` +
    `<td valign="top" width="38%" style="padding:9px 10px 9px 0;border-top:1px solid ${FARVE.kant};font-size:13px;line-height:1.5;color:${FARVE.tekst};">${esc(label)}</td>` +
    `<td valign="top" style="padding:9px 0;border-top:1px solid ${FARVE.kant};font-size:15px;line-height:1.5;color:${FARVE.blaek};font-weight:bold;">${vaerdi}</td>` +
    `</tr>`).join("");

  const boks = o.boks
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;"><tr>` +
      `<td style="padding:12px 14px;background:${FARVE.bloed};font-size:14px;line-height:1.55;color:${FARVE.tekst};">${o.boks}</td>` +
      `</tr></table>`
    : "";

  const slut = (o.slut || []).map((t) => `<p style="${AFSNIT}">${t}</p>`).join("");

  return `<!doctype html>
<html lang="da"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.overskrift)}</title></head>
<body style="margin:0;padding:0;background:#f4f7f3;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#f4f7f3;">${esc(o.forhaandsvisning)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f7f3;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;background:#ffffff;border:1px solid ${FARVE.kant};font-family:Helvetica,Arial,sans-serif;">
<tr><td style="background:${FARVE.groen};padding:14px 24px;font-size:15px;color:#ffffff;letter-spacing:.4px;"><strong>MH</strong> Sportsmassage</td></tr>
<tr><td style="padding:24px 24px 4px;">
<p style="margin:0 0 14px;font-size:20px;line-height:1.35;color:${FARVE.blaek};"><strong>${esc(o.overskrift)}</strong></p>
<p style="${AFSNIT}">${o.indledning}</p>
${raekker ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-bottom:1px solid ${FARVE.kant};">${raekker}</table>` : ""}
${boks}${slut}
</td></tr>
<tr><td style="padding:14px 24px 22px;">
<p style="margin:0;padding-top:14px;border-top:1px solid ${FARVE.kant};font-size:13px;line-height:1.6;color:${FARVE.tekst};">
${esc(KLINIK.navn)} v/ ${esc(KLINIK.behandler)}<br>${esc(KLINIK.adresse)}<br>
Tlf. <a href="tel:${esc(KLINIK.telefonLink)}" style="color:${FARVE.moerk};">${esc(KLINIK.telefon)}</a>
</p>
</td></tr>
</table></td></tr></table></body></html>`;
}

const telLink = (nr) =>
  `<a href="tel:${esc(enLinje(nr).replace(/\s/g, ""))}" style="color:${FARVE.moerk};">${esc(nr)}</a>`;

// ---------------------------------------------------------------------------
// Teksterne. Ren tekst og HTML bygges af de SAMME strenge, så de to udgaver
// ikke kan komme til at sige noget forskelligt.
// ---------------------------------------------------------------------------
function mailTilKunde(a, ydelseNavn) {
  const fornavn = fornavnAf(a.navn);
  const hej = fornavn ? `Hej ${fornavn}` : "Hej";
  const sted = `${KLINIK.navn}, ${KLINIK.adresse}`;
  const betaling = "Du betaler i klinikken med MobilePay eller kontant. Der er ingen betaling online.";
  const foer = "Kom gerne et par minutter før.";
  const aflys = `Skal du flytte eller aflyse tiden, så ring til mig på ${KLINIK.telefon}, gerne senest 24 timer før. Du kan også svare på denne mail.`;
  const kalender = "Der ligger en kalenderfil vedhæftet, hvis du vil have tiden i din kalender.";

  const emne = `Din tid hos MH Sportsmassage, ${datoKort(a.dato)} kl. ${klok(a.fra)}`;

  const tekst = [
    hej, "",
    "Din tid er booket. Du behøver ikke gøre mere.", "",
    `Behandling: ${ydelseNavn}`,
    `Dag: ${datoLang(a.dato)}`,
    `Tid: kl. ${klok(a.fra)} til ${klok(a.til)}`,
    `Pris: ${a.pris} kr.`,
    `Sted: ${sted}`, "",
    betaling, "", foer, "", aflys, "", kalender, "",
    "Vi ses.", "",
    KLINIK.behandler, KLINIK.navn, `Tlf. ${KLINIK.telefon}`,
  ].join("\n");

  const html = skal({
    overskrift: fornavn ? `${hej}, din tid er booket` : "Din tid er booket",
    indledning: "Du behøver ikke gøre mere. Her er aftalen.",
    forhaandsvisning: `${ydelseNavn}, ${datoLang(a.dato)} kl. ${klok(a.fra)}. ${a.pris} kr., betales i klinikken.`,
    fakta: [
      ["Behandling", esc(ydelseNavn)],
      ["Dag", esc(datoLang(a.dato))],
      ["Tid", `kl. ${klok(a.fra)} til ${klok(a.til)}`],
      ["Pris", `${esc(a.pris)} kr.`],
      ["Sted", esc(sted)],
    ],
    boks: esc(betaling),
    slut: [
      esc(foer),
      `Skal du flytte eller aflyse tiden, så ring til mig på ${telLink(KLINIK.telefon)}, gerne senest 24 timer før. Du kan også svare på denne mail.`,
      esc(kalender),
      "Vi ses.<br>Michael",
    ],
  });

  return { emne, tekst, html };
}

// De fire udgaver af linjen om kunden. Michael skal kunne se på ét blik,
// om han selv skal ringe.
function kundeLinjeAf(status) {
  if (status === "sendt") return "Kunden har fået den samme bekræftelse på mail.";
  if (status === "ingen") return "Kunden har ikke oplyst en e-mail og har kun kvitteringen på skærmen.";
  if (status === "ugyldig") return "Kundens e-mailadresse ser forkert ud, så bekræftelsen blev ikke sendt. Ring til kunden.";
  return "Bekræftelsen til kunden blev ikke sendt. Ring til kunden.";
}

function mailTilMichael(a, ydelseNavn, kundeStatus) {
  const navn = enLinje(a.navn) || "Uden navn";
  const telefon = enLinje(a.telefon) || "Intet nummer oplyst";
  const besked = flereLinjer(a.besked);
  const kundeLinje = kundeLinjeAf(kundeStatus);
  const sletNote = "Beskeden er kundens egne ord. Står der helbredsoplysninger i den, så slet mailen, når du har læst den.";

  // Navnet står i emnet med vilje: han skal kunne se på låseskærmen, hvem
  // der har booket. Kundens besked står ALDRIG i emnet.
  const emne = `Ny booking: ${navn}, ${datoKort(a.dato)} kl. ${klok(a.fra)}`;

  const tekst = [
    "Ny booking på hjemmesiden.", "",
    navn, telefon,
    erGyldigMail(a.email) ? a.email : null,
    "",
    datoLang(a.dato),
    `kl. ${klok(a.fra)} til ${klok(a.til)}`,
    `${ydelseNavn}, ${a.pris} kr.`,
    "",
    besked ? "Kundens besked:" : "Ingen besked fra kunden.",
    besked || null,
    besked ? "" : null,
    besked ? sletNote : null,
    "",
    kundeLinje,
    "Tiden ligger allerede under Mine tider.",
  ].filter((l) => l !== null).join("\n");

  const html = skal({
    overskrift: "Ny booking",
    indledning: `${esc(datoLang(a.dato))}, kl. ${klok(a.fra)} til ${klok(a.til)}.`,
    forhaandsvisning: `${navn}, ${telefon}, ${ydelseNavn}.`,
    fakta: [
      ["Kunde", esc(navn)],
      ["Telefon", a.telefon ? telLink(a.telefon) : "Intet nummer oplyst"],
      ["E-mail", erGyldigMail(a.email) ? esc(a.email) : "Ingen oplyst"],
      ["Behandling", `${esc(ydelseNavn)}, ${esc(a.pris)} kr.`],
    ],
    boks: besked
      ? `<strong>Kundens besked</strong><br>${escFlere(besked)}<br><br>` +
        `<span style="font-size:13px;">${esc(sletNote)}</span>`
      : "Ingen besked fra kunden.",
    slut: [esc(kundeLinje), "Tiden ligger allerede under Mine tider."],
  });

  return { emne, tekst, html };
}

function aflysningTilKunde(a, ydelseNavn) {
  const fornavn = fornavnAf(a.navn);
  const hej = fornavn ? `Hej ${fornavn}` : "Hej";
  const ingenting = "Du skal ikke møde op, og du skal ikke betale noget.";
  const nyTid = `Ring til mig på ${KLINIK.telefon}, så finder vi en ny tid.`;
  // Ærligt: en aflysning kan kun fjerne begivenheden i nogle kalendere. Vi
  // lover ikke noget, vi ikke kan holde.
  const kalender = "Har du lagt tiden i din kalender, så slet den selv der. Kalenderfilen i denne mail forsøger at fjerne den, men det er ikke alle kalendere, der gør det.";

  const emne = `Aflyst: din tid hos MH Sportsmassage ${datoKort(a.dato)} kl. ${klok(a.fra)}`;

  const tekst = [
    hej, "",
    "Jeg er desværre nødt til at aflyse din tid:", "",
    `Behandling: ${ydelseNavn}`,
    `Dag: ${datoLang(a.dato)}`,
    `Tid: kl. ${klok(a.fra)} til ${klok(a.til)}`, "",
    ingenting, "", nyTid, "", kalender, "",
    "Det er jeg ked af.", "",
    KLINIK.behandler, KLINIK.navn, `Tlf. ${KLINIK.telefon}`,
  ].join("\n");

  const html = skal({
    overskrift: "Din tid er desværre aflyst",
    indledning: fornavn
      ? `${esc(hej)}. Jeg er desværre nødt til at aflyse denne tid.`
      : "Jeg er desværre nødt til at aflyse denne tid.",
    forhaandsvisning: `${ydelseNavn} ${datoKort(a.dato)} kl. ${klok(a.fra)} er aflyst.`,
    fakta: [
      ["Behandling", esc(ydelseNavn)],
      ["Dag", esc(datoLang(a.dato))],
      ["Tid", `kl. ${klok(a.fra)} til ${klok(a.til)}`],
    ],
    boks: esc(ingenting),
    slut: [
      `Ring til mig på ${telLink(KLINIK.telefon)}, så finder vi en ny tid.`,
      esc(kalender),
      "Det er jeg ked af.<br>Michael",
    ],
  });

  return { emne, tekst, html };
}

// Michael får KUN mail om en aflysning, når kunden ikke kunne få besked.
// Lykkes det, er en kvittering til ham selv ren støj: han trykkede selv.
function aflysningsAlarm(a, ydelseNavn, kundeStatus) {
  const navn = enLinje(a.navn) || "Uden navn";
  const telefon = enLinje(a.telefon) || "Intet nummer oplyst";
  const grund = kundeStatus === "ingen"
    ? "kunden ikke har oplyst en e-mail"
    : kundeStatus === "ugyldig"
      ? "kundens e-mailadresse ser forkert ud"
      : "mailen ikke kunne sendes";

  const emne = `Aflysning: ${navn} fik ikke besked, ${datoKort(a.dato)} kl. ${klok(a.fra)}`;
  const tekst = [
    `Du har aflyst ${navn}, ${datoLang(a.dato)} kl. ${klok(a.fra)}.`, "",
    `Kunden har ikke fået besked, fordi ${grund}.`, "",
    `Ring til kunden på ${telefon}, ellers står der en person ved en låst dør.`, "",
    "Tiden er ledig igen på hjemmesiden.",
  ].join("\n");

  const html = skal({
    overskrift: "Kunden fik ikke besked",
    indledning: `Du har aflyst ${esc(navn)}, ${esc(datoLang(a.dato))} kl. ${klok(a.fra)}. Kunden har ikke fået besked, fordi ${esc(grund)}.`,
    forhaandsvisning: `Ring til ${navn} på ${telefon}.`,
    fakta: [
      ["Kunde", esc(navn)],
      ["Telefon", a.telefon ? telLink(a.telefon) : "Intet nummer oplyst"],
      ["Aflyst tid", `${esc(datoLang(a.dato))}, kl. ${klok(a.fra)}`],
      ["Behandling", esc(ydelseNavn)],
    ],
    slut: ["Ring til kunden, ellers står der en person ved en låst dør.", "Tiden er ledig igen på hjemmesiden."],
  });

  return { emne, tekst, html };
}

// ---------------------------------------------------------------------------
// Afsendelse
// ---------------------------------------------------------------------------
function lavTransport() {
  return nodemailer.createTransport({
    host: SMTP_VAERT,
    port: SMTP_PORT,
    secure: false,     // 587 starter i klartekst og opgraderer med STARTTLS
    requireTLS: true,  // uden den ville en fejlende STARTTLS sende i klartekst
    auth: { user: SMTP_BRUGERNAVN, pass: RESEND_NOEGLE.value() },
    // Fail fast. En funktion, der hænger et minut på et dødt SMTP-svar,
    // koster penge og udskyder næste forsøg.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

async function send(transport, o) {
  const post = {
    from: `"${KLINIK.navn}" <${AFSENDER}>`,
    to: o.til,
    subject: enLinje(o.emne),
    text: o.tekst,
    html: o.html,
  };
  if (o.svarTil) post.replyTo = o.svarTil;
  if (o.ics) {
    post.attachments = [{
      filename: o.ics.filnavn,
      content: o.ics.indhold,
      contentType: `text/calendar; charset=utf-8; method=${o.ics.metode}`,
      contentDisposition: "attachment",
    }];
  }
  await transport.sendMail(post);
}

// Kort, ufarlig fejltekst. Aldrig hele stakken, aldrig adgangskoden, som
// Nodemailer godt kan finde på at citere i en 535-fejl, og aldrig kundens
// adresse, som et 550-svar rutinemæssigt gentager.
function kortFejl(e) {
  const kode = (e && (e.responseCode || e.code)) || "";
  let ud = `${kode} ${String((e && e.response) || (e && e.message) || "ukendt fejl")}`;
  try {
    // split og join, ikke RegExp: en adgangskode med et punktum eller en
    // parentes i ville ellers blive til et mønster, der matchede noget helt andet.
    const hemmelig = RESEND_NOEGLE.value();
    if (hemmelig) ud = ud.split(hemmelig).join("***");
  } catch (ignoreret) { /* værdien er ikke bundet, så der er intet at maskere */ }
  return ud.replace(/<[^>]*>/g, "<adresse>").replace(/\S+@\S+/g, "<adresse>").trim().slice(0, 160);
}

// Behandlingens navn hentes fra config, så mailen siger præcis det samme som
// hjemmesiden, også hvis Michael omdøber en ydelse.
async function ydelsesNavn(key, minutter) {
  try {
    const snap = await db.doc("config/booking").get();
    const config = Object.assign({}, STANDARD, snap.exists ? snap.data() : {});
    const y = (config.ydelser || []).find((x) => x.key === key);
    if (y && y.navn) return String(y.navn);
  } catch (e) {
    logger.warn("kunne ikke hente ydelsesnavn", { fejl: String(e && e.message).slice(0, 120) });
  }
  return `${minutter} minutter`;
}

// Nødbremsen. Mailen sender KUN, når mailAktiv udtrykkeligt er sat til true i
// /config/booking. Så kan den slås til og fra på fem sekunder i konsollen,
// uden en udrulning, og den første udrulning kan ikke ramme en rigtig kunde.
async function mailErAktiv() {
  try {
    const snap = await db.doc("config/booking").get();
    return Boolean(snap.exists && snap.data().mailAktiv === true);
  } catch (e) {
    logger.error("kunne ikke læse mailAktiv", { fejl: String(e && e.message).slice(0, 120) });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Låsen. Udløsere leveres MINDST én gang, så den samme booking kan udløse
// funktionen to gange helt af sig selv, og retry gør det igen. Uden værn fik
// kunden tre ens mails.
//
// Låsen har en LEASE på 90 sekunder, ikke et evigt flag. Dør kørslen midt i
// afsendelsen, frigives den af sig selv, og både platformens genforsøg og
// vagten kan tage over. Der findes ingen lås, der kan hænge fast.
// ---------------------------------------------------------------------------
async function tagOpgaven(ref, felt) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { koer: false, grund: "vaek" };
    const a = snap.data();
    const m = a[felt] || {};

    if (m.status === "sendt") return { koer: false, grund: "sendt" };
    if (m.status === "opgivet") return { koer: false, grund: "opgivet" };
    if (m.laastTil && m.laastTil.toMillis() > Date.now()) return { koer: false, grund: "laast" };

    const forsoeg = Number(m.forsoeg || 0) + 1;
    if (forsoeg > MAX_FORSOEG) {
      tx.update(ref, {
        [`${felt}.status`]: "opgivet",
        [`${felt}.laastTil`]: FieldValue.delete(),
        [`${felt}.sidst`]: FieldValue.serverTimestamp(),
      });
      return { koer: false, grund: "opgivet" };
    }

    tx.update(ref, {
      [`${felt}.status`]: "sender",
      [`${felt}.forsoeg`]: forsoeg,
      [`${felt}.laastTil`]: Timestamp.fromMillis(Date.now() + LAAS_MS),
    });
    // De to modtagere huskes hver for sig. Gik Michaels mail igennem, mens
    // kundens fejlede, må næste forsøg IKKE sende Michaels igen.
    return { koer: true, forsoeg, aftale: a, foer: { kunde: m.kunde || null, michael: m.michael || null } };
  });
}

// ---------------------------------------------------------------------------
// Selve arbejdet. Deles af bekræftelsen, aflysningen og vagten, så der kun
// findes ÉN udgave af "hvad sker der, når en besked skal ud".
// Kaster aldrig. Returnerer { proevIgen }.
// ---------------------------------------------------------------------------
async function udfoerOpgave(ref, felt, aflysning) {
  let krav;
  try {
    krav = await tagOpgaven(ref, felt);
  } catch (e) {
    logger.error("kunne ikke tage mailopgaven", { aftale: ref.id, felt, fejl: String(e && e.message).slice(0, 160) });
    return { proevIgen: true };
  }
  if (!krav.koer) {
    // "laast" betyder, at en anden kørsel er i gang lige nu. Vi kvitterer
    // ALDRIG for en mail, der måske aldrig blev sendt: der prøves igen.
    if (krav.grund === "laast") return { proevIgen: true };
    if (krav.grund !== "sendt") logger.info("mail springes over", { aftale: ref.id, felt, grund: krav.grund });
    return { proevIgen: false };
  }

  const a = krav.aftale;

  // En begivenhed, der er blevet ved med at fejle i to døgn, skal stoppe.
  const oprettet = a.oprettet && a.oprettet.toMillis ? a.oprettet.toMillis() : Date.now();
  if (Date.now() - oprettet > MAX_ALDER_MS) {
    await ref.update({
      [`${felt}.status`]: "opgivet",
      [`${felt}.laastTil`]: FieldValue.delete(),
      [`${felt}.fejl`]: "for gammel",
      [`${felt}.sidst`]: FieldValue.serverTimestamp(),
    }).catch(() => {});
    logger.error("mail opgivet, aftalen er for gammel", { aftale: ref.id, felt });
    return { proevIgen: false };
  }

  const ydelseNavn = await ydelsesNavn(a.ydelseKey, a.minutter);
  const raaMail = enLinje(a.email);
  const kundeAdresse = erGyldigMail(raaMail) ? raaMail : "";

  // "ugyldig" og "ingen" er to forskellige ting. En adresse med slåfejl skal
  // Michael ringe om. En manglende adresse er bare et vilkår.
  let kundeStatus = krav.foer.kunde === "sendt"
    ? "sendt"
    : kundeAdresse ? "afventer" : (raaMail ? "ugyldig" : "ingen");
  let michaelStatus = krav.foer.michael === "sendt" ? "sendt" : "afventer";
  let sidsteFejl = "";
  let transport = null;

  try {
    transport = lavTransport();

    // 1) Kunden først. Michaels mail skal kunne fortælle sandheden om,
    //    hvorvidt kunden fik sin.
    if (kundeStatus === "afventer") {
      try {
        const m = aflysning ? aflysningTilKunde(a, ydelseNavn) : mailTilKunde(a, ydelseNavn);
        await send(transport, {
          til: kundeAdresse,
          svarTil: SVAR_TIL,          // kunden svarer til Michael, ikke til robotpostkassen
          emne: m.emne, tekst: m.tekst, html: m.html,
          ics: {
            filnavn: aflysning ? "aflyst-tid.ics" : "tid-hos-mh-sportsmassage.ics",
            metode: aflysning ? "CANCEL" : "PUBLISH",
            indhold: byggIcs(a, ref.id, ydelseNavn, aflysning),
          },
        });
        kundeStatus = "sendt";
      } catch (e) {
        sidsteFejl = kortFejl(e);
        kundeStatus = "fejlet";
        logger.error("mail til kunde fejlede", { aftale: ref.id, felt, fejl: sidsteFejl });
      }
    }

    // 2) Michael. Ved en NY booking får han altid sin: det er hans eneste
    //    besked om, at der er kommet en. Ved en AFLYSNING får han kun en
    //    mail, hvis kunden ikke kunne nås.
    const skalHaveMail = aflysning ? kundeStatus !== "sendt" : true;
    if (michaelStatus !== "sendt" && skalHaveMail) {
      try {
        const m = aflysning
          ? aflysningsAlarm(a, ydelseNavn, kundeStatus)
          : mailTilMichael(a, ydelseNavn, kundeStatus);
        await send(transport, {
          til: MICHAEL_MODTAGERE,
          svarTil: kundeAdresse || undefined,   // så han kan svare kunden med ét tryk
          emne: m.emne, tekst: m.tekst, html: m.html,
        });
        michaelStatus = "sendt";
      } catch (e) {
        sidsteFejl = kortFejl(e);
        michaelStatus = "fejlet";
        logger.error("mail til Michael fejlede", { aftale: ref.id, felt, fejl: sidsteFejl });
      }
    } else if (!skalHaveMail) {
      michaelStatus = "unoedvendig";
    }
  } catch (e) {
    sidsteFejl = kortFejl(e);
    logger.error("kunne ikke oprette forbindelse til SMTP", { aftale: ref.id, felt, fejl: sidsteFejl });
    if (kundeStatus === "afventer") kundeStatus = "fejlet";
    if (michaelStatus === "afventer") michaelStatus = "fejlet";
  } finally {
    if (transport) { try { transport.close(); } catch (ignoreret) { /* ligegyldigt */ } }
  }

  // Færdig, når Michael har fået sin (eller ikke skulle have en), OG kunden
  // enten fik sin, ikke har en adresse, eller har en adresse med slåfejl.
  // En slåfejl bliver ikke rigtig af at vente.
  const michaelOK = michaelStatus === "sendt" || michaelStatus === "unoedvendig";
  const kundeOK = kundeStatus === "sendt" || kundeStatus === "ingen" || kundeStatus === "ugyldig";
  const faerdig = michaelOK && kundeOK;

  await ref.update({
    [`${felt}.status`]: faerdig ? "sendt" : "fejlet",
    [`${felt}.kunde`]: kundeStatus,
    [`${felt}.michael`]: michaelStatus,
    [`${felt}.forsoeg`]: krav.forsoeg,
    [`${felt}.laastTil`]: FieldValue.delete(),
    [`${felt}.sidst`]: FieldValue.serverTimestamp(),
    [`${felt}.fejl`]: faerdig ? FieldValue.delete() : (sidsteFejl || "ukendt fejl"),
  }).catch((e) => {
    logger.error("kunne ikke skrive mailstatus", { aftale: ref.id, felt, fejl: String(e && e.message).slice(0, 160) });
  });

  if (faerdig) {
    logger.info("mail sendt", { haendelse: "mail-sendt", aftale: ref.id, felt, kunde: kundeStatus, forsoeg: krav.forsoeg });
  } else {
    logger.error("mail ikke sendt", {
      haendelse: "mail-fejl", aftale: ref.id, felt,
      kunde: kundeStatus, michael: michaelStatus, forsoeg: krav.forsoeg, fejl: sidsteFejl,
    });
  }
  return { proevIgen: !faerdig };
}

const MAIL_INDSTILLINGER = {
  region: UDLOESER_REGION,
  secrets: [RESEND_NOEGLE],
  retry: true,          // uden den er ét netværkshikke lig med ingen bekræftelse
  timeoutSeconds: 60,
  memory: "256MiB",
  maxInstances: 5,
};

// ---------------------------------------------------------------------------
// Udløser 1: ny booking
// ---------------------------------------------------------------------------
exports.sendBekraeftelse = onDocumentCreated(
  Object.assign({ document: "aftaler/{id}" }, MAIL_INDSTILLINGER),
  async (event) => {
    const snap = event.data;
    if (!snap || !snap.exists) return;
    if (snap.data().status !== "booket") return;
    if (!(await mailErAktiv())) {
      logger.info("mail er slået fra i config/booking", { aftale: snap.id });
      return;
    }
    const svar = await udfoerOpgave(snap.ref, "mail", false);
    // Kast, så platformen prøver igen med voksende pause. Uden kast bliver
    // begivenheden kvitteret, og mailen er væk for altid.
    if (svar.proevIgen) throw new Error(`bekræftelsen blev ikke sendt for ${snap.id}`);
  }
);

// ---------------------------------------------------------------------------
// Udløser 2: Michael aflyser
// ---------------------------------------------------------------------------
// Kunden har en skriftlig bekræftelse i hånden. Uden den her kører kunden til
// Bjæverskov og står foran en låst dør. Det er det værste, systemet kan lave.
exports.sendAflysning = onDocumentUpdated(
  Object.assign({ document: "aftaler/{id}" }, MAIL_INDSTILLINGER),
  async (event) => {
    const foer = event.data && event.data.before;
    const efter = event.data && event.data.after;
    if (!foer || !efter || !efter.exists) return;
    // KUN skiftet booket til aflyst. Alt andet, også vores egne skrivninger
    // af mail-felterne, falder igennem her, så funktionen ikke går i ring.
    if (foer.data().status === "aflyst" || efter.data().status !== "aflyst") return;
    if (!(await mailErAktiv())) return;

    const svar = await udfoerOpgave(efter.ref, "aflysningsMail", true);
    if (svar.proevIgen) throw new Error(`aflysningsbeskeden blev ikke sendt for ${efter.id}`);
  }
);

// ---------------------------------------------------------------------------
// Vagten. Dør en kørsel midt i en afsendelse, står låsen på "sender", og
// platformens eget genforsøg kan nå at ramme, mens låsen stadig er frisk.
// Så ville mailen være tabt, uden at nogen opdagede det. Vagten samler dem op
// hvert kvarter. Den er også den, der får en mail igennem, når man har rettet
// en forkert adgangskode: den prøver videre, længe efter at udløserens egne
// genforsøg er brugt op.
//
// Der spørges kun på ÉT felt, så der skal ikke laves et sammensat index, og
// listen er tom de allerfleste gange.
// ---------------------------------------------------------------------------
exports.mailVagt = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Europe/Copenhagen",
    region: UDLOESER_REGION,
    secrets: [RESEND_NOEGLE],
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async () => {
    if (!(await mailErAktiv())) return;
    const graense = Date.now();

    for (const felt of ["mail", "aflysningsMail"]) {
      let snap;
      try {
        snap = await db.collection("aftaler")
          .where(`${felt}.status`, "in", ["sender", "fejlet"])
          .limit(20).get();
      } catch (e) {
        logger.error("mailvagt kunne ikke hente", { felt, fejl: String(e && e.message).slice(0, 160) });
        continue;
      }
      for (const doc of snap.docs) {
        const m = doc.data()[felt] || {};
        // Rør kun dem, hvor låsen er gået kold. Ellers kunne vagten afbryde
        // en afsendelse, der er i gang lige nu.
        if (m.laastTil && m.laastTil.toMillis() > graense) continue;
        try {
          await udfoerOpgave(doc.ref, felt, felt === "aflysningsMail");
        } catch (e) {
          // Én dårlig aftale må ikke stoppe resten af rundturen.
          logger.error("mailvagt fejlede", { aftale: doc.id, felt, fejl: String(e && e.message).slice(0, 160) });
        }
      }
    }
  }
);
