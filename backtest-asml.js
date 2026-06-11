#!/usr/bin/env node
/**
 * ============================================================
 *  ASML.AS INTRADAY PATROON BACKTEST
 * ============================================================
 *  Meet over ~60 dagen (5-minuut candles, Yahoo Finance):
 *
 *  1. OPENING DIP (09:00-09:30)
 *     - diepte, tijdstip, herstel, target-haalbaarheid
 *     - gecorreleerd met VIX (vorige slot) en NDQ futures 08:55
 *     - simulatie van entry-regel: eerste groene candle na dip,
 *       stop = dagslaag - €1, target = entry + €15
 *
 *  2. 15:30 US-OPENING SPIKE/DIP
 *     - beweging 15:30-16:30 t.o.v. koers 15:25
 *     - gecorreleerd met ochtendrichting + NDQ-richting
 *
 *  3. LUNCHDIP (12:00-13:30)
 *  4. POST-ATH AFKOELING (laatste 2 uur na nieuwe 60d-high)
 *
 *  Gebruik:   node backtest-asml.js
 *  Output:    console rapport + asml-backtest.csv + asml-backtest.json
 *  Vereist:   Node 18+ (ingebouwde fetch), geen dependencies
 * ============================================================
 */

const fs = require('fs');

// yahoo-finance2 handelt crumb/cookie-auth af zodat historische
// 5m/60d data niet met 403 wordt geweigerd zoals bij directe fetch
const YF = require('yahoo-finance2').default;
const _yf = new YF({ validation: { logErrors: false } });

const TZ = 'Europe/Amsterdam';
const SYMBOL = 'ASML.AS';
const DIP_MIN_EUR = 2;        // minimaal €2 onder open = dip telt
const TARGET_EUR = 15;        // winstdoel per aandeel
const STOP_BUFFER_EUR = 1;    // stop = diplaag - buffer
const SPIKE_EUR = 8;          // >= €8 omhoog na 15:30 = spike
const STRONG_SPIKE_EUR = 20;

// ---------- tijd helpers ----------
function tsToAms(ts) {
  const d = new Date(ts * 1000);
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d); // "YYYY-MM-DD HH:MM"
  const [date, time] = s.split(' ');
  const [h, m] = time.split(':').map(Number);
  return { date, time, min: h * 60 + m };
}
const M = (h, m = 0) => h * 60 + m; // minuten sinds middernacht

// ---------- data ophalen ----------
const RANGE_DAYS = { '60d': 60, '4mo': 125, '5d': 5, '2d': 2 };

async function fetchChart(symbol, interval, range) {
  const days = RANGE_DAYS[range];
  if (!days) throw new Error(`Onbekende range: ${range}`);
  const period2 = new Date();
  const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  let result;
  try {
    // includePrePost niet op false zetten: Yahoo kan de eerste 30 min van
    // Euronext-aandelen als pre-market markeren waardoor 09:00-09:30 AMS
    // wordt uitgesloten. De analyse-code filtert zelf op reguliere sessie.
    result = await _yf.chart(symbol, { period1, period2, interval });
  } catch (e) {
    throw new Error(`Yahoo ${symbol} ${interval}/${range}: ${e.message}`);
  }

  const quotes = result.quotes || [];
  if (!quotes.length) throw new Error(`Geen data voor ${symbol}`);

  const out = [];
  for (const q of quotes) {
    const { open: o, high: h, low: l, close: c, volume, date } = q;
    if (o == null || h == null || l == null || c == null) continue;
    // quote.date is een JS Date → epoch-seconden → tsToAms voor Amsterdam tijd
    const ts = Math.floor(new Date(date).getTime() / 1000);
    const t = tsToAms(ts);
    out.push({ ts, date: t.date, time: t.time, min: t.min, o, h, l, c, v: volume || 0 });
  }
  return out;
}

function groupByDay(candles) {
  const map = new Map();
  for (const c of candles) {
    if (!map.has(c.date)) map.set(c.date, []);
    map.get(c.date).push(c);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.min - b.min);
  return map;
}

