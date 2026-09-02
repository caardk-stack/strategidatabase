// Vercel serverless function.
// Henter en Tophåndbold lag-side på vegne av appen (løser CORS) og
// tolker ut spillertroppen basert på sidens konsistente struktur:
// "#nummer" etterfulgt av posisjon, deretter spillernavn, gjentatt per spiller.

export default async function handler(req, res) {
  const teamUrl = req.query.url;

  if (!teamUrl || !teamUrl.startsWith('https://tophaandbold.dk/')) {
    res.status(400).json({ error: 'Mangler eller ugyldig url-parameter. Må være en tophaandbold.dk-lenke.' });
    return;
  }

  try {
    const response = await fetch(teamUrl);
    if (!response.ok) {
      res.status(502).json({ error: 'Klarte ikke hente siden fra Tophåndbold.', status: response.status });
      return;
    }
    const html = await response.text();
    const players = parsePlayers(html);
    res.setHeader('Cache-Control', 's-maxage=3600');
    res.status(200).json({ players });
  } catch (err) {
    res.status(500).json({ error: 'Feil ved henting/tolking av spillertropp', details: String(err) });
  }
}

function parsePlayers(html) {
  // Fjern HTML-tagger til ren tekst, behold linjeskift som separator
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&')
    .replace(/&aring;/g, 'å')
    .replace(/&oslash;/g, 'ø')
    .replace(/&aelig;/g, 'æ');

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const players = [];
  // Mønster observert på siden: "#13" på egen linje, "Målvogter" (posisjon) på neste,
  // deretter navnet gjentatt (én gang som overskrift, én gang med "#nr Posisjon" på samme linje).
  // Vi bruker det enkle, robuste mønsteret: linje som er nøyaktig "#<tall>" markerer start på en spillerblokk.
  for (let i = 0; i < lines.length; i++) {
    const numMatch = lines[i].match(/^#(\d{1,3})$/);
    if (!numMatch) continue;

    const number = numMatch[1];
    const position = lines[i + 1] || '';
    const name = lines[i + 2] || '';

    // Filtrer bort tydelig feil-treff (posisjon/navn som ser ut som lenker, tall, eller er for kort)
    if (name && name.length > 2 && !/^https?:\/\//.test(name) && !/^\d+$/.test(name)) {
      players.push({ number, position: position.trim(), name: name.trim() });
    }
  }

  // Fjern eventuelle duplikater (samme nummer+navn dukker noen ganger opp to steder på siden)
  const seen = new Set();
  return players.filter(p => {
    const key = p.number + '|' + p.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
