# Firebase-oppsett for Strategidatabase

## Hvor ting ligger (én av hver)
| Tjeneste | Konto / navn | Merknad |
|---|---|---|
| GitHub | `caardk-stack/strategidatabase` | Eneste repo for koden. Vercel og Claude er koblet hit. |
| Vercel | prosjektet `strategidatabase-app` → https://strategidatabase-app.vercel.app | Innlogget med GitHub-kontoen `caardk-stack`. `main` = produksjon, andre grener = testversjoner (preview). |
| Firebase | prosjektet `strategidatabase` | Authentication (Google + e-post/passord) og Firestore i EU. |

Utdaterte duplikater som ikke skal brukes: GitHub-kontoen `carolineaarjakobsen-glitch` (repoene `strategidatabase` og
`strategidatabase-app`) og Vercel-prosjektet `strategidatabase`.

Appen kjører i **lokal modus** (lagring i nettleseren, rollebytte, ingen innlogging) så lenge
`FIREBASE_CONFIG.apiKey` i `index.html` er tom. Når konfigurasjonen er fylt inn, krever appen innlogging
og lagrer alt i klubbens felles database.

## 1. Opprett prosjekt og tjenester
1. console.firebase.google.com → **Create a project** → `strategidatabase` (Google Analytics av).
2. **Build → Authentication → Get started → Sign-in method**: slå på **Google** og **Email/Password**
   (bare den første bryteren, ikke «Email link»).
3. **Authentication → Settings → Authorized domains**: legg til `strategidatabase-app.vercel.app`
   og adressen til eventuelle testversjoner (preview) på Vercel.
4. **Build → Firestore Database → Create database**: region `eur3 (europe)` eller `europe-west1`
   (kan ikke endres senere), **production mode**.
5. **Project settings → Your apps → `</>`**: registrer webappen og kopier `firebaseConfig`
   inn i `FIREBASE_CONFIG` øverst i skriptet i `index.html`.

## 2. Sikkerhetsregler
**Firestore Database → Rules**: erstatt alt med innholdet i `firestore.rules` og klikk **Publish**.

## 3. Ny klubb
Plattformeieren (se `PLATFORM_OWNERS` i `index.html` og `erEier()` i `firestore.rules`) oppretter nye klubber
i appen under fanen **Klubber**: klubbnavn, klubb-ID og første admins e-post. Admin gir deretter resten av
klubben tilgang under **Tilganger**.

Manuelt i konsollen (bare nødvendig hvis eieren ikke selv har tilgang ennå):
I **Firestore Database → Data**:

1. **Start collection** → Collection ID `klubber` → Document ID f.eks. `nfh`
   - felt `navn` (string): `Nykøbing Falster Håndbold`
2. **Start collection** (på rotnivå) → Collection ID `medlemmer` → Document ID = e-postadressen
   til første admin, **med små bokstaver**, f.eks. `ola@eksempel.no`
   - `epost` (string): samme e-post, små bokstaver
   - `navn` (string): navnet
   - `rolle` (string): `admin`
   - `klubbId` (string): `nfh`
   - `lagtTilAv` (string): `oppsett`
   - `lagtTil` (timestamp): dagens dato

Deretter logger admin inn i appen og gir andre tilgang under fanen **Tilganger**.

## Datamodell
| Sti | Innhold |
|---|---|
| `medlemmer/{e-post}` | `epost`, `navn`, `rolle` (`admin`/`spiller`), `klubbId`, `lagtTilAv`, `lagtTil` |
| `klubber/{klubbId}` | `navn`, `innstillinger` (klubbens versjon av `CLUB_CONFIG`) |
| `klubber/{klubbId}/data/teams` | `teams`: motstanderlag med spillere |
| `klubber/{klubbId}/data/presets_defense`, `presets_attack` | `presets`: playbook-mønstre |
| `klubber/{klubbId}/data/nextMatch` | `match`: neste kamp |

Aktivt playbook-mønster lagres lokalt på hver enhet.

## Kjente begrensninger
- Én e-postadresse kan bare høre til én klubb.
- Hvis to admins lagrer motstanderlag samtidig, vinner den som lagrer sist (hele listen lagres samlet).
- Rollen `support` for utviklere er ikke laget ennå. Inntil videre legges utviklere inn som admin
  ved behov og fjernes etterpå.
