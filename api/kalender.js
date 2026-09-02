// Vercel serverless function.
// Henter en offentlig .ics-kalenderfeed fra Tophåndbold på vegne av appen
// (nettleseren kan ikke gjøre dette selv pga. CORS) og sender rådataen videre.
//
// Kalender-ID mottas som URL-parameter fra appen (?calendarId=...),
// slik at ulike klubber/lag kan bruke samme funksjon med sin egen kalender —
// ingen hardkoding av ett bestemt lag.

export default async function handler(req, res) {
  const calendarId = req.query.calendarId;

  if (!calendarId) {
    res.status(400).json({ error: 'Mangler calendarId-parameter. Kall /api/kalender?calendarId=...' });
    return;
  }

  const icsUrl = `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`;

  try {
    const response = await fetch(icsUrl);
    if (!response.ok) {
      res.status(502).json({ error: 'Klarte ikke hente kalenderdata. Sjekk at kalender-ID er riktig og at kalenderen er offentlig.', status: response.status });
      return;
    }
    const icsText = await response.text();
    const events = parseIcs(icsText);
    res.setHeader('Cache-Control', 's-maxage=3600'); // cache 1 time, spar unødige kall
    res.status(200).json({ events });
  } catch (err) {
    res.status(500).json({ error: 'Feil ved henting/tolking av kalender', details: String(err) });
  }
}

// Enkel, robust iCalendar (.ics)-tolker for de feltene vi trenger.
// Følger RFC 5545-grunnstrukturen: VEVENT-blokker med SUMMARY/DTSTART/DTEND.
function parseIcs(icsText) {
  const events = [];
  const veventBlocks = icsText.split('BEGIN:VEVENT').slice(1);

  veventBlocks.forEach(block => {
    const summary = extractField(block, 'SUMMARY');
    const dtstart = extractField(block, 'DTSTART');
    const location = extractField(block, 'LOCATION');

    if (!summary || !dtstart) return;

    events.push({
      summary: summary.trim(),
      date: parseIcsDate(dtstart),
      location: (location || '').trim()
    });
  });

  // Sorter kronologisk
  events.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return events;
}

function extractField(block, fieldName) {
  // Matcher f.eks. "SUMMARY:Tekst her" eller "DTSTART;TZID=...:20260906T160000"
  const regex = new RegExp(fieldName + '[^:]*:(.+)', 'i');
  const match = block.match(regex);
  return match ? match[1].split('\r')[0].split('\n')[0] : null;
}

function parseIcsDate(raw) {
  // Format er typisk YYYYMMDD eller YYYYMMDDTHHMMSS(Z)
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  let result = `${year}-${month}-${day}`;
  if (digits.length >= 14) {
    const hour = digits.slice(8, 10);
    const minute = digits.slice(10, 12);
    result += `T${hour}:${minute}`;
  }
  return result;
}
