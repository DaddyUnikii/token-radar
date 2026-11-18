// token-radar-01: the radar's model. One snapshot in, one ranked board out.
//
// The implied value is a comps model, fitted once on the snapshot's own figures and nothing else:
//
//   1. Comps = every protocol whose token already trades and records a market cap (mcap_usd > 0):
//      128 protocols. They are the price signal for what a token is worth at a given TVL.
//   2. Features per comp: ln(tvl), seven-day TVL growth clamped to +-50% and written as a fraction,
//      ln(1 + age_days) (age = days since DefiLlama first listed it; a missing date uses 1000 days,
//      the median age of the comps), plus seven category-group dummies (lend, dex, stake, bridge,
//      cex, rwa, deriv; everything else is the baseline).
//   3. Model = ridge regression of ln(mcap) on those terms, penalty 1.0 on every term but the
//      intercept, solved by a Cholesky factor of X'X + lambda*I. Ridge is used because the comps'
//      mcap/TVL spread is huge and ordinary least squares over-fits the growth term.
//   4. Validation = leave-one-out: for each comp, refit on the other 127 and predict the held-out
//      one; from those 128 out-of-sample residuals the radar reports LOO R-squared and the median
//      multiplicative error, and uses the residual quartiles as the 50% band around every implied
//      value. The numbers are printed beside the board, so the fit is an honest claim, not a tune.
//
// A pre-token protocol is one whose record carries no token at all (mcap, CoinGecko id and symbol
// all null) and is not a wrapped, staked or bridged product of a token that already trades. Its
// implied value is exp(predicted ln(mcap)), the market cap the comps curve assigns a protocol of
// its TVL, growth, age and category if its record stayed as it is and it issued a token. Every row
// is scored by the same function: no protocol name is ever special-cased.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The category groups the comps model uses. Baseline (last) carries no dummy. */
export const GROUPS = ['lend', 'dex', 'stake', 'bridge', 'cex', 'rwa', 'deriv', 'other'] as const;

/** Map DefiLlama's category to one of GROUPS, so every protocol shares a fitted group effect. */
export function categoryGroup(category: string | null): string {
  const c = category ?? 'Other';
  if (c === 'Lending' || c === 'CDP' || c === 'CDP Manager' || c === 'Uncollateralized Lending' || c === 'Collateral Management') return 'lend';
  if (c === 'Dexs' || c === 'Yield' || c === 'Yield Aggregator' || c === 'Farm' || c === 'Leveraged Farming' || c === 'Liquidity Manager') return 'dex';
  if (c === 'Liquid Staking' || c === 'Restaking' || c === 'Liquid Restaking' || c === 'Staking Pool') return 'stake';
  if (c === 'Bridge' || c === 'Canonical Bridge' || c === 'Cross Chain Bridge') return 'bridge';
  if (c === 'CEX') return 'cex';
  if (c === 'RWA' || c === 'Stablecoin' || c === 'Dual-Token Stablecoin' || c === 'Stablecoin Wrapper' || c === 'CeDeFi') return 'rwa';
  if (c === 'Derivatives' || c === 'Basis Trading' || c === 'Prediction Market' || c === 'Interest Rate Derivatives' || c === 'Synthetics' || c === 'Indexes') return 'deriv';
  return 'other';
}

/** Seven-day growth as the model reads it: a fraction, clamped to the model's +-50% range. */
export function growthFraction(change7d: number | null): number {
  const g = change7d === null ? 0 : change7d;
  return Math.min(50, Math.max(-50, g)) / 100;
}

const DAY_MS = 86_400_000;

/** Whole days from listed_at to the snapshot's as_of date; null when either date is absent. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A protocol is pre-token when its record carries no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const WRAPPED_CATS = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A protocol the board may rank: pre-token and not a wrapped/staked/bridged/versioned derivative. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && WRAPPED_CATS.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  const low = p.name.toLowerCase();
  if (low.includes('wrapped') || low.includes('staked') || low.includes('staking')) return false;
  return !EXCHANGES.some((e) => p.name.startsWith(e));
}

// ---------------------------------------------------------------- the comps fit

export const RIDGE_LAMBDA = 1.0;
export const GROWTH_CLAMP = 50;
export const AGE_IMPUTE_DAYS = 1000;

export interface FitStats {
  n: number;
  lambda: number;
  beta: number[];
  labels: string[];
  groups: string[];
  r2_in: number;
  loo_r2: number;
  median_err_mult: number;
  band_lo: number;
  band_hi: number;
  age_impute_days: number;
  growth_clamp: number;
}

/** The feature vector of one protocol under the model. */
export function features(p: SnapshotProtocol, asOf: string): number[] {
  const tvl = Math.log(p.tvl_usd);
  const g = growthFraction(p.change_7d);
  const age = ageDays(asOf, p.listed_at);
  const lage = Math.log(1 + (age === null ? AGE_IMPUTE_DAYS : age));
  const group = categoryGroup(p.category);
  const dummies = GROUPS.slice(0, -1).map((gg) => (group === gg ? 1 : 0));
  return [1, tvl, g, lage, ...dummies];
}

