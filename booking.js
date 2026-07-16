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

  // ---------- Michael's config ----------
  // NOTE: opening hours are PLACEHOLDERS — Michael must confirm his real hours.
  const SERVICES = [
    { key: "30", name: "30 minutter", desc: "Fokuseret behandling af ét område",   minutes: 30, price: 350 },
    { key: "60", name: "60 minutter", desc: "Grundig behandling af flere områder", minutes: 60, price: 500 },
  ];
  // weekday 0=søn..6=lør → opening window (local Danish time). Closed days omitted.
  const HOURS = {
    1: { open: "08:00", close: "18:00" }, // mandag
    2: { open: "08:00", close: "18:00" }, // tirsdag
    3: { open: "08:00", close: "18:00" }, // onsdag
    4: { open: "08:00", close: "18:00" }, // torsdag
    5: { open: "08:00", close: "15:00" }, // fredag
  };
  const DAYS_TO_SHOW = 14;
  const LOOKAHEAD = 30;
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

  // ---------- MOCK backend (the seam — swapped for Firebase in phase 2) ----------
  const booked = new Set(); // "dayKey|HH:MM" already taken (demo only)

  const BookingBackend = {
    async availableDays() {
      const out = [];
      const now = new Date();
      for (let i = 0; i < LOOKAHEAD && out.length < DAYS_TO_SHOW; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        if (HOURS[d.getDay()]) out.push(d);
      }
      return out;
    },
    async slots(serviceKey, date) {
      const h = HOURS[date.getDay()];
      if (!h) return [];
      const svc = svcOf(serviceKey);
      const step = Math.max(svc.minutes, 30);
      const open = hhmmToMin(h.open), close = hhmmToMin(h.close);
      const key = dayKeyOf(date);
      const now = new Date();
      const isToday = key === dayKeyOf(now);
      const cutoff = now.getHours() * 60 + now.getMinutes() + 60; // 1h notice today
      const out = [];
      for (let t = open; t + svc.minutes <= close; t += step) {
        const time = minToHHMM(t);
        if (booked.has(`${key}|${time}`)) continue;
        if (isToday && t < cutoff) continue;
        out.push(time);
      }
      return out;
    },
    async book({ serviceKey, date, time }) {
      await new Promise((r) => setTimeout(r, 450)); // mimic a network round-trip
      const id = `${dayKeyOf(date)}|${time}`;
      if (booked.has(id)) return { ok: false, reason: "taken" };
      booked.add(id);
      return { ok: true };
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
    summary:  root.querySelector("#bkSummary"),
    confirm:  root.querySelector("#bkConfirm"),
    live:     root.querySelector("#bkLive"),
  };

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
      el.times.innerHTML = context + `<p class="booking__hint">Kunne ikke hente tider — prøv igen, eller ring 23 90 60 68.</p>`;
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
  const ready = () => state.serviceKey && state.date && state.time && nameOK() && phoneOK();

  function nextGap() {
    if (!state.serviceKey) return "Vælg en behandling";
    if (!state.date) return "Vælg en dag";
    if (!state.time) return "Vælg en tid";
    if (!nameOK()) return "Skriv dit navn";
    if (!phoneOK()) return "Skriv dit telefonnummer";
    return null;
  }

  function update() {
    const parts = [];
    if (state.serviceKey) {
      const s = svcOf(state.serviceKey);
      parts.push(`${s.name} <span class="price">· ${s.price} kr.</span>`);
    }
    if (state.date) parts.push(escapeHtml(fullDayLabel(state.date)));
    if (state.time) parts.push(`kl. ${escapeHtml(state.time)}`);
    const gap = nextGap();
    let html = parts.length ? parts.join(" · ") : "Vælg behandling, dag og tid.";
    if (gap && parts.length) html += ` <span class="booking__missing">· ${gap.toLowerCase()}</span>`;
    el.summary.innerHTML = html;
    el.confirm.disabled = !ready();
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
      });
    } catch {
      el.confirm.textContent = original;
      el.confirm.disabled = false;
      el.live.textContent = "Noget gik galt — prøv igen, eller ring 23 90 60 68.";
      return;
    }
    if (!res.ok) {
      el.confirm.textContent = original;
      el.confirm.disabled = false;
      el.live.textContent = "Den tid blev desværre lige booket. Vælg venligst en anden tid.";
      renderTimes();
      return;
    }
    saveContact();
    succeed(svc);
  }

  // ---------- add-to-calendar (.ics) ----------
  function icsHref(svc, date, time) {
    const [hh, mm] = time.split(":").map(Number);
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm);
    const end = new Date(start.getTime() + svc.minutes * 60000);
    const fmt = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MH Sportsmassage//Booking//DA", "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT", `UID:mh-${fmt(start)}@mhsportsmassage.dk`,
      `DTSTAMP:${fmt(start)}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`,
      `SUMMARY:${svc.name} hos MH Sportsmassage`,
      "LOCATION:MH Sportsmassage\\, Bjæverskov",
      "DESCRIPTION:Booket hos Michael Hansen. Betaling med MobilePay eller kontant i klinikken. Tlf. 23 90 60 68.",
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    return "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
  }

  // ---------- success ----------
  function succeed(svc) {
    const name = el.name.value.trim();
    const ics = icsHref(svc, state.date, state.time);
    root.classList.add("booking--done");
    root.innerHTML =
      `<div class="booking__success" role="status">` +
        `<div class="booking__check" aria-hidden="true">✓</div>` +
        `<h3 id="bkDoneHeading" tabindex="-1">Tak${name ? ", " + escapeHtml(name) : ""}!</h3>` +
        `<p class="booking__confirm">Din tid er reserveret:<br>` +
          `<strong>${svc.name} · ${fullDayLabel(state.date)} kl. ${state.time}</strong></p>` +
        `<p class="booking__confirm-sub">Michael bekræfter din tid pr. telefon. Du ser ham i klinikken i ` +
          `Bjæverskov — betaling med MobilePay eller kontant. Du kan roligt tage et skærmbillede af denne bekræftelse.</p>` +
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

  // ---------- seed a couple of demo "taken" slots (mock only) ----------
  function seedDemo() {
    if (days[0]) booked.add(`${dayKeyOf(days[0])}|09:00`);
    if (days[0]) booked.add(`${dayKeyOf(days[0])}|10:30`);
    if (days[1]) booked.add(`${dayKeyOf(days[1])}|08:00`);
  }

  // ---------- init ----------
  (async () => {
    renderServices();
    try {
      days = await BookingBackend.availableDays();
    } catch {
      el.days.innerHTML = `<p class="booking__hint">Kunne ikke hente dage — prøv igen, eller ring 23 90 60 68.</p>`;
      return;
    }
    seedDemo();
    renderDays();
    renderTimes();
    loadContact();
    el.name.addEventListener("input", update);
    el.phone.addEventListener("input", update);
    el.confirm.addEventListener("click", confirm);
    update();
  })();
})();
