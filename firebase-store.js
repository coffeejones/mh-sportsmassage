// firebase-store.js — det RIGTIGE datalag. Erstatter data.js, når backend'et er oppe.
//
// Den udstiller PRÆCIS samme window.MHStore som data.js gjorde, så hverken
// booking.js, mine-tider.js eller motoren i tilgaengelighed.js skal ændres.
// Det var hele pointen med at bygge sømmen først.
//
// Kunder logger ind ANONYMT uden at opdage det: ingen konto, ingen adgangskode,
// ingen skærm. Det er kun for at Cloud Function'en kan kende afsenderen og
// sætte et loft over spam. Michael logger ind med mail og adgangskode.
//
// ⚠️ apiKey herunder er OFFENTLIG med vilje. Den er ikke en adgangskode, den
// er nærmere et husnummer: den fortæller Google hvilket projekt der spørges
// til. Det, der beskytter data, er Firestore-reglerne i firebase/firestore.rules.

(function () {
  "use strict";

  const T = window.MHTid;

  const CONFIG_FIREBASE = {
    apiKey: "AIzaSyDPDHgSkwbY5c8P5wJ7yytSEJGFvEE2Cm0",
    authDomain: "mhsportsmassage-ea058.firebaseapp.com",
    projectId: "mhsportsmassage-ea058",
    storageBucket: "mhsportsmassage-ea058.firebasestorage.app",
    messagingSenderId: "544833731829",
    appId: "1:544833731829:web:ded6db4c876b1572f7d9bc",
  };
  const REGION = "europe-west1";

  firebase.initializeApp(CONFIG_FIREBASE);
  const db = firebase.firestore();
  const auth = firebase.auth();
  const fns = firebase.app().functions(REGION);

  // Firestore AFVISER ikke en skrivning, fordi telefonen er offline. Den lægger
  // den i kø, og løftet bliver hverken indfriet eller afvist. Uden en frist
  // ville Gem-knappen stå på "Gemmer…" for evigt, og Michael ville gå i seng i
  // troen om, at lørdagen er åben. Vi sætter derfor selv grænsen.
  // gemVinduer er idempotent, så en for tidlig frist koster ét ekstra tryk.
  const FRIST = 20000;
  function medFrist(loefte, ms) {
    return new Promise((ok, fejl) => {
      const ur = setTimeout(() => fejl({ code: "tidsgraense" }), ms);
      loefte.then(
        (v) => { clearTimeout(ur); ok(v); },
        (e) => { clearTimeout(ur); fejl(e); }
      );
    });
  }

  // ---------- login ----------
  // Kunder: anonymt, i baggrunden, uden at de mærker det.
  // Michael: mail + adgangskode.
  let klarPromise = null;
  function klar() {
    if (klarPromise) return klarPromise;
    klarPromise = new Promise((resolve) => {
      auth.onAuthStateChanged((bruger) => {
        if (bruger) return resolve(bruger);
        auth.signInAnonymously().catch(() => resolve(null));
      });
    });
    return klarPromise;
  }

  const MHAuth = {
    // Michaels login. Fejler den, får han en sætning på dansk, ikke en kode.
    async logInd(email, kode) {
      try {
        const res = await auth.signInWithEmailAndPassword(email.trim(), kode);
        return { ok: true, uid: res.user.uid };
      } catch (e) {
        const kendte = {
          "auth/invalid-email": "Det ligner ikke en e-mailadresse.",
          "auth/invalid-credential": "Forkert e-mail eller adgangskode.",
          "auth/wrong-password": "Forkert e-mail eller adgangskode.",
          "auth/user-not-found": "Forkert e-mail eller adgangskode.",
          "auth/too-many-requests": "For mange forsøg. Vent et par minutter.",
          "auth/network-request-failed": "Ingen forbindelse. Tjek nettet.",
        };
        return { ok: false, fejl: kendte[e.code] || "Kunne ikke logge ind. Prøv igen." };
      }
    },
    async logUd() { await auth.signOut(); klarPromise = null; },
    async nulstilKode(email) {
      try { await auth.sendPasswordResetEmail(email.trim()); return { ok: true }; }
      catch { return { ok: false, fejl: "Kunne ikke sende mailen. Tjek adressen." }; }
    },
    // ⚠️ KOSMETIK, IKKE SIKKERHED. Den styrer kun hvad der TEGNES. Enhver kan
    // oprette en konto i projektet og blive "ikke-anonym", og så folder
    // admin-skallen sig ud for dem. De får nul data, fordi Firestore-reglen
    // matcher Michaels konkrete uid. Byg ALDRIG en regel eller en funktion,
    // der stoler på den her i stedet for uid'et.
    erAdmin() {
      const b = auth.currentUser;
      return !!(b && !b.isAnonymous);
    },
    uid() { return auth.currentUser ? auth.currentUser.uid : null; },
    email() { return auth.currentUser ? auth.currentUser.email : null; },
    onSkift(cb) { return auth.onAuthStateChanged(cb); },
  };

  // ---------- datalaget ----------
  const Store = {
    async config() {
      try {
        const snap = await db.doc("config/booking").get();
        return Object.assign({}, T.STANDARD_CONFIG, snap.exists ? snap.data() : {});
      } catch {
        // Kan vi ikke hente indstillingerne, falder vi tilbage til
        // standardværdierne. Bookingsiden viser så bare ingen tider,
        // hvilket er den sikre tilstand.
        return T.STANDARD_CONFIG;
      }
    },

    async gemConfig(delvis) {
      await db.doc("config/booking").set(delvis, { merge: true });
      return this.config();
    },

    async dag(iso) {
      const snap = await db.doc("dage/" + iso).get();
      return snap.exists ? Object.assign(T.tomDag(iso), snap.data()) : T.tomDag(iso);
    },

    // Hele horisonten i ÉN forespørgsel. Dokument-id'et er ISO-datoen, og
    // nul-udfyldte ISO-datoer sorterer alfabetisk præcis som kronologisk,
    // så id'et er indekset. Ingen ekstra index nødvendigt.
    //
    // ⚠️ INGEN catch her, og det er med vilje. En tom liste betyder "lukket",
    // og det er en PÅSTAND, som kun må afleveres, når serveren rent faktisk
    // har svaret. Slugte vi fejlen, ville et dårligt net vise 28 tomme dage,
    // Michael ville åbne en dag, kladden ville blive bygget fra det tomme
    // dokument, og et Gem ville SLETTE hans virkelige tider. Begge kaldere
    // fanger selv og siger sandheden.
    async dage(isoListe) {
      const ud = {};
      isoListe.forEach((iso) => { ud[iso] = T.tomDag(iso); });
      if (!isoListe.length) return ud;
      const foerste = isoListe[0], sidste = isoListe[isoListe.length - 1];
      const snap = await medFrist(db.collection("dage")
        .where(firebase.firestore.FieldPath.documentId(), ">=", foerste)
        .where(firebase.firestore.FieldPath.documentId(), "<=", sidste)
        .get(), FRIST);
      snap.forEach((doc) => {
        if (ud[doc.id]) ud[doc.id] = Object.assign(T.tomDag(doc.id), doc.data());
      });
      return ud;
    },

    // Gemmer KUN vinduerne. `optaget` sendes aldrig med, præcis som
    // Firestore-reglen kræver: Michael kan ikke komme til at overskrive
    // en kundes aftale ved at gemme sine tider.
    // Kaster ALDRIG: kalderen skal kunne vise en dansk sætning i stedet for
    // at dø midt i en klik-handler og efterlade knappen på "Gemmer…".
    async gemVinduer(iso, vinduer) {
      const ref = db.doc("dage/" + iso);
      const rene = vinduer.map((v) => ({ fra: Number(v.fra), til: Number(v.til) }));
      try {
        if (!rene.length) {
          // Ingen vinduer tilbage: findes der stadig aftaler, må dokumentet
          // BLIVE (reglen forbyder også at slette det). Ellers ryddes det.
          const snap = await medFrist(ref.get(), FRIST);
          const harAftaler = snap.exists && Object.keys(snap.data().optaget || {}).length > 0;
          if (harAftaler) await medFrist(ref.set({ dato: iso, vinduer: [] }, { merge: true }), FRIST);
          else if (snap.exists) await medFrist(ref.delete(), FRIST);
          return { ok: true };
        }
        await medFrist(ref.set({
          dato: iso,
          vinduer: rene,
          opdateret: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }), FRIST);
        return { ok: true };
      } catch (e) {
        const kode = String((e && e.code) || "");
        if (kode.indexOf("permission-denied") !== -1) return { ok: false, grund: "afvist" };
        return { ok: false, grund: "net" };
      }
    },

    // Kun Michael kan læse aftaler. Reglen afviser alle andre.
    // Kun fra og med i dag: de gamle er persondata, han ikke skal bruge, og
    // det er dataminimering, ikke ydelse. I dag ville hver eneste kundes navn,
    // telefon og fritekst i tolv måneder blive hentet ned over mobildata,
    // hver gang han trykker på fanen.
    async aftaler() {
      const nu = new Date();
      const fra = new Date(nu.getFullYear(), nu.getMonth(), nu.getDate());
      const snap = await medFrist(db.collection("aftaler")
        .where("startAt", ">=", firebase.firestore.Timestamp.fromDate(fra))
        .orderBy("startAt", "asc")
        .get(), FRIST);
      return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    },

    // Booking går gennem Cloud Function'en, aldrig direkte i databasen.
    // Den er den eneste, der må skrive en aftale, og den regner selv efter,
    // om tiden stadig er ledig.
    async book(oensket) {
      await klar();
      try {
        const kald = fns.httpsCallable("bookAppointment");
        const res = await kald({
          dato: oensket.dato,
          startMin: oensket.startMin,
          ydelseKey: oensket.ydelseKey,
          navn: oensket.navn,
          telefon: oensket.telefon,
          email: oensket.email || "",
          besked: oensket.besked || "",
        });
        return { ok: true, id: res.data && res.data.id };
      } catch (e) {
        // "aborted" og "failed-precondition" betyder begge: tiden kan ikke
        // bookes længere. Kundesiden skal så hente tiderne igen.
        const optaget = e.code === "functions/aborted" || e.code === "functions/failed-precondition";
        return { ok: false, grund: optaget ? "optaget" : "fejl", besked: e.message };
      }
    },

    async aflys(id) {
      try {
        await medFrist(fns.httpsCallable("aflysAftale")({ id }), FRIST);
        return { ok: true };
      } catch { return { ok: false }; }
    },

    // Findes kun i demo-udgaven. Her er de tomme, så knapperne på
    // Mine tider ikke går i stykker, hvis de bliver stående.
    async saetDemoOp() { return false; },
    async nulstil() { return false; },
    async erTom() { return false; },
  };

  window.MHStore = Store;
  window.MHAuth = MHAuth;
  window.MHKlar = klar;
})();
