const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const WACHTWOORD = process.env.APP_WACHTWOORD || 'yappi2024';
app.use((req, res, next) => {
  const cookie = req.headers.cookie || '';
  const ingelogd = cookie.includes('yappi_auth=true');

  // Altijd doorlaten:
  if (req.path === '/login') return next();
  if (req.path.startsWith('/logo')) return next();
  if (req.path.endsWith('.png')) return next();
  if (req.path.endsWith('.ico')) return next();

  // API routes
  if (req.path.startsWith('/api/')) {
    if (!ingelogd) return res.status(401).json({ error: 'Niet ingelogd' });
    return next();
  }

  // HTML paginas
  if (!ingelogd) {
    return res.redirect('/login');
  }

  next();
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.post('/login', express.json(), (req, res) => {
  const { wachtwoord } = req.body;
  if (wachtwoord === WACHTWOORD) {
    res.setHeader('Set-Cookie', 'yappi_auth=true; Path=/; HttpOnly; Max-Age=86400');
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Fout wachtwoord' });
  }
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/quote/:symbol?interval=1d
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { interval = '1d' } = req.query;
    const intervalMap = {
      '5m':  { interval: '5m',  range: '1d' },
      '15m': { interval: '15m', range: '1d' },
      '1h':  { interval: '1h',  range: '1mo' },
      '1d':  { interval: '1d',  range: '1y' },
    };
    const params = intervalMap[interval] || intervalMap['1d'];
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${params.interval}&range=${params.range}&includePrePost=false`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    });
    if (!response.ok) throw new Error(`Yahoo returned ${response.status}`);
    const data = await response.json();
    console.log('Fetching:', symbol, interval, params.range);
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('Geen data van Yahoo');
    const ts = result.timestamp;
    const q = result.indicators?.quote?.[0];
    console.log('Quotes ontvangen:', ts?.length);
    if (!ts || ts.length === 0 || !q) {
      return res.json({
        symbol,
        interval,
        quotes: [],
        meta: result.meta || {},
        bericht: 'Geen data beschikbaar voor dit timeframe. Beurs mogelijk gesloten.'
      });
    }
    const quotes = ts.map((t, i) => ({
      date: new Date(t * 1000).toISOString(),
      open:   q.open[i]   != null ? +q.open[i].toFixed(4)   : null,
      high:   q.high[i]   != null ? +q.high[i].toFixed(4)   : null,
      low:    q.low[i]    != null ? +q.low[i].toFixed(4)    : null,
      close:  q.close[i]  != null ? +q.close[i].toFixed(4)  : null,
      volume: q.volume[i] || 0,
    })).filter(q => q.open && q.close && q.high && q.low);
    if (!quotes || quotes.length === 0) {
      return res.json({
        symbol,
        interval,
        quotes: [],
        meta: result.meta || {},
        bericht: 'Geen data beschikbaar voor dit timeframe. Beurs mogelijk gesloten.'
      });
    }
    res.json({ symbol, interval, meta: result.meta, quotes });
  } catch (err) {
    console.error('Quote error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/analyze  — body: { symbol, interval, quotes, indicators }
app.post('/api/analyze', async (req, res) => {
  try {
    const { symbol, interval, quotes, indicators } = req.body;

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'ANTHROPIC_API_KEY is niet ingesteld op de server.' });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const recent = quotes.slice(-30);
    const last   = recent[recent.length - 1];

    const fmt = (v, d = 2) => (v != null ? Number(v).toFixed(d) : 'N/A');
    const nowStr = new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });

    const now = new Date();
    const amsterdamTijd = now.toLocaleTimeString('nl-NL', {
      hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam'
    });
    const dagdeel = (() => {
      const uur = parseInt(amsterdamTijd.split(':')[0]);
      if (uur < 9) return 'pre-market';
      if (uur < 9.5) return 'opening (hoge volatiliteit, wacht op richting)';
      if (uur < 11) return 'ochtend (sterkste signalen)';
      if (uur < 13) return 'lunch (lagere betrouwbaarheid)';
      if (uur < 15.5) return 'middag (tweede beste periode)';
      if (uur < 17.5) return 'US opening invloed (verhoogde volatiliteit)';
      return 'slotveiling (vermijd nieuwe posities)';
    })();
    const openingGap = quotes.length > 1
      ? ((quotes[0].close - quotes[quotes.length-1].close) / quotes[quotes.length-1].close * 100).toFixed(2)
      : null;
    const aandeelRegels = {
      'ASML.AS': 'Institutioneel aandeel. Langzame betrouwbare bewegingen. Volgt NASDAQ/chips. Dagbereik €15-25. Min vertrouwen: 60%.',
      'ADYEN.AS': 'Hoge volatiliteit. Dagbewegingen €20-50. Gevoelig voor betaalsector. RSI betrouwbaarder dan MACD. Min vertrouwen: 65%.',
      'NVDA': 'Marktleider chips. Sterk AI/tech sentiment. Dagbewegingen $3-8. Min vertrouwen: 55%.',
      'TSLA': 'Extreem volatiel. Veel valse signalen. Alleen handelen bij vertrouwen 75%+. Strikte stop-loss.',
      'RHM.DE': 'Defensie aandeel. Stijgt bij geopolitiek nieuws. Volg NAVO/Oekraïne nieuws. Min vertrouwen: 65%.',
      'BA': 'Aerospace/defensie. US markturen leidend (14:30-21:00 NL). Volg Pentagon nieuws.',
      'LMT': 'Defensie. Gevoelig voor overheidscontracten. US markturen leidend.',
    };
    const prompt = `Je bent een elite daytrader analist met 20 jaar ervaring.
Analyseer ${symbol} op ${interval} timeframe voor een daytrade beslissing.
Doel: €100-300 winst per dag met minimaal risico.
HUIDIGE SITUATIE:
- Koers: ${fmt(last.close)}
- Tijd Amsterdam: ${amsterdamTijd} (${dagdeel})
- Opening gap vandaag: ${openingGap ? openingGap + '%' : 'onbekend'}
AANDEEL REGELS:
${aandeelRegels[symbol] || 'Standaard regels van toepassing.'}
REDENEER IN 8 STAPPEN:
STAP 1 - TREND:
EMA trend: ${indicators.trend}
Laatste 5 slotkoersen: ${quotes.slice(-5).map(q => fmt(q.close)).join(' → ')}
Is de trend opwaarts, neerwaarts of zijwaarts?
STAP 2 - MOMENTUM (RSI + MACD samen beoordelen):
RSI(14): ${fmt(indicators.rsi)} → ${Number(indicators.rsi) > 70 ? '🔴 OVERBOUGHT' : Number(indicators.rsi) < 30 ? '🟢 OVERSOLD' : '⚪ Neutraal'}
MACD: ${fmt(indicators.macd?.macd, 4)} | Signaal: ${fmt(indicators.macd?.signal, 4)} | Histogram: ${fmt(indicators.macd?.histogram, 4)}
Momentum oordeel: ${Number(indicators.rsi) < 30 && indicators.macd?.histogram > 0 ? '🟢 STERK KOOP signaal' : Number(indicators.rsi) > 70 && indicators.macd?.histogram < 0 ? '🔴 STERK VERKOOP signaal' : '⚪ Gemengd — wees voorzichtig'}
STAP 3 - BOLLINGER BANDS:
Upper: ${fmt(indicators.bb?.upper)} | Midden: ${fmt(indicators.bb?.middle)} | Lower: ${fmt(indicators.bb?.lower)}
Koers positie: ${Number(last.close) > Number(indicators.bb?.upper) ? '🔴 BOVEN upper band' : Number(last.close) < Number(indicators.bb?.lower) ? '🟢 ONDER lower band — stuitje mogelijk' : '⚪ Binnen bands'}
STAP 4 - KAARSPATRONEN (laatste 8 kaarsen):
${recent.slice(-8).map(q => {
  const d = new Date(q.date);
  const t = d.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Amsterdam'});
  const body = Math.abs(q.close-q.open);
  const range = q.high-q.low || 0.01;
  const bodyPct = Math.round(body/range*100);
  const wick_onder = Math.min(q.open,q.close)-q.low;
  const wick_boven = q.high-Math.max(q.open,q.close);
  let patroon = '';
  if (bodyPct < 10) patroon = '(doji)';
  else if (wick_onder > body*2 && q.close > q.open) patroon = '(hammer 🔨)';
  else if (wick_boven > body*2 && q.close < q.open) patroon = '(shooting star ⭐)';
  return `${q.close>=q.open?'🟢':'🔴'} ${t} O:${fmt(q.open)} H:${fmt(q.high)} L:${fmt(q.low)} C:${fmt(q.close)} ${patroon}`;
}).join('\n')}
STAP 5 - VOLUME:
${recent.slice(-5).map(q => {
  const d = new Date(q.date);
  const t = d.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Amsterdam'});
  return t + ': ' + (q.volume > 0 ? q.volume.toLocaleString() : 'n/b');
}).join(' | ')}
STAP 6 - NIEUWS & MARKTCONTEXT:
Zoek naar nieuws over ${symbol} van vandaag.
Let op: sectortrend, macro sentiment, geopolitiek (voor defensie aandelen).
STAP 7 - STEUN & WEERSTAND:
Bereken op basis van de kaarsen:
- Weerstand: hoogste recente top
- Steun: laagste recente bodem
- Stop-loss: maximaal 1% onder entry
- Target: minimaal 1.5x het risico
STAP 8 - TIJDSTIP BEOORDELING:
Het is nu ${amsterdamTijd} — ${dagdeel}.
${parseInt(amsterdamTijd) < 9 ? 'PRE-MARKET: Geef alleen een voorbereiding advies, nog niet handelen.' : ''}
${parseInt(amsterdamTijd) >= 9 && parseInt(amsterdamTijd) < 10 ? 'OPENING UUR: Hoge volatiliteit. Alleen handelen bij zeer sterk signaal (vertrouwen 80%+).' : ''}
${parseInt(amsterdamTijd) >= 16 ? 'LAAT OP DE DAG: Adviseer NIET MEER KOPEN VANDAAG tenzij er een uitzonderlijk sterk signaal is.' : ''}
Geef ALLEEN dit JSON object terug, geen tekst eromheen:
{
  "signaal": "KOOP" of "VERKOOP" of "WACHT",
  "actie": "KOOP NU" of "KOOP BIJ DALING NAAR [prijs]" of "VERKOOP NU" of "WACHT TOT [HH:MM]" of "NIET MEER KOPEN VANDAAG" of "WACHT OP BEVESTIGING",
  "vertrouwen": getal 0-100,
  "redenering": "2-3 zinnen concreet: welke combinatie geeft de doorslag, met prijsniveaus",
  "entry": prijsgetal,
  "stop_loss": prijsgetal,
  "target": prijsgetal,
  "rr_ratio": decimaal,
  "dagtrend": "beschrijving van ochtend vs middag beweging met prijzen",
  "instap_tijd": "HH:MM of omschrijving",
  "nieuws_sentiment": "POSITIEF" of "NEGATIEF" of "NEUTRAAL",
  "nieuws_samenvatting": "1-2 zinnen actueel nieuws",
  "verwacht_rendement_pct": decimaal,
  "kaarspatroon": "naam herkend patroon of geen",
  "weerstand": prijsgetal,
  "steun": prijsgetal,
  "tijdstip_advies": "specifiek advies voor dit moment op de dag"
}`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    }, {
      headers: { 'anthropic-beta': 'web-search-2025-03-05' },
    });

    // Find the last text block (web_search may produce tool_use blocks before the final answer)
    const textBlock = [...message.content].reverse().find(b => b.type === 'text');
    if (!textBlock) throw new Error('AI gaf geen tekst terug');
    const match = textBlock.text.trim().match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI gaf geen valide JSON terug');

    res.json(JSON.parse(match[0]));
  } catch (err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Server listening on port ' + PORT);
});
