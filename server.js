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

// POST /api/analyze  — body: { symbol, interval, quotes, indicators }
app.post('/api/analyze', async (req, res) => {
  try {
    const { symbol, interval, quotes, indicators } = req.body;

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
    const volumeRatio = gemVolume > 0
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
KOERS & DAG:
Prijs: €${fmt(last.close)} | Gap: ${openingGap || 0}%
Dag range: €${dagLaag} - €${dagHoog} (€${dagRange.toFixed(0)}, ${rangePct}%)
Positie in range: ${positieInRange}% ${Number(positieInRange) < 25 ? '← DICHT BIJ DAGLAAG' : Number(positieInRange) > 75 ? '← DICHT BIJ DAGHOOG' : ''}
INDICATOREN:
RSI: ${fmt(indicators.rsi)} ${Number(indicators.rsi) < 40 ? '← OVERSOLD ✅' : Number(indicators.rsi) > 65 ? '← OVERBOUGHT ❌' : '← neutraal'}
MACD histogram: ${fmt(indicators.macd?.histogram, 4)} ${indicators.macd?.histogram > 0 ? '← bullish' : '← bearish'}
Bollinger: L=${fmt(indicators.bb?.lower)} M=${fmt(indicators.bb?.middle)} U=${fmt(indicators.bb?.upper)}
Koers vs BB: ${Number(last.close) < Number(indicators.bb?.lower) ? '← ONDER lower ✅ KOOP SIGNAAL' : Number(last.close) > Number(indicators.bb?.upper) ? '← BOVEN upper ❌' : '← binnen bands'}
VOLUME: ${volumeRatio}x gemiddeld ${Number(volumeRatio) > 1.5 ? '← HOOG ✅' : Number(volumeRatio) < 0.3 ? '← LAAG ⚠️' : ''}
LAATSTE 5 KAARSEN:
${recent.slice(-5).map(q => {
  const d = new Date(q.date);
  const t = d.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Amsterdam'});
  return t+': '+fmt(q.open)+' → '+fmt(q.close)+' (H:'+fmt(q.high)+' L:'+fmt(q.low)+') '+(q.close>=q.open?'🟢':'🔴');
}).join('\n')}
KOOP als 2 van 3:
✓ RSI < 45 EN koers in onderste 35% dagrange
✓ Koers raakt/onder Bollinger Lower Band
✓ MACD histogram draait positief
STOP-LOSS REGELS:
- Voor aandelen onder €300: minimaal 1.5% onder entry
- Voor aandelen boven €300: minimaal 1% onder entry
- Stop moet buiten normale dagvolatiliteit liggen
- Een 15-minuten candle heeft gemiddeld 0.3-0.5% range
- Stop moet minimaal 3x die range onder entry liggen
TARGET REGELS:
- Voor aandelen onder €300: minimaal 3% boven entry
- Voor aandelen boven €300: minimaal 2% boven entry
- Target moet realistisch zijn binnen dagrange
Als WACHT: geef CONCREET aan bij welke prijs/conditie je WEL zou kopen.
Geen vage antwoorden - altijd een concreet level noemen.
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
