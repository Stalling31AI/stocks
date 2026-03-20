const express = require('express');
const yahooFinance = require('yahoo-finance2').default;
yahooFinance.setGlobalConfig({ validation: { logOptionsErrors: false } });
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Interval → yahoo-finance2 params
function getYahooParams(interval) {
  const map = {
    '5m':  { interval: '5m',  range: '5d'  },
    '15m': { interval: '15m', range: '1mo' },
    '1h':  { interval: '1h',  range: '3mo' },
    '1d':  { interval: '1d',  range: '1y'  },
  };
  return map[interval] || map['1d'];
}

// GET /api/quote/:symbol?interval=1d
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { interval = '1d' } = req.query;
    const { interval: yInterval, range } = getYahooParams(interval);

    const result = await yahooFinance.chart(symbol, {
      interval: yInterval,
      range: range,
    }, { validateResult: false });

    const quotes = (result.quotes || [])
      .filter(q => q.open != null && q.close != null && q.high != null && q.low != null)
      .map(q => ({
        date: q.date instanceof Date ? q.date.toISOString() : q.date,
        open:   +q.open.toFixed(4),
        high:   +q.high.toFixed(4),
        low:    +q.low.toFixed(4),
        close:  +q.close.toFixed(4),
        volume: q.volume || 0,
      }));

    res.json({ symbol, interval, meta: result.meta || {}, quotes });
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

    const prompt = `Je bent een professionele technische analist. Analyseer de marktdata voor ${symbol} en geef een concreet handelsadvies.

Aandeel: ${symbol}
Timeframe: ${interval}
Huidige koers: ${fmt(last.close)}

Recente OHLCV (laatste 10 kaarsen):
${recent.slice(-10).map(q => {
  const d = new Date(q.date);
  return `${d.toLocaleDateString('nl-NL')} ${d.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'})} | O:${fmt(q.open)} H:${fmt(q.high)} L:${fmt(q.low)} C:${fmt(q.close)} V:${q.volume}`;
}).join('\n')}

Technische indicatoren:
- RSI(14): ${fmt(indicators.rsi)}
- MACD lijn: ${fmt(indicators.macd?.macd, 4)} | Signaal: ${fmt(indicators.macd?.signal, 4)} | Histogram: ${fmt(indicators.macd?.histogram, 4)}
- Bollinger Bands: Upper ${fmt(indicators.bb?.upper)} | Midden ${fmt(indicators.bb?.middle)} | Lower ${fmt(indicators.bb?.lower)}
- Trend (EMA20 vs EMA50): ${indicators.trend || 'NEUTRAAL'}

Geef ALLEEN het volgende JSON-object terug, geen extra tekst:
{
  "signaal": "KOOP" of "VERKOOP" of "WACHT",
  "vertrouwen": <integer 0-100>,
  "redenering": "<2-3 zinnen onderbouwing in het Nederlands>",
  "entry": <entry prijs als decimaal>,
  "stop_loss": <stop-loss prijs als decimaal>,
  "target": <koersdoel als decimaal>,
  "rr_ratio": <risk/reward ratio als decimaal, bijv. 2.5>
}`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
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
