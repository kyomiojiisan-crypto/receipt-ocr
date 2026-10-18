// 品目マスタ（OCR修正の登録）: 別名照合・明細抽出・入出力（削除の墓標つき統合）
// Shared by browser (window.ItemMaster) and Node tests.
(function (root) {
  const KEY = 'itemMaster';
  const now = () => Date.now();
  const uid = p => p + now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---- normalization / similarity ----
  function collapseCJK(s) { return s.replace(/([^\x00-\x7F¥￥]) +(?=[^\x00-\x7F¥￥])/g, '$1'); }
  function norm(s) {
    return String(s || '').normalize('NFKC').toLowerCase()
      .replace(/[\s\u3000・･\-ー−‐―_.,、。:;'"`()（）\[\]「」【】*※]/g, '')
      .replace(/×/g, 'x');
  }
  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j), cur = new Array(n + 1);
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }
  function similarity(a, b) { const L = Math.max(a.length, b.length); return L ? 1 - lev(a, b) / L : 1; }
  // short strings must be (almost) exact
  function threshold(len) { return len <= 3 ? 1 : len <= 5 ? 0.8 : 0.75; }

  // ---- store ----
  function empty() { return { version: 1, items: [], tombstones: [] }; }
  function sanitize(m) {
    m = m && typeof m === 'object' ? m : empty();
    m.version = 1; m.items = Array.isArray(m.items) ? m.items : []; m.tombstones = Array.isArray(m.tombstones) ? m.tombstones : [];
    m.items.forEach(it => {
      it.id = it.id || uid('i'); it.mode = it.mode === 'menu' ? 'menu' : 'receipt'; it.name = String(it.name || '').trim();
      it.category = it.category || ''; it.price = it.price === '' || it.price == null ? null : (parseInt(it.price, 10) || null);
      it.created = it.created || now(); it.updated = it.updated || it.created; it.lastUsed = it.lastUsed || null;
      it.aliases = (Array.isArray(it.aliases) ? it.aliases : []).map(a => typeof a === 'string' ? { text: a } : a)
        .filter(a => a && String(a.text || '').trim())
        .map(a => ({ id: a.id || uid('a'), text: String(a.text).trim(), created: a.created || now(), lastUsed: a.lastUsed || null }));
    });
    m.items = m.items.filter(it => it.name);
    return m;
  }
  function load(storage) {
    try { return sanitize(JSON.parse(storage.getItem(KEY) || 'null')); } catch (e) { return empty(); }
  }
  function save(storage, m) { storage.setItem(KEY, JSON.stringify(m)); }

  function findByName(m, mode, name) { const n = norm(name); return m.items.find(it => it.mode === mode && norm(it.name) === n); }
  function addItem(m, { mode, name, category = '', price = null, aliases = [] }) {
    name = String(name || '').trim(); if (!name) return null;
    let it = findByName(m, mode, name);
    const t = now();
    if (!it) {
      it = { id: uid('i'), mode, name, category, price: price ? parseInt(price, 10) : null, aliases: [], created: t, updated: t, lastUsed: null };
      m.items.push(it);
      // re-creating something deleted earlier: its old tombstone no longer applies
      m.tombstones = m.tombstones.filter(s => !(s.type === 'item' && s.mode === mode && norm(s.name) === norm(name)));
    } else {
      if (category) it.category = category;
      if (price) it.price = parseInt(price, 10);
      it.updated = t;
    }
    aliases.forEach(a => addAlias(m, it, a));
    return it;
  }
  function addAlias(m, it, text) {
    text = String(text || '').trim(); const n = norm(text);
    if (!n || n === norm(it.name) || it.aliases.some(a => norm(a.text) === n)) return null;
    const a = { id: uid('a'), text, created: now(), lastUsed: null };
    it.aliases.push(a); it.updated = now();
    m.tombstones = m.tombstones.filter(s => !(s.type === 'alias' && s.itemName && norm(s.itemName) === norm(it.name) && norm(s.text) === n));
    return a;
  }
  // register "OCR原文 -> 品目名" (creates the item if needed)
  function registerCorrection(m, mode, original, name, extra = {}) {
    const it = addItem(m, { mode, name, category: extra.category, price: extra.price });
    if (!it) return null;
    if (original) addAlias(m, it, original);
    it.lastUsed = now();
    return it;
  }
  function deleteItem(m, id) {
    const it = m.items.find(x => x.id === id); if (!it) return false;
    m.items = m.items.filter(x => x.id !== id);
    m.tombstones.push({ type: 'item', id: it.id, mode: it.mode, name: it.name, deletedAt: now() });
    return true;
  }
  function deleteAlias(m, itemId, aliasId) {
    const it = m.items.find(x => x.id === itemId); if (!it) return false;
    const a = it.aliases.find(x => x.id === aliasId); if (!a) return false;
    it.aliases = it.aliases.filter(x => x.id !== aliasId); it.updated = now();
    m.tombstones.push({ type: 'alias', id: a.id, itemId: it.id, itemName: it.name, mode: it.mode, text: a.text, deletedAt: now() });
    return true;
  }
  function lastActivity(it) { return Math.max(it.lastUsed || 0, it.created || 0, ...it.aliases.map(a => a.lastUsed || 0)); }
  function staleItems(m, days, mode) {
    const cut = now() - days * 86400000;
    return m.items.filter(it => (!mode || it.mode === mode) && lastActivity(it) < cut);
  }
  function touch(m, itemId, aliasId) {
    const it = m.items.find(x => x.id === itemId); if (!it) return;
    it.lastUsed = now(); if (aliasId) { const a = it.aliases.find(x => x.id === aliasId); if (a) a.lastUsed = now(); }
  }


  // ---- 仮登録 (provisional; separate key; expires after 24h; never applied silently) ----
  const PROV_KEY = 'itemProvisional';
  const PROV_TTL = 24 * 3600 * 1000;
  function loadProv(storage) {
    try { const l = JSON.parse(storage.getItem(PROV_KEY) || '[]'); return Array.isArray(l) ? l.filter(x => x && x.name) : []; } catch (e) { return []; }
  }
  function saveProv(storage, list) { storage.setItem(PROV_KEY, JSON.stringify(list)); }
  function addProvisional(list, { mode, ocr, name, price }) {
    name = String(name || '').trim(); ocr = String(ocr || '').trim(); if (!name) return null;
    mode = mode === 'menu' ? 'menu' : 'receipt';
    const p = price === '' || price == null ? null : (parseInt(price, 10) || null);
    let e = list.find(x => x.mode === mode && norm(x.ocr) === norm(ocr) && norm(x.name) === norm(name));
    if (e) { if (p) e.price = p; return e; }
    e = { id: uid('p'), mode, ocr, name, price: p, createdAt: now() };
    list.push(e); return e;
  }
  function remainingMs(e, t = now()) { return (e.createdAt || 0) + PROV_TTL - t; }
  function purgeExpired(list, t = now()) {
    const keep = list.filter(e => remainingMs(e, t) > 0);
    const removed = list.length - keep.length; list.length = 0; keep.forEach(e => list.push(e)); return removed;
  }
  function confirmProvisional(m, list, id, edits = {}) {
    const i = list.findIndex(x => x.id === id); if (i < 0) return null;
    const e = { ...list[i], ...edits };
    const it = registerCorrection(m, e.mode, e.ocr, e.name, { price: e.price });
    if (it) list.splice(i, 1);
    return it;
  }
  function discardProvisional(list, id) { const i = list.findIndex(x => x.id === id); if (i < 0) return false; list.splice(i, 1); return true; }
  // suggestion only: best provisional entry for an OCR name (same scoring as matchName)
  function matchProvisional(list, mode, raw) {
    const n = norm(raw); if (n.length < 2) return null; let best = null;
    for (const e of list) {
      if (e.mode !== mode) continue;
      for (const txt of [e.ocr, e.name]) {
        const cn = norm(txt); if (!cn) continue; let score = 0;
        if (cn === n) score = 1; else if (cn.length >= 4 && n.includes(cn)) score = 0.95;
        else { const sm = similarity(n, cn); if (sm >= threshold(Math.min(n.length, cn.length))) score = sm * 0.9; }
        if (score && (!best || score > best.score)) best = { entry: e, score };
      }
    }
    return best;
  }

  // ---- correction of OCR text ----
  const SKIP_LINE = /(合\s*計|小\s*計|総\s*計|お?預|お?釣|消費税|TEL|電話|領収|ありがとう|ポイント|\d{4}\s*[年/.\-]\s*\d)/i;
  function splitLine(line, mode) {
    if (mode === 'receipt') {
      let m = line.match(/^(.*?)(\s*(?:¥|\\|￥)\s*[\dOolI,.;\s]+円?\s*\S{0,2})$/);
      if (m && m[1].trim()) return [m[1], m[2]];
      m = line.match(/^(.*\S)(\s+[\d,.]+\s*円?)$/);
      if (m) return [m[1], m[2]];
      return [line, ''];
    }
    const m = line.match(/^(.*?)(\s*[(（]?\s*\d+(?:\.\d+)?\s*(?:kcal|g|円)\s*[)）]?\s*)$/i);
    return m && m[1].trim() ? [m[1], m[2]] : [line, ''];
  }
  function matchName(m, mode, raw) {
    const n = norm(raw); if (n.length < 2) return null;
    let best = null;
    for (const it of m.items) {
      if (it.mode !== mode) continue;
      const cands = [{ text: it.name, alias: null }].concat(it.aliases.map(a => ({ text: a.text, alias: a })));
      for (const c of cands) {
        const cn = norm(c.text); if (!cn) continue;
        let score = 0, method = '';
        if (cn === n) { score = 1; method = c.alias ? '別名一致' : '品目名一致'; }
        else if (cn.length >= 4 && n.includes(cn)) { score = 0.95; method = c.alias ? '別名を含む' : '品目名を含む'; }
        else { const s = similarity(n, cn); if (s >= threshold(Math.min(n.length, cn.length))) { score = s * 0.9; method = `あいまい一致 ${Math.round(s * 100)}%`; } }
        if (score && (!best || score > best.score)) best = { item: it, alias: c.alias, score, method };
      }
    }
    return best;
  }
  // returns { text, applied:[{from,to,method,itemId,aliasId}] }
  function applyCorrections(m, mode, text, opts = {}) {
    const applied = [];
    const lines = String(text || '').split(/\r?\n/).map(l => collapseCJK(l.normalize('NFKC').replace(/\s+/g, ' ').trim()));
    const out = lines.map((line, idx) => {
      if (!line || (mode === 'receipt' && SKIP_LINE.test(line))) return line;
      const [name, tail] = splitLine(line, mode);
      const hit = matchName(m, mode, name);
      if (!hit) return line;
      if (norm(hit.item.name) !== norm(name)) applied.push({ line: idx, from: name.trim(), to: hit.item.name, method: hit.method, itemId: hit.item.id, aliasId: hit.alias ? hit.alias.id : null });
      if (opts.touch !== false) touch(m, hit.item.id, hit.alias && hit.alias.id);
      return hit.item.name + (tail.trim() ? ' ' + tail.trim() : '');
    });
    return { text: out.join('\n'), applied };
  }

  // ---- receipt line items ----
  const NOT_ITEM = /(合\s*計|小\s*計|総\s*計|お?買\s*上|お?預|お?釣|釣銭|消費税|税\s*額|対象|請求|支払|TOTAL|TEL|電話|領収|ポイント|点数|値引|割引|ありがとう|登録番号|〒|\d{4}\s*[年/.\-]\s*\d{1,2})/i;
  function extractLineItems(text) {
    const items = [];
    const all = String(text || '').split(/\r?\n/);
    for (let idx = 0; idx < all.length; idx++) {
      const raw = all[idx];
      const line = collapseCJK(raw.normalize('NFKC').replace(/\s+/g, ' ').trim());
      if (!line || NOT_ITEM.test(line)) continue;
      const m = line.match(/^(.*?[^\s¥\\\d,.].*?)\s*(?:(¥|\\)\s*)?(\d{1,3}(?:[,.]\d{3})+|\d+)\s*(円)?\s*[*※軽外内A-Z]{0,2}$/);
      if (!m) continue;
      const name = m[1].trim(), price = parseInt(m[3].replace(/[,.]/g, ''), 10);
      const marked = !!(m[2] || m[4]);
      if (!/[ぁ-んァ-ヶ一-龥A-Za-z]/.test(name) || name.length < 2) continue;
      if (!marked && (price < 10 || /^\d/.test(m[3]) && name.length < 3)) continue;
      if (price <= 0 || price > 1000000) continue;
      items.push({ ocr: name, name, price, line: idx });
    }
    return items;
  }

  // ---- export / import ----
  function exportJSON(m) {
    return JSON.stringify({ app: 'receipt-ocr-items', exportedAt: new Date().toISOString(), ...m }, null, 1);
  }
  function tombFor(tombs, type, pred) { return tombs.filter(t => t.type === type && pred(t)).reduce((x, t) => Math.max(x, t.deletedAt || 0), 0); }
  // mode 'merge' (統合) or 'replace' (置き換え). Returns stats.
  function importJSON(m, json, how = 'merge') {
    const inc = sanitize(typeof json === 'string' ? JSON.parse(json) : json);
    const st = { added: 0, updated: 0, aliasesAdded: 0, skippedDeleted: 0, removedByFileTombstone: 0 };
    if (how === 'replace') {
      m.items = inc.items; m.tombstones = inc.tombstones; st.added = inc.items.length; return st;
    }
    const tombs = m.tombstones;
    for (const it of inc.items) {
      const ts = it.updated || it.created || 0;
      const del = tombFor(tombs, 'item', t => t.id === it.id || (t.mode === it.mode && norm(t.name) === norm(it.name)));
      if (del && del >= ts) { st.skippedDeleted++; continue; }
      let cur = m.items.find(x => x.id === it.id) || findByName(m, it.mode, it.name);
      if (!cur) {
        cur = { ...it, aliases: [] }; m.items.push(cur); st.added++;
      } else {
        if ((it.updated || 0) > (cur.updated || 0)) { cur.category = it.category || cur.category; cur.price = it.price ?? cur.price; }
        cur.lastUsed = Math.max(cur.lastUsed || 0, it.lastUsed || 0) || null; st.updated++;
      }
      for (const a of it.aliases) {
        const ad = tombFor(tombs, 'alias', t => t.id === a.id || (norm(t.itemName || '') === norm(cur.name) && norm(t.text) === norm(a.text)));
        if (ad && ad >= (a.created || 0)) { st.skippedDeleted++; continue; }
        const ex = cur.aliases.find(x => x.id === a.id || norm(x.text) === norm(a.text));
        if (ex) { ex.lastUsed = Math.max(ex.lastUsed || 0, a.lastUsed || 0) || null; continue; }
        if (norm(a.text) === norm(cur.name)) continue;
        cur.aliases.push({ ...a }); st.aliasesAdded++;
      }
    }
    // deletions recorded in the file also apply here (if newer than our copy)
    for (const t of inc.tombstones) {
      if (t.type === 'item') {
        const before = m.items.length;
        m.items = m.items.filter(x => !((x.id === t.id || (x.mode === t.mode && norm(x.name) === norm(t.name))) && (x.updated || x.created || 0) <= t.deletedAt));
        st.removedByFileTombstone += before - m.items.length;
      } else if (t.type === 'alias') {
        m.items.forEach(x => { if (x.id === t.itemId || norm(x.name) === norm(t.itemName || '')) {
          const b = x.aliases.length; x.aliases = x.aliases.filter(a => !((a.id === t.id || norm(a.text) === norm(t.text)) && (a.created || 0) <= t.deletedAt)); st.removedByFileTombstone += b - x.aliases.length; } });
      }
      if (!m.tombstones.some(s => s.type === t.type && s.id === t.id)) m.tombstones.push(t);
    }
    // keep tombstones bounded (most recent 2000)
    m.tombstones = m.tombstones.sort((a, b) => b.deletedAt - a.deletedAt).slice(0, 2000);
    return st;
  }

  const api = { PROV_KEY, PROV_TTL, loadProv, saveProv, addProvisional, remainingMs, purgeExpired, confirmProvisional, discardProvisional, matchProvisional, KEY, norm, lev, similarity, collapseCJK, empty, sanitize, load, save, findByName, addItem, addAlias, registerCorrection,
    deleteItem, deleteAlias, staleItems, lastActivity, touch, matchName, applyCorrections, extractLineItems, exportJSON, importJSON };
  if (typeof module !== 'undefined') module.exports = api; else root.ItemMaster = api;
})(this);
