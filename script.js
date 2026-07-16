// Årstal i footer (findes på alle sider)
const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

// Mobilmenu (kun forsiden har den fulde nav)
const burger = document.getElementById("burger");
const nav = document.getElementById("nav");
if (burger && nav) {
  const setMenu = (open) => {
    nav.classList.toggle("open", open);
    burger.setAttribute("aria-expanded", String(open));
  };
  burger.addEventListener("click", () =>
    setMenu(burger.getAttribute("aria-expanded") !== "true")
  );
  nav.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => setMenu(false))
  );
}

// Kontaktformular (kun forsiden — kører kun i browseren; kobles til mail/backend før drift)
const form = document.getElementById("bookingForm");
const status = document.getElementById("formStatus");
if (form) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const navn = document.getElementById("navn").value.trim();
    if (status) status.textContent = `Tak, ${navn}! Din besked er klar — jeg vender tilbage hurtigst muligt.`;
    form.reset();
  });
}