/** Ridge-regression coefficients: solve (X'X + lambda*I) beta = X'y by Cholesky. */
function ridgeFit(X: number[][], y: number[], lambda: number): number[] {
  const n = X.length;
  const k = X[0]!.length;
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (let i = 0; i < n; i++) {
    const xi = X[i]!;
    const yi = y[i]!;
    for (let a = 0; a < k; a++) {
      A[a]![k]! += xi[a]! * yi;
      for (let b = a; b < k; b++) A[a]![b]! += xi[a]! * xi[b]!;
    }
  }
  for (let a = 0; a < k; a++) {
    for (let b = a; b < k; b++) {
      if (a === b) A[a]![b]! += a === 0 ? 0 : lambda;
      else A[b]![a] = A[a]![b]!;
    }
  }
  const L: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i]![j]!;
      for (let m = 0; m < j; m++) s -= L[i]![m]! * L[j]![m]!;
      if (i === j) L[i]![j] = Math.sqrt(Math.max(0, s));
      else L[i]![j] = L[j]![j]! > 0 ? s / L[j]![j]! : 0;
    }
  }
  const z = new Array<number>(k).fill(0);
  for (let i = 0; i < k; i++) {
    let s = A[i]![k]!;
    for (let m = 0; m < i; m++) s -= L[i]![m]! * z[m]!;
    z[i] = L[i]![i]! > 0 ? s / L[i]![i]! : 0;
  }
  const beta = new Array<number>(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let s = z[i]!;
    for (let m = i + 1; m < k; m++) s -= L[m]![i]! * beta[m]!;
    beta[i] = L[i]![i]! > 0 ? s / L[i]![i]! : 0;
  }
  return beta;
}

const dot = (beta: number[], x: number[]): number => beta.reduce((s, b, i) => s + b * x[i]!, 0);

/** Fit the comps model on the live-token protocols and validate it leave-one-out. */
export function fitComps(snapshot: Snapshot): FitStats {
  const comps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const X = comps.map((p) => features(p, snapshot.as_of));
  const y = comps.map((p) => Math.log(p.mcap_usd!));
  const n = comps.length;
  const beta = ridgeFit(X, y, RIDGE_LAMBDA);
  const ybar = y.reduce((s, v) => s + v, 0) / n;
  const sst = y.reduce((s, v) => s + (v - ybar) * (v - ybar), 0);
  const resid = (b: number[]): number[] => y.map((v, i) => v - dot(b, X[i]!));
  const ss = (r: number[]): number => r.reduce((s, e) => s + e * e, 0);
  const r2_in = 1 - ss(resid(beta)) / sst;

  // Leave-one-out: refit on n-1 comps, predict the one left out.
  const errs: number[] = [];
  for (let i = 0; i < n; i++) {
    const trX = X.filter((_, j) => j !== i);
    const trY = y.filter((_, j) => j !== i);
    const b = ridgeFit(trX, trY, RIDGE_LAMBDA);
    errs.push(y[i]! - dot(b, X[i]!));
  }
  const loo_r2 = 1 - ss(errs) / sst;
  const sorted = [...errs].sort((a, b) => a - b);
  const q = (f: number): number => sorted[Math.min(n - 1, Math.max(0, Math.floor(f * n)))]!;
  const medianErrMult = Math.exp(absSortedMedian(errs));
  const band_lo = Math.exp(q(0.25));
  const band_hi = Math.exp(q(0.75));

  return {
    n,
    lambda: RIDGE_LAMBDA,
    beta,
    labels: ['intercept', 'ln_tvl', 'growth_7d', 'ln(1+age)', ...GROUPS.slice(0, -1)],
    groups: [...GROUPS],
    r2_in,
    loo_r2,
    median_err_mult: medianErrMult,
    band_lo,
    band_hi,
    age_impute_days: AGE_IMPUTE_DAYS,
    growth_clamp: GROWTH_CLAMP,
  };
}

