const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');

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
  'XOM':     ['exxon','xom','oil','crude','energy','opec','brent','wti','refinery','natural gas'],
  'RTX':     ['raytheon','rtx','defense','military','missile','radar','nato','pentagon','ukraine','patriot'],
  'GLD':     ['gold','goud','safe haven','inflation','fed','dollar','vix','crisis','war','tariff'],
  'AAPL':    ['apple','aapl','iphone','ipad','mac','app store','china','tariff','supply chain','tim cook'],
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
const TWELVE_DATA_SYMBOLS = new Set(['NVDA','AMD','META','NFLX','AMAT','PYPL','LMT','ASML','XOM','RTX','GLD','AAPL']);
const _tdCallTimes = [];
let _tdQueue = Promise.resolve(); // Serialiseert alle TD-calls: nooit gelijktijdig

// Cache: voorkomt dubbele TD-calls binnen 14 minuten voor hetzelfde symbool+interval
const _tdCache = new Map(); // key: "SYMBOL:interval" → { data, timestamp }
const TD_CACHE_MS = 14 * 60 * 1000; // 14 minuten (15m candle verandert toch niet vaker)

function tdCacheGet(symbol, interval) {
  const key = `${symbol}:${interval}`;
  const hit = _tdCache.get(key);
  if (hit && Date.now() - hit.timestamp < TD_CACHE_MS) {
    console.log(`[TD-cache] HIT ${symbol} ${interval} (${Math.round((Date.now()-hit.timestamp)/1000)}s oud) — TD-call gespaard`);
    return hit.data;
  }
  return null;
}
function tdCacheSet(symbol, interval, data) {
  _tdCache.set(`${symbol}:${interval}`, { data, timestamp: Date.now() });
}
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

    // Twelve Data voor US real-time symbolen (met Yahoo fallback bij kredietlimiet)
    if (TWELVE_DATA_SYMBOLS.has(symbol)) {
      // Controleer cache eerst — bespaart TD-credit als data recent genoeg is
      const cached = tdCacheGet(symbol, interval);
      if (cached) return res.json(cached);

      try {
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
        const values = (data.values || []).slice().reverse();
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
        const result = { symbol, interval, meta: { currency: 'USD', source: 'twelvedata' }, quotes };
        tdCacheSet(symbol, interval, result);
        return res.json(result);
      } catch (tdErr) {
        // TD faalde (credits op, timeout, etc.) — val terug op Yahoo Finance
        console.warn(`[TD-fallback] ${symbol} via Yahoo (TD fout: ${tdErr.message})`);
        // val door naar Yahoo-pad hieronder
      }
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
    const isUsFallback = TWELVE_DATA_SYMBOLS.has(symbol);
    if (isUsFallback) console.log(`[Yahoo-fallback] ${symbol} ${interval}: ${quotes.length} candles (15m vertraagd)`);
    res.json({ symbol, interval, meta: result.meta, quotes, bron: isUsFallback ? 'yahoo_fallback' : 'yahoo' });
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

// ── FEAR & GREED INDEX CACHE (CNN, gratis) ────────────────────────────────
let _fearGreedCache = null;
let _fearGreedTs = 0;
const FEAR_GREED_CACHE_MS = 30 * 60 * 1000; // 30 min

async function haalFearGreed() {
  if (_fearGreedCache && Date.now() - _fearGreedTs < FEAR_GREED_CACHE_MS) return _fearGreedCache;
  try {
    const url = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json',
                 'Referer': 'https://www.cnn.com/markets/fear-and-greed' },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error(`F&G returned ${r.status}`);
    const json = await r.json();
    const score = json?.fear_and_greed?.score;
    const rating = json?.fear_and_greed?.rating;
    if (score == null) throw new Error('Geen score in response');
    const result = { score: +score.toFixed(0), rating: rating || 'onbekend' };
    _fearGreedCache = result;
    _fearGreedTs = Date.now();
    console.log(`[F&G] score: ${result.score} (${result.rating})`);
    return result;
  } catch (err) {
    console.warn('[F&G] fout:', err.message);
    return _fearGreedCache || null;
  }
}

// ── MARKTCONTEXT CACHE (SPY/QQQ/VIX) ─────────────────────────────────────
let _marktContextCache = null;
let _marktContextTs = 0;
const MARKT_CACHE_MS = 14 * 60 * 1000;

