// Vercel serverless function: henter data fra tophaandbold.dk på vegne av appen
// (nettleseren kan ikke gjøre det selv pga. CORS) og gir det tilbake som ryddig JSON.
//
// Bruk: /api/tophaandbold?type=...
//   type=roster      &url=<lagside på tophaandbold.dk>      → spillertropp med bilde, alder, høyde, nasjon og statistikk-ID-er
//   type=player      &year=&league=&team=&player=            → sesongstatistikk for én spiller
//   type=team        &year=&league=&team=                    → lagstatistikk (skudd, feil, effektivitet per posisjon)
//   type=program     &league=<slug>&year=&team=              → kampprogram (resultater og kommende kamper)
//   type=standings   &league=<slug>                          → tabell
//   type=teams       &year=&league=                          → lag i en liga (navn og ID)
//
// ID-ene (year/league/team/player) er Tophåndbolds egne statistikk-ID-er.
// League-slug er delen av adressen på tophaandbold.dk, f.eks. «kvindeligaen».

const BASE = 'https://tophaandbold.dk';

// Statistikk-liga-ID → slug som brukes i adressene for kampprogram og tabell
const LEAGUE_SLUGS = {
  1: 'herreligaen',
  2: '1-division-herrer',
  5: 'pokalturnering-herrer',
  6: 'kvindeligaen',
  7: '1-division-kvinder',
  10: 'pokalturnering-kvinder'
};

export default async function handler(req, res) {
  const q = req.query || {};
  try {
    let data;
    switch (q.type) {
      case 'roster': data = await getRoster(q.url); break;
      case 'player': data = await getPlayerStats(q); break;
      case 'team': data = await getTeamStats(q); break;
      case 'program': data = await getProgram(q); break;
      case 'standings': data = await getStandings(q); break;
      case 'teams': data = await getLeagueTeams(q); break;
      default:
        res.status(400).json({ error: 'Ukjent eller manglende type.' });
        return;
    }
    // Data endres sjelden i løpet av en time; kamper oftere, så kortere cache der.
    const maxAge = q.type === 'program' || q.type === 'standings' ? 600 : 3600;
    res.setHeader('Cache-Control', 's-maxage=' + maxAge + ', stale-while-revalidate=86400');
    res.status(200).json(data);
  } catch (err) {
    const status = err.status || 502;
    res.status(status).json({ error: err.message || 'Feil ved henting fra Tophåndbold.' });
  }
}

/* ---------------- Hjelpere ---------------- */

function fail(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function num(v, name) {
  if (v === undefined || v === null || v === '' || !/^\d{1,6}$/.test(String(v))) {
    throw fail('Mangler eller ugyldig ' + name + '.', 400);
  }
  return String(v);
}

function slug(v) {
  if (!v || !/^[a-z0-9-]{2,40}$/.test(String(v))) throw fail('Mangler eller ugyldig liga.', 400);
  return String(v);
}

async function fetchText(path) {
  const r = await fetch(BASE + path, { headers: { 'User-Agent': 'CaarAnalytics/1.0 (+strategidatabase-app.vercel.app)' } });
  if (!r.ok) throw fail('Tophåndbold svarte med status ' + r.status + '.', 502);
  return r.text();
}

async function fetchJson(path) {
  const text = await fetchText(path);
  try { return JSON.parse(text); } catch (e) { throw fail('Uventet svar fra Tophåndbold.', 502); }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', aring: 'å', Aring: 'Å', oslash: 'ø', Oslash: 'Ø', aelig: 'æ', AElig: 'Æ', ouml: 'ö', Ouml: 'Ö', auml: 'ä', Auml: 'Ä', uuml: 'ü', eacute: 'é', aacute: 'á', oacute: 'ó', iacute: 'í' };

function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in ENTITIES ? ENTITIES[n] : m));
}

