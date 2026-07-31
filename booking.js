// booking.js — MH Sportsmassage online booking
//
// PHASE 1: a local MOCK behind a thin data-layer seam, so we can see and feel the
// real flow now — no backend needed. PHASE 2 swaps ONLY the three BookingBackend
// methods to the shared Firebase backend (Firestore availability read +
// anonymous-auth guest + the atomic bookAppointment callable). The UI never changes.

(() => {
  "use strict";
  const root = document.getElementById("booking");
  if (!root) return;

  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- indstillinger ----------
  // Der findes IKKE længere hardkodede åbningstider. En dag er lukket, indtil
  // Michael selv åbner den i "Mine tider". Ydelser, varsel og horisont kommer
  // fra datalaget, så han er den eneste kilde til hvad der er ledigt.
  const T = window.MHTid;
  const Store = window.MHStore;
  let CONFIG = T.STANDARD_CONFIG;
  // datalagets form → den form UI-koden herunder allerede bruger
  const somUI = (y) => ({ key: y.key, name: y.navn, desc: y.beskrivelse, minutes: y.minutter, price: y.pris });
  let SERVICES = (CONFIG.ydelser || []).map(somUI);
  const CONTACT_KEY = "mh.booking.contact";

  // ---------- helpers ----------
  const pad = (n) => String(n).padStart(2, "0");
  const hhmmToMin = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  const minToHHMM = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const dayKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const WD  = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
  const WDS = ["søn", "man", "tir", "ons", "tor", "fre", "lør"];
  const MO  = ["jan.", "feb.", "mar.", "apr.", "maj", "jun.", "jul.", "aug.", "sep.", "okt.", "nov.", "dec."];
  const svcOf = (k) => SERVICES.find((s) => s.key === k);
  const fullDayLabel = (d) => `${WD[d.getDay()]} d. ${d.getDate()}. ${MO[d.getMonth()]}`;
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- datalaget (sømmen — byttes til Firebase i fase 2) ----------
  // Al regning ligger i tilgaengelighed.js, som Mine tider bruger PRÆCIS også.
  // Ellers ville Michaels forhåndsvisning før eller siden vise noget andet
  // end det, kunderne får at se.
  const BookingBackend = {
    async availableDays() {
      const isoer = T.datoerFrem(CONFIG.horisontDage).map(T.isoOf);
      const dage = await Store.dage(isoer);
      const nu = new Date();
      return isoer
        .filter((iso) => T.harLedigeTider(dage[iso], CONFIG, nu))
        .map(T.datoFraISO);
    },
    async slots(serviceKey, date) {
      const svc = svcOf(serviceKey);
      if (!svc) return [];
      const dag = await Store.dag(T.isoOf(date));
      return T.ledigeStarter(dag, CONFIG, { minutter: svc.minutes }, new Date()).map(T.minTilHHMM);
    },
    async book({ serviceKey, date, time, name, phone, email, note }) {
      const res = await Store.book({
        dato: T.isoOf(date),
        startMin: T.hhmmTilMin(time),
        ydelseKey: serviceKey,
        navn: name, telefon: phone, email: email, besked: note,
      });
      return { ok: res.ok, reason: res.grund, id: res.id };
    },
  };

  // ---------- state ----------
  const state = { serviceKey: null, date: null, dayIdx: -1, time: null };
  let days = [];

  const el = {
    services: root.querySelector("#bkServices"),
    days:     root.querySelector("#bkDays"),
    times:    root.querySelector("#bkTimes"),
    name:     root.querySelector("#bkName"),
    phone:    root.querySelector("#bkPhone"),
    email:    root.querySelector("#bkEmail"),
    note:     root.querySelector("#bkNote"),
    confirm:  root.querySelector("#bkConfirm"),
    live:     root.querySelector("#bkLive"),
  };

  // ---------- "Din tid" (kvitteringen i bunden) ----------
  const tid = {
    service: root.querySelector("#bkTidService"),
    day:     root.querySelector("#bkTidDay"),
    time:    root.querySelector("#bkTidTime"),
    price:   root.querySelector("#bkTidPrice"),
    gap:     root.querySelector("#bkTidGap"),
  };
  // startteksten står i HTML og læses herfra, så skærmlæseren ikke
  // får noget læst op allerede ved sideindlæsning
  let gapMsg = tid.gap ? tid.gap.textContent.trim() : "";

  const upFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const endOf = (time, minutes) => minToHHMM(hhmmToMin(time) + minutes);

  // Skriver én værdi. Kun textContent, så intet kundeinput kan tolkes som HTML.
  function setFact(node, value) {
    if (!node) return;
    const filled = Boolean(value);
    node.textContent = filled ? value : node.dataset.wait;
    node.classList.toggle("tid__value--wait", !filled);
    node.classList.remove("tid__value--next");
  }

  // ---------- services ----------
  function renderServices() {
    el.services.innerHTML = "";
    SERVICES.forEach((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "svc";
      b.setAttribute("aria-pressed", "false");
      b.innerHTML =
        `<span class="svc__name">${s.name}</span>` +
        `<span class="svc__desc">${s.desc}</span>` +
        `<span class="svc__price">${s.price} kr.</span>`;
      b.addEventListener("click", () => {
        state.serviceKey = s.key;
        state.time = null;
        [...el.services.children].forEach((c) => c.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        renderTimes();
        update();
      });
      el.services.appendChild(b);
    });
  }

  // ---------- days ----------
  function renderDays() {
    el.days.innerHTML = "";
    days.forEach((d, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "day";
      b.dataset.idx = String(i);
      b.setAttribute("aria-pressed", "false");
      b.setAttribute("aria-label", fullDayLabel(d));
      b.innerHTML =
        `<span class="day__wd">${WDS[d.getDay()]}</span>` +
        `<span class="day__num">${d.getDate()}.</span>` +
        `<span class="day__mo">${MO[d.getMonth()]}</span>`;
      b.addEventListener("click", () => selectDay(i));
      el.days.appendChild(b);
    });
  }

  function selectDay(i) {
    state.dayIdx = i;
    state.date = days[i];
    state.time = null;
    [...el.days.children].forEach((c) =>
      c.setAttribute("aria-pressed", c.dataset.idx === String(i) ? "true" : "false"));
    const chip = el.days.children[i];
    if (chip) chip.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "nearest", inline: "nearest" });
    renderTimes();
    update();
  }

  // ---------- times ----------
  async function renderTimes() {
    if (!state.serviceKey || !state.date) {
      el.times.innerHTML = `<p class="booking__hint">Vælg behandling og dag for at se ledige tider.</p>`;
      return;
    }
    const svc = svcOf(state.serviceKey);
    const context = `<p class="booking__slotcontext">Ledige tider · <strong>${svc.name} · ${svc.price} kr.</strong></p>`;
    el.times.innerHTML = context + `<p class="booking__hint">Henter ledige tider…</p>`;
    const wanted = state.date;
    let list;
    try {
      list = await BookingBackend.slots(state.serviceKey, wanted);
    } catch {
      if (state.date !== wanted) return;
      el.times.innerHTML = context + `<p class="booking__hint">Kunne ikke hente tider. Prøv igen, eller ring 23 90 60 68.</p>`;
      return;
    }
    if (state.date !== wanted) return; // a newer selection won
    if (!list.length) {
      const next = await findNextAvailable(state.dayIdx + 1);
      const jump = next
        ? `<button type="button" class="btn btn--outline btn--sm" id="bkNextDay">Næste ledige dag: ${WDS[next.date.getDay()]} d. ${next.date.getDate()}. ${MO[next.date.getMonth()]} →</button>`
        : `<span>Ring 23 90 60 68, så finder vi en tid sammen.</span>`;
      el.times.innerHTML = context +
        `<div class="booking__empty"><p>Ingen ledige tider den dag.</p>${jump}</div>`;
      const btn = el.times.querySelector("#bkNextDay");
      if (btn && next) btn.addEventListener("click", () => selectDay(next.idx));
      return;
    }
    el.times.innerHTML = context;
    list.forEach((time) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "slot";
      b.textContent = time;
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => {
        state.time = time;
        [...el.times.querySelectorAll(".slot")].forEach((c) => c.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        update();
      });
      el.times.appendChild(b);
    });
  }

  // scan forward for the next day that has any free slot for the chosen service
  async function findNextAvailable(from) {
    for (let i = Math.max(from, 0); i < days.length; i++) {
      try {
        const s = await BookingBackend.slots(state.serviceKey, days[i]);
        if (s.length) return { idx: i, date: days[i] };
      } catch { /* skip */ }
    }
    return null;
  }

  // ---------- summary + confirm gating ----------
  const nameOK = () => el.name.value.trim().length > 0;
  const phoneOK = () => el.phone.value.trim().length > 0;
  // Fanges her, mens kunden stadig står på siden og kan rette den. Bagefter
  // kan ingen nå hende. En adresse med slåfejl er værre end ingen adresse:
  // så tror hun, hun har en kvittering, og den findes ikke.
  const mailOK = () => {
    const v = el.email ? el.email.value.trim() : "";
    return !v || /^[^\s@<>,;:"'\\]+@[^\s@<>,;:"'\\]+\.[a-zA-Z]{2,}$/.test(v);
  };
  const ready = () => state.serviceKey && state.date && state.time && nameOK() && phoneOK() && mailOK();

  function nextGap() {
    if (!state.serviceKey) return "Vælg en behandling";
    if (!state.date) return "Vælg en dag";
    if (!state.time) return "Vælg en tid";
    if (!nameOK()) return "Skriv dit navn";
    if (!phoneOK()) return "Skriv dit telefonnummer";
    if (!mailOK()) return "Tjek din e-mailadresse";
    return null;
  }

  function update() {
    const svc = state.serviceKey ? svcOf(state.serviceKey) : null;

    setFact(tid.service, svc ? svc.name : "");
    setFact(tid.day, state.date ? upFirst(fullDayLabel(state.date)) : "");
    setFact(tid.time, state.time
      ? (svc ? `kl. ${state.time} til ${endOf(state.time, svc.minutes)}` : `kl. ${state.time}`)
      : "");
    setFact(tid.price, svc ? `${svc.price} kr.` : "");

    // peg roligt på den første række, der mangler
    const waiting = [tid.service, tid.day, tid.time]
      .find((n) => n && n.classList.contains("tid__value--wait"));
    if (waiting) waiting.classList.add("tid__value--next");

    const gap = nextGap();
    const msg = gap ? `${gap}.` : "";
    // skriv kun ved reel ændring, ellers læser skærmlæseren op ved hvert tastetryk
    if (tid.gap && msg !== gapMsg) { tid.gap.textContent = msg; gapMsg = msg; }

    el.confirm.disabled = !ready();
    // beskrivelsen gives først når knappen faktisk kan fokuseres
    if (gap) el.confirm.removeAttribute("aria-label");
    else el.confirm.setAttribute("aria-label",
      `Bekræft booking: ${svc.name}, ${fullDayLabel(state.date)} kl. ${state.time}, ${svc.price} kr.`);
  }

  // ---------- confirm ----------
  async function confirm() {
    if (!ready() || el.confirm.disabled) return;
    el.confirm.disabled = true;
    const original = el.confirm.textContent;
    el.confirm.textContent = "Booker…";
    el.live.textContent = "";
    const svc = svcOf(state.serviceKey);
    let res;
    try {
      res = await BookingBackend.book({
        serviceKey: state.serviceKey,
        date: state.date,
        time: state.time,
        name: el.name.value.trim(),
        phone: el.phone.value.trim(),
        email: el.email ? el.email.value.trim() : "",
        note: el.note ? el.note.value.trim() : "",
      });
    } catch {
      el.confirm.textContent = original;
      el.confirm.disabled = false;
      el.live.textContent = "Noget gik galt. Prøv igen, eller ring 23 90 60 68.";
      return;
    }
    if (!res.ok) {
      el.confirm.textContent = original;
      if (res.reason === "optaget") {
        state.time = null; // ellers står kvitteringen og lover en tid, der ikke findes
        el.live.textContent = "Den tid blev desværre lige booket. Vælg venligst en anden tid.";
        renderTimes();
      } else {
        el.live.textContent = "Noget gik galt, og tiden blev ikke booket. Prøv igen, eller ring 23 90 60 68.";
      }
      update(); // sætter selv knappen korrekt
      return;
    }
    state.id = res.id;
    saveContact();
    succeed(svc);
  }

  // ---------- add-to-calendar (.ics) ----------
  // Kalenderfilen. Den SKAL være den samme begivenhed som mailens vedhæftning,
  // ellers får kunden to poster i kalenderen. Derfor aftalens eget id som UID.
  // ⚠️ LOCATION indeholder kun byen, fordi vi ikke kender vej og husnummer.
  // Ret KLINIK.adresse i functions/index.js OG linjen herunder samtidig.
  function icsHref(svc, date, time, id) {
    const fra = hhmmToMin(time);
    const lokal = (minutter) => {
      let d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      let m = minutter;
      while (m >= 1440) { m -= 1440; d = new Date(d.getTime() + 864e5); }
      return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
             `T${pad(Math.floor(m / 60))}${pad(m % 60)}00`;
    };
    // DTSTAMP er hvornår filen blev lavet, i UTC. Før stod aftalens egen tid der.
    const naa = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MH Sportsmassage//Booking//DA",
      "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "BEGIN:VTIMEZONE", "TZID:Europe/Copenhagen",
      "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST",
      "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
      "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET",
      "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      `UID:${id || "mh-" + lokal(fra)}@mhsportsmassage.dk`,
      "SEQUENCE:0", `DTSTAMP:${naa}`,
      `DTSTART;TZID=Europe/Copenhagen:${lokal(fra)}`,
      `DTEND;TZID=Europe/Copenhagen:${lokal(fra + svc.minutes)}`,
      "STATUS:CONFIRMED", "TRANSP:OPAQUE",
      `SUMMARY:${svc.name} hos MH Sportsmassage`,
      "LOCATION:MH Sportsmassage\\, Bjæverskov",
      "DESCRIPTION:Betaling med MobilePay eller kontant i klinikken. Tlf. 23 90 60 68.",
      "BEGIN:VALARM", "ACTION:DISPLAY",
      "DESCRIPTION:Tid hos MH Sportsmassage om 2 timer", "TRIGGER:-PT2H", "END:VALARM",
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n") + "\r\n";
    return "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
  }

  // ---------- success ----------
  function succeed(svc) {
    const name = el.name.value.trim();
    const mail = el.email ? el.email.value.trim() : "";
    const ics = icsHref(svc, state.date, state.time, state.id);
    root.classList.add("booking--done");
    root.innerHTML =
      `<div class="booking__success" role="status">` +
        `<div class="booking__check" aria-hidden="true">✓</div>` +
        `<h3 id="bkDoneHeading" tabindex="-1">Tak${name ? ", " + escapeHtml(name) : ""}!</h3>` +
        `<p class="booking__confirm">Din tid er booket:<br>` +
          `<strong>${svc.name} · ${upFirst(fullDayLabel(state.date))} kl. ${state.time} ` +
          `til ${endOf(state.time, svc.minutes)}</strong></p>` +
        `<p class="booking__confirm-sub">${svc.price} kr. Du betaler i klinikken i Bjæverskov ` +
          `med MobilePay eller kontant. Tiden er din med det samme, du behøver ikke gøre mere. ` +
          `Du kan roligt tage et skærmbillede af denne bekræftelse.</p>` +
        // "Inden for få minutter", ikke "om et øjeblik": en ny afsender kan
        // blive forsinket op til en halv time af modtagerens spamfilter.
        `<p class="booking__confirm-sub">${mail
          ? `Du får en bekræftelse på ${escapeHtml(mail)} inden for få minutter. Kommer den ikke, så kig i spam.`
          : "Vi har ikke din e-mail, så du får ingen bekræftelse på skrift. Tag gerne et skærmbillede af denne side."}</p>` +
        `<div class="booking__actions">` +
          `<a class="btn btn--solid" href="${ics}" download="mh-sportsmassage.ics">Tilføj til kalender</a>` +
          `<a href="index.html" class="btn btn--outline">Til forsiden</a>` +
        `</div>` +
      `</div>`;
    const h = root.querySelector("#bkDoneHeading");
    if (h) h.focus({ preventScroll: true });
    root.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "center" });
  }

  // ---------- contact prefill (this device only) ----------
  function saveContact() {
    try {
      localStorage.setItem(CONTACT_KEY, JSON.stringify({
        name: el.name.value.trim(), phone: el.phone.value.trim(),
        email: el.email ? el.email.value.trim() : "",
      }));
    } catch { /* private mode / disabled — ignore */ }
  }
  function loadContact() {
    try {
      const c = JSON.parse(localStorage.getItem(CONTACT_KEY) || "null");
      if (!c) return;
      if (c.name) el.name.value = c.name;
      if (c.phone) el.phone.value = c.phone;
      if (c.email && el.email) el.email.value = c.email;
    } catch { /* ignore */ }
  }

  // ---------- ingen åbne tider ----------
  // Under "lukket som standard" er det her NORMALTILSTANDEN, ikke en kantsituation.
  // Derfor får den en rigtig skærm med et telefonnummer, ikke en tom dagstribe
  // med "Stryg for at se flere dage" stående under.
  function visLukket(grund) {
    const besked = (CONFIG.besked || "").trim();
    root.classList.add("booking--lukket");
    root.innerHTML =
      `<div class="booking__lukket">` +
        `<h2>Der er ikke åbne tider lige nu</h2>` +
        `<p>${escapeHtml(grund || besked ||
            "Michael lægger nye tider ud, når han kender sin vagtplan.")}</p>` +
        `<p>Ring, så finder vi en tid sammen.</p>` +
        `<a class="btn btn--solid" href="tel:+4523906068">Ring 23 90 60 68</a>` +
      `</div>`;
  }

  // ---------- init ----------
  (async () => {
    try {
      CONFIG = await Store.config();
      SERVICES = (CONFIG.ydelser || []).map(somUI);
    } catch { /* standardindstillingerne bruges */ }

    if (CONFIG.lukket) { visLukket(); return; } // nødbremsen

    renderServices();
    try {
      days = await BookingBackend.availableDays();
    } catch {
      visLukket("Vi kunne ikke hente tiderne lige nu.");
      return;
    }
    if (!days.length) { visLukket(); return; }
    renderDays();
    renderTimes();
    loadContact();
    el.name.addEventListener("input", update);
    el.phone.addEventListener("input", update);
    if (el.email) el.email.addEventListener("input", update);
    el.confirm.addEventListener("click", confirm);
    update();
  })();
})();