async function haalMarktContext() {
  if (_marktContextCache && Date.now() - _marktContextTs < MARKT_CACHE_MS) {
    return _marktContextCache;
  }
  try {
    const symbolen = ['SPY', 'QQQ', '^VIX'];
    const resultaten = await Promise.all(symbolen.map(async sym => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=2d&includePrePost=false`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const r = data?.chart?.result?.[0];
        if (!r || !r.timestamp || r.timestamp.length < 2) return null;
        const closes = r.indicators?.quote?.[0]?.close;
        if (!closes) return null;
        const valid = closes.filter(c => c != null);
        if (valid.length < 2) return null;
        const gisteren = valid[valid.length - 2];
        const vandaag  = valid[valid.length - 1];
        const pct = +((vandaag - gisteren) / gisteren * 100).toFixed(2);
        return { sym, prijs: +vandaag.toFixed(2), pct };
      } catch {
        return null;
      }
    }));
    const spy  = resultaten.find(r => r?.sym === 'SPY');
    const qqq  = resultaten.find(r => r?.sym === 'QQQ');
    const vix  = resultaten.find(r => r?.sym === '^VIX');
    if (!spy && !qqq && !vix) return null;

    const vixWaarde = vix?.prijs ?? null;
    let regime = 'neutraal';
    if (vixWaarde !== null) {
      if (vixWaarde > 30) regime = 'hoge angst — defensief handelen, kleinere posities';
      else if (vixWaarde > 20) regime = 'verhoogde volatiliteit — let op plotse bewegingen';
      else regime = 'laag — trend-following werkt goed';
    }
    const ctx = {
      spy:   spy  ? `${spy.pct > 0 ? '+' : ''}${spy.pct}% ($${spy.prijs})`  : 'N/A',
      qqq:   qqq  ? `${qqq.pct > 0 ? '+' : ''}${qqq.pct}% ($${qqq.prijs})`  : 'N/A',
      vix:   vix  ? `${vix.prijs}`  : 'N/A',
      regime,
      spyPct: spy?.pct ?? null,
      qqqPct: qqq?.pct ?? null,
      vixWaarde,
    };
    _marktContextCache = ctx;
    _marktContextTs = Date.now();
    console.log(`[MarktCtx] SPY ${ctx.spy} | QQQ ${ctx.qqq} | VIX ${ctx.vix} → ${regime}`);
    return ctx;
  } catch (err) {
    console.warn('[MarktCtx] fout:', err.message);
    return null;
  }
}

// GET /api/marktcontext — SPY/QQQ/VIX marktregime + Fear&Greed
app.get('/api/marktcontext', async (req, res) => {
  const [ctx, fg] = await Promise.all([haalMarktContext(), haalFearGreed()]);
  if (!ctx) return res.status(503).json({ error: 'Marktcontext niet beschikbaar' });
  res.json({ ...ctx, fearGreed: fg });
});

// ── PRE-MARKET DATA CACHE (Yahoo Finance v7, gratis, geen API key) ─────────
let _preMarketCache = null;
let _preMarketTs = 0;
const PREMARKET_CACHE_MS = 5 * 60 * 1000; // 5 minuten

const PREMARKET_SYMBOLS = ['AAPL','META','NVDA','AMD','AMAT','ASML','NFLX','PYPL','LMT','XOM','RTX','GLD'];

async function haalPreMarketData() {
  if (_preMarketCache && Date.now() - _preMarketTs < PREMARKET_CACHE_MS) {
    return _preMarketCache;
  }
  try {
    const syms = PREMARKET_SYMBOLS.join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${syms}&fields=preMarketPrice,preMarketChangePercent,preMarketVolume,regularMarketVolume,averageDailyVolume3Month,regularMarketPreviousClose`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`Yahoo v7 returned ${resp.status}`);
    const json = await resp.json();
    const quotes = json?.quoteResponse?.result || [];
    const result = {};
    for (const q of quotes) {
      const sym = q.symbol;
      const pmPct = q.preMarketChangePercent;
      const pmPrijs = q.preMarketPrice;
      const pmVol = q.preMarketVolume;
      const dagVol = q.averageDailyVolume3Month || q.regularMarketVolume;
      // Pre-market volume als % van gemiddeld dagvolume
      const pmVolPct = (pmVol && dagVol) ? +(pmVol / dagVol * 100).toFixed(1) : null;
      result[sym] = {
        preMarketPrijs: pmPrijs ? +pmPrijs.toFixed(2) : null,
        preMarketPct: pmPct ? +pmPct.toFixed(2) : null,
        preMarketVolume: pmVol || null,
        preMarketVolPct: pmVolPct, // bijv. 12.3 = 12.3% van gem. dagvolume
        vorigeSlot: q.regularMarketPreviousClose ? +q.regularMarketPreviousClose.toFixed(2) : null,
      };
    }
    _preMarketCache = result;
    _preMarketTs = Date.now();
    console.log(`[PreMarket] Geladen: ${Object.keys(result).join(', ')}`);
    return result;
  } catch (err) {
    console.warn('[PreMarket] Fout:', err.message);
    return _preMarketCache || {}; // geef stale cache terug bij fout
  }
}

// GET /api/premarket — pre-market koers, gap, volume voor alle US symbolen
app.get('/api/premarket', async (req, res) => {
  const data = await haalPreMarketData();
  res.json(data);
});

// GET /api/ochtendselect — dagelijkse top-5 symboolselectie op basis van nieuws + marktregime
app.get('/api/ochtendselect', async (req, res) => {
  try {
    // Alleen US symbols met realtime data — geen EU (15-min vertraging)
    const EU_SYMS = ['ASML.AS','ADYEN.AS','RHM.DE'];
    const ALLE_SYMBOLEN = ['NVDA','AMD','AMAT','ASML','META','NFLX','PYPL','LMT','XOM','RTX','GLD','AAPL'];
    const marktCtx = await haalMarktContext();
    const categorieHeadlines = await haalCategorieNieuwsOp();

    const scores = await Promise.all(ALLE_SYMBOLEN.map(async sym => {
      const keywords = SYMBOOL_KEYWORDS[sym] || [];
      const yahooH  = await haalNieuwsOp(sym);
      const catH    = categorieHeadlines.filter(h =>
        keywords.some(kw => h.toLowerCase().includes(kw))
      );
      const nieuwsScore = Math.min(10, yahooH.length * 2 + catH.length);

      // Negatief nieuws-signaal: waarschuwingskeywords verlagen score direct
      const allHeadlines = [...yahooH, ...catH].join(' ').toLowerCase();
      const risicoKeywords = ['earnings','results','warning','downgrade','miss','recall','fine','ban','lawsuit','probe','investigation'];
      const risicoTreffer = risicoKeywords.filter(k => allHeadlines.includes(k)).length;
      const risicoMalus = risicoTreffer * -2; // per risico-keyword -2 punt

      let regimeBonus = 0;
      const vix = marktCtx?.vixWaarde ?? 15;
      const spyPct = marktCtx?.spyPct ?? 0;
      const isDefense = ['LMT','RTX'].includes(sym);
      const isOlie    = sym === 'XOM';
      const isGoud    = sym === 'GLD';
      const isChips   = ['NVDA','AMD','AMAT','ASML'].includes(sym);
      const isConsumer= ['META','NFLX','PYPL'].includes(sym);

      if (vix > 25) {
        if (isDefense) regimeBonus += 4;
        if (isGoud)    regimeBonus += 4;
        if (isOlie)    regimeBonus += 3;
        if (isChips)   regimeBonus -= 2;
        if (isConsumer) regimeBonus -= 2;
      } else if (spyPct > 0.5) {
        if (isChips)   regimeBonus += 3;
        if (sym === 'AAPL') regimeBonus += 2;
        if (isConsumer) regimeBonus += 2;
        if (isGoud)    regimeBonus -= 1;
      } else if (spyPct < -0.5) {
        if (isDefense) regimeBonus += 3;
        if (isGoud)    regimeBonus += 3;
        if (isOlie)    regimeBonus += 2;
      }

      const totaal = nieuwsScore + regimeBonus + risicoMalus;
      return { sym, nieuwsScore, regimeBonus, risicoMalus, totaal,
               headlines: [...new Set([...yahooH, ...catH])].slice(0, 3) };
    }));

    scores.sort((a, b) => b.totaal - a.totaal);
    const top8 = scores.slice(0, 8); // stuur top 8 naar Claude, die kiest top 5

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const promptTekst = `Dagselectie voor US day trader. Vandaag: ${new Date().toLocaleDateString('nl-NL')}.
Marktregime: SPY ${marktCtx?.spy || 'N/A'} | QQQ ${marktCtx?.qqq || 'N/A'} | VIX ${marktCtx?.vix || 'N/A'} → ${marktCtx?.regime || 'onbekend'}

Kandidaten (score = nieuws + marktregime - risicomalus):
${top8.map(s => `${s.sym} (score ${s.totaal}): ${s.headlines.slice(0,2).join(' | ') || 'geen nieuws'}`).join('\n')}

REGELS:
- Kies MAX 5 symbolen voor top5
- Een symbool mag NIET in zowel top5 als vermijd staan
- Sluit uit bij earnings-risico, downgrade, of fundamentele waarschuwing vandaag
- Geef voorkeur aan symbolen met momentum EN geen risico-nieuws
- Alle gekozen symbolen zijn US stocks met realtime data

Reageer ALLEEN met dit JSON (geen uitleg erbuiten):
{
  "thema": "één zin: wat is het thema vandaag",
  "top5": ["SYM1","SYM2","SYM3","SYM4","SYM5"],
  "vermijd": ["SYM1","SYM2"],
  "reden": { "SYM1": "één zin waarom top5 of vermijd", ... },
  "max_trades": 3
}`;

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 500,
      messages: [{ role: 'user', content: promptTekst }]
    });
    const txt = msg.content.find(b => b.type === 'text')?.text || '';
    const match = txt.match(/\{[\s\S]*\}/);
    let parsed = match ? JSON.parse(match[0]) : null;

    // Validatie: verwijder uit top5 elk symbool dat ook in vermijd staat
    if (parsed) {
      const vermijdSet = new Set((parsed.vermijd || []).map(s => s.toUpperCase()));
      parsed.top5 = (parsed.top5 || [])
        .map(s => s.toUpperCase())
        .filter(s => !vermijdSet.has(s) && ALLE_SYMBOLEN.includes(s));
      parsed.vermijd = (parsed.vermijd || []).map(s => s.toUpperCase());
    }

    res.json({
      datum: new Date().toLocaleDateString('nl-NL'),
      marktRegime: marktCtx?.regime || 'onbekend',
      scores: top8,
      selectie: parsed,
    });
  } catch (err) {
    console.error('ochtendselect fout:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/watchlist — headlines per US symbool (gebruikt cache, geen extra credits)
app.get('/api/news/watchlist', async (req, res) => {
  const result = {};
  for (const sym of TWELVE_DATA_SYMBOLS) {
    result[sym] = await haalNieuwsOp(sym);
  }
  res.json(result);
});

// POST /api/trades/save  — sla afgeronde trade op in history
app.post('/api/trades/save', (req, res) => {
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
    const { symbol, interval, quotes, indicators, backtestTop } = req.body;
    // backtestTop: { naam: 'VWAP Bounce', winRate: 63, pnl: 450, trades: 22 } for this symbol

    // Haal nieuws, trade history, marktcontext, pre-market en Fear&Greed parallel op
    const [headlines, symHistory, marktCtx, preMarktAll, fearGreed] = await Promise.all([
      haalNieuwsOp(symbol),
      Promise.resolve(tradeHistory.filter(t => t.symbol === symbol).slice(0, 10)),
      haalMarktContext(),
      haalPreMarketData(),
      haalFearGreed(),
    ]);
    const preMarkt = preMarktAll[symbol] || null;

    // Sector sync: welke symbolen in dezelfde sector hebben ook een signaal?
    const CHIP_SYMBOLS = ['NVDA','AMD','AMAT','ASML','ASML.AS'];
    const FINTECH_SYMBOLS = ['PYPL','ADYEN.AS'];
    const DEFENSE_SYMBOLS = ['LMT','RHM.DE'];
    const sectorGenoten = symbol === 'NFLX' || symbol === 'META' ? [] :
      (CHIP_SYMBOLS.includes(symbol) ? CHIP_SYMBOLS :
       FINTECH_SYMBOLS.includes(symbol) ? FINTECH_SYMBOLS :
       DEFENSE_SYMBOLS.includes(symbol) ? DEFENSE_SYMBOLS : [])
        .filter(s => s !== symbol && lastAnalysePerSymbol[s]);
    const sectorSyncRegel = sectorGenoten.length > 0
      ? `SECTOR SYNC (${symbol}):\n` + sectorGenoten.map(s => {
          const a = lastAnalysePerSymbol[s];
          return `${s}: ${a.signaal} | RSI ${a.rsi || '?'} (${a.rsiTrend || '?'}) | vertrouwen ${a.vertrouwen || '?'}%`;
        }).join('\n')
      : '';

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
      'XOM':  'ExxonMobil. Olie/energie. Stijgt bij geopolitieke spanning, OPEC-nieuws, olieprijs stijging. Dagrange $2-5. Min vertrouwen: 55%. Correlatie: stijgt als rest markt daalt bij crisis.',
      'RTX':  'Raytheon Technologies. Luchtverdediging, raketten. Stijgt bij oorlogsescalatie, NAVO-nieuws, Patriot-orders. Dagrange $3-7. Min vertrouwen: 60%.',
      'GLD':  'SPDR Gold ETF. Safe haven. Stijgt bij VIX >25, recessievrees, dollar-zwakte, crisis. Dagrange $2-5. Min vertrouwen: 55%. Laag volatiel maar betrouwbaar trending.',
      'AAPL': 'Apple. Enorm volume. Beweegt sterk op tariefnieuws (China supply chain), iPhone sales, App Store regelgeving. Dagrange $3-8. Min vertrouwen: 55%.',
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
    const intradayPct = indicators.intradayPct;
    const lhll = indicators.lhll;
    const intradayWaarschuwing = intradayPct !== null && intradayPct !== undefined
      ? (intradayPct < -1.5
          ? `⚠️ DALENDE DAG: ${intradayPct}% onder openingskoers — bij downtrend WACHT tenzij duidelijke bodem`
          : intradayPct > 1.5
            ? `✅ STIJGENDE DAG: +${intradayPct}% boven openingskoers`
            : `Neutraal: ${intradayPct}% t.o.v. open`)
      : '';
    const isUS = !symbol.includes('.');
    const marktContextRegel = marktCtx
      ? `MARKTREGIME (SPY/QQQ/VIX):
SPY: ${marktCtx.spy} | QQQ: ${marktCtx.qqq} | VIX: ${marktCtx.vix}
Regime: ${marktCtx.regime}
${marktCtx.vixWaarde > 30 ? '⚠️ HOGE ANGST (VIX>30): verlaag positiegrootte, wijd stops, alleen STERKE signalen handelen' :
  marktCtx.vixWaarde > 20 ? '⚠️ VERHOOGDE VOLATILITEIT: extra bevestiging vereist voor instap' :
  marktCtx.spyPct < -1.0 ? '⚠️ MARKT DAALT: alleen handelen bij uitzonderlijk sterke relatieve kracht' :
  marktCtx.spyPct > 0.5 && marktCtx.qqqPct > 0.5 ? '✅ MARKT STIJGT: trend-following kansen groot, koop momentum breakouts' :
  'Neutraal marktklimaat'}`
      : '';

    // Gisteren's niveaus
    const gis = indicators.gisterenNiveaus;
    const gisterenRegel = gis
      ? `Gisteren: close ${fmt(gis.close)} | high ${fmt(gis.high)} | low ${fmt(gis.low)}`
      : '';
    // Opening Range Breakout
    const orb = indicators.openingRange;
    const orbRegel = orb
      ? `Opening Range: H=${fmt(orb.orHigh)} L=${fmt(orb.orLow)}${orb.breakoutBoven != null ? ` ✅ BREAKOUT BOVEN +${orb.breakoutBoven}%` : orb.breakoutOnder != null ? ` ❌ BREAKDOWN ONDER -${orb.breakoutOnder}%` : ' (binnen range)'}`
      : '';

    const prompt = `Elite daytrader analyse voor ${symbol}.
Tijd: ${amsterdamTijd} | Markt: ${marktContext}
${marktContextRegel}
${sectorSyncRegel}
INTRADAY SITUATIE:
${intradayWaarschuwing}
${lhll ? `❌ PATROON: ${lhll} — GEEN KOOP tegen de trend in` : ''}
KERNSTRATEGIE: Handel MET de trend. Koop momentum, geen dips in dalende aandelen.
✅ Trend-volgende koop: RSI STIJGEND + MACD STIJGEND + volume > 1.2x + koers boven vorige candle-high
✅ Pullback in uptrend: intraday > +0.5%, korte terugval naar support, RSI > 40 en stijgend → BESTE SETUP VAN DE DAG
✅ Eerste pullback na opening: aandeel gap-up open, eerste terugval naar VWAP of -1% van dagopen → KOOP bij VWAP aanraking
❌ Koop NOOIT: dalend aandeel (LH+LL), RSI < 45 EN dalend, MACD bearish, intradag < -1.5%
ANTI-CHASE REGEL: Als intradag al > +2.5% EN RSI > 75 → gebruik instap_type="pullback", NOOIT breakout. Het aandeel heeft al bewogen — wacht op de eerste dip terug naar VWAP of dagopen +1%.
Als intradag al > +3% → vertrouwen max 60%, want de meeste winst is al gemaakt.
KRITISCHE LEERREGEL: Sla een cyclus over als er geen duidelijk momentum is. Een gemiste kans is beter dan een verliesgevende trade.
Sector focus: Halfgeleiders (ASML/AMD/NVDA/AMAT) bewegen vaak synchroon. Relatieve kracht = goud.
${symbol === 'LMT' ? '⚠️ LMT WAARSCHUWING: Dit aandeel heeft weinig intraday beweging. Alleen handelen bij vertrouwen ≥75% EN duidelijk technisch signaal.' : ''}
${preMarkt && preMarkt.preMarketPct !== null ? `PRE-MARKET (voor 15:30 NL):
Gap: ${preMarkt.preMarketPct > 0 ? '+' : ''}${preMarkt.preMarketPct}% | Koers: $${preMarkt.preMarketPrijs || 'N/A'}${preMarkt.preMarketVolPct !== null ? ` | Volume: ${preMarkt.preMarketVolPct}% van gem. dagvolume` : ''}
${Math.abs(preMarkt.preMarketPct) > 2 ? `⚠️ GROTE PRE-MARKET GAP (${preMarkt.preMarketPct > 0 ? '+' : ''}${preMarkt.preMarketPct}%): verwacht hoge openingsvolatiliteit, wacht op prijsstabilisatie na open` : ''}
${preMarkt.preMarketVolPct !== null && preMarkt.preMarketVolPct > 15 ? `✅ HOOG PRE-MARKET VOLUME (${preMarkt.preMarketVolPct}%): sterke institutionele interesse vóór open` : ''}
${preMarkt.preMarketPct > 1 ? '✅ BULLISH PRE-MARKET: kans op gap-and-go bij hoge volume, maar wacht op consolidatie na open' : preMarkt.preMarketPct < -1 ? '❌ BEARISH PRE-MARKET: gap-down verwacht, wacht op bodem-vorming voor koop' : '— Neutraal pre-market'}` : ''}
KOERS & DAG:
Prijs: €${fmt(last.close)} | Gap: ${openingGap || 0}% | Intraday: ${intradayPct !== null ? intradayPct + '%' : 'N/A'} t.o.v. open
Dag range: €${dagLaag} - €${dagHoog} (€${dagRange.toFixed(0)}, ${rangePct}%)
Positie in range: ${positieInRange}% ${Number(positieInRange) < 25 ? '← DICHT BIJ DAGLAAG' : Number(positieInRange) > 75 ? '← DICHT BIJ DAGHOOG' : ''}
INDICATOREN:
RSI: ${fmt(indicators.rsi)} (${indicators.rsiTrend || '?'}) ${Number(indicators.rsi) > 55 && indicators.rsiTrend === 'STIJGEND' ? '← MOMENTUM ✅' : Number(indicators.rsi) < 40 ? '← OVERSOLD ⚠️ (alleen kopen als RSI nu omhoog draait)' : Number(indicators.rsi) > 65 ? '← OVERBOUGHT ❌' : '← neutraal'}
MACD histogram: ${fmt(indicators.macd?.histogram, 4)} (${indicators.macdRichting || '?'}) ${indicators.macd?.histogram > 0 && indicators.macdRichting === 'STIJGEND' ? '← bullish momentum ✅' : indicators.macd?.histogram > 0 ? '← bullish' : '← bearish'}
Bollinger: L=${fmt(indicators.bb?.lower)} M=${fmt(indicators.bb?.middle)} U=${fmt(indicators.bb?.upper)}
Koers vs BB: ${Number(last.close) < Number(indicators.bb?.lower) ? '← ONDER lower (wacht op terugkeer boven lower, dan koop)' : Number(last.close) > Number(indicators.bb?.upper) ? '← BOVEN upper ❌ uitgestrektheid' : '← binnen bands'}
VOLUME: ${volumeRatio}x gemiddeld ${Number(volumeRatio) > 1.5 ? '← HOOG ✅ momentum bevestigd' : Number(volumeRatio) < 0.3 ? '← LAAG ⚠️ geen momentum' : ''}
LAATSTE 5 KAARSEN:
${recent.slice(-5).map(q => {
  const d = new Date(q.date);
  const t = d.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Amsterdam'});
  return t+': '+fmt(q.open)+' → '+fmt(q.close)+' (H:'+fmt(q.high)+' L:'+fmt(q.low)+') '+(q.close>=q.open?'🟢':'🔴');
}).join('\n')}
ATR (15m, 14 periodes): ${indicators.atr ? fmt(indicators.atr) : 'N/A'} ${indicators.atr ? `← normale candle-beweging = €${fmt(indicators.atr)}` : ''}
VWAP: ${indicators.vwap ? fmt(indicators.vwap) : 'N/A'} | Koers ${indicators.vwapPositie || 'N/A'} VWAP ${indicators.vwapPositie === 'BOVEN' ? '✅ bulls in control' : indicators.vwapPositie === 'ONDER' ? '❌ bears in control' : ''}
${orbRegel}
${gisterenRegel}
MOMENTUM SCORE: ${indicators.momentumScore != null ? indicators.momentumScore + '/10' : 'N/A'} ${indicators.momentumScore >= 7 ? '✅ STERKE MOMENTUM' : indicators.momentumScore >= 5 ? '— matig' : indicators.momentumScore != null ? '❌ ZWAKKE MOMENTUM' : ''}
${indicators.adx != null ? `ADX (trendsterkte): ${indicators.adx} ${indicators.adx > 30 ? '✅ STERKE TREND — koop breakouts en momentum' : indicators.adx > 20 ? '— matige trend' : '❌ ZIJWAARTS (<20) — vermijd breakouts, handel alleen VWAP-bounces'}` : ''}
${indicators.mfi != null ? `MFI (volume-momentum): ${indicators.mfi} ${indicators.mfi > 70 ? '⚠️ OVERBOUGHT — mogelijk distributie' : indicators.mfi < 30 ? '✅ OVERSOLD met volume — accumulatie kans' : indicators.mfi > 55 ? '✅ Bullish geldstroom' : '— neutraal'}` : ''}
${indicators.stochRSI != null ? `Stochastic RSI: ${indicators.stochRSI} ${indicators.stochRSI > 80 ? '⚠️ OVERBOUGHT' : indicators.stochRSI < 20 ? '✅ OVERSOLD — koop bij draai omhoog' : indicators.stochRSI > 50 ? '— bullish' : '— bearish'}` : ''}
${fearGreed ? `FEAR & GREED INDEX: ${fearGreed.score}/100 (${fearGreed.rating}) ${fearGreed.score < 25 ? '💀 EXTREME ANGST — contra-trend kansen, maar wacht op technische bevestiging' : fearGreed.score < 45 ? '😨 ANGST — markt onderschat kansen, bullish bias' : fearGreed.score > 75 ? '🤑 EXTREME HEBZUCHT — markt overbought, wees voorzichtiger met targets' : fearGreed.score > 55 ? '😏 HEBZUCHT — momentum werkt, blijf trend volgen' : '😐 NEUTRAAL'}` : ''}
${indicators.rsiDivergentie ? `⚡ RSI DIVERGENTIE: ${indicators.rsiDivergentie}` : ''}
${indicators.candlePatroon ? `🕯 CANDLE PATROON: ${indicators.candlePatroon}` : ''}
${indicators.relKracht != null ? `📊 RELATIEVE KRACHT vs SPY: ${indicators.relKracht}x ${indicators.relKracht > 1.5 ? '✅ OUTPERFORMER — koop de leider' : indicators.relKracht < 0.5 ? '⚠️ ACHTERBLIJVER — vermijd of wacht' : '— neutraal'}` : ''}
${backtestTop ? `📈 BACKTEST (60 dagen historisch, dit symbool): Beste strategie = "${backtestTop.naam}" met ${backtestTop.winRate}% winrate (${backtestTop.trades} trades, €${backtestTop.pnl > 0 ? '+' : ''}${backtestTop.pnl} netto). INSTRUCTIE: Zoek actief naar een "${backtestTop.naam}" setup. Als de huidige situatie past bij deze strategie, verhoog vertrouwen met 5-10%. Als de situatie TEGEN deze strategie ingaat, noteer dat expliciet.` : ''}
TRADING PROFIEL: Agressieve day trader. Budget €10.000. Weekdoel: €1000 netto. Variabel risico op setup-kwaliteit:
  Platinum setup (vertrouwen ≥85%): €200 risico → potentieel €500 per trade (2.5:1 R:R)
  Gold setup (vertrouwen 70-84%): €150 risico → potentieel €375 per trade (2.5:1 R:R)
  Standaard (vertrouwen 50-69%): €100 risico → potentieel €250 per trade (2.5:1 R:R)
  Onder 50% vertrouwen: GEEN trade.
Geef je vertrouwen eerlijk maar NIET te conservatief: bij een duidelijke setup mag je 60-70% geven ook als niet alle criteria groen zijn.
${marktCtx && marktCtx.spyPct > 0.5 ? `🟢 BULL DAG (SPY +${marktCtx.spyPct}%): In een stijgende markt ZOEK je actief naar instap-momenten. Trend-following werkt. Geef momentum-setups minimaal 55% vertrouwen als richting klopt. Wacht NIET op perfecte setup — een goede setup is genoeg.` : marktCtx && marktCtx.spyPct < -0.5 ? `🔴 BEAR DAG (SPY ${marktCtx.spyPct}%): Alleen handelen bij uitzonderlijk sterke relatieve kracht. Drempel hogere vertrouwen.` : ''}
KOOP CRITERIA — vertrouwen stijgt met elk extra bevestigingssignaal:
✓ PLATINUM SETUP (vertrouwen 85%+): ORB BREAKOUT + BOVEN VWAP + momentum score ≥7 + RSI STIJGEND + sector sync groen + relKracht > 1.5
✓ GOLD SETUP (vertrouwen 70-85%): BOVEN VWAP + RSI > 50 STIJGEND + MACD STIJGEND + momentum score ≥6 + volume > 1.2x
✓ STANDAARD SETUP (vertrouwen 55-70%): RSI STIJGEND + MACD positief + koers boven VWAP OF aan VWAP-support + momentum ≥4
✓ VWAP BREAKOUT (vertrouwen 55%+): koers net BOVEN VWAP + RSI STIJGEND + volume > 1.2x
✓ PULLBACK NAAR VWAP: koers daalt naar VWAP als support, RSI > 40 STIJGEND, geen LH+LL → KOOP bij VWAP aanraking
✓ BULLISH DIVERGENTIE + HAMMER/ENGULFING aan support of VWAP → KOOP NU
✓ BREAKOUT boven gisteren high (${gis ? fmt(gis.high) : 'N/A'}) met volume > 1.2x → sterke dagtrend
STEUN/WEERSTAND NIVEAUS (gebruik als entry/stop/target):
- Gisteren high: ${gis ? fmt(gis.high) : 'N/A'} (weerstand → doorbraak = bullish)
- Gisteren close: ${gis ? fmt(gis.close) : 'N/A'} (steun/weerstand)
- Gisteren low: ${gis ? fmt(gis.low) : 'N/A'} (steun)
- VWAP: ${indicators.vwap ? fmt(indicators.vwap) : 'N/A'} (dynamisch steun/weerstand)
EXIT SIGNALEN (vertel dit ook in je redenering als je het ziet):
⚠️ BEARISH DIVERGENTIE: top in aantocht — bij open positie: verhoog stop, geen nieuwe instap
⚠️ SHOOTING STAR/BEARISH ENGULFING aan daghoog of weerstand: overweeg snelle exit
⚠️ momentum score daalt van hoog naar laag terwijl je in positie zit: trail stop
WACHT CRITERIA (alleen bij combinatie van negatieve signalen — niet bij één enkel signaal):
✗ Intradag < -2% EN momentum score < 3: duidelijk dalende dag, geen koop
✗ LH+LL patroon (4 candles) EN RSI DALEND: duidelijke downtrend
✗ RSI DALEND EN MACD DALEND EN koers ONDER VWAP: driedubbele zwakte
✗ relKracht < 0.3: echte achterblijver op een bull-dag
✗ RSI > 80 EN koers boven upper Bollinger: extreem overbought, geen nieuwe instap
✗ Koers ONDER VWAP EN momentum score < 5: bears in control
✗ Al 2 stops geraakt vandaag op dit symbool: dag is voorbij voor dit aandeel
✗ LMT zonder ≥75% vertrouwen: te weinig beweging voor rendabele trade
✗ VIX > 30 EN signaal < 70%: markt te onrustig voor lage-kans setup
STOP-LOSS REGELS:
- Minimale stop afstand: 1.2× ATR (≈ €${indicators.atr ? fmt(indicators.atr * 1.2) : '?'}) of minimaal 0.5% van entry
- Geen stop tighter dan ATR: PYPL $78 met ATR $0.80 → stop minimaal bij $77.04
- Plaats stop net onder de vorige 15m swing low MAAR minimaal 1.2× ATR van entry
- Doel: stop overleeft normale noise, niet direct geraakt bij eerste candle
TARGET REGELS:
- Minimaal 2.5× risico afstand (R:R ≥ 2.5:1) — voor consistent positief dagresultaat
- Voorbeeld: entry $78, stop $77.04 (risico $0.96) → target minimaal $80.40
- Bij sterke momentum (RSI STIJGEND, MACD STIJGEND, volume >1.5x): schaal target naar 3:1
- Bij VIX > 25 of rangy markt: hou 2.5:1 en neem winst vroeg
PROFESSIONELE DAYTRADING STRATEGIEËN (van SMB Capital / Warrior Trading):
1. GAP-AND-GO (hoogste winst-kans):
   Als pre-market gap > +1.5% MET volume > 10% dagvol → koop direct bij open of eerste terugval.
   Entry = huidige koers (direct). Stop = pre-market laag of 1 ATR onder VWAP. Target = gap-grootte.
   Signaal: instap_type="direct", vertrouwen automatisch +10% bij gap > +1.5%.
2. EERSTE PULLBACK na opening (tweede beste setup):
   Na opening gap omhoog, eerste dip terug naar VWAP of -0.5% van dagopen = KOOP.
   Dit is de meest betrouwbare intraday setup. RSI mag tijdelijk dalen naar 40-50 tijdens pullback.
   Gebruik instap_type="pullback" met entry = VWAP niveau.
3. VWAP BOUNCE (gedurende de dag):
   Prijs raakt VWAP van boven, stuitert omhoog + RSI draait van 45 naar boven = KOOP NU.
   instap_type="direct". Stop = VWAP - 1 ATR. Sterkste signaal als 2e of 3e VWAP-aanraking.
4. ORB BREAKOUT (Opening Range Breakout):
   Eerste 15-min candle high = ORB-niveau. Breakout erboven met volume > 1.5x = koop.
   instap_type="breakout" met entry = ORB high. Stop = ORB low.
ANTI-CHASE REGEL: Als aandeel al > +2.5% intradag → NOOIT breakout. Gebruik pullback of direct (bij VWAP).
VROEGE SESSIE REGEL: Vóór 15:45 NL (eerste 15 min) = weinig candles. Gebruik alleen GAP-AND-GO of EERSTE PULLBACK. Geen breakouts op basis van onvoldoende data.
ACHTERBLIJVER BLOCKER: Als SPY >+1.5% intradag EN dit aandeel <-1% intradag → instap_type="geen_trade", vertrouwen max 40%.
INSTAP TYPE — verplicht in je JSON response (kies één):
  "direct"   → koers zit NU op het koop-niveau of VWAP-aanraking. Gebruik huidige koers als entry. Actie = "KOOP NU"
  "pullback" → wacht op DALING naar support/VWAP. Entry MOET lager zijn dan huidige koers.
  "breakout" → wacht op STIJGING door weerstand/ORB. Entry MOET hoger zijn dan huidige koers. ALLEEN bij intradag < +2.5%.
  "geen_trade" → vertrouwen <50%, ongunstige condities, achterblijver, of geen setup vandaag.
KRITISCHE FOUT — nooit zo doen:
  ❌ koers=601, entry=603, actie="KOOP BIJ DALING NAAR 603"  ← koers is al ONDER 603, er is geen daling!
  ✅ koers=601, entry=601, instap_type="direct", actie="KOOP NU"
  ✅ koers=601, entry=603, instap_type="breakout", actie="KOOP BIJ STIJGING NAAR 603"
  ✅ koers=601, entry=597, instap_type="pullback", actie="KOOP BIJ DALING NAAR 597"
WACHT alleen als er werkelijk geen koopmoment is vandaag.
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
  "signaal": "KOOP" of "WACHT",
  "instap_type": "direct" of "pullback" of "breakout" of "geen_trade",
  "actie": "KOOP NU" of "KOOP BIJ DALING NAAR [prijs]" of "KOOP BIJ STIJGING NAAR [prijs]" of "GEEN SETUP",
  "vertrouwen": 0-100,
  "redenering": "max 2 zinnen met exacte prijzen en reden van instap_type keuze",
  "entry": getal (huidige koers bij direct, lager bij pullback, hoger bij breakout) of null,
  "stop_loss": getal of null,
  "target": getal of null,
  "rr_ratio": getal of null,
  "instap_conditie": "exacte conditie voor instap",
  "weerstand": getal,
  "steun": getal,
  "nieuws_samenvatting": "max 1 zin",
  "nieuws_sentiment": "BULLISH" of "BEARISH" of "NEUTRAAL"
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
        const atr = indicators.atr ? parseFloat(indicators.atr) : null;

        // Minimum stop afstand: 1.2× ATR of 0.5% van entry
        const minStopAfstand = atr
          ? Math.max(atr * 1.2, entry * 0.005)
          : entry * 0.005;
        const minStop = +(entry - minStopAfstand).toFixed(2);
        const parsedStop = parseFloat(parsed.stop_loss);

        // Stop ontbreekt, te hoog, of te dicht bij entry
        if (!parsedStop || parsedStop >= entry || (entry - parsedStop) < minStopAfstand) {
          parsed.stop_loss = minStop;
        }

        // Target minimaal 2.5× risico
        const risico = entry - parsed.stop_loss;
        const minTarget = +(entry + risico * 2.5).toFixed(2);
        const parsedTarget = parseFloat(parsed.target);

        if (!parsedTarget || parsedTarget <= entry || parsedTarget < minTarget) {
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

      // ── V2.0: instap_type validatie & entry correctie ──────────────────────
      const huidigePrijs = last.close;

      // 1a. Gap-and-go boost: pre-market gap > 1.5% met volume → vertrouwen +10%, forceer direct als RSI niet overbought
      const pmData = preMarktAll[symbol];
      if (pmData && pmData.preMarketPct > 1.5 && parsed.signaal === 'KOOP') {
        if (indicators.rsi < 80) { // niet overbought
          parsed.vertrouwen = Math.min(100, (parsed.vertrouwen || 50) + 10);
          if (parsed.instap_type === 'breakout') {
            // Op een gap-up dag: direct kopen i.p.v. nog hogere breakout wachten
            parsed.instap_type = 'direct';
            console.log(`[Gap-and-go] ${symbol} gap +${pmData.preMarketPct}% → breakout→direct, vertrouwen +10%`);
          }
        }
      }

      // 1. Detecteer instap_type als AI het niet gegeven heeft
      if (!parsed.instap_type) {
        if (parsed.vertrouwen < 50 || parsed.signaal === 'WACHT') {
          parsed.instap_type = 'geen_trade';
        } else if (parsed.entry) {
          const gap = (parseFloat(parsed.entry) - huidigePrijs) / huidigePrijs;
          if (Math.abs(gap) <= 0.005) parsed.instap_type = 'direct';
          else if (gap < -0.005) parsed.instap_type = 'pullback';
          else parsed.instap_type = 'breakout';
        } else {
          parsed.instap_type = 'geen_trade';
        }
      }

      // 2. Achterblijver blocker: markt >+1.5% maar aandeel <-1% intradag (echte achterblijver)
      // Kleine negatieve beweging op een bull-dag kan consolidatie zijn vóór de volgende stijging
      const spyStijgt = marktCtx && marktCtx.spyPct > 1.5;
      const aandDaalt = intradayPct !== null && parseFloat(intradayPct) < -1.0;
      if (spyStijgt && aandDaalt) {
        parsed.instap_type = 'geen_trade';
        parsed.vertrouwen = Math.min(parsed.vertrouwen || 50, 40);
        parsed.signaal = 'WACHT';
        parsed.actie = 'GEEN SETUP';
        parsed.redenering = `Achterblijver: markt +${marktCtx.spyPct.toFixed(1)}% maar ${symbol} ${intradayPct}% intradag. Wacht op relative strength herstel.`;
      }

      // 2b. Anti-chase: als intradag al >2.5% EN het is een breakout setup → forceer pullback
      // Aandeel heeft al flink bewogen, niet verder chassen met hogere entry
      if (intradayPct !== null && parseFloat(intradayPct) > 2.5 &&
          parsed.instap_type === 'breakout') {
        parsed.instap_type = 'pullback';
        // Entry moet lager dan huidige koers (pullback naar VWAP of -1%)
        const vwapVal = indicators.vwap ? parseFloat(indicators.vwap) : null;
        const pullbackTarget = vwapVal ? vwapVal : +(huidigePrijs * 0.99).toFixed(2);
        parsed.entry = pullbackTarget;
        parsed.actie = `KOOP BIJ DALING NAAR ${pullbackTarget.toFixed(2)}`;
        parsed.redenering = `Anti-chase: aandeel al +${intradayPct}% intradag. Wacht op pullback naar VWAP (${pullbackTarget.toFixed(2)}) i.p.v. hogere breakout kopen.`;
        console.log(`[Anti-chase] ${symbol} +${intradayPct}% intradag, breakout→pullback bij ${pullbackTarget}`);
      }
      // Cap vertrouwen als aandeel al >3% bewogen (meeste winst al gemaakt)
      if (intradayPct !== null && parseFloat(intradayPct) > 3.0 && (parsed.vertrouwen || 0) > 60) {
        parsed.vertrouwen = Math.min(parsed.vertrouwen, 60);
      }

      // 3. Confidence enforcement: <50% → geen_trade
      if (parsed.vertrouwen < 50) {
        parsed.instap_type = 'geen_trade';
        parsed.signaal = 'WACHT';
        if (!parsed.actie || parsed.actie === 'KOOP NU') parsed.actie = 'GEEN SETUP';
      }

      // 4. Entry correctie: entry boven huidige koers maar GEEN breakout → dit is een fout
      if (parsed.instap_type !== 'geen_trade' && parsed.entry && parsed.signaal === 'KOOP') {
        const entryVal = parseFloat(parsed.entry);
        const gap = (entryVal - huidigePrijs) / huidigePrijs;
        if (gap > 0.005 && parsed.instap_type !== 'breakout') {
          // Entry is >0.5% boven huidige koers maar GEEN breakout-label → correct naar direct of breakout
          if (gap <= 0.015) {
            // Klein verschil: behandel als direct entry op huidige koers
            parsed.instap_type = 'direct';
          } else {
            // Groot verschil: dit is eigenlijk een breakout setup
            parsed.instap_type = 'breakout';
          }
        }
      }

      // 5. Direct entry: zet entry op huidige koers, herbereken stop/target
      if (parsed.instap_type === 'direct' && parsed.entry) {
        const oldEntry = parseFloat(parsed.entry);
        const oldStop = parseFloat(parsed.stop_loss) || (oldEntry * 0.992);
        const risico = Math.abs(oldEntry - oldStop);
        parsed.entry = huidigePrijs;
        parsed.actie = 'KOOP NU';
        parsed.signaal = 'KOOP';
        if (risico > 0) {
          parsed.stop_loss = +(huidigePrijs - risico).toFixed(2);
          const minTarget = +(huidigePrijs + risico * 2.5).toFixed(2);
          if (!parsed.target || parseFloat(parsed.target) < minTarget) {
            parsed.target = minTarget;
          }
          parsed.rr_ratio = +((parseFloat(parsed.target) - huidigePrijs) / risico).toFixed(2);
        }
      }

      // 6. Actie-label consistent met instap_type
      if (parsed.instap_type === 'pullback' && parsed.entry) {
        parsed.actie = `KOOP BIJ DALING NAAR ${Number(parsed.entry).toFixed(2)}`;
      } else if (parsed.instap_type === 'breakout' && parsed.entry) {
        parsed.actie = `KOOP BIJ STIJGING NAAR ${Number(parsed.entry).toFixed(2)}`;
      } else if (parsed.instap_type === 'geen_trade') {
        parsed.actie = parsed.actie || 'GEEN SETUP';
        parsed.signaal = 'WACHT';
      }
      // ── einde V2.0 ─────────────────────────────────────────────────────────
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

// POST /api/weekevaluatie — AI analyseert de weekresultaten en geeft leeradvies
app.post('/api/weekevaluatie', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY ontbreekt' });
    const { trades = [], analyses = [] } = req.body;
    const gesloten = trades.filter(t => t.resultaat && t.resultaat !== 'open' && t.resultaat !== 'entry_niet_bereikt' && t.resultaat !== 'gemist');
    const winst = gesloten.filter(t => t.resultaat === 'target_bereikt');
    const verlies = gesloten.filter(t => t.resultaat === 'stop_geraakt');
    const winstSom = gesloten.reduce((s, t) => s + (t.winst || 0), 0);
    const gemisteLijst = trades.filter(t => t.resultaat === 'gemist');
    const prompt = `Jij bent een professionele daytrading coach. Analyseer de weekresultaten en geef specifieke verbeteradviezen.

WEEKOVERZICHT:
Totaal trades: ${gesloten.length} | Winst: ${winst.length} (${gesloten.length > 0 ? Math.round(winst.length/gesloten.length*100) : 0}%) | Verlies: ${verlies.length}
Netto resultaat: €${winstSom.toFixed(2)}
Gemiste kansen: ${gemisteLijst.length}

TRADES DETAIL:
${gesloten.slice(0,20).map(t => {
  const icoon = t.resultaat === 'target_bereikt' ? '✅' : t.resultaat === 'stop_geraakt' ? '🛑' : '📊';
  return `${icoon} ${t.symbol} ${t.datum||''} ${t.tijdstip||''}: entry ${t.entry}, stop ${t.stop_loss}, target ${t.target}, ${t.aantal||10}x → ${t.resultaat} €${t.winst >= 0 ? '+' : ''}${(t.winst||0).toFixed(2)} (RSI ${t.rsi||'?'})`;
}).join('\n')}
${gemisteLijst.slice(0,5).map(t =>
  `⚠️ GEMIST: ${t.symbol} ${t.datum||''}: WACHT → koers ging ${t.winst > 0 ? '+' : ''}${t.winst}%`
).join('\n')}

Analyseer:
1. Welke trades gingen verloren door te krappe stops? (check R:R vs werkelijke beweging)
2. Welk signaalpatroon (RSI, MACD, volume) correleerde het beste met winnende trades?
3. Welke symbolen presteren goed/slecht? Moet de watchlist worden aangesteld?
4. Bij gemiste kansen: welke indicatorcombinatie had KOOP moeten geven?
5. Geef 3 concrete aanpassingen voor volgende week (niet vaag, met exacte getallen).

Reageer met dit JSON:
{
  "samenvatting": "2-3 zinnen over de week",
  "winrate": ${gesloten.length > 0 ? Math.round(winst.length/gesloten.length*100) : 0},
  "netto": ${winstSom.toFixed(2)},
  "sterkePunten": ["punt1", "punt2"],
  "verbeterpunten": ["punt1", "punt2", "punt3"],
  "aanpassingen": [
    {"wat": "specifieke aanpassing", "waarom": "data-onderbouwing"},
    {"wat": "...", "waarom": "..."},
    {"wat": "...", "waarom": "..."}
  ],
  "volgendeWeekFocus": "1 concrete focus voor volgende week"
}`;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });
    const textBlock = message.content.find(b => b.type === 'text');
    const match = textBlock?.text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI gaf geen valide JSON terug');
    res.json(JSON.parse(match[0]));
  } catch (err) {
    console.error('Weekevaluatie fout:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── BACKTEST PERSISTENCE ────────────────────────────────────────────────────
const BT_FILE = path.join(__dirname, 'backtest-cache.json');
let _btServerCache = null; // in-memory voor snelle toegang

// Laad bij serverstart als het bestand bestaat
try {
  if (fs.existsSync(BT_FILE)) {
    _btServerCache = JSON.parse(fs.readFileSync(BT_FILE, 'utf8'));
    console.log('Backtest cache geladen:', _btServerCache.ts ? new Date(_btServerCache.ts).toLocaleDateString('nl-NL') : '?');
  }
} catch(e) { console.warn('Backtest cache load fout:', e.message); }

// POST /api/backtest/sla-op  — frontend stuurt resultaat op
app.post('/api/backtest/sla-op', express.json({ limit: '2mb' }), (req, res) => {
  try {
    const payload = { ts: Date.now(), data: req.body };
    _btServerCache = payload;
    fs.writeFileSync(BT_FILE, JSON.stringify(payload), 'utf8');
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/backtest/laad — frontend haalt opgeslagen resultaat op
app.get('/api/backtest/laad', (req, res) => {
  if (!_btServerCache) return res.json({ leeg: true });
  const dagenOud = (Date.now() - _btServerCache.ts) / (1000 * 60 * 60 * 24);
  res.json({ ...(_btServerCache.data), _ts: _btServerCache.ts, _dagenOud: +dagenOud.toFixed(1) });
});

// ── BACKTEST SYSTEM (zero AI credits, pure computation) ────────────────────

function btCalcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function btCalcEMA(arr, period) {
  const ema = new Array(arr.length).fill(null);
  const k = 2 / (period + 1);
  let first = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === null) continue;
    if (first === -1) { ema[i] = arr[i]; first = i; continue; }
    ema[i] = arr[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function btCalcMACD(closes) {
  const ema12 = btCalcEMA(closes, 12);
  const ema26 = btCalcEMA(closes, 26);
  const macd = closes.map((_, i) => (ema12[i] !== null && ema26[i] !== null) ? ema12[i] - ema26[i] : null);
  const signal = btCalcEMA(macd, 9);
  const hist = macd.map((v, i) => (v !== null && signal[i] !== null) ? v - signal[i] : null);
  return { macd, signal, hist };
}

function btCalcATR(quotes, period = 14) {
  const atr = new Array(quotes.length).fill(null);
  if (quotes.length < 2) return atr;
  const tr = [null];
  for (let i = 1; i < quotes.length; i++) {
    const h = quotes[i].high, l = quotes[i].low, pc = quotes[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let sum = 0, count = 0;
  for (let i = 1; i <= period && i < tr.length; i++) { sum += tr[i]; count++; }
  if (count < period) return atr;
  atr[period] = sum / period;
  for (let i = period + 1; i < quotes.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

function btCalcADX(quotes, period = 14) {
  const adx = new Array(quotes.length).fill(null);
  if (quotes.length < period * 2) return adx;
  const trArr = [null];
  const dmPArr = [null];
  const dmMArr = [null];
  for (let i = 1; i < quotes.length; i++) {
    const h = quotes[i].high, l = quotes[i].low;
    const ph = quotes[i - 1].high, pl = quotes[i - 1].low, pc = quotes[i - 1].close;
    trArr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const upMove = h - ph, downMove = pl - l;
    dmPArr.push(upMove > downMove && upMove > 0 ? upMove : 0);
    dmMArr.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  // Wilder smoothing
  let smTR = 0, smP = 0, smM = 0;
  for (let i = 1; i <= period; i++) { smTR += trArr[i]; smP += dmPArr[i]; smM += dmMArr[i]; }
  const diP = new Array(quotes.length).fill(null);
  const diM = new Array(quotes.length).fill(null);
  const dx = new Array(quotes.length).fill(null);
  diP[period] = smTR > 0 ? 100 * smP / smTR : 0;
  diM[period] = smTR > 0 ? 100 * smM / smTR : 0;
  dx[period] = (diP[period] + diM[period]) > 0 ? 100 * Math.abs(diP[period] - diM[period]) / (diP[period] + diM[period]) : 0;
  for (let i = period + 1; i < quotes.length; i++) {
    smTR = smTR - smTR / period + trArr[i];
    smP = smP - smP / period + dmPArr[i];
    smM = smM - smM / period + dmMArr[i];
    diP[i] = smTR > 0 ? 100 * smP / smTR : 0;
    diM[i] = smTR > 0 ? 100 * smM / smTR : 0;
    dx[i] = (diP[i] + diM[i]) > 0 ? 100 * Math.abs(diP[i] - diM[i]) / (diP[i] + diM[i]) : 0;
  }
  let dxSum = 0;
  for (let i = period; i < 2 * period && i < dx.length; i++) { dxSum += (dx[i] || 0); }
  adx[2 * period - 1] = dxSum / period;
  for (let i = 2 * period; i < quotes.length; i++) {
    adx[i] = (adx[i - 1] * (period - 1) + (dx[i] || 0)) / period;
  }
  return adx;
}

function btCalcMFI(quotes, period = 14) {
  const mfi = new Array(quotes.length).fill(null);
  const tp = quotes.map(q => (q.high + q.low + q.close) / 3);
  for (let i = period; i < quotes.length; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const flow = tp[j] * (quotes[j].volume || 0);
      if (tp[j] > tp[j - 1]) posFlow += flow; else negFlow += flow;
    }
    mfi[i] = negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow);
  }
  return mfi;
}

function btCalcVWAP(quotes) {
  // Rolling daily VWAP (reset each day based on timestamp)
  const vwap = new Array(quotes.length).fill(null);
  let cumTPV = 0, cumVol = 0;
  let lastDay = -1;
  for (let i = 0; i < quotes.length; i++) {
    const d = new Date(quotes[i].timestamp * 1000);
    const day = d.getUTCDate();
    if (day !== lastDay) { cumTPV = 0; cumVol = 0; lastDay = day; }
    const tp = (quotes[i].high + quotes[i].low + quotes[i].close) / 3;
    const vol = quotes[i].volume || 0;
    cumTPV += tp * vol;
    cumVol += vol;
    vwap[i] = cumVol > 0 ? cumTPV / cumVol : quotes[i].close;
  }
  return vwap;
}

async function btHaalYahooData(symbol, interval = '15m', range = '60d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`Yahoo ${symbol}: ${resp.status}`);
  const json = await resp.json();
  const result = json.chart?.result?.[0];
  if (!result) throw new Error(`Geen data voor ${symbol}`);
  const ts = result.timestamp;
  const q = result.indicators.quote[0];
  const quotes = ts.map((t, i) => ({
    timestamp: t,
    open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i],
    volume: q.volume[i],
  })).filter(c => c.open && c.high && c.low && c.close);
  return quotes;
}

function btRunStrategies(quotes, symbol) {
  const closes = quotes.map(q => q.close);
  const rsiArr = btCalcRSI(closes, 14);
  const macdData = btCalcMACD(closes);
  const atrArr = btCalcATR(quotes, 14);
  const adxArr = btCalcADX(quotes, 14);
  const mfiArr = btCalcMFI(quotes, 14);
  const vwapArr = btCalcVWAP(quotes);

  // ORB: find daily opening range high/low (first 4 candles = 1 hour)
  const orbMap = {}; // date -> { high, low }
  quotes.forEach((q, i) => {
    const d = new Date(q.timestamp * 1000);
    const dateKey = d.toISOString().slice(0, 10);
    const minFromOpen = (d.getUTCHours() - 13) * 60 + d.getUTCMinutes(); // ~US market open
    if (minFromOpen >= 0 && minFromOpen < 60) {
      if (!orbMap[dateKey]) orbMap[dateKey] = { high: q.high, low: q.low };
      else { orbMap[dateKey].high = Math.max(orbMap[dateKey].high, q.high); orbMap[dateKey].low = Math.min(orbMap[dateKey].low, q.low); }
    }
  });

  // Average daily volume (last 20 days)
  const dailyVol = {};
  quotes.forEach(q => {
    const dk = new Date(q.timestamp * 1000).toISOString().slice(0, 10);
    if (!dailyVol[dk]) dailyVol[dk] = 0;
    dailyVol[dk] += (q.volume || 0);
  });
  const dailyVolVals = Object.values(dailyVol).slice(-20);
  const avgDailyVol = dailyVolVals.reduce((a, b) => a + b, 0) / (dailyVolVals.length || 1);

  const STRATEGIES = {
    gap_and_go:      { naam: 'Gap-and-Go',           wins: 0, losses: 0, totalPnL: 0, trades: [] },
    vwap_bounce:     { naam: 'VWAP Bounce',           wins: 0, losses: 0, totalPnL: 0, trades: [] },
    orb_breakout:    { naam: 'ORB Breakout',          wins: 0, losses: 0, totalPnL: 0, trades: [] },
    pullback_trend:  { naam: 'Eerste Pullback',       wins: 0, losses: 0, totalPnL: 0, trades: [] },
    mfi_oversold:    { naam: 'MFI Oversold Bounce',   wins: 0, losses: 0, totalPnL: 0, trades: [] },
    combined:        { naam: 'Premium (3+ signalen)', wins: 0, losses: 0, totalPnL: 0, trades: [] },
  };

  // Risk per trade: €100, target 2:1 or 3:1 R:R
  const RISK = 100;

  for (let i = 28; i < quotes.length - 1; i++) {
    const q = quotes[i];
    const next = quotes[i + 1];
    const rsi = rsiArr[i];
    const adx = adxArr[i];
    const mfi = mfiArr[i];
    const vwap = vwapArr[i];
    const atr = atrArr[i];
    const macdHist = macdData.hist[i];
    const prevMacdHist = macdData.hist[i - 1];
    if (!rsi || !atr || atr === 0) continue;

    const d = new Date(q.timestamp * 1000);
    const dateKey = d.toISOString().slice(0, 10);
    const hourUTC = d.getUTCHours();
    // US market hours: 13:30-20:00 UTC (9:30-16:00 EST)
    if (hourUTC < 13 || hourUTC >= 20) continue;

    const rsiPrev = rsiArr[i - 1];
    const rsiTrendUp = rsi > (rsiPrev || 0);
    const vwapDiff = vwap ? (q.close - vwap) / vwap : 0;
    const orb = orbMap[dateKey];
    const intradayOpen = quotes.find(qx => new Date(qx.timestamp * 1000).toISOString().slice(0, 10) === dateKey);
    const intradayPct = intradayOpen ? (q.close - intradayOpen.open) / intradayOpen.open * 100 : 0;
    const prevDayCloseQ = quotes.slice(0, i).reverse().find(qx => new Date(qx.timestamp * 1000).toISOString().slice(0, 10) < dateKey);
    const gapPct = prevDayCloseQ ? (intradayOpen?.open - prevDayCloseQ.close) / prevDayCloseQ.close * 100 : 0;
    const curDateVol = dailyVol[dateKey] || 0;
    const volRatio = avgDailyVol > 0 ? curDateVol / avgDailyVol : 1;

    const macdBull = macdHist !== null && prevMacdHist !== null && macdHist > prevMacdHist;

    // Helper: simulate trade outcome using next candle and subsequent candles
    function simTrade(stopDist, targetMult, stratKey) {
      const stop = q.close - stopDist;
      const target = q.close + stopDist * targetMult;
      const units = Math.floor(RISK / stopDist) || 1;
      // Check next 8 candles (2 hours)
      for (let k = i + 1; k < Math.min(i + 9, quotes.length); k++) {
        if (quotes[k].low <= stop) {
          const pnl = -RISK;
          STRATEGIES[stratKey].losses++;
          STRATEGIES[stratKey].totalPnL += pnl;
          STRATEGIES[stratKey].trades.push({ date: dateKey, pnl, result: 'stop' });
          return;
        }
        if (quotes[k].high >= target) {
          const pnl = RISK * targetMult;
          STRATEGIES[stratKey].wins++;
          STRATEGIES[stratKey].totalPnL += pnl;
          STRATEGIES[stratKey].trades.push({ date: dateKey, pnl, result: 'target' });
          return;
        }
      }
      // Time exit: close at last checked candle
      const exitIdx = Math.min(i + 8, quotes.length - 1);
      const exitPnl = (quotes[exitIdx].close - q.close) * units;
      if (exitPnl >= 0) STRATEGIES[stratKey].wins++; else STRATEGIES[stratKey].losses++;
      STRATEGIES[stratKey].totalPnL += exitPnl;
      STRATEGIES[stratKey].trades.push({ date: dateKey, pnl: exitPnl, result: 'timeout' });
    }

    // 1. Gap-and-Go: gap >1.5%, first hour, RSI not overbought
    if (gapPct > 1.5 && rsi < 78 && (adx === null || adx > 15) && hourUTC === 13) {
      simTrade(atr * 1.5, 3.0, 'gap_and_go');
    }

    // 2. VWAP Bounce: price near VWAP ±0.3%, RSI 42-65 rising, MACD bullish
    if (Math.abs(vwapDiff) < 0.003 && rsi > 42 && rsi < 65 && rsiTrendUp && macdBull) {
      simTrade(atr * 1.2, 2.5, 'vwap_bounce');
    }

    // 3. ORB Breakout: close above ORB high, ADX >22, volume spike
    if (orb && q.close > orb.high && (adx === null || adx > 22) && volRatio > 1.3) {
      simTrade(atr * 1.5, 2.5, 'orb_breakout');
    }

    // 4. Pullback in uptrend: intraday 0.5-2.5%, above VWAP, RSI 42-62 rising
    if (intradayPct > 0.5 && intradayPct < 2.5 && vwapDiff > 0 && rsi > 42 && rsi < 62 && rsiTrendUp) {
      simTrade(atr * 1.2, 2.5, 'pullback_trend');
    }

    // 5. MFI Oversold Bounce: MFI <32, RSI <42, RSI turning up
    if (mfi !== null && mfi < 32 && rsi < 42 && rsiTrendUp) {
      simTrade(atr * 1.0, 2.5, 'mfi_oversold');
    }

    // 6. Combined Premium: 4+ signals aligning
    {
      let score = 0;
      if (rsi > 45 && rsi < 68) score++;
      if (macdBull) score++;
      if (adx !== null && adx > 25) score++;
      if (mfi !== null && mfi > 45 && mfi < 70) score++;
      if (vwapDiff > 0 && vwapDiff < 0.005) score++;
      if (volRatio > 1.2) score++;
      if (score >= 4) {
        simTrade(atr * 1.5, 3.0, 'combined');
      }
    }
  }

  // Build summary per strategy
  const resultaten = {};
  for (const [key, s] of Object.entries(STRATEGIES)) {
    const total = s.wins + s.losses;
    const winRate = total > 0 ? Math.round(s.wins / total * 100) : 0;
    const avgWin = s.trades.filter(t => t.pnl > 0).reduce((a, b) => a + b.pnl, 0) / (s.wins || 1);
    const avgLoss = s.trades.filter(t => t.pnl < 0).reduce((a, b) => a + b.pnl, 0) / (s.losses || 1);
    const profitFactor = s.losses > 0 && avgLoss !== 0 ? Math.abs((s.wins * avgWin) / (s.losses * avgLoss)) : (s.wins > 0 ? 99 : 0);
    resultaten[key] = {
      naam: s.naam,
      trades: total,
      wins: s.wins,
      losses: s.losses,
      winRate,
      totalPnL: +s.totalPnL.toFixed(2),
      avgWin: +avgWin.toFixed(2),
      avgLoss: +avgLoss.toFixed(2),
      profitFactor: +profitFactor.toFixed(2),
    };
  }
  return resultaten;
}

app.get('/api/backtest', async (req, res) => {
  try {
    const symbols = ((req.query.symbols || 'NVDA,AMD,META,AAPL,AMAT,ASML,NFLX,LMT,XOM,RTX').split(',')).slice(0, 12);
    const results = {};
    const errors = [];

    for (const sym of symbols) {
      try {
        await new Promise(r => setTimeout(r, 1200)); // rate limit
        const quotes = await btHaalYahooData(sym, '15m', '60d');
        if (quotes.length < 50) { errors.push(`${sym}: te weinig data (${quotes.length} candles)`); continue; }
        results[sym] = btRunStrategies(quotes, sym);
      } catch (err) {
        errors.push(`${sym}: ${err.message}`);
      }
    }

    // Aggregate: best strategy overall
    const stratTotals = {};
    for (const symData of Object.values(results)) {
      for (const [key, s] of Object.entries(symData)) {
        if (!stratTotals[key]) stratTotals[key] = { naam: s.naam, trades: 0, wins: 0, losses: 0, totalPnL: 0 };
        stratTotals[key].trades += s.trades;
        stratTotals[key].wins += s.wins;
        stratTotals[key].losses += s.losses;
        stratTotals[key].totalPnL += s.totalPnL;
      }
    }
    const strategieen = Object.entries(stratTotals).map(([key, s]) => {
      const winRate = s.trades > 0 ? Math.round(s.wins / s.trades * 100) : 0;
      return { key, naam: s.naam, trades: s.trades, winRate, totalPnL: +s.totalPnL.toFixed(2) };
    }).sort((a, b) => b.totalPnL - a.totalPnL);

    // Best symbol+strategy combo
    let bestCombo = null;
    for (const [sym, symData] of Object.entries(results)) {
      for (const [key, s] of Object.entries(symData)) {
        if (s.trades >= 5 && s.winRate >= 50) {
          if (!bestCombo || s.totalPnL > bestCombo.pnl) {
            bestCombo = { symbol: sym, strategie: s.naam, winRate: s.winRate, pnl: s.totalPnL, trades: s.trades };
          }
        }
      }
    }

    res.json({ symbolen: results, strategieen, bestCombo, errors, periodeD: 60, aantalSymbolen: symbols.length });
  } catch (err) {
    console.error('Backtest fout:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Server listening on port ' + PORT);
});
