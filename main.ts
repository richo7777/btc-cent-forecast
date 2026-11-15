// btc-cent-forecast-01 entry: 4-hour-ahead BTC point forecast (median estimate).
//
// Model: volatility-aware drift + mild mean reversion, all from the 72h series.
//   1. Take log returns of the 4,320 one-minute closes.
//   2. Recent drift = exponentially weighted mean of the returns, half-life
//      30 minutes (the last ~2 hours dominate, older minutes fade out).
//   3. Shrink the 240-minute drift by 0.5 toward zero: short-horizon
//      momentum is real but noisy, so we only take half of what the recent
//      tape implies.
//   4. Mean reversion: pull 10% of the way from the last close toward the
//      24h mean log price. In a sharp slide this trims the chase; in a
//      flat tape it is near zero.
//   5. Cap the total log move at one 240-minute standard deviation
//      (1-minute realised vol over the last 24h, scaled by sqrt(240)),
//      and never more than 5% in absolute terms. A forecast never runs
//      away on a volatility spike.
//   6. Forecast = last close * exp(capped move), clamped to (0, 10,000,000).
//
// Deterministic: no randomness, no clock, no network, stdlib only.
// Reads every *.in file in $MAKEFUN_INPUT_DIR (else /input) in name order
// and writes one /output/<id>.out per case with exactly one forecast row.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const HALF_LIFE_MIN = 30; // EWMA half-life for the recent drift
const DRIFT_SHRINK = 0.5; // shrink the 240-min drift toward zero
const MR_WEIGHT = 0.1; // mean-reversion pull toward the 24h mean log price
const MR_WINDOW = 1440; // mean-reversion window, minutes (24h)
const VOL_WINDOW = 1440; // realised-vol window, minutes (24h)
const CAP_SIGMAS = 1.0; // cap the log move at this many 240-min sigmas
const MAX_MOVE = 0.05; // absolute safety bound: never move more than 5% in 4h
const HORIZON_MIN = 240;

function ewmaMean(values: number[], halfLife: number): number {
  const decay = Math.pow(0.5, 1 / halfLife);
  let weight = 1;
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    weightedSum += weight * values[i];
    weightTotal += weight;
    weight *= decay;
  }
  return weightTotal === 0 ? 0 : weightedSum / weightTotal;
}

function forecastPrice(prices: number[]): number {
  const clean: number[] = [];
  for (const p of prices) {
    if (Number.isFinite(p) && p > 0) clean.push(p);
  }
  if (clean.length === 0) return 1;
  const last = clean[clean.length - 1];
  if (clean.length < 3) return last;

  const rets: number[] = [];
  for (let i = 0; i + 1 < clean.length; i++) {
    rets.push(Math.log(clean[i + 1] / clean[i]));
  }

  // Recent drift, exponentially weighted toward the newest minutes.
  const mu = ewmaMean(rets, HALF_LIFE_MIN);

  // Realised 1-minute volatility over the last day.
  const recent = rets.slice(-VOL_WINDOW);
  let mean = 0;
  for (const r of recent) mean += r;
  mean /= recent.length;
  let variance = 0;
  for (const r of recent) variance += (r - mean) * (r - mean);
  variance /= recent.length;
  const sd = Math.sqrt(variance);

  // Drift term for the horizon, shrunk toward zero.
  const drift = mu * HORIZON_MIN * DRIFT_SHRINK;

  // Mean reversion toward the 24h mean log price.
  const window = clean.slice(-MR_WINDOW);
  let avgLog = 0;
  for (const p of window) avgLog += Math.log(p);
  avgLog /= window.length;
  const reversion = MR_WEIGHT * (avgLog - Math.log(last));

  // Cap the total move at one horizon standard deviation, and never more
  // than the absolute 5% safety bound, however wild the tape looks.
  const cap = Math.min(CAP_SIGMAS * sd * Math.sqrt(HORIZON_MIN), MAX_MOVE);
  let move = drift + reversion;
  if (move > cap) move = cap;
  if (move < -cap) move = -cap;

  let price = last * Math.exp(move);
  if (!Number.isFinite(price) || price <= 0) price = last;
  if (price >= 10000000) price = 9999999.99;
  // Round to cents; JSON output stays byte-identical across runs.
  return Math.round(price * 100) / 100;
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const names = readdirSync(INPUT_DIR)
    .filter((n) => n.endsWith(".in"))
    .sort();
  for (const name of names) {
    const raw = readFileSync(join(INPUT_DIR, name), "utf8");
    const doc = JSON.parse(raw);
    const id = String(doc.case ?? name.replace(/\.in$/, ""));
    const markets = Array.isArray(doc.markets) ? doc.markets : [];
    const prices =
      markets.length > 0 && Array.isArray(markets[0].prices)
        ? markets[0].prices
        : [];
    const price = forecastPrice(prices);
    const out = JSON.stringify({ forecasts: [{ case: id, price }] });
    writeFileSync(join(OUTPUT_DIR, id + ".out"), out + "\n", "utf8");
  }
}

main();
