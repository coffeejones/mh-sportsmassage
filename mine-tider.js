// mine-tider.js. Michaels egen side: hvornår er jeg ledig?
//
// Grundprincippet: han skal ALDRIG gætte på, hvad kunderne ser. Han skal kigge
// på det. Derfor genbruges kundesidens egne knapper (.day, .slot, .btn), og
// alle tider regnes med PRÆCIS samme funktioner som bookingsiden bruger.
//
// Der findes ingen normal uge. Der findes kun dage, han har åbnet.
//
// Netværket er ægte nu. To regler gælder derfor overalt i filen:
//   1. En tom skærm må aldrig betyde "der er ingenting". Den skal sige,
//      om vi rent faktisk har fået svar fra serveren.
//   2. En kladde må aldrig forsvinde, fordi noget gik galt, eller fordi
//      han trykkede et andet sted.

(function () {
  "use strict";

  const T = window.MHTid;
  const Store = window.MHStore;
  const Auth = window.MHAuth;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Kunne firebase-scripterne ikke hentes, findes datalaget ikke, og alt
  // herunder ville kaste. En hvid side får en 55-årig til at ringe til sin søn.
  const START = $("mtStart");
  if (!T || !Store || !Auth) {
    if (START) START.textContent =
      "Siden blev ikke hentet helt. Tjek nettet, luk fanen, og åbn den igen.";
    return;
  }

  // ---------- tilstand ----------
  let CONFIG = T.STANDARD_CONFIG;
  let CONFIG_UDEN_VARSEL = Object.assign({}, CONFIG, { varselTimer: 0 });
  let CONFIG_HENTET = false;
  let DAGE = {};            // iso til dags-dokument
  let AFTALER = [];         // hentet én gang, brugt af BÅDE panelet og fanen
  let AFTALER_OK = false;
  let TILSTAND = {};        // iso til "lukket" | "ledig" | "forSent" | "fuld" | "kort"
  let AABEN_ISO = null;     // hvilken dag er foldet ud
  let KLADDER = {};         // iso til [{fra, til}]. Én kladde PR. DAG, som aldrig smides væk
  let VALGT_START = null;   // første tryk i tids-gitteret
  let PANELBESKED = "";     // lever i tilstanden, ikke i DOM'en, så den overlever gentegning
  let KVITTERING = null;    // iso for den dag, der lige blev gemt
  let GEMMER = null;        // iso for den dag, der gemmes lige nu
  let KLADDER_LAEST = false;

  const GITTER_FRA = 6 * 60;
  const GITTER_TIL = 24 * 60;   // 24:00 findes som SLUTtid, ellers er 23:00 en blindgyde

  // ---------- kladder ----------
  const gemtVinduer = (iso) => ((DAGE[iso] && DAGE[iso].vinduer) || []);
  const noegle = (v) => (v || []).slice().sort((a, b) => a.fra - b.fra)
    .map((x) => x.fra + "." + x.til).join(",");

  function kladde(iso) {
    if (!KLADDER[iso]) KLADDER[iso] = gemtVinduer(iso).map((v) => ({ fra: v.fra, til: v.til }));
    return KLADDER[iso];
  }
  function harAendringer(iso) {
    return !!KLADDER[iso] && noegle(KLADDER[iso]) !== noegle(gemtVinduer(iso));
  }

  // Telefonen låser, han tager et opkald, iOS smider fanen ud. Kladden skal
  // stadig være der. Den lægges tilbage STILLE, og pillen "Ikke gemt"
  // fortæller sandheden, så der er ingenting at svare ja eller nej til.
  const KLADDE_KEY = "mh.minetider.kladder";
  function skrivKladder() {
    try {
      const kun = {};
      Object.keys(KLADDER).forEach((iso) => { if (harAendringer(iso)) kun[iso] = KLADDER[iso]; });
      if (!Object.keys(kun).length) localStorage.removeItem(KLADDE_KEY);
      else localStorage.setItem(KLADDE_KEY, JSON.stringify({ tid: Date.now(), kladder: kun }));
    } catch { /* privat tilstand, ignoreres */ }
  }
  function laesKladder() {
    try {
      const k = JSON.parse(localStorage.getItem(KLADDE_KEY) || "null");
      if (!k || Date.now() - k.tid > 24 * 3600 * 1000) return {};
      return k.kladder || {};
    } catch { return {}; }
  }

  // ---------- login ----------
  // Det, der REELT beskytter data, er Firestore-reglen "kun Michaels uid",
  // ikke denne skærm. Åbner en fremmed siden, får de en tom skal.
  let VAR_LOGGET_IND = false;
  let SELV_LOG_UD = false;

  function visLoginFejl(tekst) {
    const p = $("mtLoginFejl");
    p.textContent = tekst || "";
    p.hidden = !tekst;
  }

  function visLogin(uventet) {
    if (START) START.hidden = true;
    $("mtLogin").hidden = false;
    $("mtApp").hidden = true;
    $("mtLogUd").hidden = true;
    visLoginFejl(uventet
      ? "Du blev logget ud. Det sker ind imellem af sikkerhedsgrunde. De tider, du har gemt, står der stadig. Log ind igen."
      : "");
  }

  async function visApp() {
    if (START) START.hidden = true;
    $("mtLogin").hidden = true;
    $("mtApp").hidden = false;
    $("mtLogUd").hidden = false;
    const hvem = $("mtHvem");
    if (hvem) hvem.textContent = "Logget ind som " + (Auth.email() || "");
    $("mtSum").textContent = "Henter dine tider…";
    await tegn();
  }

  $("mtLoginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const knap = e.target.querySelector("button[type=submit]");
    const mail = $("mtEmail").value.trim();
    const kode = $("mtKode").value;
    if (!mail || !kode) { visLoginFejl("Udfyld begge felter."); return; }

    knap.disabled = true;
    const original = knap.textContent;
    knap.textContent = "Logger ind…";
    const res = await Auth.logInd(mail, kode);
    knap.disabled = false;
    knap.textContent = original;

    if (!res.ok) { visLoginFejl(res.fejl); return; }
    visLoginFejl("");
    $("mtKode").value = "";
    await visApp();
  });

  // Funktionen lå færdig i datalaget og blev aldrig kaldt. Bliver han logget
  // ud en fredag aften, skal han ikke vente på, at Jonas tager telefonen.
  $("mtGlemt").addEventListener("click", async () => {
    const mail = $("mtEmail").value.trim();
    if (!mail) { visLoginFejl("Skriv din e-mail i feltet ovenfor først."); return; }
    const res = await Auth.nulstilKode(mail);
    visLoginFejl(res.ok
      ? "Der er sendt en mail til " + mail + ". Åbn den, og vælg en ny adgangskode."
      : res.fejl);
  });

  $("mtLogUd").addEventListener("click", async () => {
    const ugemt = Object.keys(KLADDER).filter(harAendringer).length;
    const spm = ugemt
      ? "Du har tider, du ikke har gemt. De forsvinder, hvis du logger ud. Log ud alligevel?"
      : "Log ud af Mine tider?";
    if (!window.confirm(spm)) return;
    SELV_LOG_UD = true;
    try { localStorage.removeItem(KLADDE_KEY); } catch { /* ignoreres */ }
    await Auth.logUd();
    visLogin(false);
  });

  // ---------- faner ----------
  // Begge faner tegnes af de SAMME data, hentet én gang. Så kan de to sider
  // aldrig sige noget forskelligt om den samme dag.
  function skiftFane(tider) {
    $("mtFaneTider").setAttribute("aria-pressed", tider ? "true" : "false");
    $("mtFaneBookinger").setAttribute("aria-pressed", tider ? "false" : "true");
    $("mtSideTider").hidden = !tider;
    $("mtSideBookinger").hidden = tider;
    if (!tider) tegnBookinger();
  }
  $("mtFaneTider").addEventListener("click", () => skiftFane(true));
  $("mtFaneBookinger").addEventListener("click", () => skiftFane(false));

  function status(tekst) { const p = $("mtStatus"); if (p) p.textContent = tekst || ""; }

  // ---------- hent og tegn ----------
  async function tegn() {
    try {
      if (!CONFIG_HENTET) {
        CONFIG = await Store.config();
        CONFIG_UDEN_VARSEL = Object.assign({}, CONFIG, { varselTimer: 0 });
        CONFIG_HENTET = true;   // indstillingerne ændrer sig praktisk talt aldrig
      }
      const datoer = T.datoerFrem(CONFIG.horisontDage);
      const isoer = datoer.map(T.isoOf);

      // Dage og aftaler i ÉN ventetid. Aftalerne må gerne fejle for sig:
      // så mister vi navnene, ikke hele siden.
      const [dage, aftaler] = await Promise.all([
        Store.dage(isoer),
        Store.aftaler().then((a) => ({ ok: true, a })).catch(() => ({ ok: false, a: [] })),
      ]);
      DAGE = dage;
      AFTALER = aftaler.a.filter((x) => x.status !== "aflyst");
      AFTALER_OK = aftaler.ok;

      if (!KLADDER_LAEST) { Object.assign(KLADDER, laesKladder()); KLADDER_LAEST = true; }

      // Tilstande og opsummering regnes over HELE horisonten, men kun den
      // valgte måned tegnes. Derfor er bladring gratis: ingen ny forespørgsel.
      beregnTilstande(isoer);
      tegnSum(datoer, isoer);
      tegnDage(maanedsDatoer());
    } catch {
      visHenteFejl();
    }
  }

  // Han ser hellere ingenting end noget forkert. En tom liste ville påstå,
  // at hans tider er væk.
  function visHenteFejl() {
    $("mtSum").textContent = "";
    status("");
    const box = $("mtDage");
    box.innerHTML = "";
    const kort = document.createElement("div");
    kort.className = "booking__empty";
    const p = document.createElement("p");
    p.textContent = "Dine tider kunne ikke hentes lige nu. De er der stadig, " +
      "telefonen kan bare ikke få fat i dem. Tjek nettet, og prøv igen.";
    const igen = document.createElement("button");
    igen.type = "button";
    igen.className = "btn btn--outline";
    igen.textContent = "Prøv igen";
    igen.addEventListener("click", () => { box.innerHTML = ""; $("mtSum").textContent = "Henter dine tider…"; tegn(); });
    kort.append(p, igen);
    box.appendChild(kort);
  }

  // Hvorfor er der ingen ledige tider? Tre vidt forskellige grunde, som ikke
  // må hedde det samme. Regnes ÉN gang, ikke ved hvert eneste fingertryk.
  function beregnTilstande(isoer) {
    const nu = new Date();
    TILSTAND = {};
    isoer.forEach((iso) => {
      const dag = DAGE[iso];
      if (!gemtVinduer(iso).length) { TILSTAND[iso] = "lukket"; return; }
      if (CONFIG.lukket) { TILSTAND[iso] = "ledig"; return; }  // nødbremsen, ikke dagens skyld
      if (T.harLedigeTider(dag, CONFIG, nu)) { TILSTAND[iso] = "ledig"; return; }
      // Ville der være tider, hvis varslet ikke fandtes? Så er det varslet.
      if (T.harLedigeTider(dag, CONFIG_UDEN_VARSEL, T.datoFraISO(iso))) { TILSTAND[iso] = "forSent"; return; }
      TILSTAND[iso] = T.optagetListe(dag).length ? "fuld" : "kort";
    });
  }

  const MAERKAT = {
    ledig: "", lukket: "",
    forSent: "For sent for kunder",
    fuld: "Alt er booket",
    kort: "For kort til en behandling",
  };

  // Det spørgsmål han oftest står med, tit med en kunde i røret.
  // 30-minutters starttider er en overmængde af 60 og 90, så den korteste
  // ydelse alene giver det rigtige svar.
  function naesteLedige(datoer, nu) {
    const kort = (CONFIG.ydelser || []).slice().sort((a, b) => a.minutter - b.minutter)[0];
    if (!kort) return null;
    for (let i = 0; i < datoer.length; i++) {
      const iso = T.isoOf(datoer[i]);
      const s = T.ledigeStarter(DAGE[iso], CONFIG, kort, nu);
      if (s.length) return { dato: datoer[i], min: s[0] };
    }
    return null;
  }

  function tegnSum(datoer, isoer) {
    const nu = new Date();
    let aaben = 0, booket = 0;
    isoer.forEach((iso) => { aaben += T.aabneTimer(DAGE[iso]); booket += T.bookedeTimer(DAGE[iso]); });
    const t = (n) => (Math.round(n * 10) / 10).toString().replace(".", ",");
    const sum = $("mtSum");
    sum.innerHTML = "";

    if (CONFIG.lukket) {
      const p = document.createElement("span");
      p.className = "mtsum__naeste";
      p.textContent = "Online booking er slået fra for alle dage. Ring til Jonas for at slå den til igen.";
      sum.appendChild(p);
      return;
    }

    const linje1 = document.createElement("span");
    linje1.className = "mtsum__naeste";
    if (aaben === 0) {
      linje1.textContent = "Du har ikke åbnet nogen tider. Kunder kan ikke booke lige nu, " +
        "de får dit telefonnummer i stedet. Tryk på en dag herunder for at åbne den.";
      sum.appendChild(linje1);
      return;
    }
    const n = naesteLedige(datoer, nu);
    linje1.textContent = n
      ? `Næste ledige tid: ${T.dagLabel(n.dato)} kl. ${T.minTilHHMM(n.min)}.`
      : "Der er ingen ledige tider tilbage. Kunderne får dit telefonnummer.";

    // Horisonten ruller: hver dag dukker en ny, lukket dag nummer 28 op i bunden.
    // Uden den her sætning står klinikken tom, uden at nogen opdager det.
    let sidsteAabne = null;
    isoer.forEach((iso) => { if (gemtVinduer(iso).length) sidsteAabne = iso; });
    const bagkant = (sidsteAabne && sidsteAabne !== isoer[isoer.length - 1])
      // dagLabel slutter allerede på "aug.", så et punktum mere giver "aug.."
      ? ` Du har intet åbent efter ${T.dagLabel(T.datoFraISO(sidsteAabne))}` : "";

    const linje2 = document.createElement("span");
    linje2.className = "mtsum__tal";
    linje2.textContent =
      `Du har åbnet ${t(aaben)} timer i alt, ${t(booket)} er booket.` + bagkant;
    sum.append(linje1, linje2);
  }

  // ---------- kalenderen ----------
  // Kalenderen ERSTATTER dagslisten. Den skal derfor bære alt det, listen bar:
  // alle dage i horisonten, også de lukkede; hvor meget der er åbent; hvor der
  // ligger aftaler; hvorfor en åben dag alligevel ikke kan bookes; og hvor der
  // ligger arbejde, han ikke har gemt.
  //
  // Gitteret er RIGTIGE uger, mandag til søndag, fordi hans vagtplan er skrevet
  // i uger og i ugenumre. Det koster nul til seks felter i hver ende, som ligger
  // uden for horisonten, og de får den behandling, der ikke findes andre steder
  // i gitteret: ingen æske overhovedet.
  //
  // Ingen pile, ingen sider, ingen bladring. Hele horisonten står på skærmen
  // på én gang. Han skal kunne se sin bagkant samtidig med i dag, ellers holder
  // han op med at kigge efter den.

  let FOKUS_ISO = null;   // hvilken celle tastaturet står på (roving tabindex)

  const alleISO = () => T.datoerFrem(CONFIG.horisontDage).map(T.isoOf);
  const tal1 = (n) => (Math.round(n * 10) / 10).toString().replace(".", ",");
  const stort = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function ugeNr(d) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    t.setDate(t.getDate() + 4 - (t.getDay() || 7));
    const start = new Date(t.getFullYear(), 0, 1);
    return Math.ceil(((t - start) / 86400000 + 1) / 7);
  }

  function mandagFoer(d) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
    return t;
  }

  // Hele horisonten, rundet ud til hele uger. Fire rækker hvis i dag er en
  // mandag, ellers fem. Aldrig mere. new Date(y, m, d + i) tåler sommertid,
  // det gør et tillæg på 86400000 millisekunder ikke, derfor Math.round.
  function ugerFor(datoer) {
    const start = mandagFoer(datoer[0]);
    const slut = datoer[datoer.length - 1];
    const antal = Math.ceil((Math.round((slut - start) / 86400000) + 1) / 7);
    const uger = [];
    for (let i = 0; i < antal; i++) {
      const uge = [];
      for (let j = 0; j < 7; j++) {
        uge.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i * 7 + j));
      }
      uger.push(uge);
    }
    return uger;
  }

  // Alt det, en celle og en linje skal vide, regnet ét sted.
  // Horisonten regnes ALTID over hele perioden, aldrig kun over den viste
  // måned. Ellers ville dagene i den forrige og den næste måned se døde ud,
  // selv om de kan redigeres.
  function ctxNu() {
    const nu = new Date();
    const ctx = {
      iDag: T.isoOf(nu),
      iMorgen: T.isoOf(new Date(nu.getFullYear(), nu.getMonth(), nu.getDate() + 1)),
      iHorisont: {},
    };
    T.datoerFrem(CONFIG.horisontDage).forEach((d) => { ctx.iHorisont[T.isoOf(d)] = true; });
    return ctx;
  }

  // ---------- måneden der vises ----------
  // Michael planlægger måneder frem, når vagtplanen kommer. Derfor viser
  // kalenderen én måned ad gangen, mens DATA for hele horisonten hentes ÉN
  // gang. At bladre koster derfor ingen ventetid og ingen forespørgsel.
  const MAANEDER_FULDE = ["januar", "februar", "marts", "april", "maj", "juni",
    "juli", "august", "september", "oktober", "november", "december"];
  let VIST_MND = null;   // Date, den 1. i den viste måned

  const mndStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
  const mndSkift = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);

  function vistMaaned() {
    if (!VIST_MND) VIST_MND = mndStart(new Date());
    return VIST_MND;
  }
  // Alle dage i den viste måned. tegnDage fylder selv ugerne ud til mandag og søndag.
  function maanedsDatoer() {
    const m = vistMaaned();
    const antal = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    const ud = [];
    for (let i = 1; i <= antal; i++) ud.push(new Date(m.getFullYear(), m.getMonth(), i));
    return ud;
  }
  const foersteMnd = () => mndStart(new Date());
  const sidsteMnd = () => {
    const d = T.datoerFrem(CONFIG.horisontDage);
    return mndStart(d[d.length - 1]);
  };
  function saetMaaned(m) {
    const min = foersteMnd(), max = sidsteMnd();
    VIST_MND = m < min ? min : (m > max ? max : m);
    AABEN_ISO = null;
    VALGT_START = null;
    tegnDage(maanedsDatoer());
  }

  // Cellen viser ALTID det, der står gemt på serveren, aldrig kladden. Så kan
  // en celle aldrig påstå noget over for ham, som kunderne ikke ved. Kladden
  // meldes med bjælken langs overkanten og med linjen under ugen.
  //
  // Starttidspunktet må ALDRIG vige for en tilstand. Det spørgsmål, han står
  // med efter en nattevagt, er "hvornår møder jeg", og det svar skal stå der,
  // også når dagen er udsolgt eller for sent for kunderne. Har han to vinduer
  // samme dag, står det første her og begge i linjen under gitteret.
  // Cellen er cirka 45px bred, så "17:00 til 21:00" kan ikke stå der. Men
  // starttiden alene er ikke nok til at planlægge efter. Derfor den kompakte
  // danske form: "17-21", og "17.30-21" når klokken er skæv.
  const kort = (min) => (min % 60 === 0)
    ? String(Math.floor(min / 60))
    : Math.floor(min / 60) + "." + T.pad(min % 60);

  // "17-21" er fem tegn og passer på én linje. "17.30-21" er otte og gør det
  // ikke, uanset hvor lille skriften bliver. Derfor brydes de skæve tider
  // bevidst over to linjer i stedet for at brække tilfældigt midt i et tal.
  function celleTid(iso) {
    const v = gemtVinduer(iso);
    if (!v.length) return { tekst: "", toLinjer: false };
    const sorteret = v.slice().sort((a, b) => a.fra - b.fra);
    const f = sorteret[0];
    // Har han flere vinduer samme dag, viser cellen det første og et plus.
    // Begge står ordret i linjen under ugen, i panelet og i skærmlæserens etiket.
    const plus = sorteret.length > 1 ? "+" : "";
    const helt = f.fra % 60 === 0 && f.til % 60 === 0;
    return helt
      ? { tekst: kort(f.fra) + "-" + kort(f.til) + plus, toLinjer: false }
      : { fra: kort(f.fra), til: kort(f.til) + plus, toLinjer: true };
  }

  // Mikrolinjen har tre opgaver og kun plads til én. "I dag" og "i morgen"
  // slår månedsnavnet, for det er de to dage, han beslutter noget om.
  function celleMikro(d, iso, ctx) {
    if (iso === ctx.iDag) return "i dag";
    if (iso === ctx.iMorgen) return "i morgen";
    if (d.getDate() === 1) return T.MAANEDER[d.getMonth()];
    return "";
  }

  function celleKlasser(iso, ctx) {
    const t = TILSTAND[iso] || "lukket";
    return "mtdag mtkaldag" +   // .mtdag er gemDagens egen selektor, se linje 728
      (gemtVinduer(iso).length ? " mtkaldag--aaben" : " mtkaldag--lukket") +
      (t === "fuld" || t === "forSent" || t === "kort" ? " mtkaldag--spaerret" : "") +
      (t === "forSent" || t === "kort" ? " mtkaldag--uden" : "") +
      (iso === ctx.iDag ? " mtkaldag--idag" : "") +
      (harAendringer(iso) ? " mtkaldag--ugemt" : "") +
      (AABEN_ISO === iso ? " mtkaldag--valgt" : "");
  }

  // Skærmlæseren får HELE sandheden, også den ordrette vinduetekst, som cellen
  // kun kan antyde med ét klokkeslæt.
  function celleNavn(d, iso, ctx) {
    const naar = iso === ctx.iDag ? "I dag" : (iso === ctx.iMorgen ? "I morgen" : "");
    // dagLabel slutter på en forkortet måned ("aug."), så et punktum mere
    // ville give "aug..", som skærmlæseren læser op som to sætningsslut.
    const dato = T.dagLabel(d);
    const medPunktum = /\.$/.test(dato) ? dato : dato + ".";
    const dele = [naar ? naar + ", " + medPunktum : stort(medPunktum)];
    if (gemtVinduer(iso).length) {
      dele.push("Åbent " + T.vinduerLabel(DAGE[iso]) + ", " +
        tal1(T.aabneTimer(DAGE[iso])) + " timer.");
    } else {
      dele.push("Lukket.");
    }
    const antal = T.optagetListe(DAGE[iso]).length;
    if (antal) dele.push(antal === 1 ? "1 aftale." : antal + " aftaler.");
    const m = MAERKAT[TILSTAND[iso] || "lukket"];
    if (m) dele.push(m + ".");
    if (harAendringer(iso)) dele.push("Ikke gemt.");
    else if (KVITTERING === iso) dele.push("Gemt.");
    return dele.join(" ");
  }

  // Cellens bånd har faste højder, også når de er tomme. Derfor kan indholdet
  // skifte, uden at cellen skifter højde, og uden at panelet under den flytter
  // sig under fingeren.
  function fyldCelle(knap, d, iso, ctx) {
    const antal = T.optagetListe(DAGE[iso]).length;
    knap.className = celleKlasser(iso, ctx);
    knap.setAttribute("aria-expanded", AABEN_ISO === iso ? "true" : "false");
    if (AABEN_ISO === iso) knap.setAttribute("aria-controls", "mtkalpanel");
    else knap.removeAttribute("aria-controls");
    knap.setAttribute("aria-label", celleNavn(d, iso, ctx));
    knap.innerHTML =
      `<span class="mtkaldag__mikro">${esc(celleMikro(d, iso, ctx))}</span>` +
      `<span class="mtkaldag__num">${d.getDate()}</span>` +
      (function () {
        const t = celleTid(iso);
        return t.toLinjer
          ? `<span class="mtkaldag__tid mtkaldag__tid--to">` +
            `<span>${esc(t.fra)}</span><span>${esc(t.til)}</span></span>`
          : `<span class="mtkaldag__tid">${esc(t.tekst)}</span>`;
      })() +
      (antal ? `<span class="mtkaldag__kunder">${antal > 9 ? "9+" : antal}</span>` : "");
  }

  // Linjerne under ugens gitter. De er IKKE en nøgle til gitterets former: de
  // forklarer ikke en kant, de leverer de klokkeslæt, listen skrev ud, og som
  // en celle på 45 px fysisk ikke kan rumme. De findes kun for de dage, han
  // har åbnet eller rørt ved, altså typisk to til fire pr. uge.
  function tegnFakta(uge, ctx) {
    const boks = document.createElement("div");
    boks.className = "mtkalfakta";

    uge.forEach((d) => {
      const iso = T.isoOf(d);
      if (!ctx.iHorisont[iso]) return;
      const aabent = gemtVinduer(iso).length > 0;
      const ugemt = harAendringer(iso);
      const gemt = KVITTERING === iso;
      if (!aabent && !ugemt && !gemt) return;

      const navn = iso === ctx.iDag ? "I dag"
        : (iso === ctx.iMorgen ? "I morgen"
          : stort(T.UGEDAGE_KORT[d.getDay()]) + " " + d.getDate() + ".");

      const noter = [];
      const antal = T.optagetListe(DAGE[iso]).length;
      if (antal) noter.push(antal === 1 ? "1 aftale" : antal + " aftaler");
      const m = MAERKAT[TILSTAND[iso] || "lukket"];
      if (m) noter.push(m.toLowerCase());

      const p = document.createElement("p");
      p.className = "mtkalfakta__linje";
      p.innerHTML =
        `<span class="mtkalfakta__dag">${esc(navn)}</span>` +
        `<span class="mtkalfakta__tid">${aabent ? esc(T.vinduerLabel(DAGE[iso])) : "Lukket"}</span>` +
        (noter.length ? `<span class="mtkalfakta__note">${esc(noter.join(", "))}</span>` : "") +
        (ugemt ? `<span class="mtkalfakta__note mtkalfakta__note--ugemt">Ikke gemt</span>`
          : (gemt ? `<span class="mtkalfakta__note mtkalfakta__note--gemt">Gemt</span>` : ""));
      boks.appendChild(p);
    });
    return boks;
  }

  // Piletaster i gitteret. Der er ikke noget tastatur på hans telefon, men der
  // er et på hans computer, og otteogtyve tabuleringer er ikke navigation.
  // Kun de LEVENDE celler er med i listen, og de døde ligger altid samlet i de
  // to ender, så plus og minus syv rammer stadig den samme ugedag.
  function gitterTaster(e) {
    const celle = e.target.closest ? e.target.closest(".mtkaldag[data-iso]") : null;
    if (!celle) return;
    const trin = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (trin === undefined && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();

    const celler = Array.prototype.slice.call(
      e.currentTarget.querySelectorAll(".mtkaldag[data-iso]"));
    const i = celler.indexOf(celle);
    let n = e.key === "Home" ? 0 : (e.key === "End" ? celler.length - 1 : i + trin);
    n = Math.max(0, Math.min(celler.length - 1, n));
    if (n === i) return;

    celler.forEach((c) => { c.tabIndex = -1; });
    celler[n].tabIndex = 0;
    FOKUS_ISO = celler[n].dataset.iso;
    celler[n].focus();
  }

  function tegnKalPanel(iso, dato, kol) {
    const hold = document.createElement("div");
    hold.className = "mtkalpanel";
    hold.id = "mtkalpanel";
    hold.dataset.iso = iso;
    hold.style.setProperty("--kol", String(kol));
    hold.tabIndex = -1;
    hold.setAttribute("role", "group");
    hold.setAttribute("aria-label", stort(T.dagLabel(dato)));

    // Hovedet siger med ord det, cellen kun kan sige med ét klokkeslæt.
    // Det er her, "17:00 til 21:00 · 09:00 til 14:00" bor nu.
    const hoved = document.createElement("div");
    hoved.className = "mtkalpanel__hoved";
    const v = gemtVinduer(iso);
    hoved.innerHTML =
      `<span class="mtkalpanel__dag">${esc(stort(T.dagLabel(dato)))}</span>` +
      `<span class="mtkalpanel__tid">${v.length
        ? "Åben " + esc(T.vinduerLabel(DAGE[iso])) : "Lukket"}</span>`;
    const luk = document.createElement("button");
    luk.type = "button";
    luk.className = "mtkalpanel__luk";
    luk.textContent = "Luk";
    luk.addEventListener("click", () => aabnDag(iso));
    hoved.appendChild(luk);
    hold.appendChild(hoved);

    // Listen sagde HVAD. Her står for første gang også HVORFOR, med hans
    // egne tal, så en spærret dag ikke bare er en mærkat.
    const y = (CONFIG.ydelser || []).slice().sort((a, b) => a.minutter - b.minutter)[0];
    const FORKLAR = {
      forSent: "For sent for kunder. Der skal være " + CONFIG.varselTimer +
        " timer, fra en kunde booker, til tiden begynder.",
      fuld: "Alt er booket. Der er ikke flere ledige tider tilbage på dagen.",
      kort: "For kort til en behandling. Den korteste behandling tager " +
        (y ? y.minutter : 30) + " minutter.",
    };
    const f = FORKLAR[TILSTAND[iso]];
    if (f) {
      const p = document.createElement("p");
      p.className = "mtkalpanel__stand";
      p.textContent = f;
      hold.appendChild(p);
    }

    hold.appendChild(tegnPanel(iso, dato));   // tegnPanel er UÆNDRET
    return hold;
  }

  // Navnet beholdes: gemDagen kalder tegnDage(datoer) på linje 724.
  // Kalenderen skjuler ALDRIG en dag i horisonten. En lukket dag er ét tryk
  // fra at være åben, og en dag med en aftale kan aldrig forsvinde.
  function tegnDage(datoer) {
    const box = $("mtDage");
    box.innerHTML = "";
    const ctx = ctxNu();

    // Rullede den åbne dag ud af horisonten, mens siden lå åben, kan den ikke
    // redigeres længere. Panelet lukker. Kladden bliver liggende.
    if (AABEN_ISO && !ctx.iHorisont[AABEN_ISO]) AABEN_ISO = null;
    const fokus = AABEN_ISO
      || ((FOKUS_ISO && ctx.iHorisont[FOKUS_ISO]) ? FOKUS_ISO : ctx.iDag);

    const kal = document.createElement("div");
    kal.className = "mtkal";
    kal.setAttribute("role", "group");
    kal.setAttribute("aria-label",
      "Kalender. Tryk på en dag for at se og rette dens tider.");

    // Måneds-bladring. Pilene slukkes i enderne, så han ikke kan bladre ud i
    // fortiden eller ud over den periode, kunderne kan booke i.
    const m = vistMaaned();
    const nav = document.createElement("div");
    nav.className = "mtkalnav";

    const pil = (retning, tekst, navn, slukket) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mtkalnav__pil";
      b.textContent = tekst;
      b.setAttribute("aria-label", navn);
      b.disabled = slukket;
      if (!slukket) b.addEventListener("click", () => saetMaaned(mndSkift(m, retning)));
      return b;
    };
    nav.appendChild(pil(-1, "‹", "Forrige måned", m <= foersteMnd()));

    const midt = document.createElement("div");
    midt.className = "mtkalnav__midt";
    const navn = document.createElement("p");
    navn.className = "mtkalnav__navn";
    navn.setAttribute("aria-live", "polite");
    navn.textContent = MAANEDER_FULDE[m.getMonth()] + " " + m.getFullYear();
    midt.appendChild(navn);
    // Er han seks måneder ude, skal han ikke trykke tilbage seks gange.
    if (m.getTime() !== foersteMnd().getTime()) {
      const hjem = document.createElement("button");
      hjem.type = "button";
      hjem.className = "mtlink mtkalnav__hjem";
      hjem.textContent = "Gå til denne måned";
      hjem.addEventListener("click", () => saetMaaned(foersteMnd()));
      midt.appendChild(hjem);
    }
    nav.appendChild(midt);
    nav.appendChild(pil(1, "›", "Næste måned", m >= sidsteMnd()));
    kal.appendChild(nav);

    // Ugedagsrækken er ren pynt for en skærmlæser: hver celle siger selv
    // "torsdag d. 30. jul." i sit eget aria-label.
    const wd = document.createElement("div");
    wd.className = "mtkal__wd";
    wd.setAttribute("aria-hidden", "true");
    wd.innerHTML = [1, 2, 3, 4, 5, 6, 0]
      .map((i) => `<span>${T.UGEDAGE_KORT[i]}</span>`).join("");
    kal.appendChild(wd);

    // En uge, hvor ingen dag kan redigeres, er syv blege tal og ingenting at
    // trykke på. Den udelades, så han ikke skal rulle forbi tre døde uger i
    // den måned, vi står i.
    const uger = ugerFor(datoer)
      .filter((uge) => uge.some((d) => ctx.iHorisont[T.isoOf(d)]));

    uger.forEach((uge) => {
      const manISO = T.isoOf(uge[0]);
      const sek = document.createElement("section");
      sek.className = "mtkaluge";
      sek.dataset.man = manISO;
      sek.setAttribute("aria-labelledby", "mtuge-" + manISO);

      // Ugens facit, præcis som ugeoverskriften i listen bar det. Han kan
      // finde en tom uge ved at læse fire linjer.
      const timer = uge.reduce((s, d) => {
        const iso = T.isoOf(d);
        return ctx.iHorisont[iso] ? s + T.aabneTimer(DAGE[iso]) : s;
      }, 0);
      const h = document.createElement("p");
      h.className = "mtuge";
      h.id = "mtuge-" + manISO;
      h.innerHTML = `<span>Uge ${ugeNr(uge[0])}</span>` +
        `<span class="mtuge__sum">${timer ? tal1(timer) + " timer åbent" : "Intet åbent"}</span>`;
      sek.appendChild(h);

      const raek = document.createElement("div");
      raek.className = "mtkaluge__dage";
      uge.forEach((d, kol) => {
        const iso = T.isoOf(d);
        if (!ctx.iHorisont[iso]) {
          // Dage før i dag og dage efter horisonten. Ingen ramme, ingen flade,
          // ingen knap, ingen fokusring, ikke i tabuleringen og ikke i
          // skærmlæseren. De ser hverken bookbare ud eller ud som en fejl.
          const ude = document.createElement("div");
          ude.className = "mtkaldag mtkaldag--ude";
          ude.setAttribute("aria-hidden", "true");
          ude.innerHTML = `<span class="mtkaldag__mikro"></span>` +
            `<span class="mtkaldag__num">${d.getDate()}</span>` +
            `<span class="mtkaldag__tid"></span>`;
          raek.appendChild(ude);
          return;
        }
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.iso = iso;
        b.dataset.kol = String(kol);
        b.tabIndex = iso === fokus ? 0 : -1;
        fyldCelle(b, d, iso, ctx);
        b.addEventListener("click", () => aabnDag(iso));
        raek.appendChild(b);
      });
      sek.appendChild(raek);
      sek.appendChild(tegnFakta(uge, ctx));

      // Panelet folder ud i SIN EGEN uge. Cellen bliver siddende højst 100 px
      // over det, og næbbet peger på den. Under hele kalenderen ville den
      // trykkede dag kunne ligge fire rækker væk.
      if (AABEN_ISO) {
        const nr = uge.map(T.isoOf).indexOf(AABEN_ISO);
        if (nr !== -1) sek.appendChild(tegnKalPanel(AABEN_ISO, uge[nr], nr));
      }
      kal.appendChild(sek);
    });

    kal.addEventListener("keydown", gitterTaster);
    kal.addEventListener("focusin", (e) => {
      const c = e.target.closest ? e.target.closest(".mtkaldag[data-iso]") : null;
      if (c) FOKUS_ISO = c.dataset.iso;
    });

    // Kanten af horisonten må ikke kunne misforstås som noget, han mangler
    // at gøre. Én sætning, ikke en brugsanvisning.
    const fod = document.createElement("p");
    fod.className = "mtkalfod";
    // Teksten skal beskrive de blege dage, der FAKTISK står i den viste
    // måned, og den skal bruge horisontens rigtige slutdato, ikke månedens.
    // dagLabel slutter allerede på et punktum, så der lægges ikke et til.
    const viste = uger.reduce((a, u) => a.concat(u), []);
    const fortid = viste.some((d) => !ctx.iHorisont[T.isoOf(d)] && T.isoOf(d) < ctx.iDag);
    const efter = viste.some((d) => !ctx.iHorisont[T.isoOf(d)] && T.isoOf(d) > ctx.iDag);
    const dele = [];
    if (fortid) dele.push("De blege dage er allerede forbi.");
    if (efter) {
      const h = T.datoerFrem(CONFIG.horisontDage);
      dele.push("Du kan åbne tider til og med " + T.dagLabel(h[h.length - 1]));
    }
    fod.textContent = dele.join(" ");
    fod.hidden = !dele.length;
    kal.appendChild(fod);
    box.appendChild(kal);

    // Efter et gem forsvandt Gem-knappen sammen med panelet, og fokus faldt
    // ned på <body>. En skærmlæserbruger stod i ingenting efter sin vigtigste
    // handling. Læg fokus på den dag, han lige gemte.
    if (KVITTERING && document.activeElement === document.body) {
      const c = box.querySelector(`.mtkaldag[data-iso="${KVITTERING}"]`);
      if (c) c.focus({ preventScroll: true });
    }
  }

  // Kun cellens eget indhold. Bånd med faste højder, så højden ikke kan
  // skifte, og bjælken for "ikke gemt" er absolut placeret.
  function opdaterCelle(iso) {
    const c = $("mtDage").querySelector(`.mtkaldag[data-iso="${iso}"]`);
    if (c) fyldCelle(c, T.datoFraISO(iso), iso, ctxNu());
  }

  // Linjerne under den uge, dagen ligger i. De kan skifte HØJDE, for en dag
  // med en frisk kladde får en linje, den ikke havde før. Kaldes derfor kun
  // inde i en måling, se tegnPanelIgen og opdaterHoejre.
  function opdaterFakta(iso) {
    const c = $("mtDage").querySelector(`.mtkaldag[data-iso="${iso}"]`);
    const sek = c && c.closest(".mtkaluge");
    const gl = sek && sek.querySelector(".mtkalfakta");
    if (!gl) return;
    const man = T.datoFraISO(sek.dataset.man);
    const uge = [];
    for (let i = 0; i < 7; i++) {
      uge.push(new Date(man.getFullYear(), man.getMonth(), man.getDate() + i));
    }
    sek.replaceChild(tegnFakta(uge, ctxNu()), gl);
  }

  // Navnet beholdes: gemDagen kalder opdaterHoejre(iso) på linje 693, og
  // gemDagen røres ikke. Den bruges KUN ét sted, nemlig i fejlvejen, hvor en
  // aftale faldt uden for de nye vinduer og dagen lige er hentet frisk fra
  // serveren. Der er DAGE[iso] ny, så både tilstanden, cellen og linjen under
  // ugen er forældet. Derfor regnes tilstandene om, hele gitteret friskes op,
  // og funktionen flytter selv scroll'en tilbage, så panelet ikke vandrer
  // under fingeren, mens han læser sidens vigtigste fejlbesked.
  //
  // Den er dyr, og den skal blive ved med kun at have det ene kaldested.
  // Hvert tryk i tids-gitteret bruger opdaterCelle, ikke den her.
  function opdaterHoejre(iso) {
    const box = $("mtDage");
    const panel = box.querySelector(".mtkalpanel .mtpanel");
    const foer = panel ? panel.getBoundingClientRect().top : null;

    beregnTilstande(alleISO());
    const ctx = ctxNu();
    box.querySelectorAll(".mtkaldag[data-iso]").forEach((c) => {
      fyldCelle(c, T.datoFraISO(c.dataset.iso), c.dataset.iso, ctx);
    });
    box.querySelectorAll(".mtkaluge").forEach((sek) => {
      const gl = sek.querySelector(".mtkalfakta");
      if (!gl) return;
      const man = T.datoFraISO(sek.dataset.man);
      const uge = [];
      for (let i = 0; i < 7; i++) {
        uge.push(new Date(man.getFullYear(), man.getMonth(), man.getDate() + i));
      }
      sek.replaceChild(tegnFakta(uge, ctx), gl);
    });

    // "instant" er nødvendigt: styles.css linje 30 sætter scroll-behavior: smooth.
    if (foer !== null) {
      const efter = panel.getBoundingClientRect().top;
      if (efter !== foer) window.scrollBy({ top: efter - foer, behavior: "instant" });
    }
  }

  // ---------- dagspanelet ----------
  // Folder sig ud i sin egen uge-række. Ikke en modal og ikke et bundark:
  // de skaber fokusfælder og højde-problemer på iOS.
  //
  // Kladden bliver liggende pr. dag. Han kan rode i lørdag, hoppe til onsdag,
  // hoppe tilbage, og alt står der. Derfor er der intet at spørge om.
  function aabnDag(iso) {
    if (GEMMER) return;
    PANELBESKED = "";
    KVITTERING = null;
    VALGT_START = null;
    AABEN_ISO = (AABEN_ISO === iso) ? null : iso;
    if (AABEN_ISO) kladde(iso);
    FOKUS_ISO = iso;
    tegnDage(maanedsDatoer());

    const celle = $("mtDage").querySelector(`.mtkaldag[data-iso="${iso}"]`);
    if (!AABEN_ISO) {
      if (celle) celle.focus({ preventScroll: true });
      status("Dagen er foldet sammen igen.");
      return;
    }
    // Panelet ligger EFTER resten af ugen i DOM-rækkefølgen. En tastaturbruger,
    // der lige trykkede Enter, skal ikke tabulere gennem seks dage for at nå
    // det, han åbnede. Panelet har tabindex -1 og siger selv dagens navn.
    const panel = $("mtDage").querySelector(".mtkalpanel");
    if (panel) panel.focus({ preventScroll: true });
    // Der scrolles til hele UGEN, ikke til cellen: så står ugens facit, de syv
    // dage, linjerne og panelets øverste del på skærmen på én gang.
    // html har allerede scroll-padding-top: 80px.
    const sek = celle && celle.closest(".mtkaluge");
    if (sek) sek.scrollIntoView({ block: "start", behavior: REDUCED ? "auto" : "smooth" });
    status(MAERKAT[TILSTAND[iso]] || "");
  }

  // Kun panelet tegnes om. Gitteret, hans scroll og hans plads i horisonten
  // skal stå helt stille, mens han vælger tider.
  function tegnPanelIgen() {
    const iso = AABEN_ISO;
    const hold = $("mtDage").querySelector(".mtkalpanel");
    if (!iso || !hold) { tegnDage(maanedsDatoer()); return; }

    // MÅL FØRST, og mål før ALLE ændringer. Ved det første tryk i tids-gitteret
    // dukker der en "Ikke gemt"-linje op OVER panelet, og panelet ville flytte
    // sig cirka 20 px under fingeren. Ved at måle panelets egen top før både
    // linjen og indholdet ændrer sig, dækker den ene kompensation begge dele.
    const gl = hold.querySelector(".mtpanel");
    const foer = gl ? gl.getBoundingClientRect().top : null;
    const aktiv = document.activeElement;
    const genfind = aktiv && aktiv.dataset && aktiv.dataset.min ? aktiv.dataset.min : null;

    opdaterCelle(iso);
    opdaterFakta(iso);

    const nyt = tegnPanel(iso, T.datoFraISO(iso));
    if (gl) hold.replaceChild(nyt, gl); else hold.appendChild(nyt);

    if (foer !== null) {
      const efter = nyt.getBoundingClientRect().top;
      if (efter !== foer) window.scrollBy({ top: efter - foer, behavior: "instant" });
    }
    if (genfind) {
      const n = nyt.querySelector(`.slot[data-min="${genfind}"]`);
      if (n) n.focus({ preventScroll: true });
    }
  }

  // Op til tre sæt tider, HAN selv har gemt, nærmeste dage først.
  // Systemet gætter ikke et ugemønster. Det tilbyder en kopi af noget, der
  // står der i forvejen, og han skal stadig trykke Gem.
  function tidligereSaet(iso) {
    const ud = [];
    const nuvaerende = noegle(kladde(iso));
    Object.keys(DAGE).sort().forEach((k) => {
      if (ud.length >= 3) return;
      const v = gemtVinduer(k);
      if (!v.length) return;
      const n = noegle(v);
      if (n === nuvaerende || ud.some((s) => s.noegle === n)) return;
      ud.push({ noegle: n, navn: T.vinduerLabel({ vinduer: v }), vinduer: v });
    });
    return ud;
  }

  function tegnPanel(iso, dato) {
    const panel = document.createElement("div");
    panel.className = "mtpanel";
    const mine = kladde(iso);
    const dagens = AFTALER.filter((a) => a.dato === iso).sort((a, b) => a.fra - b.fra);
    const optaget = T.optagetListe(DAGE[iso]);

    // 0) beskeder lever i tilstanden, så de overlever hvert eneste fingertryk
    if (PANELBESKED) {
      const b = document.createElement("p");
      b.className = "mtpanel__besked";
      b.setAttribute("role", "status");
      b.textContent = PANELBESKED;
      panel.appendChild(b);
    }

    // 1) hvem er booket. Han skal ikke holde sin egen kalender i hovedet,
    //    mens han redigerer den, kl. 22 efter en nattevagt.
    if (dagens.length) {
      const liste = document.createElement("div");
      liste.className = "mtvinduer";
      dagens.forEach((a) => {
        const r = document.createElement("div");
        r.className = "mtaftale";
        r.innerHTML =
          `<span class="mtaftale__tid">${T.minTilHHMM(a.fra)} til ${T.minTilHHMM(a.til)}</span>` +
          `<span class="mtaftale__navn">${esc(a.navn || "Booket")}</span>`;
        if (a.telefon) {
          const ring = document.createElement("a");
          ring.className = "mtaftale__ring";
          ring.href = "tel:" + a.telefon.replace(/\s/g, "");
          ring.textContent = "Ring";
          r.appendChild(ring);
        }
        liste.appendChild(r);
      });
      panel.appendChild(liste);
    } else if (optaget.length && !AFTALER_OK) {
      const p = document.createElement("p");
      p.className = "mtpanel__besked";
      p.textContent = `Der er ${optaget.length === 1 ? "en aftale" : optaget.length + " aftaler"} ` +
        "på dagen, men navnene kunne ikke hentes lige nu.";
      panel.appendChild(p);
    }

    // 2) hvad er åbent i kladden
    const liste = document.createElement("div");
    liste.className = "mtvinduer";
    if (!mine.length) {
      const p = document.createElement("p");
      p.className = "mtpanel__tom";
      p.textContent = "Lukket. Vælg en starttid og en sluttid nedenfor.";
      liste.appendChild(p);
    } else {
      mine.slice().sort((a, b) => a.fra - b.fra).forEach((v) => {
        const rk = document.createElement("div");
        rk.className = "mtvindue";
        rk.innerHTML = `<span class="mtvindue__tid">${T.minTilHHMM(v.fra)} til ${T.minTilHHMM(v.til)}</span>`;
        const fjern = document.createElement("button");
        fjern.type = "button";
        fjern.className = "mtvindue__fjern";
        fjern.textContent = "Fjern";
        // Fjern rører kun kladden og kan derfor ALTID fortrydes med et tryk mere
        // i gitteret. Kunden beskyttes ét sted: i Gem, mod friske tal.
        fjern.addEventListener("click", () => {
          KLADDER[iso] = mine.filter((x) => !(x.fra === v.fra && x.til === v.til));
          VALGT_START = null;
          PANELBESKED = "";
          skrivKladder();
          tegnPanelIgen();
        });
        rk.appendChild(fjern);
        liste.appendChild(rk);
      });
    }
    panel.appendChild(liste);

    // 3) samme tider som en dag, han selv har åbnet
    const saet = tidligereSaet(iso);
    if (saet.length) {
      const h = document.createElement("p");
      h.className = "mtpanel__hjaelp";
      h.textContent = "Samme tider som en dag, du selv har åbnet:";
      const raek = document.createElement("div");
      raek.className = "mtsamme";
      saet.forEach((s) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "slot";
        b.textContent = s.navn;
        b.addEventListener("click", () => {
          KLADDER[iso] = s.vinduer.map((v) => ({ fra: v.fra, til: v.til }));
          VALGT_START = null;
          PANELBESKED = "";
          skrivKladder();
          status("Tiderne er lagt ind. Tryk Gem tider.");
          tegnPanelIgen();
        });
        raek.appendChild(b);
      });
      panel.append(h, raek);
    }

    // 4) tids-gitteret: tryk starttid, tryk sluttid. Ingen chips, intet gæt.
    const hj = document.createElement("p");
    hj.className = "mtpanel__hjaelp";
    hj.textContent = VALGT_START === null
      ? "Tryk på det klokkeslæt, du kan starte."
      : `Start kl. ${T.minTilHHMM(VALGT_START)}. Tryk nu på det klokkeslæt, du er færdig. Tryk på ${T.minTilHHMM(VALGT_START)} igen for at fortryde.`;
    panel.appendChild(hj);

    const gitter = document.createElement("div");
    gitter.className = "booking__times mtgitter";
    for (let m = GITTER_FRA; m <= GITTER_TIL; m += 30) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "slot";
      b.dataset.min = String(m);
      b.textContent = T.minTilHHMM(m);
      const valgt = VALGT_START === m;
      const iVindue = mine.some((v) => m >= v.fra && m < v.til);
      const erOptaget = optaget.some((x) => T.overlapper(m, m + 30, x.fra, x.til));
      b.setAttribute("aria-pressed", valgt ? "true" : "false");
      if (iVindue && !valgt) b.classList.add("slot--aaben");
      if (erOptaget) {
        b.classList.add("slot--optaget");
        b.setAttribute("aria-label", T.minTilHHMM(m) + ", booket");
      } else if (iVindue) {
        b.setAttribute("aria-label", T.minTilHHMM(m) + ", åben");
      }
      b.addEventListener("click", () => {
        PANELBESKED = "";
        if (VALGT_START === m) {
          VALGT_START = null;
        } else if (VALGT_START === null) {
          if (m >= GITTER_TIL) {
            PANELBESKED = "24:00 kan kun være en sluttid. Tryk på det klokkeslæt, du kan starte.";
          } else { VALGT_START = m; }
        } else if (m > VALGT_START) {
          const nye = T.tilfoejVindue(mine, VALGT_START, m);
          // Firestore-reglen tillader højst otte tidsrum på en dag. Sig det her,
          // i stedet for at lade serveren afvise gemningen bagefter.
          if (nye.length > 8) {
            PANELBESKED = "Du kan have op til otte tidsrum på én dag. Læg nogle af dem sammen, eller fjern et.";
          } else { KLADDER[iso] = nye; }
          VALGT_START = null;
        } else {
          VALGT_START = m;
        }
        skrivKladder();
        status(PANELBESKED || (VALGT_START === null
          ? "Tryk på det klokkeslæt, du kan starte."
          : `Start klokken ${T.minTilHHMM(VALGT_START)}. Tryk nu på det klokkeslæt, du er færdig.`));
        tegnPanelIgen();
      });
      gitter.appendChild(b);
    }
    panel.appendChild(gitter);

    // 5) foden
    const foed = document.createElement("div");
    foed.className = "mtpanel__foed";
    const timer = mine.reduce((s, v) => s + (v.til - v.fra), 0) / 60;
    const opsum = document.createElement("p");
    opsum.className = "mtpanel__opsum";
    opsum.textContent = mine.length
      ? `Åbent ${T.vinduerLabel({ vinduer: mine })}, ${(Math.round(timer * 10) / 10).toString().replace(".", ",")} timer.`
      : "Dagen bliver lukket.";
    foed.appendChild(opsum);

    const gem = document.createElement("button");
    gem.type = "button";
    gem.className = "btn btn--solid btn--full";
    gem.textContent = "Gem tider";
    gem.addEventListener("click", () => gemDagen(iso, gem));
    foed.appendChild(gem);

    if (mine.length) {
      // Han bliver sat på vagt. Det er en rigtig hændelse i hans liv,
      // og den skal ikke koste et tryk pr. tidsrum.
      const luk = document.createElement("button");
      luk.type = "button";
      luk.className = "btn btn--outline btn--full";
      luk.textContent = "Luk hele dagen";
      luk.addEventListener("click", () => {
        KLADDER[iso] = [];
        VALGT_START = null;
        PANELBESKED = "";
        skrivKladder();
        tegnPanelIgen();
      });
      foed.appendChild(luk);
    }
    panel.appendChild(foed);
    return panel;
  }

  async function gemDagen(iso, gem) {
    if (GEMMER) return;
    const vinduer = kladde(iso).map((v) => ({ fra: v.fra, til: v.til }));
    GEMMER = iso;
    gem.disabled = true;
    gem.classList.add("btn--venter");
    gem.textContent = "Gemmer…";

    const tilbage = (tekst) => {
      GEMMER = null;
      PANELBESKED = tekst;
      status(tekst);
      if (AABEN_ISO === iso) tegnPanelIgen();
    };

    // Auto-bekræft betyder, at en kunde kan have booket, mens siden lå åben.
    // Firestore-reglen vogter kun, at `optaget` ikke ændres, ikke at vinduerne
    // stadig dækker aftalerne. Derfor spørger vi selv, lige før vi skriver.
    let frisk;
    try { frisk = await Store.dag(iso); }
    catch {
      tilbage("Dagen kunne ikke tjekkes for nye aftaler, så der blev ikke gemt noget. Prøv igen, når du har forbindelse.");
      return;
    }

    const udenfor = T.optagetListe(frisk).filter(
      (b) => !vinduer.some((v) => b.fra >= v.fra && b.til <= v.til));
    if (udenfor.length) {
      DAGE[iso] = frisk;
      opdaterHoejre(iso);
      tilbage(
        `Der ${udenfor.length === 1 ? "ligger en aftale" : "ligger " + udenfor.length + " aftaler"} på dagen kl. ` +
        udenfor.map((b) => T.minTilHHMM(b.fra)).join(", ") +
        ". De falder uden for de tider, du er ved at gemme, så der blev ikke gemt noget. " +
        "Ret tiderne, eller ring til kunden og aflys aftalen under Bookinger.");
      return;
    }

    const svar = await Store.gemVinduer(iso, vinduer);
    if (!svar.ok) {
      // Kladden bliver stående. Den er hele hans arbejde.
      tilbage(svar.grund === "afvist"
        ? "Der blev ikke gemt noget. Din adgang er måske udløbet. Hent siden igen, og log ind."
        : "Der blev ikke gemt noget. Telefonen har ikke forbindelse lige nu. Dine tider står her stadig, prøv igen om lidt.");
      return;
    }

    // Vi ved selv, hvad der nu står i dagen. Netværket skal ikke spørges
    // om noget, vi lige har sagt.
    GEMMER = null;
    DAGE[iso] = Object.assign(frisk, { vinduer: vinduer });
    delete KLADDER[iso];
    skrivKladder();
    PANELBESKED = "";
    KVITTERING = iso;
    if (AABEN_ISO === iso) { AABEN_ISO = null; VALGT_START = null; }

    const datoer = T.datoerFrem(CONFIG.horisontDage);
    beregnTilstande(datoer.map(T.isoOf));
    tegnSum(datoer, datoer.map(T.isoOf));
    tegnDage(maanedsDatoer());
    status(vinduer.length
      ? `Gemt. ${T.dagLabel(T.datoFraISO(iso))} er åben ${T.vinduerLabel({ vinduer })}.`
      : `Gemt. ${T.dagLabel(T.datoFraISO(iso))} er lukket.`);
    const row = $("mtDage").querySelector(`.mtdag[data-iso="${iso}"]`);
    if (row) row.scrollIntoView({ block: "center", behavior: REDUCED ? "auto" : "smooth" });
  }

  // ---------- bookinger ----------
  // Tegnes af de aftaler, der allerede er hentet i tegn(). Ingen ny hentning,
  // ingen mulighed for at de to faner siger noget forskelligt.
  function tegnBookinger() {
    const box = $("mtBookinger");
    box.innerHTML = "";

    if (!AFTALER_OK) {
      // En tom skærm ville betyde "du har ingen aftaler". Det ved vi ikke,
      // og det er den værst tænkelige fejlvisning på præcis denne skærm.
      const kort = document.createElement("div");
      kort.className = "booking__empty";
      const p = document.createElement("p");
      p.textContent = "Dine bookinger kunne ikke hentes. Det betyder ikke, at der ingen er. " +
        "Tjek forbindelsen, og prøv igen.";
      const igen = document.createElement("button");
      igen.type = "button";
      igen.className = "btn btn--outline";
      igen.textContent = "Prøv igen";
      igen.addEventListener("click", async () => { await tegn(); tegnBookinger(); });
      kort.append(p, igen);
      box.appendChild(kort);
      return;
    }

    const nu = new Date();
    const iDag = T.isoOf(nu);
    const minutterNu = nu.getHours() * 60 + nu.getMinutes();
    const kommende = AFTALER.filter((a) => a.dato > iDag || (a.dato === iDag && a.til > minutterNu));

    if (!kommende.length) {
      box.innerHTML = `<p class="mtpanel__tom">Ingen bookinger endnu.</p>`;
      return;
    }

    let sidsteDato = null;
    kommende.forEach((a) => {
      if (a.dato !== sidsteDato) {
        const h = document.createElement("p");
        h.className = "mtuge";
        h.textContent = T.dagLabel(T.datoFraISO(a.dato));
        box.appendChild(h);
        sidsteDato = a.dato;
      }
      const kort = document.createElement("div");
      kort.className = "mtbooking";
      kort.innerHTML =
        `<p class="mtbooking__tid">${T.minTilHHMM(a.fra)} til ${T.minTilHHMM(a.til)}` +
        `<span class="mtbooking__ydelse">${esc(a.minutter)} minutter, ${esc(a.pris)} kr.</span></p>` +
        `<p class="mtbooking__navn">${esc(a.navn || "Uden navn")}</p>`;

      // Stilhed betyder, at det virkede. Vises der noget hver gang, holder han
      // op med at læse linjen. Aftaler fra før mailen blev slået til har intet
      // mail-felt og må ikke give falsk alarm.
      const m = a.mail || null;
      if (m) {
        let tekst = "";
        if (m.kunde === "fejlet" || m.michael === "fejlet" || m.status === "opgivet") {
          tekst = "Kunden har ikke fået sin bekræftelse. Ring til kunden.";
        } else if (m.kunde === "ugyldig") {
          tekst = "Kundens e-mailadresse ser forkert ud. Ring til kunden.";
        } else if (m.status === "sender") {
          tekst = "Bekræftelsen er på vej.";
        }
        if (tekst) {
          const p = document.createElement("p");
          p.className = m.status === "sender"
            ? "mtbooking__mail" : "mtbooking__mail mtbooking__mail--fejl";
          p.setAttribute("role", "status");
          p.textContent = tekst;
          kort.appendChild(p);
        }
      }

      if (a.telefon) {
        const ring = document.createElement("a");
        ring.className = "btn btn--outline mtbooking__ring";
        ring.href = "tel:" + a.telefon.replace(/\s/g, "");
        ring.textContent = `Ring ${a.telefon}`;
        kort.appendChild(ring);
      }

      // Beskeden er FOLDET SAMMEN. Han åbner den her skærm i klinikken, hvor
      // den næste kunde kan stå ved siden af ham.
      if (a.besked) {
        const d = document.createElement("details");
        d.className = "mtbooking__besked";
        d.innerHTML = `<summary>Vis besked</summary><p></p>`;
        d.querySelector("p").textContent = a.besked;
        kort.appendChild(d);
      }

      const aflys = document.createElement("button");
      aflys.type = "button";
      aflys.className = "mtlink mtbooking__aflys";
      aflys.textContent = "Aflys";
      aflys.addEventListener("click", async () => {
        // Fra i dag FÅR kunden besked, hvis hun har oplyst en mail. Teksten
        // ville ellers lyve fra det øjeblik, mailen blev slået til.
        const harMail = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(String(a.email || "").trim());
        const ok = window.confirm(
          `Aflys ${a.navn || "aftalen"} kl. ${T.minTilHHMM(a.fra)}?\n\n` +
          (harMail
            ? "Kunden får en mail med det samme. Er tiden inden for et døgn, så ring alligevel. "
            : "Kunden har ikke oplyst en e-mail, så kunden får ikke besked. Du skal ringe. ") +
          `Nummeret bliver stående bagefter.`);
        if (!ok) return;
        aflys.disabled = true;
        aflys.textContent = "Aflyser…";
        const svar = await Store.aflys(a.id);
        if (!svar.ok) {
          aflys.disabled = false;
          aflys.textContent = "Aflys";
          const p = document.createElement("p");
          p.className = "mtpanel__besked";
          p.setAttribute("role", "status");
          p.textContent = "Aftalen er ikke aflyst. Prøv igen, eller ring til kunden og aftal det direkte.";
          kort.appendChild(p);
          return;
        }
        // Nummeret må først forsvinde, når han har brugt det.
        kort.innerHTML = "";
        const k = document.createElement("p");
        k.className = "mtbooking__navn";
        k.textContent = `Aflyst: ${T.minTilHHMM(a.fra)}, ${a.navn || "uden navn"}. ` +
          (harMail ? "Kunden får en mail." : "Husk at ringe.");
        kort.appendChild(k);
        if (a.telefon) {
          const ring = document.createElement("a");
          ring.className = "btn btn--solid mtbooking__ring";
          ring.href = "tel:" + a.telefon.replace(/\s/g, "");
          ring.textContent = `Ring ${a.telefon}`;
          kort.appendChild(ring);
        }
        const luk = document.createElement("button");
        luk.type = "button";
        luk.className = "mtlink";
        luk.textContent = "Jeg har ringet, fjern den";
        luk.addEventListener("click", async () => { await tegn(); tegnBookinger(); });
        kort.appendChild(luk);
      });
      kort.appendChild(aflys);
      box.appendChild(kort);
    });
  }

  // ---------- frisk igen, når han tager telefonen frem ----------
  // Han låser telefonen og lægger den i lommen. En time senere er der måske
  // kommet en booking. Er han midt i en redigering, springes det over i
  // stilhed: kladden må aldrig forsvinde under fingrene på ham.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!Auth.erAdmin() || AABEN_ISO || GEMMER) return;
    tegn();
  });

  // ---------- start ----------
  let SVAR_KOM = false;
  Auth.onSkift(async (bruger) => {
    SVAR_KOM = true;
    if (bruger && !bruger.isAnonymous) { VAR_LOGGET_IND = true; await visApp(); }
    else { visLogin(VAR_LOGGET_IND && !SELV_LOG_UD); VAR_LOGGET_IND = false; SELV_LOG_UD = false; }
  });
  setTimeout(() => {
    if (SVAR_KOM || !START) return;
    START.textContent = "Der er ingen forbindelse til systemet lige nu. Tjek nettet, og hent siden igen.";
  }, 8000);
})();
