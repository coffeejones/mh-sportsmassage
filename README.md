# MH Sportsmassage — hjemmeside

Kildekoden til hjemmesiden for **MH Sportsmassage** v/ Michael Hansen, Bjæverskov.
Sportsmassage, manuel terapi, akupunktur og cupping.

## Sådan ser du siden
Dobbeltklik på **`index.html`** — så åbner hjemmesiden i din browser. Der er
ingen server nødvendig for at kigge på den.

## Filerne
| Fil | Hvad det er |
| --- | --- |
| `index.html` | **Forsiden** — behandlinger, priser, om mig, anmeldelser, kontakt |
| `book.html` | **Booking-siden** ("Book en tid") |
| `styles.css` | Alt design — farver, skrifttyper, layout (rør kun hvis du ved hvad du laver) |
| `script.js` | Menu + kontaktformular |
| `booking.js` | Selve booking-flowet (kører på demo-data indtil backend kobles på) |
| `images/mh/` | Billeder |

## Sådan retter du tekst (det meste)
Al tekst på forsiden står i **`index.html`**. Åbn filen i en teksteditor,
find teksten du vil ændre, ret den, og gem. Genindlæs siden i browseren for
at se ændringen.

Nyttige steder i `index.html`:
- **Priser** — søg efter `priceblock__amt` (fx `350 kr.`)
- **Telefon** — søg efter `23 90 60 68`
- **Om mig / anmeldelser** — søg efter afsnittet `id="om"` og `Anmeldelser`

## Åbningstider og booking-priser
Booking-flowets **åbningstider** og **priser** står øverst i `booking.js`
(felterne `HOURS` og `SERVICES`). Ret tal her, hvis åbningstider eller
priser ændrer sig.

> Bemærk: booking kører på demo-data lige nu. Når det rigtige booking-system
> (backend) kobles på, gemmes bookinger for alvor og deles med app'en.