// Ren tekst fra et HTML-utsnitt
function text(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Innholdet i første element med gitt klasse (enkelt nok for Tophåndbolds faste markup)
function byClass(html, cls, tag) {
  const t = tag || '[a-z0-9]+';
  const re = new RegExp('<(' + t + ')[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>', 'i');
  const m = html.match(re);
  return m ? m[2] : '';
}

function absUrl(path) {
  if (!path) return '';
  const p = decode(path);
  return /^https?:\/\//.test(p) ? p : BASE + (p.startsWith('/') ? '' : '/') + p;
}

/* ---------------- Spillertropp ---------------- */

async function getRoster(url) {
  if (!url || !/^https:\/\/(www\.)?tophaandbold\.dk\//.test(url)) {
    throw fail('Lim inn en lenke til lagets side på tophaandbold.dk.', 400);
  }
  const path = url.replace(/^https:\/\/(www\.)?tophaandbold\.dk/, '');
  const html = await fetchText(path);

  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const teamName = titleMatch ? text(titleMatch[1]).replace(/\s*[-|].*$/, '') : '';

  const chunks = html.split(/<div class="team__player">/).slice(1);
  const players = [];
  let ids = null;
  let logo = '';

  for (const chunk of chunks) {
    // Navn og «#nr Posisjon»
    const nameBlock = byClass(chunk, 'team__player__name', 'div');
    const name = text(nameBlock.split(/<br\s*\/?>/i)[0]);
    const posText = text(byClass(chunk, 'team__player__name__position', 'span'));
    const pm = posText.match(/^#\s*(\d{1,3})\s*(.*)$/);
    if (!name) continue;

    const photoMatch = chunk.match(/<img[^>]*src="([^"]*player-images[^"]*)"/i);
    if (!logo) {
      const lm = chunk.match(/<img[^>]*src="([^"]*klublogoer[^"]*)"/i);
      if (lm) logo = absUrl(lm[1].split('?')[0]);
    }

    // Faktaboksen: FØDT / NATIONALITET / HØJDE
    const right = byClass(chunk, 'team__player__right', 'div') || chunk;
    const fact = (label) => {
      const m = right.match(new RegExp(label + ':?\\s*</strong>\\s*<p[^>]*>([\\s\\S]*?)</p>', 'i'));
      return m ? text(m[1]) : '';
    };
    const born = fact('FØDT') || fact('F&Oslash;DT');
    const ageMatch = born.match(/\((\d{1,2})\s*år\)/);

    // Statistikk-lenken har ID-ene: players[0][year|league|bracket|team|player]
    const statMatch = chunk.match(/href="([^"]*comparePlayer[^"]*)"/i);
    let stats = null;
    if (statMatch) {
      const href = decodeURIComponent(decode(statMatch[1]));
      const get = (k) => { const m = href.match(new RegExp('\\[' + k + '\\]=(\\d+)')); return m ? m[1] : null; };
      stats = { year: get('year'), league: get('league'), bracket: get('bracket'), team: get('team'), player: get('player') };
      if (!ids && stats.team) ids = { year: stats.year, league: stats.league, team: stats.team };
    }

    players.push({
      number: pm ? pm[1] : '',
      position: pm ? pm[2].trim() : posText,
      name,
      photo: photoMatch ? absUrl(photoMatch[1].split('?')[0]) : '',
      born: born.replace(/\s*\(\d+\s*år\)/, ''),
      age: ageMatch ? Number(ageMatch[1]) : null,
      nationality: fact('NATIONALITET'),
      height: fact('HØJDE') || fact('H&Oslash;JDE'),
      tpPlayerId: stats ? stats.player : null
    });
  }

  // Samme spiller kan i sjeldne tilfeller stå to ganger
  const seen = new Set();
  const unique = players.filter(p => {
    const key = p.number + '|' + p.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    teamName,
    logo,
    tophaandbold: ids ? { ...ids, leagueSlug: LEAGUE_SLUGS[ids.league] || null, teamPageUrl: url } : { teamPageUrl: url },
    players: unique
  };
}

/* ---------------- Statistikk (Tophåndbold har JSON for disse) ---------------- */

// Gjør {name,type,value} om til {label, value, percent?, of?}
function cleanStats(groups) {
  const out = {};
  for (const [group, items] of Object.entries(groups || {})) {
    out[group] = (items || []).map(it => {
      if (it.type === 'percentage' && it.value && typeof it.value === 'object') {
        const pct = Number(it.value.percentage);
        const max = Number(it.value.max);
        const min = Number(it.value.min);
        // «Effektivitet fra …» har max=100: da er min selve prosenten, ikke et antall
        return max === 100 && Math.abs(min - pct) < 0.01
          ? { label: it.name, percent: Math.round(pct * 10) / 10 }
          : { label: it.name, value: min, of: max, percent: Math.round(pct * 10) / 10 };
      }
      const v = Number(it.value);
      return { label: it.name, value: it.type === 'number' && !isNaN(v) ? Math.round(v * 100) / 100 : it.value };
    });
  }
  return out;
}

async function getPlayerStats(q) {
  const path = '/tophaandbold-theme/statistics/player-statistics/' +
    [num(q.year, 'sesong'), num(q.league, 'liga'), q.bracket ? num(q.bracket, 'pulje') : '0', num(q.team, 'lag'), num(q.player, 'spiller')].join('/') + '.json';
  const j = await fetchJson(path);
  const p = j.player || {};
  return { name: p.name, teamName: p.team_name, teamShort: p.team_short, photo: absUrl(p.image), groups: cleanStats(p.statistics) };
}

async function getTeamStats(q) {
  const path = '/tophaandbold-theme/statistics/team-statistics/' +
    [num(q.year, 'sesong'), num(q.league, 'liga'), q.bracket ? num(q.bracket, 'pulje') : '0', num(q.team, 'lag')].join('/') + '.json';
  const j = await fetchJson(path);
  const t = j.team || {};
  return { name: t.name, short: t.short, logo: absUrl(String(t.logo || '').split('?')[0]), groups: cleanStats(t.statistics) };
}

async function getLeagueTeams(q) {
  const j = await fetchJson('/tophaandbold-theme/statistics/get-season-league-brackets/' +
    num(q.year, 'sesong') + '/' + num(q.league, 'liga') + '.json?teams');
  return {
    seasons: j.seasons || {},
    leagues: j.leagues || {},
    teams: Object.entries(j.teams || {}).map(([id, name]) => ({ id, name }))
  };
}

/* ---------------- Kampprogram ---------------- */

async function getProgram(q) {
  const league = slug(q.league);
  const params = [];
  if (q.year) params.push('year=' + num(q.year, 'sesong'));
  if (q.team) params.push('team=' + num(q.team, 'lag'));
  const html = await fetchText('/kampprogram/' + league + (params.length ? '?' + params.join('&') : ''));

  const chunks = html.split(/<div class="match-program__row[ "]/).slice(1);
  const matches = [];
  for (const chunk of chunks) {
    const dateText = text(byClass(chunk, 'match-program__row__date', 'div'));
    const dm = dateText.match(/(\d{2})-(\d{2})-(\d{2})(?:\s+(\d{1,2}:\d{2}))?/);
    if (!dm) continue;
    const teamsHtml = chunk.match(/<div class="match-program__row__team">([\s\S]*?)<\/div>/gi) || [];
    if (teamsHtml.length < 2) continue;
    const scoreText = text(byClass(chunk, 'match-program__row__score', 'div'));
    const sm = scoreText.match(/^(\d+)\s*-\s*(\d+)$/);
    const idMatch = chunk.match(/href="\/match\/(\d+)"/);
    const logos = [...chunk.matchAll(/<img[^>]*src="([^"]*)"[^>]*match-program__row__team__logo|<img[^>]*match-program__row__team__logo[^>]*src="([^"]*)"/gi)]
      .map(m => absUrl((m[1] || m[2] || '').split('?')[0]));
    // TV-kanal står som et logo-bilde i den første «livescore»-cellen, når kampen sendes
    const tvMatch = chunk.match(/js-livescore">\s*(?:<a[^>]*>)?\s*<img[^>]*(?:alt|title)="([^"]+)"/i);
    const id = idMatch ? idMatch[1] : null;
    matches.push({
      id,
      date: '20' + dm[3] + '-' + dm[2] + '-' + dm[1],
      time: dm[4] ? dm[4].padStart(5, '0') : null,
      home: text(teamsHtml[0]),
      away: text(teamsHtml[1]),
      homeLogo: logos[0] || '',
      awayLogo: logos[1] || '',
      homeGoals: sm ? Number(sm[1]) : null,
      awayGoals: sm ? Number(sm[2]) : null,
      played: !!sm,
      tv: tvMatch ? decode(tvMatch[1]) : null,
      livescoreUrl: id ? BASE + '/match/' + id : null,
      reportPdf: id && /pdfs\/game\/\d+\/report/.test(chunk) ? BASE + '/intranet/pdfs/game/' + id + '/report' : null,
      eventsPdf: id && /pdfs\/game\/\d+\/events/.test(chunk) ? BASE + '/intranet/pdfs/game/' + id + '/events' : null
    });
  }
  return { league, matches };
}

/* ---------------- Tabell ---------------- */

async function getStandings(q) {
  const league = slug(q.league);
  const html = await fetchText('/stillinger/' + league);
  const rows = html.split(/<tr class="team-position__row/).slice(1);
  const table = [];
  for (const row of rows) {
    const body = row.split(/<\/tr>/)[0];
    const rank = text(byClass(body, 'team-position__rank', 'span'));
    const teamCell = byClass(body, 'team-position__team', 'td');
    const cells = (body.match(/<td class="text-center">([\s\S]*?)<\/td>/gi) || []).map(text);
    const form = [...body.matchAll(/team-position__form-dot--(win|draw|loss|lose|tie)/gi)]
      .map(m => ({ win: 'V', draw: 'U', tie: 'U', loss: 'T', lose: 'T' }[m[1].toLowerCase()]));
    const logo = teamCell.match(/<img[^>]*src="([^"]*)"/i);
    if (!rank || cells.length < 6) continue;
    table.push({
      rank: Number(rank),
      team: text(teamCell),
      logo: logo ? absUrl(logo[1].split('?')[0]) : '',
      played: Number(cells[0]), won: Number(cells[1]), drawn: Number(cells[2]), lost: Number(cells[3]),
      goals: cells[4], points: Number(cells[5]),
      form
    });
  }
  return { league, table };
}
