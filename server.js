const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('Geen data van Yahoo');
    const ts = result.timestamp;
    const q = result.indicators.quote[0];
    const quotes = ts.map((t, i) => ({
      date: new Date(t * 1000).toISOString(),
      open:   q.open[i]   != null ? +q.open[i].toFixed(4)   : null,
      high:   q.high[i]   != null ? +q.high[i].toFixed(4)   : null,
      low:    q.low[i]    != null ? +q.low[i].toFixed(4)    : null,
      close:  q.close[i]  != null ? +q.close[i].toFixed(4)  : null,
      volume: q.volume[i] || 0,
    })).filter(q => q.open && q.close && q.high && q.low);
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

    const prompt = `Je bent een elite daytrader analist met 20 jaar ervaring
in technische analyse. Je taak is een concreet intraday handelsadvies
geven voor ${symbol} op het ${interval} timeframe.
REDENEER STAP VOOR STAP VOOR JE EEN CONCLUSIE TREKT:
STAP 1 - TREND ANALYSE:
Bepaal de primaire trend van vandaag op basis van de kaarsen.
- Opent het aandeel boven of onder gisteren slotkoers?
- Opening gap: ${indicators.openingGap ? indicators.openingGap + '%' : 'onbekend'}
- Huidige koers: ${fmt(last.close)}
- EMA trend: ${indicators.trend || 'onbekend'}
- Beschrijf in 1 zin: is de dagtrend opwaarts, neerwaarts of zijwaarts?
STAP 2 - MOMENTUM ANALYSE:
Beoordeel RSI en MACD samen, niet apart.
- RSI(14): ${fmt(indicators.rsi)}
  → ${indicators.rsi > 70 ? 'OVERBOUGHT: verkoopdruk waarschijnlijk' : indicators.rsi < 30 ? 'OVERSOLD: koopdruk mogelijk' : 'Neutraal gebied'}
- MACD lijn: ${fmt(indicators.macd?.macd, 4)}
- Signaal lijn: ${fmt(indicators.macd?.signal, 4)}
- Histogram: ${fmt(indicators.macd?.histogram, 4)}
  → ${indicators.macd?.histogram > 0 ? 'Positief: bullish momentum' : 'Negatief: bearish momentum'}
- Combinatie oordeel: ${indicators.rsi < 30 && indicators.macd?.histogram > 0 ? 'STERK KOOP: RSI oversold + MACD draait om' : indicators.rsi > 70 && indicators.macd?.histogram < 0 ? 'STERK VERKOOP: RSI overbought + MACD draait om' : 'Gemengd signaal, wees voorzichtig'}
STAP 3 - BOLLINGER BANDS ANALYSE:
- Upper band: ${fmt(indicators.bb?.upper)}
- Midden (MA20): ${fmt(indicators.bb?.middle)}
- Lower band: ${fmt(indicators.bb?.lower)}
- Koers vs bands: ${last.close > indicators.bb?.upper ? 'BOVEN upper band: extreem overbought' : last.close < indicators.bb?.lower ? 'ONDER lower band: extreem oversold, stuitje mogelijk' : 'Binnen de bands: normale beweging'}
STAP 4 - KAARSPATROON ANALYSE:
Laatste 10 kaarsen (meest recent eerst):
${recent.slice(-10).reverse().map((q,i) => {
  const d = new Date(q.date);
  const tijd = d.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Amsterdam'});
  const body = Math.abs(q.close-q.open);
  const range = q.high-q.low;
  const bodyPct = range > 0 ? (body/range*100).toFixed(0) : 0;
  const type = q.close >= q.open ? '🟢' : '🔴';
  return `${type} ${tijd} | O:${fmt(q.open)} H:${fmt(q.high)} L:${fmt(q.low)} C:${fmt(q.close)} | Body:${bodyPct}% van range`;
}).join('\n')}
Herken je een van deze patronen?
- Doji (twijfel): body < 10% van range
- Hammer (mogelijk koop): lange onderstaart, kleine body bovenaan
- Shooting star (mogelijk verkoop): lange bovenstaart, kleine body onderaan
- Engulfing bullish: grote groene kaars na kleine rode
- Engulfing bearish: grote rode kaars na kleine groene
- 3 opeenvolgende rode kaarsen = sterke neerwaartse druk
- 3 opeenvolgende groene kaarsen = sterke opwaartse druk
STAP 5 - VOLUME ANALYSE:
${recent.slice(-5).map(q => {
  const d = new Date(q.date);
  return d.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Amsterdam'}) +
    ': volume ' + (q.volume > 0 ? q.volume.toLocaleString() : 'onbekend');
}).join(' | ')}
- Hoog volume bij stijging = bevestiging
- Hoog volume bij daling = sterke verkoopdruk
- Laag volume = beweging niet betrouwbaar
STAP 6 - MARKTCONTEXT:
Zoek naar recent nieuws over ${symbol} van vandaag.
Beoordeel:
- Is er fundamenteel nieuws dat de technische analyse overschrijft?
- Wat is het algemene marktsentiment vandaag?
- Zijn er sectorgenoten die sterker/zwakker zijn?
STAP 7 - RISICO BEOORDELING:
Bepaal specifieke prijsniveaus:
- Weerstand: dichtstbijzijnde niveau waar verkopers actief zijn
- Steun: dichtstbijzijnde niveau waar kopers actief zijn
- Stop-loss: maximaal 1% onder entry voor long posities
- Target: minimaal 1.5x risico (R/R minimaal 1:1.5)
STAP 8 - TIJDSTIP ADVIES:
Geef specifiek advies voor het huidige moment op de dag.
Amsterdam tijd is nu: ${new Date().toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Amsterdam'})}
- 09:00-09:30: Eerste 30 min — hoge volatiliteit, wacht op richting
- 09:30-11:00: Ochtend trend — sterkste signalen van de dag
- 11:00-13:00: Lunch consolidatie — lagere betrouwbaarheid
- 13:00-15:30: Middag hervatting — tweede beste periode
- 15:30-17:30: US opening invloed — verhoogde volatiliteit
- Na 16:30: Slotveiling opbouw — vermijd nieuwe posities
AANDEEL-SPECIFIEKE REGELS:
${symbol.includes('ASML') ? `
ASML specifiek:
- Zeer institutioneel aandeel, langzame maar betrouwbare bewegingen
- Volgt sterk de NASDAQ/chipsektor (NVDA, AMAT)
- Gemiddeld dagbereik €15-25 op normale dagen
- Verhoogde volatiliteit na ASML earnings of chipsektor nieuws
- Minimaal vertrouwen voor signaal: 60%` : ''}
${symbol.includes('ADYEN') ? `
ADYEN specifiek:
- Hoge volatiliteit, grote dagbewegingen mogelijk (€20-50)
- Gevoelig voor betaalsector nieuws (Visa, Mastercard, PayPal)
- RSI signalen zijn betrouwbaarder dan MACD voor dit aandeel
- Minimaal vertrouwen voor signaal: 65%` : ''}
${symbol === 'NVDA' ? `
NVIDIA specifiek:
- Marktleider chips, beïnvloedt hele sektoor
- Sterk gecorreleerd met AI/tech sentiment
- Grote dagbewegingen normaal ($3-8)
- Pre-market bewegingen zijn indicatief voor dagtrend
- Minimaal vertrouwen voor signaal: 55%` : ''}
${symbol === 'TSLA' ? `
TESLA specifiek:
- Extreem volatiel, grootste dagbewegingen van de lijst
- Sterk beïnvloed door Elon Musk nieuws en macro sentiment
- Veel valse signalen — gebruik alleen hoog-vertrouwen signalen (75%+)
- Stop-loss altijd strikter aanhouden dan andere aandelen` : ''}
${symbol === 'RHM.DE' ? `
RHEINMETALL specifiek:
- Defensie aandeel, stijgt bij geopolitiek nieuws
- Volg nieuws over Oekraïne/NAVO/defensiebudgetten
- Minder liquide dan US aandelen, grotere spreads
- Minimaal vertrouwen voor signaal: 65%` : ''}
${symbol === 'BA' || symbol === 'LMT' ? `
Defensie/aerospace specifiek:
- Gevoelig voor overheidscontracten en defensienieuws
- US markturen zijn leidend (14:30-21:00 NL tijd)
- Volg Pentagon aankondigingen en budgetvotes` : ''}
GEEF NU JE CONCLUSIE:
Na bovenstaande analyse, geef ALLEEN dit JSON object terug:
{
  "signaal": "KOOP" of "VERKOOP" of "WACHT",
  "actie": "KOOP NU" of "KOOP BIJ DALING NAAR X" of "VERKOOP NU" of "WACHT TOT XX:XX" of "NIET MEER KOPEN VANDAAG" of "WACHT OP BEVESTIGING",
  "vertrouwen": getal 0-100,
  "redenering": "2-3 zinnen: welke combinatie van factoren geeft de doorslag? Noem concrete prijsniveaus en tijdstippen.",
  "entry": prijsgetal,
  "stop_loss": prijsgetal,
  "target": prijsgetal,
  "rr_ratio": decimaal getal,
  "dagtrend": "beschrijving ochtend vs middag beweging met concrete prijzen",
  "instap_tijd": "HH:MM of omschrijving zoals na 14:00 als RSI bevestigt",
  "nieuws_sentiment": "POSITIEF" of "NEGATIEF" of "NEUTRAAL",
  "nieuws_samenvatting": "1-2 zinnen relevant nieuws van vandaag",
  "verwacht_rendement_pct": decimaal getal,
  "kaarspatroon": "naam van herkend patroon of geen patroon",
  "weerstand": prijsgetal,
  "steun": prijsgetal,
  "tijdstip_advies": "specifiek advies voor het huidige moment op de dag"
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