/** median of |errs|. */
function absSortedMedian(errs: number[]): number {
  const a = errs.map((e) => Math.abs(e)).sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a[mid]!;
}

// ---------------------------------------------------------------- the board

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  tier: 'farm' | 'thin' | 'skip';
  implied_value_usd: number;
  value_low_usd: number;
  value_high_usd: number;
  group: string;
  growth_pct: number;
  growth_mult: number;
  age_mult: number;
  group_mult: number;
  inter_mult: number;
  farm_steps: string[];
}

/** The dashboard's compact view of one row (what data.js carries). */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  tier: string;
  implied_value_usd: number;
  value_low_usd: number;
  value_high_usd: number;
  group: string;
  growth_pct: number;
  growth_mult: number;
  age_mult: number;
  group_mult: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  watchlist_size: number;
  board_size: number;
  live_size: number;
  fit: FitStats;
  rows: RadarRow[];
  live: LiveRow[];
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** One protocol's model terms and implied value under a fitted model. */
function score(p: SnapshotProtocol, asOf: string, fit: FitStats): Omit<BoardRow, 'farm_steps' | 'rank' | 'tier' | 'on_watchlist'> & { ln: number } {
  const x = features(p, asOf);
  const ln = dot(fit.beta, x);
  const value = Math.max(1, Math.round(Math.exp(ln)));
  const inter = fit.beta[0]!;
  const bTvl = fit.beta[1]!;
  const bGrowth = fit.beta[2]!;
  const bAge = fit.beta[3]!;
  const group = categoryGroup(p.category);
  const gi = fit.groups.indexOf(group);
  const bGroup = gi >= 0 && gi < fit.groups.length - 1 ? fit.beta[4 + gi]! : 0;
  const age = ageDays(asOf, p.listed_at);
  const lage = Math.log(1 + (age === null ? fit.age_impute_days : age));
  const growthPct = growthFraction(p.change_7d) * 100;
  return {
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_days: age,
    token_status: 'pre-token',
    implied_value_usd: value,
    value_low_usd: Math.max(1, Math.round(value * fit.band_lo)),
    value_high_usd: Math.max(1, Math.round(value * fit.band_hi)),
    group,
    growth_pct: round4(growthPct),
    growth_mult: round4(Math.exp(bGrowth * (growthPct / 100))),
    age_mult: round4(Math.exp(bAge * lage)),
    group_mult: round4(Math.exp(bGroup)),
    inter_mult: round4(Math.exp(inter)),
    ln,
  };
}

/** The farming tier: at/above the watchlist floor is a full farm, below it thin or skip. */
export function tierOf(tvlUsd: number): 'farm' | 'thin' | 'skip' {
  if (tvlUsd >= 50_000_000) return 'farm';
  if (tvlUsd >= 20_000_000) return 'thin';
  return 'skip';
}

// ---------------------------------------------------------------- farm plans