// dichtstbijzijnde candle bij doelminuut (max afwijking ±maxDev)
function candleAt(dayCandles, targetMin, maxDev = 15) {
  let best = null, bestD = Infinity;
  for (const c of dayCandles) {
    const d = Math.abs(c.min - targetMin);
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= maxDev ? best : null;
}

const cumVolBefore = (cs, untilMin) =>
  cs.filter(c => c.min < untilMin).reduce((s, c) => s + c.v, 0);

const round2 = x => (x == null || Number.isNaN(x)) ? null : Math.round(x * 100) / 100;

// ---------- analyse per dag ----------
function analyzeAsmlDay(dayCandles, prevClose) {
  // alleen reguliere sessie 09:00-17:35
  const s = dayCandles.filter(c => c.min >= M(9, 0) && c.min <= M(17, 35));
  if (s.length < 50) return null; // halve dag / kapotte data overslaan

  const open = s[0].o;
  const dayHigh = Math.max(...s.map(c => c.h));
  const dayLow = Math.min(...s.map(c => c.l));
  const close = s[s.length - 1].c;

  // --- Opening momentum: hoe ver omhoog vanaf open in eerste 15/30 min ---
  const win15 = s.filter(c => c.min < M(9, 15));
  const win30 = s.filter(c => c.min < M(9, 30));
  const up15 = Math.max(...win15.map(c => c.h)) - open;
  const up30 = Math.max(...win30.map(c => c.h)) - open;

  // --- Simulatie C: "open en gelijk omhoog" ---
  // entry = slot van de EERSTE 5m candle (realistischer dan de openingsprint:
  // de veilingprijs zelf is voor een particulier zelden te vangen),
  // target = entry + €10, stop = entry - €10, tijdslimiet 10:30 (exit op slot 10:30)
  const simC = { entry: null, result: null, pnl: null, exitTime: null };
  {
    const entry = s[0].c;
    const stop = entry - 10, target = entry + 10;
    simC.entry = round2(entry);
    const afterOpen = s.filter(c => c.min > s[0].min && c.min <= M(10, 30));
    for (const c of afterOpen) {
      if (c.l <= stop) { simC.result = 'STOP'; simC.pnl = -10; simC.exitTime = c.time; break; }
      if (c.h >= target) { simC.result = 'TARGET'; simC.pnl = 10; simC.exitTime = c.time; break; }
    }
    if (!simC.result && afterOpen.length) {
      const last = afterOpen[afterOpen.length - 1];
      simC.result = 'TIJD'; simC.pnl = round2(last.c - entry); simC.exitTime = last.time;
    }
  }

  // --- Fase 1: eerste 5 min omhoog? ---
  const phase1Up = s[0].h - open;

  // --- Opening dip: laagste punt 09:00-09:30 ---
  const dipWin = s.filter(c => c.min < M(9, 30));
  if (!dipWin.length) return null; // vangnet: geen 09:00-09:30 candles (halve dag of data-gat)
  let dip = dipWin[0];
  for (const c of dipWin) if (c.l < dip.l) dip = c;
  const dipDepth = open - dip.l;
  const hasDip = dipDepth >= DIP_MIN_EUR;
  const dipMinute = dip.min - M(9, 0); // minuten na opening

  // --- Herstel na dip (tot 11:00) ---
  const afterDip = s.filter(c => c.min > dip.min && c.min <= M(11, 0));
  const bounceHigh = afterDip.length ? Math.max(...afterDip.map(c => c.h)) : dip.l;
  const recovery = bounceHigh - dip.l;
  const backAboveOpen = bounceHigh >= open;

  // --- Entry-simulatie: eerste groene candle na diplaag ---
  // entry = close van eerste candle met c > o na de dipcandle
  // stop  = diplaag - buffer, target = entry + TARGET_EUR
  let sim = { entry: null, result: null, pnl: null, exitTime: null };
  if (hasDip) {
    const after = s.filter(c => c.min > dip.min);
    const greenIdx = after.findIndex(c => c.c > c.o);
    if (greenIdx >= 0) {
      const entry = after[greenIdx].c;
      const stop = dip.l - STOP_BUFFER_EUR;
      const target = entry + TARGET_EUR;
      sim.entry = round2(entry);
      for (let i = greenIdx + 1; i < after.length; i++) {
        const c = after[i];
        if (c.l <= stop) {            // stop eerst (conservatief bij twijfel)
          sim.result = 'STOP'; sim.pnl = round2(stop - entry); sim.exitTime = c.time; break;
        }
        if (c.h >= target) {
          sim.result = 'TARGET'; sim.pnl = TARGET_EUR; sim.exitTime = c.time; break;
        }
      }
      if (!sim.result) {              // einde dag: sluiten op slot
        sim.result = 'EOD'; sim.pnl = round2(close - entry); sim.exitTime = s[s.length - 1].time;
      }
    }
  }

  // --- Volume benchmarks (cumulatief) ---
  const vol0915 = cumVolBefore(s, M(9, 15));
  const vol0930 = cumVolBefore(s, M(9, 30));
  const vol1000 = cumVolBefore(s, M(10, 0));
  const vol1530 = cumVolBefore(s, M(15, 30));

  // --- 15:30 spike/dip ---
  const ref1525 = candleAt(s, M(15, 25), 10);
  const spikeWin = s.filter(c => c.min >= M(15, 30) && c.min <= M(16, 30));
  let spikeUp = null, spikeDown = null, bullish1525 = null;
  if (ref1525 && spikeWin.length) {
    const ref = ref1525.c;
    spikeUp = Math.max(...spikeWin.map(c => c.h)) - ref;
    spikeDown = ref - Math.min(...spikeWin.map(c => c.l));
    bullish1525 = ref > open;
  }

  // --- Lunchdip 12:00-13:30 ---
  const px12c = candleAt(s, M(12, 0), 10);
  const lunchWin = s.filter(c => c.min >= M(12, 0) && c.min <= M(13, 30));
  let lunchPullback = null;
  if (px12c && lunchWin.length) {
    lunchPullback = px12c.c - Math.min(...lunchWin.map(c => c.l));
  }

  // --- Laatste 2 uur (15:30 -> slot) ---
  const last2h = ref1525 ? close - ref1525.c : null;

  return {
    open: round2(open), close: round2(close),
    dayHigh: round2(dayHigh), dayLow: round2(dayLow),
    prevClose: round2(prevClose),
    gap: prevClose != null ? round2(open - prevClose) : null,
    phase1Up: round2(phase1Up),
    up15: round2(up15), up30: round2(up30), simC,
    hasDip, dipDepth: round2(dipDepth), dipMinute, dipTime: dip.time,
    recovery: round2(recovery), backAboveOpen,
    sim,
    vol0915, vol0930, vol1000, vol1530,
    bullish1525, spikeUp: round2(spikeUp), spikeDown: round2(spikeDown),
    lunchPullback: round2(lunchPullback),
    last2h: round2(last2h),
  };
}

// ---------- NDQ futures context ----------
function buildNqLookup(nqCandles) {
  const byDay = groupByDay(nqCandles);
  return function nqAt(date, targetMin) {
    const day = byDay.get(date);
    if (!day) return null;
    const c = candleAt(day, targetMin, 30);
    return c ? c.c : null;
  };
}

// ---------- VIX context (dagdata) ----------
function buildVixLookup(vixDaily) {
  // vixDaily: candles met 1 per dag; map datum -> close
  const dates = [...new Set(vixDaily.map(c => c.date))].sort();
  const closeByDate = new Map();
  for (const c of vixDaily) closeByDate.set(c.date, c.c);
  return function vixBefore(date) {
    // laatste twee VIX-slotkoersen vóór deze datum
    const prior = dates.filter(d => d < date);
    if (!prior.length) return { prev: null, dir: null };
    const prev = closeByDate.get(prior[prior.length - 1]);
    const prev2 = prior.length > 1 ? closeByDate.get(prior[prior.length - 2]) : null;
    const dir = prev2 == null ? null : (prev < prev2 ? 'dalend' : 'stijgend');
    return { prev: round2(prev), dir };
  };
}

const vixBucket = v => v == null ? 'onbekend' : v < 16 ? '<16' : v <= 17.5 ? '16-17.5' : '>17.5';

// ---------- aggregatie & rapport ----------
const pct = (n, d) => d ? `${Math.round((n / d) * 100)}%` : 'n.v.t.';
const avg = arr => arr.length ? round2(arr.reduce((a, b) => a + b, 0) / arr.length) : null;

function report(days) {
  const L = [];
  const p = x => L.push(x);
  const dipDays = days.filter(d => d.hasDip);

  p('============================================================');
  p(` ASML.AS PATROON BACKTEST — ${days[0].date} t/m ${days[days.length - 1].date}`);
  p(` ${days.length} handelsdagen, 5-minuut data (Yahoo Finance)`);
  p('============================================================');
  p('');
  p('--- 1. OPENING DIP (09:00-09:30) ---');
  p(`Dip aanwezig (>= €${DIP_MIN_EUR} onder open): ${dipDays.length}/${days.length} dagen (${pct(dipDays.length, days.length)})`);
  p(`Gemiddelde dipdiepte:      €${avg(dipDays.map(d => d.dipDepth))}`);
  p(`Mediaan tijdstip diplaag:  ${median(dipDays.map(d => d.dipMinute))} min na opening`);
  p(`Fase 1 (eerste 5 min omhoog >= €1): ${pct(days.filter(d => d.phase1Up >= 1).length, days.length)}`);
  p(`Herstel terug boven open (voor 11:00): ${pct(dipDays.filter(d => d.backAboveOpen).length, dipDays.length)}`);
  p(`Herstel >= €${TARGET_EUR} vanaf diplaag:      ${pct(dipDays.filter(d => d.recovery >= TARGET_EUR).length, dipDays.length)}`);
  p('');
  p('Dipdiepte per VIX-niveau (slot vorige dag):');
  for (const b of ['<16', '16-17.5', '>17.5']) {
    const grp = dipDays.filter(d => vixBucket(d.vixPrev) === b);
    p(`  VIX ${b.padEnd(8)} ${String(grp.length).padStart(2)} dagen   gem. dip €${avg(grp.map(d => d.dipDepth)) ?? '-'}`);
  }
  p('Dipdiepte per NDQ-futures richting (08:55):');
  for (const [label, test] of [['groen', d => d.nqMorningPct > 0], ['rood ', d => d.nqMorningPct <= 0]]) {
    const grp = dipDays.filter(d => d.nqMorningPct != null && test(d));
    p(`  NDQ ${label}    ${String(grp.length).padStart(2)} dagen   gem. dip €${avg(grp.map(d => d.dipDepth)) ?? '-'}`);
  }
  p('');
  p(`--- 2. ENTRY-SIMULATIE (1e groene candle na dip, stop diplaag-€${STOP_BUFFER_EUR}, target +€${TARGET_EUR}) ---`);
  const sims = dipDays.filter(d => d.sim && d.sim.result);
  const wins = sims.filter(d => d.sim.result === 'TARGET');
  const stops = sims.filter(d => d.sim.result === 'STOP');
  const eods = sims.filter(d => d.sim.result === 'EOD');
  p(`Trades gesimuleerd: ${sims.length}`);
  p(`  TARGET geraakt: ${wins.length} (${pct(wins.length, sims.length)})`);
  p(`  STOP geraakt:   ${stops.length} (${pct(stops.length, sims.length)})  gem. verlies €${avg(stops.map(d => d.sim.pnl)) ?? '-'}`);
  p(`  Einde dag:      ${eods.length}  gem. resultaat €${avg(eods.map(d => d.sim.pnl)) ?? '-'}`);
  p(`Som P&L per aandeel over alle trades: €${round2(sims.reduce((s, d) => s + (d.sim.pnl || 0), 0))}`);
  const simsNqGroen = sims.filter(d => d.nqMorningPct > 0);
  p(`Alleen op NDQ-groene ochtenden (${simsNqGroen.length} trades): som €${round2(simsNqGroen.reduce((s, d) => s + (d.sim.pnl || 0), 0))}, winrate ${pct(simsNqGroen.filter(d => d.sim.result === 'TARGET').length, simsNqGroen.length)}`);
  p('');
  p('--- 2b. OPENING MOMENTUM ("opent en gaat gelijk omhoog") ---');
  p(`Max stijging vanaf open, eerste 15 min: gem. €${avg(days.map(d => d.up15))}, mediaan €${median(days.map(d => d.up15))}`);
  p(`Dagen met >= €10 omhoog binnen 15 min: ${pct(days.filter(d => d.up15 >= 10).length, days.length)}`);
  p(`Dagen met >= €10 omhoog binnen 30 min: ${pct(days.filter(d => d.up30 >= 10).length, days.length)}`);
  const simCs = days.filter(d => d.simC && d.simC.result);
  const cWins = simCs.filter(d => d.simC.result === 'TARGET');
  const cStops = simCs.filter(d => d.simC.result === 'STOP');
  const cTime = simCs.filter(d => d.simC.result === 'TIJD');
  p(`Simulatie C (koop slot 1e candle, target +€10, stop -€10, exit 10:30):`);
  p(`  TARGET: ${cWins.length} (${pct(cWins.length, simCs.length)})   STOP: ${cStops.length} (${pct(cStops.length, simCs.length)})   tijd-exit: ${cTime.length} (gem. €${avg(cTime.map(d => d.simC.pnl)) ?? '-'})`);
  p(`  Som P&L per aandeel: €${round2(simCs.reduce((s2, d) => s2 + (d.simC.pnl || 0), 0))}  (excl. spread/slippage — trek daar realistisch €1-2 per trade vanaf)`);
  const simCsGap = simCs.filter(d => d.gap != null && d.gap > 5);
  p(`  Alleen op gap-up dagen (>+€5): ${simCsGap.length} trades, som €${round2(simCsGap.reduce((s2, d) => s2 + (d.simC.pnl || 0), 0))}, winrate ${pct(simCsGap.filter(d => d.simC.result === 'TARGET').length, simCsGap.length)}`);
  p('');
  const spikeData = days.filter(d => d.spikeUp != null);
  p(`Spike >= €${SPIKE_EUR}:  ${pct(spikeData.filter(d => d.spikeUp >= SPIKE_EUR).length, spikeData.length)} van alle dagen (gem. max omhoog €${avg(spikeData.map(d => d.spikeUp))})`);
  p(`Sterke spike >= €${STRONG_SPIKE_EUR}: ${pct(spikeData.filter(d => d.spikeUp >= STRONG_SPIKE_EUR).length, spikeData.length)}`);
  const bull = spikeData.filter(d => d.bullish1525 === true);
  const bear = spikeData.filter(d => d.bullish1525 === false);
  p(`Ochtend bullish (koers 15:25 > open), ${bull.length} dagen:  spike>=€${SPIKE_EUR} in ${pct(bull.filter(d => d.spikeUp >= SPIKE_EUR).length, bull.length)}, gem. omhoog €${avg(bull.map(d => d.spikeUp))}, gem. omlaag €${avg(bull.map(d => d.spikeDown))}`);
  p(`Ochtend bearish, ${bear.length} dagen:                       spike>=€${SPIKE_EUR} in ${pct(bear.filter(d => d.spikeUp >= SPIKE_EUR).length, bear.length)}, gem. omhoog €${avg(bear.map(d => d.spikeUp))}, gem. omlaag €${avg(bear.map(d => d.spikeDown))}`);
  const bullNq = bull.filter(d => d.nq1525Pct != null && d.nq1525Pct > 0);
  p(`Ochtend bullish ÉN NDQ groen om 15:25 (${bullNq.length} dagen): spike>=€${SPIKE_EUR} in ${pct(bullNq.filter(d => d.spikeUp >= SPIKE_EUR).length, bullNq.length)}, gem. omhoog €${avg(bullNq.map(d => d.spikeUp))}`);
  p('');
  p('--- 4. LUNCHDIP (terugval vanaf 12:00 naar laagste punt 12:00-13:30) ---');
  const lunch = days.filter(d => d.lunchPullback != null);
  p(`Gemiddelde terugval: €${avg(lunch.map(d => d.lunchPullback))}`);
  p(`Terugval €5-15 (jouw venster): ${pct(lunch.filter(d => d.lunchPullback >= 5 && d.lunchPullback <= 15).length, lunch.length)} van de dagen`);
  p('');
  p('--- 5. POST-ATH AFKOELING (nieuwe 60d-high die dag) ---');
  const athDays = days.filter(d => d.isNewHigh && d.last2h != null);
  const nonAth = days.filter(d => !d.isNewHigh && d.last2h != null);
  p(`Nieuwe-high dagen: ${athDays.length}   gem. beweging laatste 2 uur: €${avg(athDays.map(d => d.last2h))}`);
  p(`Overige dagen:     ${nonAth.length}   gem. beweging laatste 2 uur: €${avg(nonAth.map(d => d.last2h))}`);
  p('');
  p('--- VOLUME BENCHMARKS (mediaan cumulatief) ---');
  p(`09:15: ${fmtVol(median(days.map(d => d.vol0915)))}   (jouw grens actief: >15K)`);
  p(`09:30: ${fmtVol(median(days.map(d => d.vol0930)))}   (jouw grens richting: >30K)`);
  p(`10:00: ${fmtVol(median(days.map(d => d.vol1000)))}   (jouw grens sterk: >60K)`);
  p(`15:30: ${fmtVol(median(days.map(d => d.vol1530)))}   (jouw grens pre-spike: >150K)`);
  p('============================================================');
  return L.join('\n');
}

function median(arr) {
  const a = arr.filter(x => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}
const fmtVol = v => v == null ? '-' : v >= 1000 ? `${Math.round(v / 1000)}K` : String(v);

// ---------- CSV ----------
function toCsv(days) {
  const cols = ['date', 'open', 'close', 'dayHigh', 'dayLow', 'prevClose', 'gap',
    'phase1Up', 'up15', 'up30', 'simCEntry', 'simCResult', 'simCPnl',
    'hasDip', 'dipDepth', 'dipMinute', 'dipTime', 'recovery', 'backAboveOpen',
    'simEntry', 'simResult', 'simPnl', 'simExitTime',
    'vixPrev', 'vixDir', 'nqMorningPct', 'nq1525Pct',
    'vol0915', 'vol0930', 'vol1000', 'vol1530',
    'bullish1525', 'spikeUp', 'spikeDown', 'lunchPullback', 'last2h', 'isNewHigh'];
  const rows = days.map(d => cols.map(c => {
    if (c === 'simEntry') return d.sim?.entry ?? '';
    if (c === 'simCEntry') return d.simC?.entry ?? '';
    if (c === 'simCResult') return d.simC?.result ?? '';
    if (c === 'simCPnl') return d.simC?.pnl ?? '';
    if (c === 'simResult') return d.sim?.result ?? '';
    if (c === 'simPnl') return d.sim?.pnl ?? '';
    if (c === 'simExitTime') return d.sim?.exitTime ?? '';
    const v = d[c];
    return v == null ? '' : v;
  }).join(';'));
  return [cols.join(';'), ...rows].join('\n');
}

// ---------- backtest runner (herbruikbaar voor CLI én Express-endpoint) ----------
async function runBacktest() {
  console.log('Data ophalen van Yahoo Finance...');
  const [asml, nq, vixDaily] = await Promise.all([
    fetchChart(SYMBOL, '5m', '60d'),
    fetchChart('NQ=F', '5m', '60d').catch(e => { console.warn('NQ=F mislukt:', e.message); return []; }),
    fetchChart('^VIX', '1d', '4mo').catch(e => { console.warn('^VIX mislukt:', e.message); return []; }),
  ]);
  console.log(`ASML: ${asml.length} candles, NQ=F: ${nq.length} candles, VIX: ${vixDaily.length} dagen`);

  const byDay = groupByDay(asml);
  const dates = [...byDay.keys()].sort();
  const nqAt = buildNqLookup(nq);
  const vixBefore = buildVixLookup(vixDaily);

  const days = [];
  let prevClose = null;
  let rollingHigh = -Infinity;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const a = analyzeAsmlDay(byDay.get(date), prevClose);
    if (!a) continue;

    // VIX context
    const vix = vixBefore(date);
    a.vixPrev = vix.prev; a.vixDir = vix.dir;

    // NDQ context: 08:55 vandaag vs 22:00 vorige handelsdag
    const prevDate = days.length ? days[days.length - 1].date : null;
    const nqMorning = nqAt(date, M(8, 55));
    const nqPrevSettle = prevDate ? nqAt(prevDate, M(22, 0)) : null;
    a.nqMorningPct = (nqMorning && nqPrevSettle)
      ? round2(((nqMorning - nqPrevSettle) / nqPrevSettle) * 100) : null;
    const nq1525 = nqAt(date, M(15, 25));
    a.nq1525Pct = (nq1525 && nqPrevSettle)
      ? round2(((nq1525 - nqPrevSettle) / nqPrevSettle) * 100) : null;

    // nieuwe 60d high?
    a.isNewHigh = a.dayHigh > rollingHigh && rollingHigh !== -Infinity;
    rollingHigh = Math.max(rollingHigh, a.dayHigh);

    a.date = date;
    days.push(a);
    prevClose = a.close;
  }

  if (!days.length) throw new Error('Geen bruikbare dagen gevonden.');

  return { days, rapport: report(days), csv: toCsv(days) };
}

// ---------- CLI ----------
async function main() {
  const { days, rapport, csv } = await runBacktest();
  console.log('\n' + rapport);
  fs.writeFileSync('asml-backtest.csv', csv);
  fs.writeFileSync('asml-backtest.json', JSON.stringify(days, null, 2));
  fs.writeFileSync('asml-backtest-rapport.txt', rapport);
  console.log('\nWeggeschreven: asml-backtest.csv, asml-backtest.json, asml-backtest-rapport.txt');
  console.log('Tip: bewaar deze bestanden met datum in de naam en draai het script maandelijks opnieuw om je dataset te laten groeien.');
}

module.exports = { runBacktest, analyzeAsmlDay, groupByDay, tsToAms, buildVixLookup, buildNqLookup, candleAt, report };

if (require.main === module) {
  main().catch(e => { console.error('FOUT:', e.message); process.exit(1); });
}
