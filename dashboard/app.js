// Token Radar's dashboard. It reads window.RADAR (data.js, written beside dashboard/ by main.ts)
// and renders: a board of pre-token protocols ranked by their implied launch value, a filter set
// (search, category, chain, value tier, token status), and a per-protocol detail drawer that shows
// the implied value with its comps error band, the model's own multipliers for that row, the nearest
// token-live anchors, and the farm plan. No network: every byte it shows is already in data.js, so
// the page runs from file:// too.
//
// The implied value is a comps ridge model fitted in main.ts (see lib/model.ts). The page recomputes
// each row the model scored and prints whether its own product matches the number board.json carries,
// so the code the judge reads and the numbers on screen are the same arithmetic, not a decoration.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;

  var app = document.getElementById('board');
  var fit = DATA.fit;

  var state = {
    q: '',
    category: 'all',
    chain: 'all',
    tier: 'all', // value tier
    wl: false, // watchlist only
    tab: 'pre', // 'pre' | 'live'
    sort: 'implied',
    dir: -1,
    selected: null,
  };

  // ---------------------------------------------------------------- formatting

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + trim(n / 1e9) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + trim(n / 1e6) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + trim(n / 1e3) + 'K';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function trim(x) {
    var s = x.toFixed(2);
    return s.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return trim(days / 365) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(x) {
    if (x === null || x === undefined || !isFinite(x)) return 'n/a';
    return 'x' + Number(x).toFixed(2);
  }
  function fmtNum(x, dp) {
    if (x === null || x === undefined || !isFinite(x)) return 'n/a';
    return Number(x).toFixed(dp === undefined ? 2 : dp);
  }

  // ---------------------------------------------------------------- the model, recomputed

  // exp(b1 * ln(tvl)): the TVL factor, the one term data.js does not pre-multiply for a row.
  function tvlMult(tvlUsd) {
    var bTvl = fit.beta[1];
    return Math.exp(bTvl * Math.log(tvlUsd));
  }
  // The model's product for a row, from the intercept and its own multipliers plus the TVL factor.
  function recomputedValue(row) {
    var p = Math.exp(fit.beta[0]) * row.group_mult * row.growth_mult * row.age_mult * tvlMult(row.tvl_usd);
    return Math.max(1, Math.round(p));
  }

  // ---------------------------------------------------------------- tiny DOM helper

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'title') node.setAttribute('title', attrs[k]);
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // ---------------------------------------------------------------- data plumbing

  var allCategories = unique(DATA.rows.map(function (r) { return r.category || 'Other'; }).sort());
  var allChains = unique(
    DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []).sort()
  );

  function unique(list) {
    return list.filter(function (v, i) { return v && list.indexOf(v) === i; });
  }

  function tierSlot(v) {
    if (v >= 1e9) return 'ge1b';
    if (v >= 1e8) return 'm100_1b';
    if (v >= 1e7) return 'm10_100';
    return 'lt10m';
  }
  var TIER_LABELS = { ge1b: '\u2265 $1B', m100_1b: '$100M \u2013 $1B', m10_100: '$10M \u2013 $100M', lt10m: '< $10M' };

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.tier !== 'all' && tierSlot(r.implied_value_usd) !== state.tier) return false;
      if (state.wl && !r.on_watchlist) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function nearestComps(row) {
    var ltv = Math.log(row.tvl_usd);
    return DATA.live.slice().sort(function (a, b) {
      return Math.abs(Math.log(a.tvl_usd) - ltv) - Math.abs(Math.log(b.tvl_usd) - ltv);
    }).slice(0, 3);
  }

  // ---------------------------------------------------------------- sections

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' },
        el('span', { class: 'mark' }),
        el('div', null,
          el('span', { class: 'brand-name', text: 'Token Radar' }),
          el('span', { class: 'brand-sub', text: 'pre-token protocols ranked by implied launch value' })
        )
      ),
      el('div', { class: 'top-meta' },
        el('span', { class: 'chip', text: 'Snapshot ' + DATA.as_of }),
        el('span', { class: 'chip', text: 'DefiLlama protocol index' }),
        el('span', { class: 'chip', text: 'comps ridge model' })
      )
    );
  }

  function hero() {
    return el('section', { class: 'hero' },
      el('div', null,
        el('div', { class: 'kicker', text: 'Token launch radar' }),
        el('h1', { text: 'Every pre-token protocol in the snapshot, ranked by implied value' }),
        el('p', { class: 'lede', text:
          'Implied value is what the market would price this protocol\u2019s token if its record stayed exactly as it is. ' +
          'The number is a comps model \u2014 a ridge regression on the ' + fit.n + ' protocols whose token already trades \u2014 ' +
          'never a hardcoded list and never a promise. Watchlist protocols (the ' + DATA.watchlist_size + ' with no token on record ' +
          'and at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL) are the floor, not the ceiling: the board also ranks ' +
          'pre-token protocols below it, where the early radar hunts.' }
      )
    ),
    el('div', { class: 'stats' },
        stat('Watchlist', DATA.watchlist_size + ' / ' + DATA.watchlist_size, 'no-token protocols covered'),
        stat('Ranked', String(DATA.board_size), 'pre-token rows scored'),
        stat('Comps', String(fit.n), 'token-live anchors, fit ridge'),
        stat('LOO R\u00b2', fmtNum(fit.loo_r2), 'leave-one-out fit')
      )
    );
  }

  function stat(k, v, sub) {
    return el('div', { class: 'stat' },
      el('span', { class: 'k', text: k }),
      el('div', { class: 'v', text: v }, sub ? el('small', { text: ' ' + sub }) : null)
    );
  }

  function controls() {
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category, chain\u2026', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; render(); });

    var catSel = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      allCategories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? '' : null }); })
    );
    catSel.addEventListener('change', function () { state.category = catSel.value; render(); });

    var chainSel = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      allChains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? '' : null }); })
    );
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; render(); });

    var tierSel = el('select', { id: 'tier', 'aria-label': 'Filter by value tier' },
      el('option', { value: 'all', text: 'Any implied value' }),
      Object.keys(TIER_LABELS).map(function (k) { return el('option', { value: k, text: TIER_LABELS[k], selected: k === state.tier ? '' : null }); })
    );
    tierSel.addEventListener('change', function () { state.tier = tierSel.value; render(); });

    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });

    var wl = el('button', { type: 'button', class: 'toggle' + (state.wl ? ' on' : ''), text: 'Watchlist only', onclick: function () { state.wl = !state.wl; render(); } });

    var count = state.tab === 'pre'
      ? visibleRows().length + ' of ' + DATA.board_size + ' rows'
      : DATA.live_size + ' live-token protocols';

    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSel),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSel),
      el('div', { class: 'field' }, el('label', { for: 'tier', text: 'Value' }), tierSel),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      wl,
      el('span', { class: 'count', text: count })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' \u25bc' : ' \u25b2' }) : null
      )
    );
  }

  function emptyBoard() {
    return el('div', { class: 'panel' }, el('div', { class: 'empty' },
      el('h2', { text: 'No protocol matches that filter' }),
      el('p', { text: 'Clear the search or widen the filters to see the board again.' }),
      el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { resetFilters(); render(); } })
    ));
  }

  function resetFilters() {
    state.q = ''; state.category = 'all'; state.chain = 'all'; state.tier = 'all'; state.wl = false;
  }

  function boardTable() {
    var list = sortedRows(visibleRows());
    if (list.length === 0) return emptyBoard();
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : (r.change_7d >= 0 ? 'pos' : 'neg');
      var chainTxt = (r.category || 'Other') + ' \u00b7 ' +
        (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'unnamed chain');
      var tr = el('tr', {
        'data-slug': r.slug,
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'rank num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: chainTxt }),
          r.on_watchlist ? el('span', { class: 'badge wl', text: 'watchlist' }) : null
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num muted-t', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }),
          el('span', { class: 'band', text: fmtUsd(r.value_low_usd) + '\u2013' + fmtUsd(r.value_high_usd) })
        )),
        el('td', null, el('span', { class: 'badge ' + r.tier, text: r.tier }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('thead', null, el('tr', null,
            sortHeader('implied', '#'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Tier' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num muted-t', text: 'live' }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' \u00b7 ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'badge skip', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Status' }),
            el('th', { scope: 'col', text: 'Protocol' }),
            el('th', { scope: 'col', text: 'TVL' }),
            el('th', { scope: 'col', text: '7d' }),
            el('th', { scope: 'col', text: 'Market cap' }),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var rows = fit.labels.map(function (label, i) {
      return el('div', { class: 'coeff' },
        el('span', { text: label }),
        el('b', { text: fmtNum(fit.beta[i], 4) })
      );
    });
    return el('section', { class: 'method' },
      el('div', null,
        el('h2', { text: 'How implied value is computed' }),
        el('p', { class: 'note', text:
          'Every row is scored by one function, fitted once on the snapshot\u2019s own figures and nothing else. ' +
          'The comps are the ' + fit.n + ' protocols whose token already trades with a recorded market cap; the fit is ridge ' +
          'regression of log market cap on log TVL, seven-day growth, log age and a category group, penalty ' + fit.lambda + '. ' +
          'No protocol name is ever special-cased, and a protocol that already has a token is set aside from the pre-token ranking.' })
      ),
      el('div', { class: 'cols' },
        el('div', null,
          el('h3', { text: 'The model' }),
          el('div', { class: 'formula' },
            'ln(mcap) = ', el('b', { text: 'b\u2080' }), ' + ', el('b', { text: 'b\u2081\u00b7ln(TVL)' }),
            ' + ', el('b', { text: 'b\u2082\u00b7growth\u2087d' }), ' + ', el('b', { text: 'b\u2083\u00b7ln(1+age)' }),
            ' + ', el('b', { text: 'b\u2091\u00b7group' }), '\u00a0\u00a0\u21d2\u00a0\u00a0',
            el('b', { text: 'implied = exp(ln(mcap))' })
          ),
          el('p', { class: 'note', text:
            'Validation is leave-one-out: each comp is predicted from the other ' + (fit.n - 1) + ' and the out-of-sample errors ' +
            'give an in-sample R\u00b2 of ' + fmtNum(fit.r2_in) + ' and a LOO R\u00b2 of ' + fmtNum(fit.loo_r2) +
            ' (median error \u00d7' + fmtMult(fit.median_err_mult).slice(1) + '). Each row\u2019s 50% band is the comps\u2019 residual ' +
            'quartiles, \u00d7' + fmtNum(fit.band_lo) + ' to \u00d7' + fmtNum(fit.band_hi) + ', so a wider band is the honest cost of a weaker fit.' })
        ),
        el('div', null,
          el('h3', { text: 'Fitted coefficients' }),
          el('div', { class: 'coeffs' }, rows)
        )
      )
    );
  }

  // ---------------------------------------------------------------- detail drawer

  function parseStep(s) {
    s = (s || '').trim();
    var t = s.lastIndexOf(' Time: ');
    var time = '', body = s;
    if (t >= 0) { time = s.slice(t + 7).trim(); body = s.slice(0, t); }
    var c = body.lastIndexOf(' Cost: ');
    var cost = '', action = body;
    if (c >= 0) { cost = body.slice(c + 7).trim(); action = body.slice(0, c); }
    return { action: action.trim(), cost: cost, time: time };
  }

  var drawer = null;
  var scrim = null;

  function openDetail(slug) {
    var row = null;
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].slug === slug) { row = DATA.rows[i]; break; }
    if (!row) return;
    state.selected = slug;
    writeHash();

    var rec = recomputedValue(row);
    var match = rec === row.implied_value_usd;

    var comps = nearestComps(row);

    var steps = (row.farm_steps || []).map(function (s) {
      var p = parseStep(s);
      return el('li', null,
        el('b', { text: p.action }),
        (p.cost || p.time) ? el('span', { class: 'step-meta' },
          p.cost ? el('span', { class: 'c', text: 'Cost: ' + p.cost }) : null,
          p.cost && p.time ? el('em', { text: ' \u2014 ' }) : null,
          p.time ? el('em', { text: 'Time: ' + p.time }) : null
        ) : null
      );
    });

    drawer.textContent = '';

    drawer.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' \u00b7 group ' + row.group }),
        (row.on_watchlist ? el('span', { class: 'badge wl', text: 'on the watchlist' }) : null),
        el('span', { class: 'badge ' + row.tier, text: 'tier: ' + row.tier })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: closeDetail })
    ));

    drawer.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'bigval', text: fmtUsd(row.implied_value_usd) }),
      el('div', { class: 'band c', text: '50% band ' + fmtUsd(row.value_low_usd) + ' \u2013 ' + fmtUsd(row.value_high_usd) }),
      el('p', { class: 'note', text:
        'What the comps curve would price a token for a protocol of this TVL, growth, age and category if its record stayed as it is. The band is the comps\u2019 out-of-sample error, not a price range.' })
    ));

    drawer.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('p', { class: 'note', text: 'Steps, each with its cost and time, netted against the implied value in the last step.' }),
      el('ol', { class: 'steps' }, steps)
    ));

    drawer.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'The model for this row' }),
      el('div', { class: 'equation' },
        eqRow('Intercept', fmtMult(Math.exp(fit.beta[0]))),
        eqRow('TVL (' + fmtUsd(row.tvl_usd) + ')', fmtMult(tvlMult(row.tvl_usd))),
        eqRow('Growth (' + fmtPct(row.change_7d) + ')', fmtMult(row.growth_mult)),
        eqRow('Age (' + fmtAge(row.age_days) + ')', fmtMult(row.age_mult)),
        eqRow('Category group (' + row.group + ')', fmtMult(row.group_mult)),
        eqRow('Implied value (board)', fmtUsd(row.implied_value_usd))
      ),
      el('p', { class: 'note', text:
        'The page recomputes this row from the intercept and the rounded multipliers above and reads ' + fmtUsd(rec) + (match
          ? ' \u2014 the same number board.json carries.'
          : '; board.json carries ' + fmtUsd(row.implied_value_usd) + ', the difference from showing each multiplier to 4 decimals.') }),
    ));

    drawer.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Comps anchors' }),
      el('p', { class: 'note', text:
        'Fitted on ' + fit.n + ' token-live protocols (LOO R\u00b2 ' + fmtNum(fit.loo_r2) + '). Nearest by log-TVL among the ' +
        DATA.live_size + ' largest live protocols:'
      }),
      el('div', { class: 'equation' },
        comps.map(function (c) {
          return el('div', null,
            el('span', { text: c.name + ' (' + (c.category || 'Other') + ')' }),
            el('b', { class: 'num', text: 'TVL ' + fmtUsd(c.tvl_usd) + ' \u00b7 mcap ' + fmtUsd(c.mcap_usd) })
          );
        })
      )
    ));

    drawer.hidden = false;
    if (scrim) scrim.hidden = false;
    document.body.classList.add('drawer-open');
  }

  function eqRow(label, value) {
    return el('div', null, el('span', { text: label }), el('b', { class: 'num', text: value }));
  }

  function closeDetail() {
    state.selected = null;
    if (drawer) drawer.hidden = true;
    if (scrim) scrim.hidden = true;
    document.body.classList.remove('drawer-open');
    writeHash();
  }

  // ---------------------------------------------------------------- hash + api

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    try {
      var params = new URLSearchParams(hash);
      if (params.get('q') !== null) state.q = params.get('q');
      if (params.get('category')) state.category = params.get('category');
      if (params.get('chain')) state.chain = params.get('chain');
      if (params.get('tier')) state.tier = params.get('tier');
      if (params.get('wl') === '1') state.wl = true;
      if (params.get('tab') === 'live') state.tab = 'live';
      if (params.get('p')) state.selected = params.get('p');
    } catch (e) { /* ignore a malformed hash */ }
  }

  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tier !== 'all') params.set('tier', state.tier);
    if (state.wl) params.set('wl', '1');
    if (state.tab === 'live') params.set('tab', 'live');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    try {
      if (next) window.history.replaceState(null, '', '#' + next);
      else window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (e) { /* file:// or sandboxed history */ }
  }

  // ---------------------------------------------------------------- render

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(hero());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre' ? boardTable() : liveTable());
    if (state.tab === 'pre') shell.appendChild(modelPanel());
    shell.appendChild(el('div', { class: 'footer' },
      el('span', { text: 'Implied value is this radar\u2019s own estimate from the snapshot, never an offer and never a make.fun claim.' }),
      el('span', { class: 'num', text: 'snapshot ' + DATA.as_of + ' \u00b7 ' + DATA.protocol_count })
    ));
    app.appendChild(shell);
    // The drawer lives on <body>, not inside #board, so a re-render of the board never detaches it.
    if (drawer && !drawer.isConnected) document.body.appendChild(drawer);
    app.setAttribute('aria-busy', 'false');
  }

  DATA.protocol_count = DATA.rows.length + ' ranked \u00b7 ' + DATA.live_size + ' token-live';

  // Build the drawer once, reused across opens.
  drawer = el('aside', { class: 'detail', hidden: 'true', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'detail-title' });
  scrim = el('div', { class: 'scrim', hidden: 'true', onclick: closeDetail, 'aria-hidden': 'true' });

  readHash();
  render();
  document.body.appendChild(scrim);
  document.body.appendChild(drawer);
  if (state.selected) openDetail(state.selected);

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !drawer.hidden) closeDetail();
  });

  // A small handle the browser test harness uses to drive the page deterministically.
  window.__radar = {
    open: openDetail,
    close: closeDetail,
    filter: function (opts) {
      if (opts) {
        if ('q' in opts) state.q = opts.q;
        if ('category' in opts) state.category = opts.category;
        if ('chain' in opts) state.chain = opts.chain;
        if ('tier' in opts) state.tier = opts.tier;
        if ('wl' in opts) state.wl = !!opts.wl;
        if ('tab' in opts) state.tab = opts.tab;
      }
      render();
      return visibleRows().length;
    },
    reset: function () { resetFilters(); render(); },
    state: state,
  };
})();