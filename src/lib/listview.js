'use strict';

/**
 * Control panel generik: Search · Filters · Group By (gaya Odoo).
 * Query string: q=teks&f=filter1&f=filter2&g=groupby&v=list|kanban
 * Filter dalam grup yang sama digabung OR, antar grup digabung AND.
 */
function arr(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

function buildList(req, rows, cfg) {
  const query = req.query || {};
  const q = String(query.q || '').trim();
  const filters = cfg.filters || [];
  const groupBys = cfg.groupBys || [];
  const hasF = query.f !== undefined;
  const active = hasF ? arr(query.f) : (cfg.defaultFilters || []);
  const groupBy = query.g !== undefined ? String(query.g) : (cfg.defaultGroupBy || '');
  const view = cfg.views && cfg.views.includes(query.v) ? query.v : (cfg.defaultView || 'list');

  let out = rows;
  if (q) {
    const needle = q.toLowerCase();
    out = out.filter((r) => (cfg.search || []).some((k) => String(typeof k === 'function' ? k(r) : r[k] ?? '').toLowerCase().includes(needle)));
  }
  const activeFilters = filters.filter((f) => active.includes(f.key));
  const byGroup = {};
  for (const f of activeFilters) (byGroup[f.group || f.key] = byGroup[f.group || f.key] || []).push(f);
  for (const fs of Object.values(byGroup)) out = out.filter((r) => fs.some((f) => f.test(r)));

  let groups = null;
  const gb = groupBys.find((g) => g.key === groupBy);
  if (gb) {
    const map = new Map();
    for (const r of out) {
      const k = String(gb.value(r) ?? '—');
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    if (gb.order) {
      for (const k of gb.order) if (!map.has(k)) map.set(k, []);
    }
    let keys = [...map.keys()];
    if (gb.order) keys = gb.order.filter((k) => map.has(k)).concat(keys.filter((k) => !gb.order.includes(k)));
    groups = keys.map((k) => ({ key: k, label: k, rows: map.get(k) }));
  }

  const params = (overrides = {}) => {
    const p = new URLSearchParams();
    const state = { q, f: active, g: groupBy, v: view, ...overrides };
    for (const [k, v] of Object.entries(cfg.keep || {})) p.append(k, v);
    if (state.q) p.set('q', state.q);
    const fs = arr(state.f);
    if (fs.length) fs.forEach((f) => p.append('f', f));
    else if (hasF || overrides.f !== undefined) p.append('f', '');
    if (state.g) p.set('g', state.g);
    if (state.v && state.v !== (cfg.defaultView || 'list')) p.set('v', state.v);
    return `?${p.toString()}`;
  };
  const toggleFilter = (key) => params({ f: active.includes(key) ? active.filter((x) => x !== key) : [...active, key] });
  const setGroup = (key) => params({ g: groupBy === key ? '' : key });

  return { rows: out, total: rows.length, groups, q, active, groupBy, view, filters, groupBys, toggleFilter, setGroup, params };
}

module.exports = { buildList, arr };
