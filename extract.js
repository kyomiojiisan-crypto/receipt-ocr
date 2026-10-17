// Receipt field extraction (shared by browser and Node tests)
(function (root) {
  function toHalf(s) {
    return s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[，、]/g, ',').replace(/[．。]/g, '.').replace(/[：]/g, ':')
      .replace(/[￥]/g, '¥').replace(/[／]/g, '/').replace(/[－ー―‐−]/g, m => m)
      .replace(/\u3000/g, ' ')
      .replace(/\\(?=\s*\d)/g, '¥') // tesseract often reads ¥ as backslash
      .replace(/(\d)\s*[;,]\s*[.,]?\s*(\d{3})(?!\d)/g, '$1,$2').replace(/(\d)\s*\.\s+(\d{3})(?!\d)/g, '$1,$2') // '4, 860' -> '4,860'
      .replace(/(¥)\s+(\d)/g, '$1$2');
  }
  // Fix OCR confusions only when adjacent to digits
  function fixDigits(s) {
    let prev;
    do {
      prev = s;
      s = s.replace(/(\d[,.]?)[OoD〇]/g, '$10').replace(/[OoD〇]([,.]?\d)/g, '0$1')
           .replace(/(\d[,.]?)[lI|i!]/g, '$11').replace(/[lI|!]([,.]?\d)/g, '1$1')
           .replace(/(\d[,.]?)[S$]/g, '$15').replace(/[S]([,.]?\d)/g, '5$1')
           .replace(/(\d[,.]?)B/g, '$18');
    } while (s !== prev);
    return s;
  }
  function normalize(text) {
    return text.split(/\r?\n/).map(l => fixDigits(toHalf(l).replace(/([^\x00-\x7F¥]) (?=[^\x00-\x7F¥])/g, '$1')).replace(/\s+/g, ' ').trim()).filter(Boolean);
  }
  const TOTAL_KW = [
    [/ご?請求(額|金額)?/, 100], [/合\s*計/, 90], [/総\s*(合計|計)/, 95], [/お?買\s*上(げ)?(計|金額|合計)?/, 85],
    [/税込(合計|金額)?/, 70], [/お?支払(い)?(金額|合計)?/, 60], [/TOTAL/i, 80]
  ];
  const NEG_KW = /(小\s*計|お?預(か)?り|お?釣|釣銭|内\s*消費税|消費税|税\s*額|対象|ポイント|点数|個数|割引|値引|No\.?|TEL|電話|登録番号|〒)/i;
  function amountsInLine(line) {
    const out = [];
    // amount patterns: ¥1,234 / 1,234円 / 1234 / ¥ 1 234
    const re = /(¥\s*)?(\d{1,3}(?:[,.]\d{3})+|\d+)(\s*円)?/g;
    let m;
    while ((m = re.exec(line))) {
      const raw = m[2];
      // reject dates/times/phone fragments
      const after = line.slice(m.index + m[0].length, m.index + m[0].length + 1);
      const before = line.slice(Math.max(0, m.index - 1), m.index);
      if (/[/:年月日\-]/.test(after) || /[/:\-]/.test(before)) continue;
      if (/^\d+\.\d{1,2}$/.test(raw)) continue;
      const v = parseInt(raw.replace(/[,.]/g, ''), 10);
      if (!isFinite(v) || v <= 0 || v > 10000000) continue;
      const marked = !!(m[1] || m[3]);
      if (!marked && raw.length >= 7 && !/[,.]/.test(raw)) continue; // long bare number: likely id
      out.push({ value: v, marked });
    }
    return out;
  }
  function extractAmount(text) {
    const lines = normalize(text);
    const cands = [];
    lines.forEach((line, i) => {
      const am = amountsInLine(line);
      let kwScore = 0, kwName = '';
      for (const [re, s] of TOTAL_KW) if (re.test(line) && s > kwScore) { kwScore = s; kwName = line.match(re)[0]; }
      const neg = NEG_KW.test(line) && !/(税込|合計)/.test(line.replace(/小\s*計/, ''));
      if (kwScore && !neg) {
        let a = am;
        if (!a.length && lines[i + 1]) a = amountsInLine(lines[i + 1]); // amount on next line
        (a.filter(x => x.marked).length ? a.filter(x => x.marked) : a.slice(-1)).forEach(x => cands.push({ value: x.value, score: kwScore + (x.marked ? 5 : 0) + i * 0.01, reason: kwName, line }));
      } else {
        am.filter(x => x.marked || x.value >= 10).forEach(x => cands.push({ value: x.value, score: (x.marked ? 10 : 1) - (neg ? 20 : 0), reason: neg ? '除外語あり' : (x.marked ? '¥/円付き' : '数字'), line }));
      }
    });
    // 小計と一致する金額は合計の可能性が高い（税込レシート）
    const subVals = new Set();
    lines.forEach(l => { if (/小\s*計/.test(l)) amountsInLine(l).forEach(x => subVals.add(x.value)); });
    cands.forEach(c => { if (subVals.has(c.value) && !/小\s*計/.test(c.line)) { c.score += 15; c.reason += '・小計と一致'; } });
    // merge by value, keep best score
    const map = new Map();
    for (const c of cands) if (!map.has(c.value) || map.get(c.value).score < c.score) map.set(c.value, c);
    let list = [...map.values()];
    const hasKw = list.some(c => c.score >= 50);
    if (!hasKw) {
      // fallback: largest plausible marked amount, then largest any
      list.forEach(c => { if (c.score > 0) c.score += Math.log10(c.value + 1); });
      const best = list.filter(c => c.score > 0).sort((a, b) => b.value - a.value)[0];
      if (best) { best.score += 30; best.reason += '（最大額）'; }
    }
    list.sort((a, b) => b.score - a.score);
    return list.slice(0, 6);
  }
  function extractDate(text) {
    const lines = normalize(text);
    for (const l of lines) {
      let m = l.match(/(20\d{2}|令和\s*\d{1,2}|R\s*\d{1,2})\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})/);
      if (m) {
        let y = m[1];
        if (/^(令和|R)/.test(y)) y = 2018 + parseInt(y.replace(/\D/g, ''), 10);
        const mo = +m[2], d = +m[3];
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31)
          return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
      m = l.match(/(?:^|\D)(\d{2})[/.](\d{1,2})[/.](\d{1,2})(?:\D|$)/);
      if (m && +m[2] <= 12 && +m[3] <= 31) return `20${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    }
    return '';
  }
  function extractStore(text) {
    const lines = normalize(text).slice(0, 6);
    const kw = lines.find(l => /(店|ストア|マート|ホームセンター|薬局|ドラッグ|商店|株式会社|\(株\)|ダイソー|ダイレックス|コメリ|カインズ|DCM|イオン)/.test(l) && !/(TEL|電話|領収|レシート|\d{3,}-)/.test(l));
    if (kw) return kw;
    const first = lines.find(l => /[ぁ-んァ-ン一-龥A-Za-z]{2,}/.test(l) && !/(領収|レシート|いらっしゃい|ありがとう|TEL|〒)/.test(l));
    return first || '';
  }
  function extractAll(text) {
    const amounts = extractAmount(text);
    return { amount: amounts[0] ? amounts[0].value : null, amounts, date: extractDate(text), store: extractStore(text) };
  }
  const api = { normalize, extractAmount, extractDate, extractStore, extractAll };
  if (typeof module !== 'undefined') module.exports = api; else root.ReceiptExtract = api;
})(this);