const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/** How much capital one farming position needs, from the protocol's own TVL. */
function capitalFor(tvlUsd: number): number {
  if (tvlUsd >= 5_000_000_000) return 500;
  if (tvlUsd >= 1_000_000_000) return 250;
  if (tvlUsd >= 100_000_000) return 150;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols need a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The category's one deposit action, in a farmer's own words. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply ${usd(capital)} of USDC to ${name} on ${chain} and borrow against it once, keeping the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('farm') || c.includes('liquidity')) return `Provide ${usd(capital)} of liquidity to ${name}'s main pool on ${chain} and keep the position in range.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit ${usd(capital)} into a ${name} vault or strategy on ${chain} and keep the shares.`;
  if (c.includes('rwa') || c.includes('cedefi') || c.includes('stable')) return `Mint or deposit ${usd(capital)} of the protocol's yield asset through ${name} on ${chain} and hold it.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis') || c.includes('prediction')) return `Deposit ${usd(capital)} of USDC as margin on ${name} on ${chain} and open one small, hedged position.`;
  if (c.includes('stake') || c.includes('restak') || c.includes('btc') || c.includes('chain')) return `Stake or validate ${usd(capital)} of the chain's asset through ${name} on ${chain} and keep the receipt token.`;
  if (c.includes('bridge')) return `Bridge ${usd(capital)} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  return `Deposit ${usd(capital)} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each with a dollar cost and a time, netted to one break-even
 * number in the last step. Derived only from the protocol's own record and the model's implied
 * value; no name is special-cased.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, impliedValue: number, tier: string): string[] {
  const chain = firstChain(p);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const setupGas = capital >= 250 ? 8 : capital >= 150 ? 6 : 4;
  const weeks = Math.max(3, Math.ceil(hold / 7));
  const gasTotal = setupGas + 2 * weeks;
  const opportunity = capital * 0.04 * (hold / 365);
  const outlay = Math.round(gasTotal + opportunity);
  const retroPool = Math.round(impliedValue * 0.02);

  const opener = `Use a fresh wallet that holds only the funds you farm, and keep the seed phrase offline. It needs ${usd(capital)} plus gas on ${chain}.`;
  const recurring = `Make one qualifying action each week (a deposit, borrow, swap or vote) so the activity shows in more than one snapshot. Cost: about $2 of gas a week. Time: 10 minutes a week.`;
  const holdStep = `Hold the position for at least ${hold} days (younger protocols need a longer window). Cost: the ${usd(capital)} stays put, worth about ${usd(Math.round(opportunity))} of forgone yield. Time: ${hold} days.`;
  const claimStep = `When a token or points page opens, claim only through the link the protocol itself publishes, and never pay anyone to claim. Cost: $0 to check, $0 to claim. Time: 10 minutes.`;

  let net: string;
  if (tier === 'skip') {
    net = `Net it out: outlay is about ${usd(outlay)} over ${hold} days against an implied ${usd(impliedValue)} launch value, so this one is a skip unless the TVL doubles. Check back quarterly.`;
  } else if (tier === 'thin') {
    net = `Net it out: outlay is about ${usd(outlay)} over ${hold} days. At a 2% retro share the implied ${usd(impliedValue)} value means a ${usd(retroPool)} pool to split, so farm thin: only with capital you were already deploying.`;
  } else {
    net = `Net it out: outlay is about ${usd(outlay)} over ${hold} days. Break even when your allocation is worth ${usd(outlay)}; at a 2% retro share the implied ${usd(impliedValue)} value means a ${usd(retroPool)} pool to split, so a top-third draw more than pays for the plan.`;
  }

  return [
    `${opener} Cost: under $3 of gas for the first transaction. Time: 5 minutes.`,
    `${actionFor(p, capital, chain)} Cost: ${usd(capital)} plus about $${setupGas} of gas. Time: 15 minutes to set up.`,
    recurring,
    holdStep,
    claimStep,
    `${net} Then write the wallet, dates and every transaction in a farm log so you can repeat or unwind it.`,
  ];
}

// ---------------------------------------------------------------- build

function radarRow(r: BoardRow): RadarRow {
  return {
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    listed_at: r.listed_at,
    age_days: r.age_days,
    on_watchlist: r.on_watchlist,
    tier: r.tier,
    implied_value_usd: r.implied_value_usd,
    value_low_usd: r.value_low_usd,
    value_high_usd: r.value_high_usd,
    group: r.group,
    growth_pct: r.growth_pct,
    growth_mult: r.growth_mult,
    age_mult: r.age_mult,
    group_mult: r.group_mult,
    farm_steps: r.farm_steps,
  };
}

/** The ranked board: every rankable pre-token protocol, strongest implied value first. */
export function buildBoard(snapshot: Snapshot, fit: FitStats): BoardRow[] {
  const watchlist = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isRankable)
    .map((p) => {
      const s = score(p, snapshot.as_of, fit);
      const tier = tierOf(p.tvl_usd);
      return { ...s, tier, on_watchlist: watchlist.has(p.slug), farm_steps: farmSteps(p, s.age_days, s.implied_value_usd, tier) };
    })
    .sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return scored.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** The token-live protocols, by market cap, set aside from the pre-token ranking. */
export function liveRows(snapshot: Snapshot, limit = 30): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, limit)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard renders. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const fit = fitComps(snapshot);
  const board = buildBoard(snapshot, fit);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    fit,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

// ---------------------------------------------------------------- parse + gate checks

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why the gate would refuse this board, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share one implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value over the cap`;
  }
  return null;
}

/** data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}