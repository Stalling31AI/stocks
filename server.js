const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── TRADE HISTORY (in-memory, reset bij herstart) ──────────────────────────
const tradeHistory = []; // max 200 afgeronde trades
const MAX_HISTORY = 200;

// ── NEWS CACHE ─────────────────────────────────────────────────────────────
const newsCache = {}; // per-symbol Yahoo cache (10 min)
const categoryNewsCache = {}; // category feeds cache (30 min)

// Keywords per symbool voor filtering van categorie-feeds
const SYMBOOL_KEYWORDS = {
  'NVDA':    ['nvidia','nvda','chip','semiconductor','ai','gpu','tariff','export control','tsmc','jensen'],
  'AMD':     ['amd','chip','semiconductor','ai','gpu','tariff','export','radeon','lisa su'],
  'AMAT':    ['applied materials','amat','semiconductor','chip equipment','wafer'],
  'ASML':    ['asml','semiconductor','chip','lithography','euv','tariff','export','netherlands'],
  'ASML.AS': ['asml','semiconductor','chip','lithography','euv','tariff','export'],
  'META':    ['meta','facebook','instagram','social media','advertising','zuckerberg','regulation','antitrust'],
  'NFLX':    ['netflix','nflx','streaming','subscriber','content','disney','advertising'],
  'PYPL':    ['paypal','pypl','fintech','payments','venmo','regulation','visa','mastercard'],
  'LMT':     ['lockheed','lmt','defense','military','nato','pentagon','ukraine','f-35','missile'],
  'RHM.DE':  ['rheinmetall','rhm','defense','military','nato','ukraine','bundeswehr','ammunition','tank'],
  'ADYEN.AS':['adyen','payments','fintech','european payments','regulation','bnpl'],
};
// Macro-keywords die altijd meegaan ongeacht symbool
const MACRO_KEYWORDS = ['trump','tariff','fed ','federal reserve','interest rate','inflation','recession',
  'nasdaq','s&p','dow jones','market rally','market crash','earnings','gdp'];

