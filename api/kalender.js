// Vercel serverless function.
// Henter en offentlig .ics-kalenderfeed (Google Calendar) på vegne av appen
// (nettleseren kan ikke gjøre dette selv pga. CORS) og returnerer kampene som JSON.
//
// Parametere fra appen (ingen klubb hardkodet her):
//   ?calendarId=...  kalender-ID fra klubbens konfigurasjon
//   ?tz=...          IANA-tidssone fra klubbens konfigurasjon, f.eks. Europe/Copenhagen
//
// Hver kamp returneres som:
//   { summary, location, date: 'ÅÅÅÅ-MM-DD', time: 'TT:MM' | null, allDay, start: ISO-tid i UTC | null }
// der date/time allerede er omregnet til klubbens tidssone.

export default async function handler(req, res) {
  const calendarId = req.query.calendarId;
  const timeZone = isValidTimeZone(req.query.tz) ? req.query.tz : 'UTC';

  if (!calendarId) {
    res.status(400).json({ error: 'Mangler calendarId-parameter. Kall /api/kalender?calendarId=...&tz=...' });
    return;
  }

  const icsUrl = `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`;

  try {
    const response = await fetch(icsUrl);
    if (!response.ok) {
      res.status(502).json({ error: 'Klarte ikke hente kalenderdata. Sjekk at kalender-ID er riktig og at kalenderen er offentlig.', status: response.status });
      return;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const icsText = unfoldAndDecode(bytes);
    const events = parseIcs(icsText, timeZone);
    res.setHeader('Cache-Control', 's-maxage=3600'); // cache 1 time, spar unødige kall
    res.status(200).json({ timeZone, events });
  } catch (err) {
    res.status(500).json({ error: 'Feil ved henting/tolking av kalender', details: String(err) });
  }
}

/* ---------- iCalendar-tolking (RFC 5545) ---------- */

// RFC 5545 §3.1: linjer over 75 oktetter brettes med linjeskift + ett mellomrom/tab.
// Brettingen gjøres på byte-nivå, så vi fjerner den FØR UTF-8-dekoding —
// ellers kan æ/ø/å som er delt over to linjer bli ødelagt.
function unfoldAndDecode(bytes) {
  const out = new Uint8Array(bytes.length);
  let j = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0D && bytes[i + 1] === 0x0A && (bytes[i + 2] === 0x20 || bytes[i + 2] === 0x09)) { i += 2; continue; }
    if (bytes[i] === 0x0A && (bytes[i + 1] === 0x20 || bytes[i + 1] === 0x09)) { i += 1; continue; }
    out[j++] = bytes[i];
  }
  return new TextDecoder('utf-8').decode(out.subarray(0, j));
}

// Deler en innholdslinje i navn, parametere og verdi.
// Kolon inni anførselstegn (parameterverdier) skiller ikke navn fra verdi.
function parseLine(line) {
  let inQuotes = false;
  let colonAt = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) { colonAt = i; break; }
  }
  if (colonAt === -1) return null;
  const head = line.slice(0, colonAt).split(';');
  const params = {};
  head.slice(1).forEach(p => {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  });
  return { name: head[0].toUpperCase(), params, value: line.slice(colonAt + 1) };
}

// RFC 5545 §3.3.11: tekstverdier escaper \\ \; \, og \n.
function unescapeText(value) {
  return value.replace(/\\([\\;,nN])/g, (_, ch) => (ch === 'n' || ch === 'N') ? '\n' : ch);
}

function parseIcs(icsText, timeZone) {
  const events = [];
  const lines = icsText.split(/\r?\n/);
  let current = null;
  let nestedDepth = 0; // f.eks. VALARM inni VEVENT — de skal ikke overskrive kampens felt

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = {}; nestedDepth = 0; continue; }
    if (!current) continue;
    if (line === 'END:VEVENT') {
      const ev = buildEvent(current, timeZone);
      if (ev) events.push(ev);
      current = null;
      continue;
    }
    if (line.startsWith('BEGIN:')) { nestedDepth++; continue; }
    if (line.startsWith('END:')) { nestedDepth--; continue; }
    if (nestedDepth > 0) continue;

    const prop = parseLine(line);
    if (prop && !current[prop.name]) current[prop.name] = prop;
  }

  // Sorter kronologisk (heldagshendelser først på sin dato)
  events.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  return events;
}

function buildEvent(props, timeZone) {
  const summary = props.SUMMARY ? unescapeText(props.SUMMARY.value).trim() : '';
  if (!summary || !props.DTSTART) return null;
  const when = resolveStart(props.DTSTART, timeZone);
  if (!when) return null;
  return {
    summary,
    location: props.LOCATION ? unescapeText(props.LOCATION.value).trim() : '',
    ...when
  };
}

/* ---------- Tidspunkt og tidssoner ---------- */

// Tre varianter i RFC 5545 §3.3.5:
//   20260906T160000Z                       → UTC
//   TZID=Europe/Copenhagen:20260906T180000 → lokal tid i oppgitt sone
//   20260906T180000                        → «flytende» tid, tolkes som klubbens sone
// pluss heldag: VALUE=DATE:20260906
function resolveStart(prop, clubTimeZone) {
  const m = prop.value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;

  if (!h || prop.params.VALUE === 'DATE') {
    return { date: `${y}-${mo}-${d}`, time: null, allDay: true, start: null };
  }

  const parts = [+y, +mo, +d, +h, +mi, +(s || 0)];
  let utcMs;
  if (z) {
    utcMs = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  } else {
    const sourceZone = isValidTimeZone(prop.params.TZID) ? prop.params.TZID : clubTimeZone;
    utcMs = zonedTimeToUtc(parts, sourceZone);
  }

  const local = partsInZone(utcMs, clubTimeZone);
  return {
    date: `${local.year}-${local.month}-${local.day}`,
    time: `${local.hour}:${local.minute}`,
    allDay: false,
    start: new Date(utcMs).toISOString()
  };
}

function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch { return false; }
}

// Klokke og dato for et UTC-tidspunkt, sett fra en gitt tidssone.
function partsInZone(utcMs, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const out = {};
  fmt.formatToParts(new Date(utcMs)).forEach(p => { if (p.type !== 'literal') out[p.type] = p.value; });
  return out;
}

// Sonens avvik fra UTC (ms) på et gitt tidspunkt — tar hensyn til sommertid.
function offsetMs(utcMs, timeZone) {
  const p = partsInZone(utcMs, timeZone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// Lokal veggklokketid i en sone → UTC. To runder for å treffe riktig ved sommertidsskifte.
function zonedTimeToUtc([y, mo, d, h, mi, s], timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = guess - offsetMs(guess, timeZone);
  const second = guess - offsetMs(utc, timeZone);
  if (second !== utc) utc = second;
  return utc;
}
