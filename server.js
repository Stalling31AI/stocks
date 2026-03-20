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

    const prompt = `Je bent een professionele daytrader en technische analist. Analyseer ${symbol} voor intraday handel.

Aandeel: ${symbol}
Timeframe: ${interval}
Huidige koers: ${fmt(last.close)}
Huidige tijd (Amsterdam): ${nowStr}

Recente OHLCV (laatste 15 kaarsen):
${recent.slice(-15).map(q => {
  const d = new Date(q.date);
  return `${d.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' })} | O:${fmt(q.open)} H:${fmt(q.high)} L:${fmt(q.low)} C:${fmt(q.close)} V:${q.volume}`;
}).join('\n')}

Technische indicatoren:
- RSI(14): ${fmt(indicators.rsi)}
- MACD lijn: ${fmt(indicators.macd?.macd, 4)} | Signaal: ${fmt(indicators.macd?.signal, 4)} | Histogram: ${fmt(indicators.macd?.histogram, 4)}
- Bollinger Bands: Upper ${fmt(indicators.bb?.upper)} | Midden ${fmt(indicators.bb?.middle)} | Lower ${fmt(indicators.bb?.lower)}
- Trend (EMA20 vs EMA50): ${indicators.trend || 'NEUTRAAL'}

Zoek eerst naar recent nieuws over ${symbol} van vandaag via web search.

Analyseer dan:
1. Dagtrend: hoe bewoog het aandeel van ochtend naar middag?
2. Nieuws sentiment: positief of negatief nieuws vandaag?
3. Concreet instapmoment: wanneer is/was het beste instapmoment vandaag? (geef tijdstip HH:MM)
4. Actie-advies: KOOP NU / WACHT TOT HH:MM / NIET MEER KOPEN VANDAAG

Geef ALLEEN het volgende JSON-object terug, geen extra tekst:
{
  "signaal": "KOOP" of "VERKOOP" of "WACHT",
  "actie": "KOOP NU" of "WACHT TOT HH:MM" of "NIET MEER KOPEN VANDAAG",
  "instap_tijd": "<bijv. 14:30 of nu>",
  "vertrouwen": <integer 0-100>,
  "dagtrend": "<1-2 zinnen over ochtend vs middag beweging>",
  "nieuws_sentiment": "POSITIEF" of "NEGATIEF" of "NEUTRAAL",
  "nieuws_samenvatting": "<1-2 zinnen over recent nieuws>",
  "redenering": "<3-4 zinnen volledige onderbouwing in het Nederlands>",
  "entry": <entry prijs als decimaal>,
  "stop_loss": <stop-loss prijs als decimaal>,
  "target": <koersdoel als decimaal>,
  "verwacht_rendement_pct": <verwacht rendement in % als decimaal>,
  "rr_ratio": <risk/reward ratio als decimaal>
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