// Categorie RSS-feeds (30 min cache)
const CATEGORIE_FEEDS = [
  { naam: 'Reuters Top',    url: 'https://feeds.reuters.com/reuters/topNews' },
  { naam: 'Reuters World',  url: 'https://feeds.reuters.com/Reuters/worldNews' },
  { naam: 'Reuters Tech',   url: 'https://feeds.reuters.com/reuters/technologyNews' },
  { naam: 'Reuters Biz',    url: 'https://feeds.reuters.com/reuters/businessNews' },
  { naam: 'CNBC Markets',   url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
  { naam: 'CNBC Tech',      url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html' },
  { naam: 'CNBC World',     url: 'https://www.cnbc.com/id/100727362/device/rss/rss.html' },
  { naam: 'MarketWatch',    url: 'https://feeds.marketwatch.com/marketwatch/topstories/' },
  { naam: 'AP Business',    url: 'https://feeds.apnews.com/rss/apf-business' },
];

function parseRssTitels(xml) {
  // Probeer CDATA-formaat, dan gewoon <title>
  const cdataMatch = [...xml.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/gs)].map(m => m[1]);
  if (cdataMatch.length > 1) return cdataMatch.slice(1, 10);
  const plainMatch = [...xml.matchAll(/<title>(.*?)<\/title>/gs)].map(m => m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').trim());
  return plainMatch.slice(1, 10);
}

async function haalCategorieNieuwsOp() {
  const nu = Date.now();
  const CACHE_MS = 30 * 60 * 1000;
  const alleHeadlines = [];
  for (const feed of CATEGORIE_FEEDS) {
    if (categoryNewsCache[feed.naam] && nu - categoryNewsCache[feed.naam].ts < CACHE_MS) {
      alleHeadlines.push(...categoryNewsCache[feed.naam].headlines);
      continue;
    }
    try {
      const r = await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
      const xml = await r.text();
      const titels = parseRssTitels(xml);
      categoryNewsCache[feed.naam] = { ts: nu, headlines: titels };
      alleHeadlines.push(...titels);
    } catch(e) {
      console.warn(`Categorie nieuws fout (${feed.naam}):`, e.message);
    }
  }
  return alleHeadlines;
}

async function haalNieuwsOp(symbol) {
  const nu = Date.now();
  // 1. Yahoo Finance per-symbool (10 min cache)
  let yahooHeadlines = [];
  if (newsCache[symbol] && nu - newsCache[symbol].ts < 10 * 60 * 1000) {
    yahooHeadlines = newsCache[symbol].headlines;
  } else {
    try {
      const cleanSym = symbol.replace('.AS','').replace('.DE','');
      const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${cleanSym}&region=US&lang=en-US`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
      const xml = await r.text();
      yahooHeadlines = parseRssTitels(xml).slice(0, 3);
      newsCache[symbol] = { ts: nu, headlines: yahooHeadlines };
    } catch(e) {
      console.warn(`Yahoo nieuws fout voor ${symbol}:`, e.message);
    }
  }
  // 2. Categorie-feeds gefilterd op symbool-keywords + macro
  const symKeywords = (SYMBOOL_KEYWORDS[symbol] || []);
  const alleKeywords = [...symKeywords, ...MACRO_KEYWORDS];
  const categorieHeadlines = (await haalCategorieNieuwsOp())
    .filter(h => alleKeywords.some(kw => h.toLowerCase().includes(kw)))
    .slice(0, 5);
  // Combineer, deduplicate op eerste 40 chars
  const seen = new Set();
  const combined = [...yahooHeadlines, ...categorieHeadlines].filter(h => {
    const key = h.substring(0, 40).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return combined.slice(0, 7); // max 7 headlines naar AI
}

// ── MISSED OPPORTUNITY TRACKING ───────────────────────────────────────────
const lastAnalysePerSymbol = {}; // { symbol: { signaal, prijs, rsi, rsiTrend, macdRichting, tijdstip, datum, label } }

const TWELVE_DATA_KEY = '818a833a78d8440ea0f60d83707420fb';
const TWELVE_DATA_SYMBOLS = new Set(['NVDA','AMD','META','NFLX','AMAT','PYPL','LMT','ASML']);
const _tdCallTimes = [];
let _tdQueue = Promise.resolve(); // Serialiseert alle TD-calls: nooit gelijktijdig
async function tdRateLimit() {
  // Wacht tot vorige call klaar is (queue), dan minimaal 8s gap
  _tdQueue = _tdQueue.then(() => new Promise(async resolve => {
    const now = Date.now();
    while (_tdCallTimes.length && now - _tdCallTimes[0] > 60000) _tdCallTimes.shift();
    if (_tdCallTimes.length >= 8) {
      const wait = 60100 - (now - _tdCallTimes[0]);
      console.log(`TD rate limit: wacht ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      const now2 = Date.now();
      while (_tdCallTimes.length && now2 - _tdCallTimes[0] > 60000) _tdCallTimes.shift();
    } else if (_tdCallTimes.length > 0) {
      // Minimaal 8 seconden tussen calls
      const sindsLaatste = Date.now() - _tdCallTimes[_tdCallTimes.length - 1];
      if (sindsLaatste < 8000) await new Promise(r => setTimeout(r, 8000 - sindsLaatste));
    }
    _tdCallTimes.push(Date.now());
    resolve();
  }));
  return _tdQueue;
}

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

    // Twelve Data voor US real-time symbolen
    if (TWELVE_DATA_SYMBOLS.has(symbol)) {
      const now = Date.now();
      const recent = _tdCallTimes.filter(t => now - t < 60000).length;
      console.log(`[TD] call aangevraagd: ${symbol} | credits deze minuut (voor call): ${recent} | route: ${req.headers.referer || 'onbekend'}`);
      await tdRateLimit();
      const tdIntervalMap = { '5m':'5min', '15m':'15min', '1h':'1h', '1d':'1day' };
      const tdInterval = tdIntervalMap[interval] || '15min';
      const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${tdInterval}&format=JSON&outputsize=100&timezone=UTC&apikey=${TWELVE_DATA_KEY}`;
      console.log('Fetching TD:', symbol, tdInterval);
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      if (!response.ok) throw new Error(`Twelve Data returned ${response.status}`);
      const data = await response.json();
      if (data.status === 'error') throw new Error('Twelve Data: ' + (data.message || 'onbekende fout'));
      const values = (data.values || []).slice().reverse(); // newest-first → oldest-first
      const quotes = values.map(v => ({
        date: new Date(v.datetime.replace(' ', 'T') + 'Z').toISOString(),
        open:   +parseFloat(v.open).toFixed(4),
        high:   +parseFloat(v.high).toFixed(4),
        low:    +parseFloat(v.low).toFixed(4),
        close:  +parseFloat(v.close).toFixed(4),
        volume: parseInt(v.volume) || 0,
      })).filter(q => q.open && q.close && q.high && q.low);
      if (quotes.length === 0) {
        return res.json({ symbol, interval, quotes: [], meta: { currency: 'USD', source: 'twelvedata' }, bericht: 'Geen data van Twelve Data.' });
      }
      return res.json({ symbol, interval, meta: { currency: 'USD', source: 'twelvedata' }, quotes });
    }

    const intervalMap = {
      '5m':  { interval: '5m',  range: '1d' },
      '15m': { interval: '15m', range: '2d' },
      '1h':  { interval: '1h',  range: '5d' },
      '1d':  { interval: '1d',  range: '3mo' },
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

// GET /api/news/briefing — pre-market overzicht: nieuws gegroepeerd per symbool met score
app.get('/api/news/briefing', async (req, res) => {
  const alleSymbolen = ['NVDA','AMD','META','NFLX','AMAT','PYPL','LMT','ASML','ASML.AS','ADYEN.AS','RHM.DE'];
  const categorieHeadlines = await haalCategorieNieuwsOp();
  const briefing = {};
  for (const sym of alleSymbolen) {
    const symKeywords = SYMBOOL_KEYWORDS[sym] || [];
    const alleKeywords = [...symKeywords, ...MACRO_KEYWORDS];
    // Yahoo per-symbool
    const yahooH = await haalNieuwsOp(sym);
    // Filter categorie op keywords
    const catH = categorieHeadlines.filter(h =>
      symKeywords.some(kw => h.toLowerCase().includes(kw))
    );
    const alleH = [...new Set([...yahooH, ...catH])].slice(0, 8);
    if (alleH.length > 0) {
      briefing[sym] = {
        headlines: alleH,
        score: alleH.length, // simpele relevantiescore
        bullish: alleH.filter(h => /upgrad|deal|partner|contract|record|beat|surge|jump|rally|win|award/i.test(h)).length,
        bearish: alleH.filter(h => /downgrad|miss|cut|fine|ban|tariff|sanction|probe|lawsuit|recall|crash/i.test(h)).length,
      };
    }
  }
  res.json(briefing);
});

// GET /api/news/watchlist — headlines per US symbool (gebruikt cache, geen extra credits)
app.get('/api/news/watchlist', async (req, res) => {
  const result = {};
  for (const sym of TWELVE_DATA_SYMBOLS) {
    result[sym] = await haalNieuwsOp(sym);
  }
  res.json(result);
});

// POST /api/trades/save  — sla afgeronde trade op in historyapp.post('/api/trades/save', (req, res) => {
  const { symbol, resultaat, winst, entry, stop_loss, target, rsi, signaal, tijdstip, datum, label } = req.body;
  if (!symbol || !resultaat) return res.status(400).json({ error: 'symbol en resultaat zijn verplicht' });
  tradeHistory.unshift({ symbol, resultaat, winst, entry, stop_loss, target, rsi, signaal, tijdstip, datum, label, opgeslagenOm: new Date().toISOString() });
  if (tradeHistory.length > MAX_HISTORY) tradeHistory.length = MAX_HISTORY;
  console.log(`Trade opgeslagen: ${symbol} ${resultaat} €${winst} (history: ${tradeHistory.length})`);
  res.json({ ok: true, count: tradeHistory.length });
});

// POST /api/analyze  — body: { symbol, interval, quotes, indicators }
app.post('/api/analyze', async (req, res) => {
  try {
    const { symbol, interval, quotes, indicators } = req.body;

    // Haal nieuws en trade history parallel op
    const [headlines, symHistory] = await Promise.all([
      haalNieuwsOp(symbol),
      Promise.resolve(tradeHistory.filter(t => t.symbol === symbol).slice(0, 10))
    ]);

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'ANTHROPIC_API_KEY is niet ingesteld op de server.' });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const recent = quotes.slice(-10).map(q => ({
      date: q.date,
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume || 0
    }));
    const last   = recent[recent.length - 1];

    const gemVolume = quotes.slice(-20)
      .reduce((sum, q) => sum + (q.volume || 0), 0) / 20;
    const lastVolume = quotes[quotes.length-1].volume || 0;
    const volumeRatio = indicators.volumeRatio != null
      ? indicators.volumeRatio
      : gemVolume > 0
        ? (lastVolume / gemVolume).toFixed(2)
        : 'onbekend';

    const dagHoog = Math.max(...quotes.map(q => q.high));
    const dagLaag = Math.min(...quotes.map(q => q.low));
    const vorigeSlot = quotes.length > 1 ? quotes[0].close : null;
    const dagRange = dagHoog - dagLaag;
    const rangePct = dagRange > 0 ? (dagRange / dagLaag * 100).toFixed(2) : '0.00';
    const positieInRange = dagRange > 0
      ? Math.round((last.close - dagLaag) / dagRange * 100)
      : 50;

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
      'META': 'Social media/AI. Hoge dagrange $8-15. Sterk gecorreleerd met tech sentiment. Min vertrouwen: 55%.',
      'NFLX': 'Streaming. Volatiel rond earnings. Dagrange $8-20. Min vertrouwen: 60%.',
      'AMD':  'Chips/AI. Volgt NVDA sterk. Dagrange $3-6. Min vertrouwen: 55%.',
      'AMAT': 'Applied Materials. Chip equipment. Volgt ASML/NVDA. Dagrange $3-7. Min vertrouwen: 60%.',
      'PYPL': 'PayPal. Fintech. Gevoelig voor rente. Dagrange $2-4. Min vertrouwen: 60%.',
      'LMT':  'Lockheed Martin. Defensie. Stijgt bij geopolitiek nieuws. Dagrange $5-10. Min vertrouwen: 65%.',
      'ASML': 'ASML US NASDAQ listing. Chip equipment leider. Volgt ASML.AS. Dagrange $10-25. Min vertrouwen: 60%.',
    };
    const isEuropees = ['ASML.AS','ADYEN.AS','RHM.DE'].includes(symbol);
    const handelVenster = isEuropees ? '09:00-17:30' : '15:30-22:00';
    const marktContext = isEuropees
      ? `Europese markt: ${handelVenster} NL tijd`
      : `Amerikaanse markt (NYSE/NASDAQ): ${handelVenster} NL tijd. \
     De Europese beurzen zijn gesloten maar de Amerikaanse \
     markt is OPEN tot 22:00 NL tijd. \
     Geef gewoon een normaal daytrade advies \
     voor de resterende handelstijd.`;
    const binnenVenster = (() => {
      const [open, sluit] = handelVenster.split('-');
      const [oH, oM] = open.split(':').map(Number);
      const [sH, sM] = sluit.split(':').map(Number);
      const nlUur = parseInt(amsterdamTijd.split(':')[0]);
      const nlMin = parseInt(amsterdamTijd.split(':')[1]);
      const nuMin = nlUur * 60 + nlMin;
      return nuMin >= oH * 60 + oM && nuMin < sH * 60 + sM;
    })();
    const prompt = `Elite daytrader analyse voor ${symbol}.
Tijd: ${amsterdamTijd} | Markt: ${marktContext}
MARKT CONTEXT (AEX/NASDAQ):
- Huidige sentiment: Houd rekening met algemene markttrend
- Sector focus: Halfgeleiders (ASML/AMD/NVDA) bewegen vaak synchroon.
KOERS & DAG:
Prijs: €${fmt(last.close)} | Gap: ${openingGap || 0}%
Dag range: €${dagLaag} - €${dagHoog} (€${dagRange.toFixed(0)}, ${rangePct}%)
Positie in range: ${positieInRange}% ${Number(positieInRange) < 25 ? '← DICHT BIJ DAGLAAG' : Number(positieInRange) > 75 ? '← DICHT BIJ DAGHOOG' : ''}
INDICATOREN:
RSI: ${fmt(indicators.rsi)} (${indicators.rsiTrend || '?'}) ${Number(indicators.rsi) < 40 ? '← OVERSOLD ✅' : Number(indicators.rsi) > 65 ? '← OVERBOUGHT ❌' : '← neutraal'}
MACD histogram: ${fmt(indicators.macd?.histogram, 4)} (${indicators.macdRichting || '?'}) ${indicators.macd?.histogram > 0 ? '← bullish' : '← bearish'}
Bollinger: L=${fmt(indicators.bb?.lower)} M=${fmt(indicators.bb?.middle)} U=${fmt(indicators.bb?.upper)}
Koers vs BB: ${Number(last.close) < Number(indicators.bb?.lower) ? '← ONDER lower ✅ KOOP SIGNAAL' : Number(last.close) > Number(indicators.bb?.upper) ? '← BOVEN upper ❌' : '← binnen bands'}
VOLUME: ${volumeRatio}x gemiddeld ${Number(volumeRatio) > 1.5 ? '← HOOG ✅' : Number(volumeRatio) < 0.3 ? '← LAAG ⚠️' : ''}
LAATSTE 5 KAARSEN:
${recent.slice(-5).map(q => {
  const d = new Date(q.date);
  const t = d.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Amsterdam'});
  return t+': '+fmt(q.open)+' → '+fmt(q.close)+' (H:'+fmt(q.high)+' L:'+fmt(q.low)+') '+(q.close>=q.open?'🟢':'🔴');
}).join('\n')}
TRADING PROFIEL: Scalper. Risico per trade: max €70 (10 aandelen). Dagdoel: €350. Gebruik strakke stops net onder de laatste 15m low.
KOOP CRITERIA:
✓ OVERSOLD BOUNCE: RSI < 40 EN prijs toont bodemvorming → KOOP NU.
✓ MOMENTUM BREAKOUT: RSI 44-58 EN RSI STIJGEND EN MACD histogram STIJGEND EN volume > 1.2x → KOOP NU (entry = huidige prijs). Dit vangt stijgingen zoals RHM.DE van 1374→1387.
✓ BOLLINGER SQUEEZE: Prijs onder Middle Bollinger Band met RSI STIJGEND → KOOP NU.
✓ Target > 1% boven huidige koers vereist voor KOOP. Bij momentum breakout mag 0.8% als dagrange groot genoeg is.
✓ Accepteer Risk/Reward van 1:1 voor snelle scalp-trades.
✓ GEEN koop bij sterke downtrend (Lower Highs/Lower Lows) of RSI DALEND zonder bodemvorming.
STOP-LOSS REGELS:
- Maximaal €70 totaalrisico op 10 aandelen (= max €7 per aandeel voor EU; max 0.6% voor US stocks)
- Plaats stop net onder de laagste 15-minuten candle van het laatste uur
- Stop moet buiten normale dagvolatiliteit liggen
TARGET REGELS:
- Voor aandelen onder €300: minimaal 2% boven entry
- Voor aandelen boven €300: minimaal 1.5% boven entry
- Target realistisch binnen dagrange; bij snelle scalp mag target kleiner zijn
- Voorkeur R/R ≥ 2.5 maar accepteer 1.2 als entry-kans groot is.
- WACHT alleen als er werkelijk geen koopmoment is vandaag.
Als WACHT: geef CONCREET aan bij welke prijs/conditie je WEL zou kopen.
Geen vage antwoorden - altijd een concreet level noemen.
${headlines.length > 0 ? `RECENT NIEUWS (${symbol}):
${headlines.map((h, i) => `${i+1}. ${h}`).join('\n')}
Laat dit meewegen in je sentiment en nieuws_samenvatting.` : ''}
${symHistory.filter(t => t.resultaat !== 'gemist').length > 0 ? `EIGEN TRADE GESCHIEDENIS ${symbol} (leer hiervan):
${symHistory.filter(t => t.resultaat !== 'gemist').map(t => {
  const icoon = t.resultaat === 'target_bereikt' ? '✅' : '🛑';
  return `${icoon} ${t.datum||''} ${t.tijdstip||''}: entry ${t.entry}, RSI ${t.rsi||'?'} → ${t.resultaat} (${t.winst >= 0 ? '+' : ''}€${t.winst})`;
}).join('\n')}
Win rate: ${symHistory.filter(t=>t.resultaat==='target_bereikt').length}/${symHistory.filter(t=>t.resultaat!=='gemist').length} trades succesvol.` : ''}
${symHistory.filter(t => t.resultaat === 'gemist').length > 0 ? `GEMISTE KANSEN ${symbol} (WACHT gegeven, koers bewoog toch):
${symHistory.filter(t => t.resultaat === 'gemist').slice(0,5).map(t =>
  `⚠️ ${t.datum||''} ${t.tijdstip||''}: RSI ${t.rsi||'?'} (${t.rsiTrend||'?'}), MACD ${t.macdRichting||'?'} → koers ging ${t.winst > 0 ? '+' : ''}${t.winst}% ${t.richting||''}`
).join('\n')}
Leer hiervan: bij welke RSI/MACD combinatie had je WEL moeten kopen?` : ''}
Reageer ALLEEN met dit JSON:
{
  "signaal": "KOOP" als je nu of bij een specifieke prijs zou kopen. "WACHT" alleen als er geen enkel koopmoment is vandaag.
  "actie": "KOOP NU" of "KOOP BIJ DALING NAAR [prijs]",
  BELANGRIJK: Als je "KOOP BIJ DALING NAAR [prijs]" geeft, gebruik dan signaal="KOOP" en vul entry in met die prijs. Nooit signaal="WACHT" combineren met een KOOP actie.
  "vertrouwen": 0-100,
  "redenering": "max 2 zinnen met exacte prijzen",
  "entry": getal of null,
  "stop_loss": getal of null,
  "target": getal of null,
  "rr_ratio": getal of null,
  "instap_conditie": "exacte conditie voor instap",
  "weerstand": getal,
  "steun": getal,
  "nieuws_samenvatting": "Analyse puur technisch",
  "nieuws_sentiment": "NEUTRAAL"
}`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = message.content.find(b => b.type === 'text');
    if (!textBlock) throw new Error('AI gaf geen tekst terug');
    const match = textBlock.text.trim().match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('AI response:', textBlock.text.substring(0, 500));
      throw new Error('AI gaf geen valide JSON terug');
    }
    try {
      const parsed = JSON.parse(match[0]);
      // Validatie na JSON parse
      if (parsed.signaal === 'KOOP') {
        const entry = parseFloat(parsed.entry);

        // Minimum stop afstand op basis van prijs
        let minStopPct;
        if (entry > 1000) minStopPct = 0.988;      // 1.2%
        else if (entry > 500) minStopPct = 0.985;   // 1.5%
        else if (entry > 100) minStopPct = 0.982;   // 1.8%
        else minStopPct = 0.978;                     // 2.2%
        const minStop = +(entry * minStopPct).toFixed(2);
        const parsedStop = parseFloat(parsed.stop_loss);

        // Stop te hoog of te dichtbij
        if (!parsedStop || parsedStop >= entry ||
            parsedStop > minStop) {
          parsed.stop_loss = minStop;
        }

        // Target minimaal 2x risico
        const risico = entry - parsed.stop_loss;
        const minTarget = +(entry + risico * 2).toFixed(2);
        const parsedTarget = parseFloat(parsed.target);

        if (!parsedTarget || parsedTarget <= entry ||
            parsedTarget < minTarget) {
          parsed.target = minTarget;
        }

        parsed.rr_ratio = +(
          (parsed.target - entry) /
          (entry - parsed.stop_loss)
        ).toFixed(2);
      }
      // KOOP actie maar WACHT signaal - fix signaal + entry
      if (parsed.actie &&
          parsed.actie.toUpperCase().includes('KOOP') &&
          parsed.signaal === 'WACHT') {
        const m = parsed.actie.match(/[\d]+[,.]?[\d]*/);
        if (m) {
          parsed.entry = parseFloat(m[0].replace(',', '.'));
          parsed.signaal = 'KOOP';
          if (!parsed.stop_loss ||
              parseFloat(parsed.stop_loss) >= parsed.entry) {
            parsed.stop_loss = +(parsed.entry * 0.992).toFixed(2);
          }
          if (!parsed.target ||
              parseFloat(parsed.target) <= parsed.entry) {
            parsed.target = +(parsed.entry * 1.02).toFixed(2);
          }
        }
      }
      // Gemiste kans detectie: was vorige analyse WACHT en bewoog koers >0.8%?
      const vorige = lastAnalysePerSymbol[symbol];
      if (vorige && vorige.signaal === 'WACHT' && vorige.prijs) {
        const beweeg = ((last.close - vorige.prijs) / vorige.prijs) * 100;
        if (Math.abs(beweeg) > 0.8) {
          tradeHistory.unshift({
            symbol, label: symbol, resultaat: 'gemist',
            winst: +beweeg.toFixed(2), // % beweging als proxy
            entry: vorige.prijs, prijs_nu: last.close,
            rsi: vorige.rsi, rsiTrend: vorige.rsiTrend, macdRichting: vorige.macdRichting,
            tijdstip: vorige.tijdstip, datum: vorige.datum,
            richting: beweeg > 0 ? 'OMHOOG' : 'OMLAAG'
          });
          if (tradeHistory.length > MAX_HISTORY) tradeHistory.length = MAX_HISTORY;
          console.log(`Gemiste kans: ${symbol} WACHT gegeven, koers bewoog ${beweeg.toFixed(2)}%`);
        }
      }
      // Sla huidige analyse op voor volgende vergelijking
      lastAnalysePerSymbol[symbol] = {
        signaal: parsed.signaal, prijs: last.close,
        rsi: indicators.rsi, rsiTrend: indicators.rsiTrend, macdRichting: indicators.macdRichting,
        tijdstip: new Date().toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' }),
        datum: new Date().toLocaleDateString('nl-NL')
      };
      res.json(parsed);
    } catch(e) {
      console.error('JSON parse fout:', match[0].substring(0, 200));
      throw new Error('JSON kon niet geparsed worden: ' + e.message);
    }
  } catch (err) {
    console.error('Analyze error:', err.message);
    console.error('Analyze error stack:', err.stack);
    console.error('Symbol:', req.body?.symbol, 'Interval:', req.body?.interval);
    console.error('Quotes length:', quotes?.length);
    console.error('Last candle:', last);
    res.status(500).json({ error: err.message, details: err.stack?.split('\n')[1] });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Server listening on port ' + PORT);
});
