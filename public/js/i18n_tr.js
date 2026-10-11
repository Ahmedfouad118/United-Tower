// Runtime phrase translator.
// Most screens pass their text through t(key), but a lot of report/form text is
// written directly in Arabic inside the page templates. When the UI language is
// English/Hindi, this swaps those Arabic fragments (from i18n_phrases.json plus
// every Arabic value in the dictionary) for the chosen language, in text nodes
// and in placeholder/title attributes. Whole-word matching keeps names and other
// data that merely contain an Arabic letter run untouched; very short fragments
// only match when they are the entire text of a node.
(function () {
  const AR = /[؀-ۿ]/;
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const state = { lang: null, re: null, map: null, exact: null, pats: [] };
  let phrases = [];

  const unesc = (s) => String(s || '').replace(/\\n/g, '\n');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function build(lang) {
    const map = new Map(), exact = new Map();
    const add = (ar, out) => {
      ar = unesc(ar); out = unesc(out);
      if (!ar || !out || !AR.test(ar) || map.has(ar)) return;
      map.set(ar, out);
      const tr = ar.trim();
      if (tr && !exact.has(tr)) exact.set(tr, out.trim());
    };
    // phrases with {0}/{1} placeholders (server-generated sentences carrying numbers) become regex patterns
    const pats = [];
    for (const p of phrases) {
      if (/\{\d\}/.test(p.ar || '')) {
        if (!p[lang]) continue;
        const src = esc(unesc(p.ar)).replace(/\\\{(\d)\\\}/g, '(-?[0-9][0-9.,]*)');
        const out = unesc(p[lang]);
        pats.push([new RegExp(src, 'g'), (...m) => out.replace(/\{(\d)\}/g, (_, i) => m[Number(i) + 1] ?? '')]);
        continue;
      }
      add(p.ar, p[lang]);
    }
    state.pats = pats;
    // every dictionary value already written in Arabic (nav labels, headings…)
    const D = I18N.getDict();
    for (const k of Object.keys(D.ar)) if (D[lang] && D[lang][k]) add(D.ar[k], D[lang][k]);
    const long = [...map.keys()].filter((k) => k.trim().length >= 4).sort((a, b) => b.length - a.length);
    state.re = long.length
      ? new RegExp('(?<![\\u0621-\\u064A])(?:' + long.map(esc).join('|') + ')(?![\\u0621-\\u064A])', 'g') : null;
    state.map = map; state.exact = exact; state.lang = lang;
  }

  function tr(str) {
    const lang = I18N.getLang();
    if (lang === 'ar' || !str || !AR.test(str) || !phrases.length) return str;
    if (state.lang !== lang) build(lang);
    if (state.pats.length) for (const [re, fn] of state.pats) str = str.replace(re, fn);
    if (!AR.test(str)) return str;
    const trimmed = str.trim();
    if (state.exact.has(trimmed)) { const o = state.exact.get(trimmed); return str.replace(trimmed, () => o); }
    let out = state.re ? str.replace(state.re, (m) => state.map.get(m) ?? m) : str;
    // short fragments (e.g. "يوم" in "5 يوم") only when they are a whole Arabic word-run on their own
    if (AR.test(out)) out = out.replace(/[؀-ۿ]+(?:[ ]+[؀-ۿ]+)*/g, (run) => state.exact.get(run) ?? run);
    return out;
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { const v = tr(root.nodeValue); if (v !== root.nodeValue) root.nodeValue = v; return; }
    if (root.nodeType !== 1 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      const tag = root.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return;
      for (const a of ATTRS) if (root.hasAttribute && root.hasAttribute(a)) { const v = root.getAttribute(a); const n = tr(v); if (n !== v) root.setAttribute(a, n); }
      if (tag === 'TEXTAREA') return;   // its value is the user's own text, but its placeholder is UI
    }
    for (let c = root.firstChild; c; c = c.nextSibling) walk(c);
  }

  // translate an HTML string (used before printing / exporting standalone documents)
  function trHTML(html) {
    if (I18N.getLang() === 'ar' || !AR.test(html || '')) return html;
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    walk(tpl.content);
    return tpl.innerHTML;
  }

  function start() {
    walk(document.body);
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') m.addedNodes.forEach((n) => walk(n));
        else if (m.type === 'characterData') walk(m.target);
        else if (m.type === 'attributes') walk(m.target);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    for (const fn of ['alert', 'confirm', 'prompt']) {
      const orig = window[fn].bind(window);
      window[fn] = (msg, ...rest) => orig(tr(msg), ...rest);
    }
  }

  I18N.tr = tr;
  I18N.trHTML = trHTML;
  const load = (u) => fetch(u).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  Promise.all([load('/js/i18n_phrases.json'), load('/js/i18n_phrases2.json'), load('/js/i18n_phrases3.json'), load('/js/i18n_phrases4.json')]).then(([a, b, c, d]) => { phrases = a.concat(b, c, d).filter((p) => p && p.ar); state.lang = null; start(); })
    .catch(() => { /* untranslated fallback: Arabic stays as is */ });
})();
