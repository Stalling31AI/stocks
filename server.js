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
    const isEuropees = ['ASML.AS','ADYEN.AS','RHM.DE'].includes(symbol);
    const handelVenster = isEuropees ? '09:30-17:30' : '15:30-22:00';
    const binnenVenster = (() => {
      const [open, sluit] = handelVenster.split('-');
      const [oH, oM] = open.split(':').map(Number);
      const [sH, sM] = sluit.split(':').map(Number);
      const nlUur = parseInt(amsterdamTijd.split(':')[0]);
      const nlMin = parseInt(amsterdamTijd.split(':')[1]);
      const nuMin = nlUur * 60 + nlMin;
      return nuMin >= oH * 60 + oM && nuMin < sH * 60 + sM;
    })();
    const prompt = `STRIKTE REGELS - GEEN UITZONDERINGEN:
1. Baseer je analyse UITSLUITEND op de meegeleverde prijsdata en indicatoren. Verzin GEEN nieuws.
2. Als je geen nieuws hebt, zet nieuws_samenvatting op "Geen nieuws beschikbaar - analyse puur technisch"
3. nieuws_sentiment = "NEUTRAAL" als geen nieuws beschikbaar
4. Schrijf in de redenering ALLEEN wat je daadwerkelijk ziet in de data.
Je bent een elite daytrader. Analyseer ${symbol} op ${interval} timeframe. Doel: concreet koop/verkoop advies.
MARKTDATA:
- Prijs: ${fmt(last.close)} | Tijd: ${amsterdamTijd} (${dagdeel})
VOLUME ANALYSE:
- Huidig volume: ${lastVolume.toLocaleString()}
- Gemiddeld volume (20 periodes): ${Math.round(gemVolume).toLocaleString()}
- Volume ratio: ${volumeRatio}x gemiddeld
${Number(volumeRatio) > 1.5 ? '→ HOOG volume: beweging wordt bevestigd' : Number(volumeRatio) < 0.5 ? '→ LAAG volume: beweging niet betrouwbaar' : '→ Normaal volume'}
KEY PRICE LEVELS VANDAAG:
- Dag hoog: ${dagHoog.toFixed(2)}
- Dag laag: ${dagLaag.toFixed(2)}
- Vorige slotkoers: ${vorigeSlot ? vorigeSlot.toFixed(2) : 'onbekend'}
- Psychologisch niveau: ${Math.round(last.close / 50) * 50} (dichtstbijzijnde ronde €50)
MULTI-TIMEFRAME CONTEXT:
- Huidig timeframe: ${interval}
- Voor betrouwbaar daytrade signaal: controleer of trend op 1u timeframe overeenkomt
- Opening gap: ${openingGap ? openingGap + '%' : 'onbekend'}
- RSI(14): ${fmt(indicators.rsi)} ${Number(indicators.rsi) > 70 ? '→ OVERBOUGHT' : Number(indicators.rsi) < 30 ? '→ OVERSOLD' : '→ neutraal'}
- MACD: ${fmt(indicators.macd?.macd, 4)} | Histogram: ${fmt(indicators.macd?.histogram, 4)} ${indicators.macd?.histogram > 0 ? '→ bullish' : '→ bearish'}
- Bollinger: Upper ${fmt(indicators.bb?.upper)} | Mid ${fmt(indicators.bb?.middle)} | Lower ${fmt(indicators.bb?.lower)}
- Koers vs Bollinger: ${Number(last.close) > Number(indicators.bb?.upper) ? 'BOVEN upper band' : Number(last.close) < Number(indicators.bb?.lower) ? 'ONDER lower band' : 'Binnen bands'}
- Trend: ${indicators.trend}
Laatste koers: ${fmt(last.close)} om ${amsterdamTijd}
Trend laatste 3 kaarsen: ${recent.slice(-3).map(q =>
  (q.close >= q.open ? '▲' : '▼') + fmt(q.close)
).join(' ')}
AANDEEL: ${aandeelRegels[symbol] || 'Standaard regels.'}
TIJDSTIP: ${dagdeel}
HANDELVENSTER: ${handelVenster} NL tijd
Status: ${binnenVenster ? '✅ Binnen handelvenster' : '❌ Buiten handelvenster - geef NIET MEER KOPEN VANDAAG'}
BELANGRIJK - WANNEER WELK SIGNAAL:
KOOP: alleen als er een concreet en betrouwbaar instapmoment is op basis van de technische analyse. Geef dan een specifieke entry prijs, stop-loss en target.
VERKOOP: alleen als je een bestaande longpositie zou sluiten of een short zou openen op basis van duidelijke verkoopsignalen.
WACHT: als het signaal onduidelijk is, de betrouwbaarheid te laag is, of als het beter is om de markt af te wachten. Bij WACHT: geef GEEN entry, stop-loss of target. Zet entry, stop_loss, target op null. Leg in de redenering uit WANNEER je wel zou instappen (bijv "wacht op RSI onder 30" of "instappen als koers boven 1155 breekt met volume").
NIET MEER KOPEN VANDAAG: als de dag al te ver gevorderd is of de kans op een goed instapmoment voorbij is. Geef ook geen entry meer.
Zo weet de gebruiker altijd:
- KOOP/VERKOOP = nu actie ondernemen met concrete prijzen
- WACHT = wachten op betere omstandigheden, uitleg waarom
- NIET MEER KOPEN VANDAAG = dag afschrijven voor dit aandeel
STRIKTE REGELS - GEEN UITZONDERINGEN:
KOOP signaal alleen als ALLE van deze punten gelden:
1. RSI onder 40 (oversold of richting oversold)
2. MACD histogram positief OF aan het omkeren
3. Volume ratio boven 0.8 (minimaal normaal volume)
4. Koers NIET al gestegen meer dan 1% vandaag
5. Tijdstip tussen 09:30 en 15:30
VERKOOP signaal alleen als ALLE van deze punten gelden:
1. RSI boven 60 (overbought of richting overbought)
2. MACD histogram negatief OF aan het omkeren
3. Volume ratio boven 0.8
4. Koers NIET al gedaald meer dan 1.5% vandaag
5. Tijdstip tussen 09:30 en 15:30
WACHT altijd als:
- Volume ratio onder 0.5 (te weinig volume)
- Tijdstip voor 09:30 of na 15:30
- RSI tussen 40 en 60 zonder duidelijk momentum
- Opening gap groter dan 2% (te volatiel)
- Niet aan bovenstaande KOOP of VERKOOP criteria voldaan
ENTRY REGELS:
- Entry maximaal 0.3% van huidige koers
- Stop-loss maximaal 1% onder entry
- Target minimaal 2x stop-loss afstand (R/R minimaal 1:2)
- Geen entry als R/R onder 1:1.5
NIEUWS:
- Verzin GEEN nieuws
- Als geen nieuws beschikbaar: nieuws_samenvatting = "Analyse puur technisch"
- nieuws_sentiment = "NEUTRAAL" als geen nieuws
VERTROUWEN:
- Onder 50%: altijd WACHT
- 50-65%: KOOP of VERKOOP mogelijk maar voorzichtig
- Boven 65%: sterke bevestiging van alle criteria vereist
Geef ALLEEN dit JSON object terug (geen tekst eromheen):
{
  "signaal": "KOOP" of "VERKOOP" of "WACHT",
  "actie": "KOOP NU" of "KOOP BIJ DALING NAAR [prijs]" of "VERKOOP NU" of "WACHT TOT [HH:MM]" of "NIET MEER KOPEN VANDAAG",
  "vertrouwen": getal 0-100,
  "redenering": "2-3 zinnen concreet met prijsniveaus",
  "entry": prijsgetal,
  "stop_loss": prijsgetal,
  "target": prijsgetal,
  "rr_ratio": decimaal,
  "dagtrend": "korte beschrijving dagbeweging",
  "instap_tijd": "HH:MM of omschrijving",
  "nieuws_sentiment": "POSITIEF" of "NEGATIEF" of "NEUTRAAL",
  "nieuws_samenvatting": "1 zin actueel nieuws",
  "verwacht_rendement_pct": decimaal,
  "kaarspatroon": "naam patroon of geen",
  "weerstand": prijsgetal,
  "steun": prijsgetal,
  "tijdstip_advies": "specifiek advies voor nu"
}`;

    // web_search tijdelijk uitgeschakeld vanwege rate limits
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    // Find the last text block (web_search may produce tool_use blocks before the final answer)
    const textBlock = [...message.content].reverse().find(b => b.type === 'text');
    if (!textBlock) throw new Error('AI gaf geen tekst terug');
    const match = textBlock.text.trim().match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('AI response:', textBlock.text.substring(0, 500));
      throw new Error('AI gaf geen valide JSON terug');
    }
    try {
      const parsed = JSON.parse(match[0]);
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
