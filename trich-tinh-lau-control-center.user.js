// ==UserScript==
// @name         Trích Tinh Lâu - Control Center Toàn Diện
// @namespace    https://github.com/caccac11/TTL
// @version      1.2.1
// @description  Control Center quản lý truyện + chương + bulk update/create/fix giá + doanh thu. Một chức năng chỉ giữ một workflow tối ưu; đọc form/route thật từ server.
// @match        https://trichtinhlau.com/*
// @homepageURL  https://github.com/caccac11/TTL
// @supportURL   https://github.com/caccac11/TTL/issues
// @updateURL    https://raw.githubusercontent.com/caccac11/TTL/main/trich-tinh-lau-control-center.user.js
// @downloadURL  https://raw.githubusercontent.com/caccac11/TTL/main/trich-tinh-lau-control-center.user.js
// @noframes
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  // Không bao giờ inject Control Center bên trong iframe.
  // Doanh thu dùng iframe cùng domain; nếu không chặn, userscript sẽ
  // tự tạo Control Center lồng trong Control Center.
  if (window.top !== window.self) return;

  if (window.__TTL_CONTROL_CENTER__) return;
  window.__TTL_CONTROL_CENTER__ = true;

  const VERSION = '1.2.1';
  const ORIGIN = location.origin;
  const STORE_KEY = 'ttl-control-center-v1';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const jitter = max => Math.floor(Math.random() * Math.max(0, max));
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  const CFG = {
    getAttempts: 4,
    getTimeoutMs: 25000,
    retryBaseMs: 900,
    requestGapMs: 800,
    bulkCooldownEvery: 10,
    bulkCooldownMs: 3500,
    maxPreviewRows: 250,
    maxLogLines: 600,
    pricing: {
      minPaidWords: 1000,
      maxStars: 10,
      maxDiamonds: 1,
    },
  };

  const state = {
    stories: new Map(),
    storySearchForm: null,
    selectedStoryId: null,
    selectedStory: null,
    storyEditorModel: null,
    chapterCreateModel: null,
    chapters: [],
    chapterMap: new Map(),
    chapterHeaderMap: {},
    chapterLoading: false,
    running: false,
    cancelled: false,
    snapshotCache: new Map(),
    bulk: {
      parsed: [],
      pricing: new Map(),
      existingPricing: new Map(),
      operation: 'price_update',
    },
    log: [],
    activeTab: 'dashboard',

    revenue: {
      loaded: false,
      loading: false,
      updatedAt: null,
      error: '',
      period: '',
      totalKC: null,
      totalSales: null,
      monthKC: null,
      balanceKC: null,
      withdrawableVnd: null,
      withdrawPackage: null,
      minWithdrawPackage: null,
      stories: [],
    },
  };

  // ==========================================================
  // COMMON
  // ==========================================================

  function text(value) {
    return String(value ?? '')
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function norm(value) {
    return text(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd');
  }

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function nowTime() {
    return new Date().toLocaleTimeString();
  }

  function addLog(message, level = 'info') {
    const item = {
      at: new Date().toISOString(),
      time: nowTime(),
      level,
      message: String(message),
    };

    state.log.push(item);
    if (state.log.length > CFG.maxLogLines) {
      state.log.splice(0, state.log.length - CFG.maxLogLines);
    }

    const box = $('#ttlcc-log');
    if (box) {
      const line = document.createElement('div');
      line.className = `ttlcc-log-line ${level}`;
      line.textContent = `[${item.time}] ${item.message}`;
      box.appendChild(line);
      while (box.children.length > CFG.maxLogLines) box.firstChild.remove();
      box.scrollTop = box.scrollHeight;
    }

    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
      `[TTL Control Center] ${message}`
    );
  }

  function toast(message, level = 'info', timeout = 3200) {
    let host = $('#ttlcc-toast-host');
    if (!host) return addLog(message, level);

    const el = document.createElement('div');
    el.className = `ttlcc-toast ${level}`;
    el.textContent = message;
    host.appendChild(el);

    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 220);
    }, timeout);

    addLog(message, level);
  }

  function setStatus(message, level = 'info') {
    const el = $('#ttlcc-status');
    if (!el) return;
    el.className = `ttlcc-status ${level}`;
    el.textContent = message;
  }

  function savePrefs() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          selectedStoryId: state.selectedStoryId,
          activeTab: state.activeTab,
          minimized: $('#ttlcc-panel')?.classList.contains('ttlcc-minimized') || false,
        })
      );
    } catch {}
  }

  function loadPrefs() {
    try {
      const prefs = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');

      // Migration từ v1.0: tab "tools" đã được rút gọn thành "revenue".
      if (prefs.activeTab === 'tools') {
        prefs.activeTab = 'revenue';
      }

      return prefs;
    } catch {
      return {};
    }
  }

  function routeUrl(path) {
    return new URL(path, ORIGIN).href;
  }

  function effectiveFormMethod(form) {
    return String(
      form.querySelector('[name="_method"]')?.value ||
      form.getAttribute('method') ||
      'GET'
    ).toUpperCase();
  }

  function rawFormMethod(form) {
    return String(form.getAttribute('method') || 'GET').toUpperCase();
  }

  function retryable(status) {
    return [408, 425, 429, 500, 502, 503, 504].includes(status);
  }

  function retryAfterMs(res) {
    const raw = res?.headers?.get('Retry-After');
    if (!raw) return 0;
    const sec = Number(raw);
    if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
    const t = Date.parse(raw);
    return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
  }

  async function fetchGet(url, label = 'GET') {
    let last = null;

    for (let attempt = 1; attempt <= CFG.getAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CFG.getTimeoutMs);

      try {
        const res = await fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'follow',
          headers: {
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5',
          },
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.ok || !retryable(res.status) || attempt === CFG.getAttempts) {
          return res;
        }

        const wait = Math.max(
          retryAfterMs(res),
          CFG.retryBaseMs * (2 ** (attempt - 1)) + jitter(450)
        );
        addLog(`${label}: HTTP ${res.status}; retry ${attempt + 1}/${CFG.getAttempts} sau ${Math.ceil(wait / 1000)}s`, 'warn');
        try { await res.body?.cancel(); } catch {}
        await sleep(wait);
      } catch (err) {
        clearTimeout(timer);
        last = err;
        if (attempt === CFG.getAttempts) break;
        const wait = CFG.retryBaseMs * (2 ** (attempt - 1)) + jitter(450);
        addLog(`${label}: ${err?.message || err}; retry ${attempt + 1}/${CFG.getAttempts}`, 'warn');
        await sleep(wait);
      }
    }

    throw new Error(`${label}: ${last?.message || 'GET thất bại'}`);
  }

  async function hiddenNavigateHtml(url, timeoutMs = 18000) {
    return await new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;left:-20000px;top:-20000px;width:2px;height:2px;opacity:0;pointer-events:none;border:0';
      let done = false;

      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { frame.remove(); } catch {}
        fn(value);
      };

      const timer = setTimeout(
        () => finish(reject, new Error('Navigation fallback timeout')),
        timeoutMs
      );

      frame.onload = () => {
        try {
          if (!frame.contentWindow || !frame.contentDocument) return;
          const href = frame.contentWindow.location.href;
          if (!href || href === 'about:blank') return;
          if (!href.startsWith(ORIGIN)) {
            return finish(reject, new Error(`Redirect ngoài domain: ${href}`));
          }
          const html = frame.contentDocument.documentElement?.outerHTML || '';
          if (!html) return finish(reject, new Error('Navigation fallback không đọc được HTML'));
          finish(resolve, { html, finalUrl: href });
        } catch (err) {
          finish(reject, err);
        }
      };

      frame.onerror = () => finish(reject, new Error('Navigation fallback frame error'));
      frame.src = url;
      document.documentElement.appendChild(frame);
    });
  }

  async function fetchHtml(url, label = 'GET page') {
    try {
      const res = await fetchGet(url, label);
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
      const finalUrl = res.url || url;
      if (!finalUrl.startsWith(ORIGIN)) {
        throw new Error(`${label}: phiên đăng nhập có thể đã hết`);
      }
      return {
        html: await res.text(),
        finalUrl,
        status: res.status,
        via: 'fetch',
      };
    } catch (err) {
      addLog(`${label}: fetch không đọc được (${err.message}); thử navigation fallback...`, 'warn');
      const nav = await hiddenNavigateHtml(url);
      return { ...nav, status: 200, via: 'iframe' };
    }
  }

  async function fetchDoc(url, label = 'GET page') {
    const result = await fetchHtml(url, label);
    return {
      ...result,
      doc: new DOMParser().parseFromString(result.html, 'text/html'),
    };
  }

  async function postOnce(url, { body, headers = {}, label = 'POST', rawMethod = 'POST' } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CFG.getTimeoutMs);

    try {
      const res = await fetch(url, {
        method: rawMethod,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'follow',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5',
          ...headers,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
      return res;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  // ==========================================================
  // LIVE FORM ADAPTER
  // ==========================================================

  function controlLabel(el, form) {
    if (!el) return '';

    const id = el.id;
    if (id) {
      const direct = form.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (direct) return text(direct.textContent);
    }

    const parentLabel = el.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input,select,textarea,button').forEach(x => x.remove());
      const t = text(clone.textContent);
      if (t) return t;
    }

    const group = el.closest('.form-group,.mb-3,.mb-2,.row,.col-md-6,.col-md-12');
    if (group) {
      const lab = group.querySelector('label,.col-form-label,.control-label,strong');
      const t = text(lab?.textContent);
      if (t) return t;
    }

    return el.getAttribute('placeholder') || el.name || el.id || '';
  }

  function optionModel(opt) {
    return {
      value: opt.value,
      text: text(opt.textContent),
      selected: opt.selected,
      disabled: opt.disabled,
    };
  }

  function formToModel(form, pageUrl = location.href) {
    const fields = [];

    for (const el of form.elements) {
      const tag = String(el.tagName || '').toLowerCase();
      const type = String(el.type || tag).toLowerCase();
      const name = el.name || '';

      if (['submit', 'button', 'reset', 'image'].includes(type)) continue;
      if (!name) continue;

      fields.push({
        tag,
        type,
        name,
        id: el.id || '',
        label: controlLabel(el, form),
        value: type === 'file' ? '' : (el.value ?? ''),
        checked: !!el.checked,
        required: !!el.required,
        disabled: !!el.disabled,
        readonly: !!el.readOnly,
        multiple: !!el.multiple,
        accept: el.getAttribute('accept') || '',
        min: el.getAttribute('min') || '',
        max: el.getAttribute('max') || '',
        step: el.getAttribute('step') || '',
        placeholder: el.getAttribute('placeholder') || '',
        options: tag === 'select' ? [...el.options].map(optionModel) : [],
      });
    }

    return {
      pageUrl,
      action: new URL(form.getAttribute('action') || pageUrl, pageUrl).href,
      rawMethod: rawFormMethod(form),
      effectiveMethod: effectiveFormMethod(form),
      enctype: form.getAttribute('enctype') || 'application/x-www-form-urlencoded',
      fields,
    };
  }

  function modelField(model, name) {
    return model?.fields?.find(f => f.name === name) || null;
  }

  function modelValue(model, name) {
    const f = modelField(model, name);
    if (!f) return '';
    if (f.type === 'checkbox' || f.type === 'radio') return f.checked ? f.value : '';
    return f.value ?? '';
  }

  function modelToPairs(model) {
    const pairs = [];

    for (const f of model.fields) {
      if (f.disabled || f.type === 'file') continue;
      if ((f.type === 'checkbox' || f.type === 'radio') && !f.checked) continue;

      if (f.tag === 'select' && f.multiple) {
        for (const o of f.options.filter(x => x.selected)) {
          pairs.push([f.name, o.value]);
        }
      } else {
        pairs.push([f.name, f.value ?? '']);
      }
    }

    return pairs;
  }

  function modelToParams(model, overrides = {}) {
    const p = new URLSearchParams();
    for (const [k, v] of modelToPairs(model)) p.append(k, v);

    for (const [k, v] of Object.entries(overrides)) {
      p.delete(k);
      if (Array.isArray(v)) {
        for (const x of v) p.append(k, String(x ?? ''));
      } else if (v !== undefined && v !== null) {
        p.set(k, String(v));
      }
    }

    return p;
  }

  function inputKey(name, index) {
    return `ttlcc-f-${name.replace(/[^a-z0-9_-]/gi, '_')}-${index}`;
  }

  function renderLiveForm(container, model, { title = '', submitText = 'Lưu', onSubmit = null } = {}) {
    container.innerHTML = '';

    if (title) {
      const h = document.createElement('div');
      h.className = 'ttlcc-form-title';
      h.textContent = title;
      container.appendChild(h);
    }

    const form = document.createElement('form');
    form.className = 'ttlcc-live-form';
    form.dataset.action = model.action;
    form.dataset.rawMethod = model.rawMethod;
    form.dataset.effectiveMethod = model.effectiveMethod;
    form.dataset.enctype = model.enctype;

    const hidden = [];
    const groups = new Map();

    model.fields.forEach((f, index) => {
      if (f.type === 'hidden') {
        hidden.push({ f, index });
        return;
      }
      if (['checkbox', 'radio'].includes(f.type)) {
        const key = `${f.type}:${f.name}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ f, index });
        return;
      }
      groups.set(`single:${index}`, [{ f, index }]);
    });

    for (const { f, index } of hidden) {
      const i = document.createElement('input');
      i.type = 'hidden';
      i.name = f.name;
      i.value = f.value ?? '';
      i.disabled = f.disabled;
      form.appendChild(i);
    }

    for (const [key, entries] of groups) {
      const wrap = document.createElement('div');
      const multiCheck = key.startsWith('checkbox:') && entries.length > 1;
      const multiRadio = key.startsWith('radio:') && entries.length > 1;
      wrap.className = multiCheck || multiRadio ? 'ttlcc-field ttlcc-field-wide' : 'ttlcc-field';

      if (multiCheck || multiRadio) {
        const label = document.createElement('div');
        label.className = 'ttlcc-label';
        label.textContent = entries[0].f.name === 'category[]'
          ? 'Thể loại'
          : (entries[0].f.label || entries[0].f.name);
        wrap.appendChild(label);

        const grid = document.createElement('div');
        grid.className = 'ttlcc-choice-grid';

        for (const { f, index } of entries) {
          const l = document.createElement('label');
          l.className = 'ttlcc-choice';
          const i = document.createElement('input');
          i.type = f.type;
          i.name = f.name;
          i.value = f.value ?? '';
          i.checked = f.checked;
          i.disabled = f.disabled;
          i.id = inputKey(f.name, index);
          l.append(i, document.createTextNode(f.label || f.value || f.name));
          grid.appendChild(l);
        }
        wrap.appendChild(grid);
        form.appendChild(wrap);
        continue;
      }

      const { f, index } = entries[0];
      const label = document.createElement('label');
      label.className = 'ttlcc-label';
      label.htmlFor = inputKey(f.name, index);
      label.textContent = f.label || f.name;
      wrap.appendChild(label);

      let el;
      if (f.tag === 'textarea') {
        el = document.createElement('textarea');
        el.value = f.value ?? '';
        if (['content_chapter', 'mota', 'description'].includes(f.name)) {
          wrap.classList.add('ttlcc-field-wide');
          el.rows = f.name === 'content_chapter' ? 16 : 8;
          el.classList.add('ttlcc-code-area');
        }
      } else if (f.tag === 'select') {
        el = document.createElement('select');
        el.multiple = f.multiple;
        for (const o of f.options) {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.text;
          opt.selected = o.selected;
          opt.disabled = o.disabled;
          el.appendChild(opt);
        }
      } else {
        el = document.createElement('input');
        el.type = f.type || 'text';
        if (f.type !== 'file') el.value = f.value ?? '';
        if (f.accept) el.accept = f.accept;
        if (f.min) el.min = f.min;
        if (f.max) el.max = f.max;
        if (f.step) el.step = f.step;
      }

      el.id = inputKey(f.name, index);
      el.name = f.name;
      el.required = f.required;
      el.disabled = f.disabled;
      el.readOnly = f.readonly;
      if (f.placeholder) el.placeholder = f.placeholder;
      wrap.appendChild(el);
      form.appendChild(wrap);
    }

    const actions = document.createElement('div');
    actions.className = 'ttlcc-form-actions ttlcc-field-wide';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'ttlcc-btn ttlcc-btn-primary';
    submit.textContent = submitText;
    actions.appendChild(submit);
    form.appendChild(actions);

    if (onSubmit) {
      form.addEventListener('submit', async e => {
        e.preventDefault();
        await onSubmit(form, model, submit);
      });
    }

    container.appendChild(form);
    return form;
  }

  function panelFormToPayload(form, model) {
    const hasFile = $$('input[type="file"]', form).some(i => i.files?.length);
    const useMultipart = /multipart\/form-data/i.test(model.enctype) || hasFile;

    if (useMultipart) {
      return {
        body: new FormData(form),
        headers: {},
      };
    }

    const fd = new FormData(form);
    const p = new URLSearchParams();
    for (const [k, v] of fd.entries()) {
      if (typeof File !== 'undefined' && v instanceof File) continue;
      p.append(k, String(v));
    }
    return {
      body: p.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    };
  }

  async function submitRenderedForm(form, model, label) {
    const payload = panelFormToPayload(form, model);

    if (model.rawMethod === 'GET') {
      const p = payload.body instanceof FormData
        ? new URLSearchParams([...payload.body.entries()].map(([k, v]) => [k, String(v)]))
        : new URLSearchParams(payload.body);
      const url = new URL(model.action);
      for (const [k, v] of p.entries()) url.searchParams.append(k, v);
      return fetchGet(url.href, label);
    }

    return postOnce(model.action, {
      ...payload,
      rawMethod: model.rawMethod || 'POST',
      label,
    });
  }

  // ==========================================================
  // STORY DISCOVERY / MANAGEMENT
  // ==========================================================

  function nearestStoryContainer(el) {
    return el.closest('tr,.card,.list-group-item,.media,.row,li,.post,.item') || el.parentElement;
  }

  function candidateStoryTitle(container, id) {
    if (!container) return '';

    const preferred = [
      '[class*="title"]',
      '[class*="name"]',
      'h2', 'h3', 'h4', 'strong',
    ];

    for (const sel of preferred) {
      for (const el of container.querySelectorAll(sel)) {
        const t = text(el.textContent);
        if (
          t &&
          t.length >= 2 &&
          t.length <= 180 &&
          !/^(sửa|xóa|chương mới|danh sách chương|đang hiển thị|tạm ẩn)$/i.test(t)
        ) {
          return t;
        }
      }
    }

    const all = text(container.textContent);
    if (all && all.length <= 180) return all;
    return '';
  }

  function parsePublishForm(form, pageUrl) {
    const action = new URL(form.getAttribute('action') || '', pageUrl);
    const m = action.pathname.match(/^\/publishtruyen\/(\d+)\/?$/);
    if (!m) return null;

    const model = formToModel(form, pageUrl);
    const button = form.querySelector('button[type="submit"],input[type="submit"]');
    return {
      storyId: Number(m[1]),
      model,
      label: text(button?.textContent || button?.value || 'Đổi trạng thái'),
      title: button?.getAttribute('title') || '',
      kichhoat: modelValue(model, 'kichhoat'),
    };
  }

  function parseStoriesFromDoc(doc, pageUrl) {
    const map = new Map();

    function ensure(id) {
      id = Number(id);
      if (!Number.isInteger(id) || id <= 0) return null;
      if (!map.has(id)) {
        map.set(id, {
          id,
          title: '',
          editUrl: routeUrl(`/truyen/${id}/edit`),
          chapterUrl: routeUrl(`/chapter/${id}`),
          createChapterUrl: routeUrl(`/createchapter/${id}`),
          publish: null,
          evidence: [],
        });
      }
      return map.get(id);
    }

    for (const form of doc.querySelectorAll('form[action]')) {
      const pub = parsePublishForm(form, pageUrl);
      if (!pub) continue;
      const s = ensure(pub.storyId);
      if (!s) continue;
      s.publish = pub;
      const container = nearestStoryContainer(form);
      const title = candidateStoryTitle(container, s.id);
      if (title && !s.title) s.title = title;
      const confirmText = form.querySelector('[onclick*="confirm"]')?.getAttribute('onclick') || '';
      const cm = confirmText.match(/truyện\s+(.+?)\s+(?:không|khong)\?/i);
      if (cm?.[1]) s.title = text(cm[1]);
      s.evidence.push('publish-form');
    }

    const selectors = [
      ['a[href*="/truyen/"][href$="/edit"]', /\/truyen\/(\d+)\/edit(?:$|[?#])/],
      ['a[href*="/chapter/"]', /\/chapter\/(\d+)(?:$|[?#])/],
      ['a[href*="/createchapter/"]', /\/createchapter\/(\d+)(?:$|[?#])/],
    ];

    for (const [selector, regex] of selectors) {
      for (const a of doc.querySelectorAll(selector)) {
        let href = '';
        try { href = new URL(a.getAttribute('href'), pageUrl).href; } catch { continue; }
        const m = href.match(regex);
        if (!m) continue;
        const s = ensure(m[1]);
        if (!s) continue;
        const container = nearestStoryContainer(a);
        const title = candidateStoryTitle(container, s.id);
        if (title && (!s.title || s.title.startsWith('Truyện #'))) s.title = title;
        s.evidence.push(selector);
      }
    }

    for (const s of map.values()) {
      if (!s.title) s.title = `Truyện #${s.id}`;
    }

    return map;
  }

  async function hydrateStoryTitles(map) {
    const unknown = [...map.values()].filter(s => !s.title || s.title.startsWith('Truyện #'));
    for (let i = 0; i < Math.min(unknown.length, 8); i++) {
      const s = unknown[i];
      try {
        const { doc } = await fetchDoc(s.editUrl, `Đọc tên truyện #${s.id}`);
        const f = [...doc.forms].find(x => x.querySelector('[name="tentruyen"]'));
        const title = f?.querySelector('[name="tentruyen"]')?.value;
        if (title) s.title = text(title);
      } catch {}
      if (i + 1 < unknown.length) await sleep(200);
    }
  }

  function mergeStories(next) {
    for (const [id, s] of next) {
      const prev = state.stories.get(id);
      state.stories.set(id, {
        ...prev,
        ...s,
        title: s.title || prev?.title || `Truyện #${id}`,
        publish: s.publish || prev?.publish || null,
      });
    }
  }

  async function loadStories({ serverSearch = false, query = '' } = {}) {
    setStatus(serverSearch ? 'Đang tìm truyện trên server…' : 'Đang tải danh sách truyện…');

    let doc;
    let pageUrl = routeUrl('/truyen');

    if (!serverSearch) {
      const result = await fetchDoc(pageUrl, 'GET danh sách truyện');
      doc = result.doc;
      pageUrl = result.finalUrl;

      const searchForm = [...doc.forms].find(f => {
        const path = new URL(f.getAttribute('action') || '', pageUrl).pathname;
        return path === '/truyen/search' && f.querySelector('[name="key_search"]');
      });
      if (searchForm) state.storySearchForm = formToModel(searchForm, pageUrl);
    } else {
      if (!state.storySearchForm) await loadStories();
      const p = modelToParams(state.storySearchForm, {
        key_search: query,
        date_start: '',
        date_end: '',
      });
      const res = await postOnce(state.storySearchForm.action, {
        body: p.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        rawMethod: state.storySearchForm.rawMethod || 'POST',
        label: 'POST tìm truyện',
      });
      pageUrl = res.url || state.storySearchForm.action;
      doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    }

    const found = parseStoriesFromDoc(doc, pageUrl);
    await hydrateStoryTitles(found);

    if (!serverSearch) state.stories.clear();
    mergeStories(found);

    renderStoryList();
    setStatus(`Đã nhận ${state.stories.size} truyện.`, 'ok');

    if (!state.selectedStoryId || !state.stories.has(Number(state.selectedStoryId))) {
      const remembered = Number(loadPrefs().selectedStoryId || 0);
      const first = state.stories.get(remembered) || [...state.stories.values()][0] || null;
      if (first) await selectStory(first.id, { loadChaptersNow: true });
    } else {
      state.selectedStory = state.stories.get(Number(state.selectedStoryId));
      renderStoryHeader();
    }

    return found;
  }

  function renderStoryList() {
    const body = $('#ttlcc-story-list');
    if (!body) return;
    body.innerHTML = '';

    const filter = norm($('#ttlcc-story-filter')?.value || '');
    const rows = [...state.stories.values()]
      .filter(s => !filter || norm(`${s.title} ${s.id}`).includes(filter))
      .sort((a, b) => a.id - b.id);

    if (!rows.length) {
      body.innerHTML = '<div class="ttlcc-empty">Không có truyện phù hợp.</div>';
      return;
    }

    for (const story of rows) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `ttlcc-story-item ${Number(state.selectedStoryId) === story.id ? 'active' : ''}`;
      el.innerHTML = `
        <span class="ttlcc-story-title">${esc(story.title)}</span>
        <span class="ttlcc-story-id">#${story.id}</span>
      `;
      el.onclick = () => selectStory(story.id, { loadChaptersNow: true });
      body.appendChild(el);
    }
  }

  function resetBulkForStoryChange() {
    state.bulk.parsed = [];
    state.bulk.pricing.clear();
    state.bulk.existingPricing.clear();
    state.snapshotCache.clear();

    const txt = $('#ttlcc-bulk-text');
    if (txt) txt.value = '';

    for (const id of [
      '#ttlcc-bulk-from',
      '#ttlcc-bulk-to',
      '#ttlcc-price-from',
      '#ttlcc-price-to',
    ]) {
      const el = $(id);
      if (el) el.value = '';
    }

    renderBulkPreview();
  }

  async function selectStory(id, { loadChaptersNow = false } = {}) {
    id = Number(id);

    const previousStoryId = Number(state.selectedStoryId || 0);

    if (previousStoryId && previousStoryId !== id) {
      resetBulkForStoryChange();

      // Không để bảng/chỉ số/chapter template của truyện cũ tồn tại
      // trong lúc truyện mới đang được tải.
      state.chapters = [];
      state.chapterMap.clear();
      state.chapterHeaderMap = {};
      state.chapterCreateModel = null;
      state.storyEditorModel = null;

      addLog(
        `Đổi truyện #${previousStoryId} → #${id}: đã xóa dữ liệu chương/TXT/target Bulk cũ để tránh thao tác nhầm truyện.`,
        'warn'
      );
    }

    const story = state.stories.get(id) || {
      id,
      title: `Truyện #${id}`,
      editUrl: routeUrl(`/truyen/${id}/edit`),
      chapterUrl: routeUrl(`/chapter/${id}`),
      createChapterUrl: routeUrl(`/createchapter/${id}`),
      publish: null,
    };

    state.selectedStoryId = id;
    state.selectedStory = story;
    state.snapshotCache.clear();
    renderStoryList();
    renderStoryHeader();
    savePrefs();

    if (loadChaptersNow) {
      try { await loadChapters(id); } catch (err) { toast(`Không tải được chương: ${err.message}`, 'error', 5000); }
    }
  }

  function renderStoryHeader() {
    const story = state.selectedStory;
    const title = $('#ttlcc-selected-title');
    const sub = $('#ttlcc-selected-sub');
    if (title) title.textContent = story ? story.title : 'Chưa chọn truyện';
    if (sub) sub.textContent = story ? `ID ${story.id}` : 'Hãy chọn truyện từ danh sách';

    const badge = $('#ttlcc-story-badge');
    if (badge) badge.textContent = story ? `#${story.id}` : '—';

    renderDashboard();
  }

  async function loadStoryEditor(mode = 'edit') {
    const host = $('#ttlcc-story-editor');
    if (!host) return;

    if (mode === 'edit' && !state.selectedStoryId) {
      return toast('Chưa chọn truyện.', 'warn');
    }

    host.innerHTML = '<div class="ttlcc-loading">Đang đọc form thật từ server…</div>';

    const url = mode === 'create'
      ? routeUrl('/truyen/create')
      : routeUrl(`/truyen/${state.selectedStoryId}/edit`);

    try {
      const { doc, finalUrl } = await fetchDoc(url, mode === 'create' ? 'GET form tạo truyện' : 'GET form sửa truyện');
      const form = [...doc.forms].find(f => {
        const action = new URL(f.getAttribute('action') || '', finalUrl).pathname;
        return f.querySelector('[name="tentruyen"]') && (
          mode === 'create' ? action === '/truyen' : /^\/truyen\/\d+$/.test(action)
        );
      });

      if (!form) throw new Error('Không tìm thấy form truyện có field tentruyen.');

      const model = formToModel(form, finalUrl);
      state.storyEditorModel = model;

      renderLiveForm(host, model, {
        title: mode === 'create' ? 'Tạo truyện mới' : `Sửa truyện #${state.selectedStoryId}`,
        submitText: mode === 'create' ? 'Tạo truyện' : 'Lưu thay đổi',
        onSubmit: async (uiForm, liveModel, btn) => {
          const action = mode === 'create' ? 'TẠO TRUYỆN MỚI' : `LƯU TRUYỆN #${state.selectedStoryId}`;
          if (!confirm(`${action}\n\nScript sẽ gửi đúng form vừa đọc từ server. Tiếp tục?`)) return;

          btn.disabled = true;
          try {
            const res = await submitRenderedForm(uiForm, liveModel, action);
            toast(`${action}: server đã nhận yêu cầu. Đang re-check…`, 'ok');

            await sleep(500);
            await loadStories();

            if (mode === 'edit') {
              await loadStoryEditor('edit');
            } else {
              switchTab('stories');
            }
          } catch (err) {
            toast(`${action} lỗi: ${err.message}`, 'error', 6000);
          } finally {
            btn.disabled = false;
          }
        },
      });
    } catch (err) {
      host.innerHTML = `
        <div class="ttlcc-error-box">
          Không dựng được form tùy biến: ${esc(err.message)}
          <button class="ttlcc-btn ttlcc-btn-soft" id="ttlcc-story-native-fallback" type="button">Mở form gốc trong Control Center</button>
        </div>`;
      $('#ttlcc-story-native-fallback')?.addEventListener(
        'click',
        () => openNativeTool(url, 'Form truyện gốc')
      );
    }
  }

  async function togglePublishSelected() {
    if (!state.selectedStoryId) return toast('Chưa chọn truyện.', 'warn');

    let story = state.stories.get(Number(state.selectedStoryId));
    if (!story?.publish) {
      await loadStories();
      story = state.stories.get(Number(state.selectedStoryId));
    }

    if (!story?.publish) {
      return toast('Không tìm thấy form publish/ẩn cho truyện này trên danh sách hiện tại.', 'warn', 5000);
    }

    const p = story.publish;
    const msg = `${p.label || 'Đổi trạng thái'} — ${story.title}\n\n${p.title || 'Đây là thao tác thay đổi trạng thái thật trên server.'}`;
    if (!confirm(msg)) return;

    try {
      const params = modelToParams(p.model);
      await postOnce(p.model.action, {
        rawMethod: p.model.rawMethod || 'POST',
        body: params.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        label: `Publish truyện #${story.id}`,
      });
      toast('Đã gửi thay đổi trạng thái. Đang tải lại danh sách…', 'ok');
      await sleep(450);
      await loadStories();
    } catch (err) {
      toast(`Đổi trạng thái lỗi: ${err.message}`, 'error', 6000);
    }
  }

  // ==========================================================
  // CHAPTER LIST / EDIT / CREATE / DELETE
  // ==========================================================

  function mapChapterHeaders(table) {
    const map = {};
    const headers = [...table.querySelectorAll('thead th')].map((th, index) => ({
      index,
      text: norm(th.textContent),
    }));

    function find(key, regex) {
      const h = headers.find(x => regex.test(x.text));
      if (h) map[key] = h.index;
    }

    find('no', /^(#|stt|so thu tu)$/);
    find('title', /ten chuong/);
    find('status', /trang thai/);
    find('slug', /slug/);
    find('words', /so tu/);
    find('pass', /co pass|mat khau|pass/);
    find('stars', /so sao|sao mo khoa/);
    find('diamonds', /kim cuong|kc mo khoa/);
    find('actions', /chuc nang|thao tac/);

    return map;
  }

  function parseIntText(value) {
    return Number(String(value || '').replace(/[^0-9.-]/g, '')) || 0;
  }

  function parseChapterList(doc, pageUrl, storyId) {
    const table = doc.querySelector('#PhanTrang') || [...doc.querySelectorAll('table')].find(t => {
      const hs = norm([...t.querySelectorAll('th')].map(x => x.textContent).join(' | '));
      return hs.includes('ten chuong') && hs.includes('so tu');
    });

    if (!table) throw new Error('Không tìm thấy bảng chương.');

    const hm = mapChapterHeaders(table);
    if (hm.title === undefined || hm.words === undefined) {
      throw new Error('Không map được header Tên chương/Số từ.');
    }

    const deletes = new Map();
    for (const form of doc.querySelectorAll('form[action]')) {
      const action = new URL(form.getAttribute('action'), pageUrl);
      const m = action.pathname.match(/^\/chapter\/(\d+)\/?$/);
      if (!m || effectiveFormMethod(form) !== 'DELETE') continue;
      deletes.set(Number(m[1]), formToModel(form, pageUrl));
    }

    const rows = [];
    let fallbackNo = 0;

    for (const tr of table.querySelectorAll('tbody tr')) {
      const cells = [...tr.querySelectorAll('td')];
      if (!cells.length) continue;

      const edit = tr.querySelector('a[href*="/chapter/"][href*="/edit"]');
      const editHref = edit ? new URL(edit.getAttribute('href'), pageUrl).href : '';
      const mid = editHref.match(/\/chapter\/(\d+)\/edit(?:$|[?#])/);
      if (!mid) continue;
      const chapterId = Number(mid[1]);

      let no = hm.no !== undefined ? parseIntText(cells[hm.no]?.textContent) : 0;
      if (!no) no = ++fallbackNo;
      else fallbackNo = no;

      const title = text(cells[hm.title]?.textContent);
      const row = {
        chapterNo: no,
        chapterId,
        storyId: Number(storyId),
        title,
        status: hm.status !== undefined ? text(cells[hm.status]?.textContent) : '',
        slug: hm.slug !== undefined ? text(cells[hm.slug]?.textContent) : '',
        wordCount: hm.words !== undefined ? parseIntText(cells[hm.words]?.textContent) : 0,
        passLabel: hm.pass !== undefined ? text(cells[hm.pass]?.textContent) : '',
        stars: hm.stars !== undefined ? parseIntText(cells[hm.stars]?.textContent) : 0,
        diamonds: hm.diamonds !== undefined ? parseIntText(cells[hm.diamonds]?.textContent) : 0,
        editUrl: editHref,
        deleteModel: deletes.get(chapterId) || null,
      };
      rows.push(row);
    }

    return {
      headerMap: hm,
      rows: rows.sort((a, b) => a.chapterNo - b.chapterNo),
    };
  }

  async function loadChapters(storyId = state.selectedStoryId) {
    if (!storyId) throw new Error('Chưa chọn truyện.');
    if (state.chapterLoading) return;

    state.chapterLoading = true;
    const listBody = $('#ttlcc-chapter-body');
    if (listBody) listBody.innerHTML = '<tr><td colspan="10" class="ttlcc-loading">Đang tải danh sách chương…</td></tr>';

    try {
      const url = routeUrl(`/chapter/${storyId}`);
      const { doc, finalUrl } = await fetchDoc(url, `GET chương truyện #${storyId}`);
      const parsed = parseChapterList(doc, finalUrl, storyId);

      state.chapters = parsed.rows;
      state.chapterMap = new Map(parsed.rows.map(r => [r.chapterNo, r]));
      state.chapterHeaderMap = parsed.headerMap;
      state.snapshotCache.clear();

      initializeExistingPricing();
      renderChapters();
      renderDashboard();
      renderBulkPreview();
      setStatus(`Đã tải ${state.chapters.length} chương của truyện #${storyId}.`, 'ok');
    } finally {
      state.chapterLoading = false;
    }
  }

  function renderChapters() {
    const body = $('#ttlcc-chapter-body');
    if (!body) return;
    body.innerHTML = '';

    const q = norm($('#ttlcc-chapter-filter')?.value || '');
    const onlyPaid = $('#ttlcc-chapter-paid')?.checked;
    const onlyShort = $('#ttlcc-chapter-short')?.checked;

    const rows = state.chapters.filter(r => {
      if (q && !norm(`${r.chapterNo} ${r.title} ${r.slug} ${r.status}`).includes(q)) return false;
      if (onlyPaid && !(r.stars > 0 || r.diamonds > 0)) return false;
      if (onlyShort && !(r.wordCount > 0 && r.wordCount < CFG.pricing.minPaidWords)) return false;
      return true;
    });

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="10" class="ttlcc-empty">Không có chương phù hợp.</td></tr>';
      return;
    }

    for (const r of rows) {
      const price = r.diamonds > 0 ? `${r.diamonds} KC` : r.stars > 0 ? `${r.stars} sao` : 'FREE';
      const shortPaid = r.wordCount > 0 && r.wordCount < CFG.pricing.minPaidWords && (r.stars > 0 || r.diamonds > 0);
      const tr = document.createElement('tr');
      if (shortPaid) tr.classList.add('ttlcc-row-warn');
      tr.innerHTML = `
        <td>${r.chapterNo}</td>
        <td class="ttlcc-left">${esc(r.title)}</td>
        <td>${esc(r.status || '—')}</td>
        <td>${esc(r.slug || '—')}</td>
        <td>${r.wordCount.toLocaleString()}</td>
        <td>${esc(r.passLabel || '—')}</td>
        <td>${esc(price)}${shortPaid ? '<div class="ttlcc-mini-warn">&lt;1000 từ nhưng đang trả phí</div>' : ''}</td>
        <td class="ttlcc-row-actions">
          <button type="button" class="ttlcc-btn ttlcc-btn-mini ttlcc-btn-soft" data-edit="${r.chapterNo}">Sửa</button>
          <button type="button" class="ttlcc-btn ttlcc-btn-mini ttlcc-btn-danger" data-delete="${r.chapterNo}" ${r.deleteModel ? '' : 'disabled'}>Xóa</button>
        </td>
      `;
      body.appendChild(tr);
    }

    body.querySelectorAll('[data-edit]').forEach(btn => {
      btn.onclick = () => openChapterEditor(Number(btn.dataset.edit));
    });
    body.querySelectorAll('[data-delete]').forEach(btn => {
      btn.onclick = () => deleteChapter(Number(btn.dataset.delete));
    });
  }

  function findChapterForm(doc, mode = 'edit') {
    return [...doc.forms].find(f => {
      const hasCore = f.querySelector('[name="name_chapter"]') && f.querySelector('[name="content_chapter"]');
      if (!hasCore) return false;
      const action = new URL(f.getAttribute('action') || '', ORIGIN).pathname;
      return mode === 'create' ? action === '/chapter' : /^\/chapter\/\d+$/.test(action);
    }) || null;
  }

  async function openChapterEditor(chapterNo) {
    const row = state.chapterMap.get(Number(chapterNo));
    if (!row) return toast(`Không map được chương ${chapterNo}.`, 'error');

    openModal(`Sửa CHƯƠNG ${chapterNo}`, '<div class="ttlcc-loading">Đang đọc form chương…</div>');
    const host = $('#ttlcc-modal-body');

    try {
      const { doc, finalUrl } = await fetchDoc(row.editUrl, `GET edit CHƯƠNG ${chapterNo}`);
      const form = findChapterForm(doc, 'edit');
      if (!form) throw new Error('Không tìm thấy form PUT chương.');
      const model = formToModel(form, finalUrl);

      const ui = renderLiveForm(host, model, {
        title: `${row.title} · ID ${row.chapterId}`,
        submitText: 'Cập nhật chương',
        onSubmit: async (uiForm, liveModel, btn) => {
          if (!confirm(`Cập nhật CHƯƠNG ${chapterNo} thật lên server?`)) return;

          const content = uiForm.querySelector('[name="content_chapter"]')?.value || '';
          const wc = uiForm.querySelector('[name="word_count2"]');
          if (wc) wc.value = String(countWordsFromHtml(content));

          btn.disabled = true;
          try {
            await submitRenderedForm(uiForm, liveModel, `PUT CHƯƠNG ${chapterNo}`);
            toast(`Đã lưu CHƯƠNG ${chapterNo}. Đang re-check…`, 'ok');
            await sleep(450);
            await loadChapters();
            closeModal();
          } catch (err) {
            toast(`Lưu CHƯƠNG ${chapterNo} lỗi: ${err.message}`, 'error', 6000);
          } finally {
            btn.disabled = false;
          }
        },
      });

      bindScheduleFields(ui);
    } catch (err) {
      host.innerHTML = `<div class="ttlcc-error-box">${esc(err.message)}</div>`;
    }
  }

  async function openCreateChapter() {
    if (!state.selectedStoryId) return toast('Chưa chọn truyện.', 'warn');

    openModal('Thêm chương mới', '<div class="ttlcc-loading">Đang đọc form tạo chương…</div>');
    const host = $('#ttlcc-modal-body');

    try {
      const url = routeUrl(`/createchapter/${state.selectedStoryId}`);
      const { doc, finalUrl } = await fetchDoc(url, 'GET form tạo chương');
      const form = findChapterForm(doc, 'create');
      if (!form) throw new Error('Không tìm thấy form POST /chapter.');
      const model = formToModel(form, finalUrl);
      state.chapterCreateModel = model;

      const ui = renderLiveForm(host, model, {
        title: `Truyện #${state.selectedStoryId}`,
        submitText: 'Đăng chương',
        onSubmit: async (uiForm, liveModel, btn) => {
          const name = text(uiForm.querySelector('[name="name_chapter"]')?.value || '');
          if (!name) return toast('Tên chương đang rỗng.', 'warn');
          if (!confirm(`Đăng chương mới "${name}"?`)) return;

          const content = uiForm.querySelector('[name="content_chapter"]')?.value || '';
          const wc = countWordsFromHtml(content);
          const wcEl = uiForm.querySelector('[name="word_count2"]');
          if (wcEl) wcEl.value = String(wc);

          if (wc > 0 && wc < CFG.pricing.minPaidWords) {
            const s = uiForm.querySelector('[name="stars_active"]');
            const d = uiForm.querySelector('[name="diamonds_active"]');
            if (s) s.value = '0';
            if (d) d.value = '0';
          }

          btn.disabled = true;
          try {
            await submitRenderedForm(uiForm, liveModel, 'POST tạo chương');
            toast('Server đã nhận chương mới. Đang xác minh danh sách…', 'ok');
            await sleep(600);
            await loadChapters();
            closeModal();
          } catch (err) {
            toast(`Đăng chương lỗi: ${err.message}`, 'error', 6000);
          } finally {
            btn.disabled = false;
          }
        },
      });

      bindScheduleFields(ui);
    } catch (err) {
      host.innerHTML = `<div class="ttlcc-error-box">${esc(err.message)}</div>`;
    }
  }

  function bindScheduleFields(form) {
    const radios = $$('[name="publish_mode"]', form);
    const at = $('[name="publish_at"]', form);
    if (!radios.length || !at) return;

    const sync = () => {
      const selected = radios.find(r => r.checked)?.value || 'now';
      at.disabled = selected !== 'schedule';
    };
    radios.forEach(r => r.addEventListener('change', sync));
    sync();
  }

  async function deleteChapter(chapterNo) {
    const row = state.chapterMap.get(Number(chapterNo));
    if (!row?.deleteModel) return toast('Không tìm thấy form DELETE thật của chương.', 'error');

    if (!confirm(`XÓA CHƯƠNG ${chapterNo}: ${row.title}\n\nThao tác này không thể hoàn tác. Tiếp tục?`)) return;
    const verify = prompt(`Gõ đúng số chương ${chapterNo} để xác nhận xóa:`);
    if (String(verify).trim() !== String(chapterNo)) {
      return toast('Hủy xóa: mã xác nhận không khớp.', 'warn');
    }

    try {
      const p = modelToParams(row.deleteModel);
      await postOnce(row.deleteModel.action, {
        rawMethod: row.deleteModel.rawMethod || 'POST',
        body: p.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        label: `DELETE CHƯƠNG ${chapterNo}`,
      });
      toast(`Đã gửi xóa CHƯƠNG ${chapterNo}. Đang re-check…`, 'ok');
      await sleep(500);
      await loadChapters();
      if (state.chapterMap.has(Number(chapterNo))) {
        toast(`Re-check: CHƯƠNG ${chapterNo} vẫn còn trên server.`, 'error', 6000);
      }
    } catch (err) {
      toast(`Xóa CHƯƠNG ${chapterNo} lỗi: ${err.message}`, 'error', 6000);
    }
  }

  // ==========================================================
  // BULK CHAPTER ENGINE
  // ==========================================================

  function plainTextToHtml(raw) {
    const input = String(raw || '').replace(/\r\n?/g, '\n').trim();
    if (!input) return '';
    if (/<(?:p|div|br|blockquote|h[1-6]|ul|ol|li|table|pre)\b/i.test(input)) return input;
    return input
      .split('\n')
      .map(x => x.trim())
      .filter(Boolean)
      .map(x => `<p>${esc(x)}</p>`)
      .join('');
  }

  function sanitizeChapterTitle(value, expectedNo = null) {
    let title = text(value);

    for (let i = 0; i < 4; i++) {
      const m = title.match(/^chương\s+(\d+)\s*(?::|：|-|–|—|\.)?\s*(.*)$/i);
      if (!m) break;
      const embedded = Number(m[1]);
      if (expectedNo !== null && Number(expectedNo) !== embedded) {
        throw new Error(`CHƯƠNG ${expectedNo} chứa nhãn CHƯƠNG ${embedded}: dừng để tránh map sai.`);
      }
      title = text(m[2]);
      if (!title) throw new Error(`CHƯƠNG ${expectedNo ?? embedded} không có tên thật.`);
    }

    if (!title) throw new Error(`CHƯƠNG ${expectedNo ?? '?'} có tên rỗng.`);
    return title;
  }

  function parseTxtBatch(raw) {
    const input = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const re = /^Chương\s+(\d+)\s*:\s*(.+?)\s*$/gim;
    const hits = [];
    let m;
    while ((m = re.exec(input))) {
      hits.push({ chapterNo: Number(m[1]), titleRaw: m[2], start: m.index, contentStart: re.lastIndex });
    }
    if (!hits.length) throw new Error('Không tìm thấy tiêu đề dạng "CHƯƠNG X: Tên chương".');

    const out = hits.map((h, i) => {
      const end = i + 1 < hits.length ? hits[i + 1].start : input.length;
      const rawContent = input.slice(h.contentStart, end).trim();
      return {
        chapterNo: h.chapterNo,
        title: sanitizeChapterTitle(h.titleRaw, h.chapterNo),
        rawContent,
        htmlContent: plainTextToHtml(rawContent),
      };
    });

    const seen = new Set();
    for (const x of out) {
      if (seen.has(x.chapterNo)) throw new Error(`Trùng CHƯƠNG ${x.chapterNo} trong TXT.`);
      seen.add(x.chapterNo);
    }
    return out.sort((a, b) => a.chapterNo - b.chapterNo);
  }

  function countWordsFromHtml(html) {
    const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
    const words = text(doc.body.textContent).match(/\S+/g);
    return words ? words.length : 0;
  }

  function normalizeHtml(html) {
    return String(html || '').replace(/\r\n?/g, '\n').replace(/>\s+</g, '><').trim();
  }

  function initializeExistingPricing(reset = false) {
    // existingPricing vừa là snapshot ban đầu vừa là TARGET mà user đang chỉnh.
    // Vì vậy refresh server/re-check KHÔNG được clear target đang chọn;
    // chỉ reset khi user chủ động chuyển vào tác vụ Fix giá.
    if (reset) state.bulk.existingPricing.clear();

    for (const row of state.chapters) {
      if (reset || !state.bulk.existingPricing.has(row.chapterNo)) {
        state.bulk.existingPricing.set(row.chapterNo, rowToPricing(row));
      }
    }
  }

  function rowToPricing(row) {
    if (!row) return { type: 'free', value: 0 };
    if (row.wordCount > 0 && row.wordCount < CFG.pricing.minPaidWords) return { type: 'free', value: 0 };
    if (Number(row.diamonds) > 0) return { type: 'diamond', value: 1 };
    if (Number(row.stars) > 0) return { type: 'stars', value: clamp(Number(row.stars), 1, CFG.pricing.maxStars) };
    return { type: 'free', value: 0 };
  }

  function normalizePricing(p) {
    if (p?.type === 'stars') return { type: 'stars', value: clamp(Math.floor(Number(p.value) || 1), 1, CFG.pricing.maxStars) };
    if (p?.type === 'diamond') return { type: 'diamond', value: 1 };
    return { type: 'free', value: 0 };
  }

  function bulkOperation() {
    return $('#ttlcc-bulk-operation')?.value || state.bulk.operation || 'price_update';
  }

  function bulkItemWordCount(no) {
    const parsed = state.bulk.parsed.find(x => x.chapterNo === Number(no));
    if (parsed) return countWordsFromHtml(parsed.htmlContent);
    return Number(state.chapterMap.get(Number(no))?.wordCount || 0);
  }

  function pricingLocked(no) {
    const words = bulkItemWordCount(no);
    return words > 0 && words < CFG.pricing.minPaidWords;
  }

  function activePriceMap() {
    return bulkOperation() === 'price_update'
      ? state.bulk.existingPricing
      : state.bulk.pricing;
  }

  function getPricing(no) {
    no = Number(no);
    const map = activePriceMap();
    if (pricingLocked(no)) {
      const p = { type: 'free', value: 0 };
      map.set(no, p);
      return p;
    }
    if (!map.has(no)) {
      map.set(no, bulkOperation() === 'price_update' ? rowToPricing(state.chapterMap.get(no)) : { type: 'free', value: 0 });
    }
    return normalizePricing(map.get(no));
  }

  function setPricing(no, type, value = 0) {
    no = Number(no);
    const map = activePriceMap();
    const p = pricingLocked(no) ? { type: 'free', value: 0 } : normalizePricing({ type, value });
    map.set(no, p);
    return p;
  }

  function pricingFields(p, no) {
    if (pricingLocked(no)) return { stars_active: '0', diamonds_active: '0' };
    p = normalizePricing(p);
    if (p.type === 'stars') return { stars_active: String(p.value), diamonds_active: '0' };
    if (p.type === 'diamond') return { stars_active: '0', diamonds_active: '1' };
    return { stars_active: '0', diamonds_active: '0' };
  }

  function pricingLabel(p) {
    p = normalizePricing(p);
    if (p.type === 'stars') return `${p.value} sao`;
    if (p.type === 'diamond') return '1 KC';
    return 'FREE';
  }

  function priceMatchesRow(p, row) {
    p = normalizePricing(p);
    const stars = Number(row?.stars || 0);
    const diamonds = Number(row?.diamonds || 0);
    if (p.type === 'stars') return stars === p.value && diamonds === 0;
    if (p.type === 'diamond') return stars === 0 && diamonds === 1;
    return stars === 0 && diamonds === 0;
  }

  function selectedBulkItems() {
    const from = Number($('#ttlcc-bulk-from')?.value || 0);
    const to = Number($('#ttlcc-bulk-to')?.value || Number.MAX_SAFE_INTEGER);
    const op = bulkOperation();

    if (op === 'price_update') {
      return state.chapters
        .filter(r => r.chapterNo >= from && r.chapterNo <= to)
        .map(r => ({
          chapterNo: r.chapterNo,
          title: r.title,
          htmlContent: '',
          wordCount: r.wordCount,
        }));
    }

    return state.bulk.parsed.filter(x => x.chapterNo >= from && x.chapterNo <= to);
  }

  function applyPricingRange() {
    const from = Number($('#ttlcc-price-from').value);
    const to = Number($('#ttlcc-price-to').value);
    const type = $('#ttlcc-price-type').value;
    const value = Number($('#ttlcc-price-value').value || 0);

    if (!Number.isInteger(from) || !Number.isInteger(to)) return toast('Phạm vi giá không hợp lệ.', 'warn');
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    let count = 0;

    for (const item of selectedBulkItems()) {
      if (item.chapterNo < lo || item.chapterNo > hi) continue;
      setPricing(item.chapterNo, type, value);
      count++;
    }

    toast(`Đã áp giá cho ${count} chương trong dải ${lo}-${hi}.`, 'ok');
    renderBulkPreview();
  }

  function applyAlternating(first = 'stars') {
    const from = Number($('#ttlcc-price-from').value || $('#ttlcc-bulk-from').value);
    const to = Number($('#ttlcc-price-to').value || $('#ttlcc-bulk-to').value);
    const star = clamp(Number($('#ttlcc-price-value').value || 5), 1, CFG.pricing.maxStars);
    const items = selectedBulkItems().filter(x => x.chapterNo >= Math.min(from, to) && x.chapterNo <= Math.max(from, to));
    let idx = 0;
    for (const item of items) {
      if (pricingLocked(item.chapterNo)) {
        setPricing(item.chapterNo, 'free');
        continue;
      }
      const type = idx % 2 === 0 ? first : (first === 'stars' ? 'diamond' : 'stars');
      setPricing(item.chapterNo, type, type === 'stars' ? star : 1);
      idx++;
    }
    renderBulkPreview();
  }

  function renderBulkPreview() {
    const body = $('#ttlcc-bulk-preview');
    if (!body) return;
    body.innerHTML = '';

    const op = bulkOperation();
    const items = selectedBulkItems();
    const maxExisting = state.chapters.length ? Math.max(...state.chapters.map(x => x.chapterNo)) : 0;
    let changed = 0;

    for (const item of items.slice(0, CFG.maxPreviewRows)) {
      const row = state.chapterMap.get(item.chapterNo);
      const p = getPricing(item.chapterNo);
      let status = '';

      if (op === 'price_update') {
        const diff = row && !priceMatchesRow(p, row);
        if (diff) changed++;
        status = !row ? 'KHÔNG THẤY' : diff ? 'SẼ SỬA GIÁ' : 'KHÔNG ĐỔI';
      } else if (op === 'create') {
        status = row || item.chapterNo <= maxExisting ? 'ĐÃ TỒN TẠI' : 'SẼ ĐĂNG';
      } else {
        status = row ? 'SẼ CẬP NHẬT' : 'THIẾU TRÊN WEB';
      }

      const canPrice = ['price_update', 'create'].includes(op);
      const locked = pricingLocked(item.chapterNo);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${item.chapterNo}</td>
        <td class="ttlcc-left">${esc(item.title || row?.title || '')}</td>
        <td>${op === 'price_update' ? Number(row?.wordCount || 0).toLocaleString() : countWordsFromHtml(item.htmlContent).toLocaleString()}</td>
        <td>
          ${canPrice ? (
            locked
              ? '<span class="ttlcc-price-lock">FREE · &lt;1000 từ</span>'
              : `<div class="ttlcc-inline-price">
                   <select data-price-type="${item.chapterNo}">
                     <option value="free" ${p.type === 'free' ? 'selected' : ''}>FREE</option>
                     <option value="stars" ${p.type === 'stars' ? 'selected' : ''}>Sao</option>
                     <option value="diamond" ${p.type === 'diamond' ? 'selected' : ''}>KC</option>
                   </select>
                   <input data-price-value="${item.chapterNo}" type="number" min="1" max="10" value="${p.type === 'stars' ? p.value : p.type === 'diamond' ? 1 : ''}" ${p.type === 'stars' ? '' : 'disabled'}>
                 </div>`
          ) : '—'}
        </td>
        <td><span class="ttlcc-state ${/SẼ/.test(status) ? 'pending' : /KHÔNG ĐỔI/.test(status) ? 'ok' : /THIẾU|ĐÃ TỒN TẠI/.test(status) ? 'bad' : ''}">${esc(status)}</span></td>
      `;
      body.appendChild(tr);
    }

    body.querySelectorAll('[data-price-type]').forEach(sel => {
      sel.onchange = () => {
        const no = Number(sel.dataset.priceType);
        const input = body.querySelector(`[data-price-value="${no}"]`);
        const p = setPricing(no, sel.value, Number(input?.value || 1));
        if (input) {
          input.disabled = p.type !== 'stars';
          input.value = p.type === 'stars' ? p.value : p.type === 'diamond' ? 1 : '';
        }
        renderBulkPreview();
      };
    });

    body.querySelectorAll('[data-price-value]').forEach(inp => {
      inp.onchange = () => {
        const no = Number(inp.dataset.priceValue);
        setPricing(no, 'stars', Number(inp.value));
        renderBulkPreview();
      };
    });

    const summary = $('#ttlcc-bulk-summary');
    if (summary) {
      const missing = items.filter(x => !state.chapterMap.has(x.chapterNo)).length;
      summary.textContent = op === 'price_update'
        ? `${items.length} chương trong phạm vi · ${changed} chương sẽ đổi giá`
        : op === 'create'
          ? `${items.length} chương từ TXT · chương cuối web: ${maxExisting}`
          : `${items.length} chương từ TXT · thiếu trên web: ${missing}`;
    }
  }

  async function fetchChapterSnapshot(row, fresh = false) {
    if (!fresh && state.snapshotCache.has(row.chapterId)) return state.snapshotCache.get(row.chapterId);
    const { doc, finalUrl } = await fetchDoc(row.editUrl, `GET snapshot CHƯƠNG ${row.chapterNo}`);
    const form = findChapterForm(doc, 'edit');
    if (!form) throw new Error('Không tìm thấy form update chương.');
    const model = formToModel(form, finalUrl);
    const snap = {
      row,
      model,
      currentName: modelValue(model, 'name_chapter'),
      currentContent: modelValue(model, 'content_chapter'),
      currentStars: Number(modelValue(model, 'stars_active') || 0),
      currentDiamonds: Number(modelValue(model, 'diamonds_active') || 0),
    };
    state.snapshotCache.set(row.chapterId, snap);
    return snap;
  }

  async function submitChapterOverrides(snapshot, overrides, label) {
    const params = modelToParams(snapshot.model, overrides);
    return postOnce(snapshot.model.action, {
      rawMethod: snapshot.model.rawMethod || 'POST',
      body: params.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      label,
    });
  }

  async function verifyChapter(row, expected) {
    const snap = await fetchChapterSnapshot(row, true);
    if (expected.name !== undefined && snap.currentName !== expected.name) {
      throw new Error(`Tên không khớp sau lưu: web="${snap.currentName}" cần="${expected.name}"`);
    }
    if (expected.content !== undefined && normalizeHtml(snap.currentContent) !== normalizeHtml(expected.content)) {
      throw new Error('Nội dung không khớp sau lưu.');
    }
    if (expected.stars !== undefined && Number(snap.currentStars) !== Number(expected.stars)) {
      throw new Error(`Sao không khớp sau lưu: web=${snap.currentStars} cần=${expected.stars}`);
    }
    if (expected.diamonds !== undefined && Number(snap.currentDiamonds) !== Number(expected.diamonds)) {
      throw new Error(`KC không khớp sau lưu: web=${snap.currentDiamonds} cần=${expected.diamonds}`);
    }
    return true;
  }

  async function getCreateChapterModel() {
    if (state.chapterCreateModel && Number(modelValue(state.chapterCreateModel, 'post_id')) === Number(state.selectedStoryId)) {
      return state.chapterCreateModel;
    }
    const { doc, finalUrl } = await fetchDoc(routeUrl(`/createchapter/${state.selectedStoryId}`), 'GET template tạo chương');
    const form = findChapterForm(doc, 'create');
    if (!form) throw new Error('Không tìm thấy form POST /chapter.');
    state.chapterCreateModel = formToModel(form, finalUrl);
    return state.chapterCreateModel;
  }

  async function runBulk() {
    if (state.running) return;
    if (!state.selectedStoryId) return toast('Chưa chọn truyện.', 'warn');

    const op = bulkOperation();
    state.bulk.operation = op;

    if (op === 'price_update') {
      // Refresh server trước khi chạy nhưng GIỮ nguyên target giá user vừa chọn.
      await loadChapters();
      initializeExistingPricing(false);
    } else if (op === 'create') {
      // Một refresh trước validation là đủ. Sau mỗi POST, loadChapters()
      // bên dưới vừa re-check vừa tạo snapshot mới cho vòng kế tiếp.
      await loadChapters();
    }

    let items = selectedBulkItems();
    if (!items.length) return toast('Không có chương trong phạm vi.', 'warn');

    if (op === 'price_update') {
      items = items.filter(x => {
        const row = state.chapterMap.get(x.chapterNo);
        return row && !priceMatchesRow(getPricing(x.chapterNo), row);
      });
      if (!items.length) return toast('Không có chương nào thay đổi giá.', 'warn');
    }

    if (op !== 'price_update' && !state.bulk.parsed.length) {
      return toast('Cần nạp/parse TXT trước.', 'warn');
    }

    if (op !== 'create') {
      const missing = items.filter(x => !state.chapterMap.has(x.chapterNo));
      if (missing.length) return toast(`Thiếu trên web: ${missing.map(x => x.chapterNo).join(', ')}`, 'error', 6000);
    }

    if (op === 'create') {
      const maxExisting = state.chapters.length ? Math.max(...state.chapters.map(x => x.chapterNo)) : 0;
      const sorted = [...items].sort((a, b) => a.chapterNo - b.chapterNo);
      if (sorted[0].chapterNo !== maxExisting + 1) {
        return toast(`Đăng mới phải bắt đầu từ CHƯƠNG ${maxExisting + 1}.`, 'error', 6000);
      }
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].chapterNo !== maxExisting + 1 + i) {
          return toast(`Dải đăng mới không liên tục tại CHƯƠNG ${sorted[i].chapterNo}.`, 'error', 6000);
        }
      }
    }

    const labels = {
      price_update: 'FIX GIÁ CHƯƠNG CŨ',
      both: 'CẬP NHẬT TÊN + NỘI DUNG',
      title: 'CHỈ ĐỔI TÊN',
      content: 'CHỈ CẬP NHẬT NỘI DUNG',
      create: 'ĐĂNG CHƯƠNG MỚI',
    };

    if (!confirm(`${labels[op]}\n\nTruyện #${state.selectedStoryId}\nSố chương: ${items.length}\n\nĐây là thao tác thật lên server. Tiếp tục?`)) return;

    state.running = true;
    state.cancelled = false;
    const runBtn = $('#ttlcc-bulk-run');
    const cancelBtn = $('#ttlcc-bulk-cancel');
    if (runBtn) runBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = false;

    const verify = $('#ttlcc-bulk-verify')?.checked ?? true;
    const stopError = $('#ttlcc-bulk-stop-error')?.checked ?? true;
    const delayMs = Math.max(0, Number($('#ttlcc-bulk-delay')?.value || 1000));
    let ok = 0;
    let errors = 0;

    try {
      let createModel = null;
      if (op === 'create') createModel = await getCreateChapterModel();

      for (let i = 0; i < items.length; i++) {
        if (state.cancelled) {
          addLog('Bulk: đã hủy trước request kế tiếp.', 'warn');
          break;
        }

        const item = items[i];
        setStatus(`${labels[op]} ${i + 1}/${items.length}: CHƯƠNG ${item.chapterNo}`);

        try {
          if (op === 'create') {
            // state.chapters luôn là snapshot mới nhất: refresh trước batch
            // hoặc re-check sau POST của chương trước.
            const maxNow = state.chapters.length ? Math.max(...state.chapters.map(x => x.chapterNo)) : 0;
            if (item.chapterNo !== maxNow + 1) {
              const exists = state.chapterMap.get(item.chapterNo);
              if (exists && sanitizeChapterTitle(exists.title, null) === sanitizeChapterTitle(item.title, item.chapterNo)) {
                addLog(`Bỏ qua CHƯƠNG ${item.chapterNo}: đã tồn tại đúng tên.`, 'warn');
                ok++;
                continue;
              }
              throw new Error(`Thứ tự server đổi: chương cuối=${maxNow}, đang chuẩn bị=${item.chapterNo}`);
            }

            const price = pricingFields(getPricing(item.chapterNo), item.chapterNo);
            const params = modelToParams(createModel, {
              name_chapter: sanitizeChapterTitle(item.title, item.chapterNo),
              content_chapter: item.htmlContent,
              word_count2: String(countWordsFromHtml(item.htmlContent)),
              post_id: String(state.selectedStoryId),
              publish_mode: 'now',
              publish_at: '',
              stars_active: price.stars_active,
              diamonds_active: price.diamonds_active,
            });

            let postError = null;
            try {
              await postOnce(createModel.action, {
                rawMethod: createModel.rawMethod || 'POST',
                body: params.toString(),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                label: `POST CHƯƠNG ${item.chapterNo}`,
              });
            } catch (err) {
              postError = err;
              addLog(`POST CHƯƠNG ${item.chapterNo} bất định: ${err.message}; đang xác minh server…`, 'warn');
            }

            await sleep(500);
            await loadChapters();
            const row = state.chapterMap.get(item.chapterNo);
            if (!row) throw postError || new Error('POST trả về nhưng chương chưa xuất hiện.');
            if (sanitizeChapterTitle(row.title, null) !== sanitizeChapterTitle(item.title, item.chapterNo)) {
              throw new Error(`Chương xuất hiện nhưng tên không khớp: web="${row.title}"`);
            }
            const targetP = getPricing(item.chapterNo);
            if (!priceMatchesRow(targetP, row)) {
              throw new Error(`Giá sau tạo không khớp: web=${row.stars} sao/${row.diamonds} KC, cần=${pricingLabel(targetP)}`);
            }
          } else {
            const row = state.chapterMap.get(item.chapterNo);
            const snap = await fetchChapterSnapshot(row, op === 'price_update');
            const overrides = {};
            const expected = {};

            if (op === 'both' || op === 'title') {
              overrides.name_chapter = sanitizeChapterTitle(item.title, item.chapterNo);
              expected.name = overrides.name_chapter;
            }
            if (op === 'both' || op === 'content') {
              overrides.content_chapter = item.htmlContent;
              overrides.word_count2 = String(countWordsFromHtml(item.htmlContent));
              expected.content = item.htmlContent;
            }
            if (op === 'price_update') {
              const pf = pricingFields(getPricing(item.chapterNo), item.chapterNo);
              overrides.stars_active = pf.stars_active;
              overrides.diamonds_active = pf.diamonds_active;
              expected.stars = Number(pf.stars_active || 0);
              expected.diamonds = Number(pf.diamonds_active || 0);
            }

            await submitChapterOverrides(snap, overrides, `UPDATE CHƯƠNG ${item.chapterNo}`);
            if (verify) {
              await sleep(350 + jitter(180));
              await verifyChapter(row, expected);
            }
          }

          ok++;
          addLog(`${labels[op]} OK: CHƯƠNG ${item.chapterNo}`, 'ok');
        } catch (err) {
          errors++;
          addLog(`${labels[op]} LỖI CHƯƠNG ${item.chapterNo}: ${err.message}`, 'error');
          if (stopError) throw err;
        }

        if (i + 1 < items.length) {
          if ((i + 1) % CFG.bulkCooldownEvery === 0) {
            await sleep(CFG.bulkCooldownMs);
          } else if (delayMs) {
            await sleep(delayMs + jitter(220));
          }
        }
      }

      await loadChapters();
      setStatus(`Bulk hoàn tất: thành công ${ok}, lỗi ${errors}.`, errors ? 'warn' : 'ok');
      toast(`Bulk hoàn tất: ${ok} OK / ${errors} lỗi.`, errors ? 'warn' : 'ok', 5000);
    } catch (err) {
      setStatus(`Bulk dừng: ${err.message}`, 'error');
      toast(`Bulk dừng: ${err.message}`, 'error', 6500);
    } finally {
      state.running = false;
      if (runBtn) runBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = true;
      renderBulkPreview();
    }
  }

  // ==========================================================
  // DASHBOARD / NATIVE TOOLS
  // ==========================================================

  function renderDashboard() {
    const story = state.selectedStory;
    const chapters = state.chapters;
    const paidStars = chapters.filter(x => x.stars > 0).length;
    const paidDiamonds = chapters.filter(x => x.diamonds > 0).length;
    const free = chapters.filter(x => x.stars <= 0 && x.diamonds <= 0).length;
    const shortPaid = chapters.filter(x => x.wordCount > 0 && x.wordCount < CFG.pricing.minPaidWords && (x.stars > 0 || x.diamonds > 0)).length;

    const set = (id, value) => { const el = $(id); if (el) el.textContent = value; };
    set('#ttlcc-stat-story', story ? story.title : '—');
    set('#ttlcc-stat-chapters', chapters.length.toLocaleString());
    set('#ttlcc-stat-free', free.toLocaleString());
    set('#ttlcc-stat-stars', paidStars.toLocaleString());
    set('#ttlcc-stat-diamonds', paidDiamonds.toLocaleString());
    set('#ttlcc-stat-shortpaid', shortPaid.toLocaleString());

    const warn = $('#ttlcc-dashboard-warning');
    if (warn) {
      warn.style.display = shortPaid ? '' : 'none';
      warn.textContent = shortPaid
        ? `Phát hiện ${shortPaid} CHƯƠNG dưới 1000 từ nhưng vẫn đang trả phí. Có thể sửa ngay ở tab Bulk → Fix giá.`
        : '';
    }
  }

  function parseLooseNumber(value) {
    const raw = String(value ?? '')
      .replace(/\u00A0/g, ' ')
      .trim();

    const m = raw.match(/-?\d[\d.,]*/);
    if (!m) return null;

    // Các số trên site chủ yếu là số nguyên; bỏ separator ngàn.
    const digits = m[0].replace(/[^\d-]/g, '');
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
  }

  function formatKC(value) {
    const n = Number(value);
    return Number.isFinite(n)
      ? `${n.toLocaleString('vi-VN')} KC`
      : '—';
  }

  function formatVnd(value) {
    const n = Number(value);
    return Number.isFinite(n)
      ? `${n.toLocaleString('vi-VN')} ₫`
      : '—';
  }

  function findMetricContainer(doc, label) {
    const target = norm(label);
    let best = null;
    let bestScore = -Infinity;

    for (const el of doc.body?.querySelectorAll('*') || []) {
      const own = norm(el.textContent);
      if (!own.includes(target)) continue;

      let node = el;

      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        const raw = text(node.textContent);
        const n = norm(raw);
        if (!n.includes(target)) continue;

        let score = 0;
        const cls = String(node.className || '').toLowerCase();

        if (
          /info-box|small-box|card|stat|summary/.test(cls)
        ) {
          score += 100;
        }

        if (/\d/.test(raw)) score += 35;
        if (/kim\s*cương/i.test(raw)) score += 30;
        if (raw.length <= 180) score += 25;
        if (raw.length > 500) score -= 80;

        if (score > bestScore) {
          bestScore = score;
          best = node;
        }
      }
    }

    return best;
  }

  function metricNumber(doc, label) {
    const container = findMetricContainer(doc, label);
    if (!container) return null;

    const target = norm(label);
    const candidates = [];

    for (const el of container.querySelectorAll('*')) {
      const raw = text(el.textContent);
      if (!raw || !/\d/.test(raw)) continue;
      if (norm(raw).includes(target)) continue;
      if (/r[uú]t ti[eề]n/i.test(raw)) continue;
      if (raw.length > 90) continue;

      let score = 0;
      const cls = String(el.className || '').toLowerCase();
      const tag = String(el.tagName || '').toLowerCase();

      if (/number|value|amount|info-box-number/.test(cls)) score += 90;
      if (['strong', 'b', 'h2', 'h3', 'h4'].includes(tag)) score += 50;
      if (el.children.length === 0) score += 25;
      if (/kim\s*cương/i.test(raw)) score += 35;
      if (/^\d[\d.,]*(?:\s*kim\s*cương)?$/i.test(raw)) score += 60;

      candidates.push({
        raw,
        value: parseLooseNumber(raw),
        score,
      });
    }

    candidates.sort((a, b) => b.score - a.score);

    const hit = candidates.find(x => x.value !== null);
    if (hit) return hit.value;

    return parseLooseNumber(container.textContent);
  }

  function revenuePeriod(doc) {
    const from = doc.querySelector(
      'select[name="from_month"] option:checked'
    );
    const to = doc.querySelector(
      'select[name="to_month"] option:checked'
    );

    if (!from && !to) return '';

    const a = text(from?.textContent || from?.value || '');
    const b = text(to?.textContent || to?.value || '');

    if (a && b) return a === b ? a : `${a} → ${b}`;
    return a || b;
  }

  function headerIndex(table, regex) {
    const headers = [
      ...table.querySelectorAll('thead th'),
    ].map((th, index) => ({
      index,
      text: norm(th.textContent),
    }));

    return headers.find(x => regex.test(x.text))?.index ?? -1;
  }

  function aggregateStoryRevenueTable(table) {
    if (!table) return [];

    const nameIx = headerIndex(
      table,
      /ten truyen|^truyen$/
    );
    const salesIx = headerIndex(
      table,
      /so luot mua|luot mua|luot ban/
    );
    const revenueIx = headerIndex(
      table,
      /doanh thu.*kim cuong/
    );

    if (nameIx < 0 || revenueIx < 0) return [];

    const map = new Map();

    for (const tr of table.querySelectorAll('tbody tr')) {
      const cells = [...tr.querySelectorAll('td')];
      if (!cells.length) continue;

      const title = text(cells[nameIx]?.textContent);
      if (
        !title ||
        /dang tai|khong co du lieu/i.test(norm(title))
      ) {
        continue;
      }

      const sales =
        salesIx >= 0
          ? (parseLooseNumber(cells[salesIx]?.textContent) || 0)
          : 0;

      const kc =
        parseLooseNumber(cells[revenueIx]?.textContent) || 0;

      const prev = map.get(title) || {
        title,
        sales: 0,
        kc: 0,
      };

      prev.sales += sales;
      prev.kc += kc;
      map.set(title, prev);
    }

    return [...map.values()];
  }

  function aggregateRevenueHistory(table) {
    if (!table) return [];

    const storyIx = headerIndex(
      table,
      /^truyen$|ten truyen/
    );
    const typeIx = headerIndex(
      table,
      /loai nhan/
    );
    const receivedIx = headerIndex(
      table,
      /kim cuong.*diem sao.*ban nhan|ban nhan/
    );

    if (storyIx < 0 || receivedIx < 0) return [];

    const map = new Map();

    for (const tr of table.querySelectorAll('tbody tr')) {
      const cells = [...tr.querySelectorAll('td')];
      if (!cells.length) continue;

      const title = text(cells[storyIx]?.textContent);

      if (
        !title ||
        /chua co|dang tai|khong co/i.test(norm(title))
      ) {
        continue;
      }

      const receiveType =
        typeIx >= 0
          ? norm(cells[typeIx]?.textContent)
          : 'kim cuong';

      // User chỉ cần KC thu về, bỏ các dòng nhận điểm sao.
      if (
        receiveType &&
        !receiveType.includes('kim cuong')
      ) {
        continue;
      }

      const kc =
        parseLooseNumber(cells[receivedIx]?.textContent) || 0;

      const prev = map.get(title) || {
        title,
        sales: 0,
        kc: 0,
      };

      prev.sales += 1;
      prev.kc += kc;
      map.set(title, prev);
    }

    return [...map.values()];
  }

  function mergeStoryRevenue(primary, fallback) {
    if (primary?.length) return primary;

    return fallback || [];
  }

  function matchStoryIdByTitle(title) {
    const target = norm(title);
    if (!target) return null;

    for (const story of state.stories.values()) {
      if (norm(story.title) === target) {
        return story.id;
      }
    }

    return null;
  }

  function sortStoryRevenue(rows) {
    return [...rows]
      .map(row => ({
        ...row,
        storyId:
          row.storyId ||
          matchStoryIdByTitle(row.title),
      }))
      .sort((a, b) => {
        const aSelected =
          Number(a.storyId) ===
          Number(state.selectedStoryId);
        const bSelected =
          Number(b.storyId) ===
          Number(state.selectedStoryId);

        if (aSelected !== bSelected) {
          return aSelected ? -1 : 1;
        }

        return (
          Number(b.kc || 0) -
            Number(a.kc || 0) ||
          Number(b.sales || 0) -
            Number(a.sales || 0) ||
          a.title.localeCompare(b.title, 'vi')
        );
      });
  }

  async function loadRevenueLiveProbe(
    url = routeUrl('/truyen/doanh-thu')
  ) {
    return await new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');

      frame.setAttribute(
        'sandbox',
        'allow-scripts allow-same-origin'
      );
      frame.setAttribute('aria-hidden', 'true');

      frame.style.cssText =
        'position:fixed;left:-20000px;top:-20000px;' +
        'width:1200px;height:900px;opacity:0;' +
        'pointer-events:none;border:0';

      let finished = false;

      const finish = (fn, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);

        try {
          frame.remove();
        } catch {}

        fn(value);
      };

      const timeout = setTimeout(
        () => finish(
          reject,
          new Error('Revenue live probe timeout')
        ),
        12000
      );

      frame.onerror = () =>
        finish(
          reject,
          new Error('Revenue iframe load error')
        );

      frame.onload = async () => {
        try {
          const win = frame.contentWindow;
          const doc = frame.contentDocument;

          if (!win || !doc?.documentElement) {
            throw new Error('Revenue iframe NO_DOCUMENT');
          }

          // Chờ AJAX/DataTables của trang gốc hoàn tất.
          const started = Date.now();

          while (Date.now() - started < 5500) {
            const table = [
              ...doc.querySelectorAll('table'),
            ].find(t => {
              const h = norm(
                [...t.querySelectorAll('thead th')]
                  .map(x => x.textContent)
                  .join(' | ')
              );

              return (
                h.includes('ten truyen') &&
                h.includes('doanh thu') &&
                h.includes('kim cuong')
              );
            });

            const usefulRows = table
              ? [...table.querySelectorAll('tbody tr')]
                  .filter(tr => {
                    const t = norm(tr.textContent);
                    return (
                      t &&
                      !t.includes('dang tai')
                    );
                  })
              : [];

            if (usefulRows.length) break;
            await sleep(180);
          }

          const stats = {
            totalKC:
              metricNumber(doc, 'Tổng doanh thu'),
            totalSales:
              metricNumber(doc, 'Tổng lượt bán'),
            monthKC:
              metricNumber(doc, 'Doanh thu tháng này'),
            balanceKC:
              metricNumber(doc, 'Số dư hiện tại'),
          };

          const summaryTable = [
            ...doc.querySelectorAll('table'),
          ].find(t => {
            const h = norm(
              [...t.querySelectorAll('thead th')]
                .map(x => x.textContent)
                .join(' | ')
            );

            return (
              h.includes('ten truyen') &&
              h.includes('so luot mua') &&
              h.includes('doanh thu') &&
              h.includes('kim cuong')
            );
          });

          const stories =
            aggregateStoryRevenueTable(summaryTable);

          const packages = [];
          const form =
            doc.querySelector('#withdrawForm') ||
            doc.querySelector(
              'form:has([name="package_vnd"])'
            );

          if (form) {
            const radios = [
              ...form.querySelectorAll(
                '[name="package_vnd"]'
              ),
            ];

            for (const radio of radios) {
              const vnd =
                parseLooseNumber(radio.value);

              if (!vnd) continue;

              try {
                radio.checked = true;
                radio.dispatchEvent(
                  new win.Event('change', {
                    bubbles: true,
                  })
                );
                radio.dispatchEvent(
                  new win.Event('input', {
                    bubbles: true,
                  })
                );
                radio.click();
              } catch {}

              await sleep(90);

              const scope =
                radio.closest('.modal') ||
                form.closest('.modal') ||
                form;

              const raw = text(scope.textContent);

              const costMatch = raw.match(
                /s[oố]\s*kim\s*cương\s*b[iị]\s*tr[ừu]\s*:\s*([\d.,]+)/i
              );

              const diamonds = costMatch
                ? parseLooseNumber(costMatch[1])
                : null;

              if (
                Number.isFinite(vnd) &&
                Number.isFinite(diamonds)
              ) {
                packages.push({
                  vnd,
                  diamonds,
                });
              }
            }
          }

          finish(resolve, {
            stats,
            stories,
            packages,
            period: revenuePeriod(doc),
          });
        } catch (err) {
          finish(reject, err);
        }
      };

      frame.src = url;
      document.documentElement.appendChild(frame);
    });
  }

  function computeWithdrawable(
    balanceKC,
    packages
  ) {
    if (!Number.isFinite(Number(balanceKC))) {
      return {
        withdrawableVnd: null,
        withdrawPackage: null,
        minWithdrawPackage: null,
      };
    }

    const valid = (packages || [])
      .filter(
        p =>
          Number.isFinite(Number(p.vnd)) &&
          Number.isFinite(Number(p.diamonds))
      )
      .map(p => ({
        vnd: Number(p.vnd),
        diamonds: Number(p.diamonds),
      }))
      .sort((a, b) => a.vnd - b.vnd);

    if (!valid.length) {
      return {
        withdrawableVnd: null,
        withdrawPackage: null,
        minWithdrawPackage: null,
      };
    }

    const affordable = valid
      .filter(
        p =>
          p.diamonds <= Number(balanceKC)
      )
      .sort((a, b) => b.vnd - a.vnd)[0] || null;

    return {
      withdrawableVnd:
        affordable?.vnd || 0,
      withdrawPackage:
        affordable,
      minWithdrawPackage:
        valid[0],
    };
  }

  function renderRevenue() {
    const r = state.revenue;

    const amount = $('#ttlcc-revenue-withdrawable');
    const amountSub = $('#ttlcc-revenue-withdrawable-sub');
    const total = $('#ttlcc-revenue-total');
    const totalSub = $('#ttlcc-revenue-total-sub');
    const month = $('#ttlcc-revenue-month');
    const period = $('#ttlcc-revenue-period');
    const list = $('#ttlcc-revenue-stories');
    const meta = $('#ttlcc-revenue-meta');
    const refresh = $('#ttlcc-revenue-refresh');

    if (refresh) {
      refresh.disabled = r.loading;
      refresh.textContent =
        r.loading ? 'Đang tải…' : '↻ Refresh';
    }

    if (amount) {
      if (r.loading && !r.loaded) {
        amount.textContent = '…';
      } else if (
        Number.isFinite(
          Number(r.withdrawableVnd)
        )
      ) {
        amount.textContent =
          formatVnd(r.withdrawableVnd);
      } else {
        amount.textContent =
          formatKC(r.balanceKC);
      }
    }

    if (amountSub) {
      if (
        r.minWithdrawPackage &&
        Number(r.withdrawableVnd) === 0
      ) {
        amountSub.textContent =
          `Số dư ${formatKC(r.balanceKC)} · ` +
          `cần ${formatKC(r.minWithdrawPackage.diamonds)} ` +
          `cho gói ${formatVnd(r.minWithdrawPackage.vnd)}`;
      } else if (r.withdrawPackage) {
        amountSub.textContent =
          `Số dư ${formatKC(r.balanceKC)} · ` +
          `gói này dùng ${formatKC(r.withdrawPackage.diamonds)}`;
      } else {
        amountSub.textContent =
          `Số dư khả dụng: ${formatKC(r.balanceKC)}`;
      }
    }

    if (total) {
      total.textContent =
        formatKC(r.totalKC);
    }

    if (totalSub) {
      totalSub.textContent =
        Number.isFinite(Number(r.totalSales))
          ? `${Number(r.totalSales).toLocaleString('vi-VN')} lượt bán`
          : '— lượt bán';
    }

    if (month) {
      month.textContent =
        formatKC(r.monthKC);
    }

    if (period) {
      period.textContent =
        r.period || 'Kỳ hiện tại';
    }

    if (meta) {
      if (r.loading) {
        meta.textContent =
          'Đang đọc doanh thu…';
      } else if (r.error) {
        meta.textContent =
          r.error;
      } else if (r.updatedAt) {
        meta.textContent =
          `Cập nhật ${new Date(
            r.updatedAt
          ).toLocaleTimeString()}`;
      } else {
        meta.textContent = '';
      }
    }

    if (!list) return;

    if (r.loading && !r.loaded) {
      list.innerHTML =
        '<div class="ttlcc-empty">Đang tổng hợp theo truyện…</div>';
      return;
    }

    if (!r.stories.length) {
      list.innerHTML =
        '<div class="ttlcc-empty">Chưa có doanh thu KC theo truyện.</div>';
      return;
    }

    list.innerHTML = r.stories
      .map(row => {
        const selected =
          Number(row.storyId) ===
          Number(state.selectedStoryId);

        return `
          <div
            class="ttlcc-revenue-story ${selected ? 'selected' : ''}"
            ${row.storyId ? `data-story-revenue-id="${row.storyId}"` : ''}
          >
            <div class="ttlcc-revenue-story-main">
              <div class="ttlcc-revenue-story-title">
                ${esc(row.title)}
                ${selected ? '<span class="ttlcc-current-chip">đang chọn</span>' : ''}
              </div>
            </div>
            <div class="ttlcc-revenue-story-sales">
              ${Number(row.sales || 0).toLocaleString('vi-VN')}
              <span>lượt</span>
            </div>
            <div class="ttlcc-revenue-story-kc">
              ${Number(row.kc || 0).toLocaleString('vi-VN')}
              <span>KC</span>
            </div>
          </div>
        `;
      })
      .join('');

    list
      .querySelectorAll('[data-story-revenue-id]')
      .forEach(el => {
        el.addEventListener('click', async () => {
          const id = Number(
            el.dataset.storyRevenueId
          );

          if (
            !id ||
            id === Number(state.selectedStoryId)
          ) {
            return;
          }

          try {
            await selectStory(id, {
              loadChaptersNow: false,
            });
            renderRevenue();
          } catch {}
        });
      });
  }

  async function loadRevenueData(
    { force = false } = {}
  ) {
    const r = state.revenue;

    if (r.loading) return;
    if (r.loaded && !force) {
      renderRevenue();
      return;
    }

    r.loading = true;
    r.error = '';
    renderRevenue();

    try {
      let live = null;

      try {
        live = await loadRevenueLiveProbe();
      } catch (err) {
        addLog(
          `Revenue live probe lỗi: ${err.message}; dùng fetch fallback.`,
          'warn'
        );
      }

      let revenueDoc = null;
      let revenueUrl =
        routeUrl('/truyen/doanh-thu');

      if (!live) {
        const fetched = await fetchDoc(
          revenueUrl,
          'GET doanh thu'
        );

        revenueDoc = fetched.doc;
        revenueUrl = fetched.finalUrl;

        live = {
          stats: {
            totalKC:
              metricNumber(
                revenueDoc,
                'Tổng doanh thu'
              ),
            totalSales:
              metricNumber(
                revenueDoc,
                'Tổng lượt bán'
              ),
            monthKC:
              metricNumber(
                revenueDoc,
                'Doanh thu tháng này'
              ),
            balanceKC:
              metricNumber(
                revenueDoc,
                'Số dư hiện tại'
              ),
          },
          stories: [],
          packages: [],
          period:
            revenuePeriod(revenueDoc),
        };

        const summaryTable = [
          ...revenueDoc.querySelectorAll('table'),
        ].find(t => {
          const h = norm(
            [...t.querySelectorAll('thead th')]
              .map(x => x.textContent)
              .join(' | ')
          );

          return (
            h.includes('ten truyen') &&
            h.includes('doanh thu') &&
            h.includes('kim cuong')
          );
        });

        live.stories =
          aggregateStoryRevenueTable(
            summaryTable
          );
      }

      // Fallback riêng cho danh sách truyện:
      // /customer/purchases có revenueTable server-rendered.
      let fallbackStories = [];

      if (!live.stories?.length) {
        try {
          const purchases = await fetchDoc(
            routeUrl('/customer/purchases'),
            'GET revenue history'
          );

          const historyTable =
            purchases.doc.querySelector(
              '#revenueTable'
            ) ||
            [...purchases.doc.querySelectorAll('table')]
              .find(t => {
                const h = norm(
                  [...t.querySelectorAll('thead th')]
                    .map(x => x.textContent)
                    .join(' | ')
                );

                return (
                  h.includes('loai nhan') &&
                  h.includes('ban nhan') &&
                  h.includes('truyen')
                );
              });

          fallbackStories =
            aggregateRevenueHistory(
              historyTable
            );
        } catch (err) {
          addLog(
            `Revenue history fallback lỗi: ${err.message}`,
            'warn'
          );
        }
      }

      const stories =
        mergeStoryRevenue(
          live.stories,
          fallbackStories
        );

      const withdraw =
        computeWithdrawable(
          live.stats?.balanceKC,
          live.packages
        );

      r.totalKC =
        live.stats?.totalKC ?? null;
      r.totalSales =
        live.stats?.totalSales ?? null;
      r.monthKC =
        live.stats?.monthKC ?? null;
      r.balanceKC =
        live.stats?.balanceKC ?? null;

      r.withdrawableVnd =
        withdraw.withdrawableVnd;
      r.withdrawPackage =
        withdraw.withdrawPackage;
      r.minWithdrawPackage =
        withdraw.minWithdrawPackage;

      r.period =
        live.period || '';
      r.stories =
        sortStoryRevenue(stories);

      r.loaded = true;
      r.updatedAt =
        new Date().toISOString();

      const missing = [];

      if (!Number.isFinite(Number(r.balanceKC))) {
        missing.push('số dư');
      }
      if (!Number.isFinite(Number(r.totalKC))) {
        missing.push('tổng doanh thu');
      }
      if (!Number.isFinite(Number(r.monthKC))) {
        missing.push('doanh thu tháng');
      }

      if (missing.length) {
        r.error =
          `Thiếu dữ liệu: ${missing.join(', ')}`;
      }

      addLog(
        `Doanh thu: ${r.stories.length} truyện · ` +
        `${formatKC(r.totalKC)} tổng · ` +
        `${formatKC(r.balanceKC)} số dư.`,
        r.error ? 'warn' : 'ok'
      );
    } catch (err) {
      r.error =
        `Không tải được doanh thu: ${err.message}`;
      addLog(r.error, 'error');
    } finally {
      r.loading = false;
      renderRevenue();
    }
  }

  // Chỉ giữ fallback trang gốc khi custom live-form bị web đổi cấu trúc.
  function openNativeTool(
    url,
    title = 'Trang gốc'
  ) {
    openModal(
      title,
      `<iframe
        id="ttlcc-fallback-frame"
        src="${esc(url)}"
        style="width:100%;height:min(78vh,820px);border:0;border-radius:9px;background:#fff"
      ></iframe>`
    );

    const frame =
      $('#ttlcc-fallback-frame');

    if (!frame) return;

    frame.onload = () => {
      try {
        const doc = frame.contentDocument;
        if (!doc) return;

        const style =
          doc.createElement('style');

        style.textContent = `
          .main-header,
          .main-sidebar,
          .control-sidebar,
          footer.main-footer {
            display:none!important
          }

          .content-wrapper {
            margin-left:0!important;
            min-height:100vh!important
          }
        `;

        doc.head.appendChild(style);
      } catch {}
    };
  }

  // ==========================================================
  // MODAL
  // ==========================================================

  function openModal(title, html = '') {
    const modal = $('#ttlcc-modal');
    if (!modal) return;
    $('#ttlcc-modal-title').textContent = title;
    $('#ttlcc-modal-body').innerHTML = html;
    modal.classList.add('open');
  }

  function closeModal() {
    $('#ttlcc-modal')?.classList.remove('open');
    const body = $('#ttlcc-modal-body');
    if (body) body.innerHTML = '';
  }

  // ==========================================================
  // UI
  // ==========================================================

  const CSS_TEXT = `
    :root {
      --ttlcc-bg:#10151c;
      --ttlcc-panel:#171e27;
      --ttlcc-panel2:#1c2530;
      --ttlcc-input:#111922;
      --ttlcc-border:#2d3947;
      --ttlcc-text:#d7dee7;
      --ttlcc-soft:#a8b4c1;
      --ttlcc-muted:#788697;
      --ttlcc-primary:#5f95a1;
      --ttlcc-primary2:#75aab5;
      --ttlcc-ok:#79a184;
      --ttlcc-warn:#c09a62;
      --ttlcc-danger:#b46268;
      --ttlcc-shadow:0 24px 65px rgba(0,0,0,.42);
    }
    #ttlcc-panel,#ttlcc-panel *{box-sizing:border-box}
    #ttlcc-panel{position:fixed;z-index:2147483000;inset:14px 14px 14px auto;width:min(1180px,calc(100vw - 28px));background:var(--ttlcc-bg);color:var(--ttlcc-text);border:1px solid var(--ttlcc-border);border-radius:16px;box-shadow:var(--ttlcc-shadow);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;overflow:hidden;display:flex;flex-direction:column}
    #ttlcc-panel.ttlcc-minimized{inset:auto 82px 18px auto;width:auto;height:auto;border-radius:11px}
    #ttlcc-panel.ttlcc-minimized .ttlcc-main,#ttlcc-panel.ttlcc-minimized .ttlcc-tabs,#ttlcc-panel.ttlcc-minimized .ttlcc-selection{display:none!important}
    #ttlcc-panel.ttlcc-minimized .ttlcc-head{padding:9px 11px;cursor:pointer}
    #ttlcc-panel.ttlcc-minimized .ttlcc-head-title{font-size:13px}
    #ttlcc-panel.ttlcc-minimized .ttlcc-head-sub,#ttlcc-panel.ttlcc-minimized #ttlcc-story-badge,#ttlcc-panel.ttlcc-minimized #ttlcc-minimize{display:none}
    .ttlcc-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 15px;background:linear-gradient(135deg,#293a43,#314b53 55%,#355149);color:white}
    .ttlcc-head-main{min-width:0}.ttlcc-head-title{font-size:17px;font-weight:800}.ttlcc-head-sub{font-size:11px;opacity:.78;margin-top:2px}
    .ttlcc-head-actions{display:flex;align-items:center;gap:7px}.ttlcc-badge{padding:4px 8px;border-radius:999px;background:rgba(255,255,255,.12);font-size:11px;font-weight:700}
    .ttlcc-icon{width:34px;height:34px;border:1px solid rgba(255,255,255,.25);border-radius:9px;background:rgba(255,255,255,.10);color:#fff;cursor:pointer}
    .ttlcc-selection{display:flex;align-items:center;gap:10px;padding:9px 13px;background:var(--ttlcc-panel);border-bottom:1px solid var(--ttlcc-border)}
    .ttlcc-selection-main{min-width:0;flex:1}.ttlcc-selected-title{font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ttlcc-selected-sub{font-size:11px;color:var(--ttlcc-muted)}
    .ttlcc-tabs{display:flex;gap:4px;padding:7px 10px;background:#131a22;border-bottom:1px solid var(--ttlcc-border);overflow:auto}
    .ttlcc-tab-btn{border:1px solid transparent;background:transparent;color:var(--ttlcc-soft);padding:7px 11px;border-radius:8px;cursor:pointer;white-space:nowrap;font-weight:700}
    .ttlcc-tab-btn.active{background:var(--ttlcc-panel2);border-color:var(--ttlcc-border);color:#fff}
    .ttlcc-main{min-height:0;flex:1;overflow:auto;padding:12px}
    .ttlcc-pane{display:none}.ttlcc-pane.active{display:block}
    .ttlcc-grid2{display:grid;grid-template-columns:minmax(270px,340px) minmax(0,1fr);gap:12px}.ttlcc-grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
    .ttlcc-card{background:var(--ttlcc-panel);border:1px solid var(--ttlcc-border);border-radius:12px;padding:12px;margin-bottom:12px}.ttlcc-card-title{font-weight:800;margin-bottom:9px;display:flex;align-items:center;justify-content:space-between;gap:8px}
    .ttlcc-toolbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.ttlcc-toolbar + .ttlcc-toolbar{margin-top:8px}
    .ttlcc-input,.ttlcc-card input[type="text"],.ttlcc-card input[type="number"],.ttlcc-card input[type="date"],.ttlcc-card input[type="datetime-local"],.ttlcc-card input[type="url"],.ttlcc-card input[type="file"],.ttlcc-card select,.ttlcc-live-form input,.ttlcc-live-form select,.ttlcc-live-form textarea{border:1px solid var(--ttlcc-border);background:var(--ttlcc-input);color:var(--ttlcc-text);border-radius:8px;padding:7px 9px;outline:none;max-width:100%}
    .ttlcc-input:focus,.ttlcc-live-form input:focus,.ttlcc-live-form select:focus,.ttlcc-live-form textarea:focus{border-color:var(--ttlcc-primary);box-shadow:0 0 0 3px rgba(95,149,161,.12)}
    .ttlcc-btn{border:1px solid transparent;border-radius:8px;padding:7px 10px;min-height:32px;cursor:pointer;font-weight:700;background:var(--ttlcc-panel2);color:var(--ttlcc-text)}.ttlcc-btn:disabled{opacity:.42;cursor:not-allowed}
    .ttlcc-btn-primary{background:var(--ttlcc-primary);color:white}.ttlcc-btn-primary:hover:not(:disabled){background:var(--ttlcc-primary2)}.ttlcc-btn-soft{border-color:var(--ttlcc-border)}.ttlcc-btn-danger{background:var(--ttlcc-danger);color:white}.ttlcc-btn-mini{padding:4px 7px;min-height:26px;font-size:11px}
    .ttlcc-story-list{max-height:calc(100vh - 280px);overflow:auto;display:flex;flex-direction:column;gap:5px}.ttlcc-story-item{border:1px solid var(--ttlcc-border);background:#131a22;color:var(--ttlcc-text);border-radius:9px;padding:9px;text-align:left;cursor:pointer;display:flex;align-items:center;gap:8px}.ttlcc-story-item.active{border-color:var(--ttlcc-primary);background:#1b2931}.ttlcc-story-title{flex:1;font-weight:700}.ttlcc-story-id{color:var(--ttlcc-muted);font-size:11px}
    .ttlcc-stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px}.ttlcc-stat{border:1px solid var(--ttlcc-border);background:var(--ttlcc-panel);border-radius:11px;padding:12px}.ttlcc-stat-label{font-size:11px;color:var(--ttlcc-muted)}.ttlcc-stat-value{font-size:19px;font-weight:800;margin-top:3px;overflow:hidden;text-overflow:ellipsis}
    .ttlcc-warning{border:1px solid rgba(192,154,98,.45);background:rgba(192,154,98,.08);color:#d8bb8e;padding:9px 11px;border-radius:9px;margin-top:10px}
    .ttlcc-status{padding:7px 10px;border-radius:8px;background:#18242d;color:#b7c8d0}.ttlcc-status.ok{color:#9fc3a8}.ttlcc-status.warn{color:#d5b37f}.ttlcc-status.error{color:#dc9599}
    .ttlcc-table-wrap{overflow:auto;max-height:calc(100vh - 285px);border:1px solid var(--ttlcc-border);border-radius:9px}.ttlcc-table{width:100%;border-collapse:collapse;font-size:12px}.ttlcc-table th{position:sticky;top:0;z-index:2;background:#1c2530;color:#c9d2dc;text-align:left}.ttlcc-table th,.ttlcc-table td{padding:7px 8px;border-bottom:1px solid #273240;vertical-align:top}.ttlcc-table tr:hover td{background:#151e27}.ttlcc-table td:not(.ttlcc-left){white-space:nowrap}.ttlcc-row-actions{display:flex;gap:5px}.ttlcc-row-warn td{background:rgba(192,154,98,.05)}.ttlcc-mini-warn{font-size:10px;color:#d3aa72;white-space:normal;max-width:130px}
    .ttlcc-live-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.ttlcc-field{display:flex;flex-direction:column;gap:5px}.ttlcc-field-wide{grid-column:1/-1}.ttlcc-label{font-weight:700;color:var(--ttlcc-soft)}.ttlcc-live-form textarea{width:100%;resize:vertical}.ttlcc-code-area{font:12px/1.5 Consolas,"SFMono-Regular",monospace}.ttlcc-choice-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.ttlcc-choice{display:flex;gap:6px;align-items:flex-start;padding:6px 7px;border:1px solid #2b3744;border-radius:7px;background:#121922;font-size:11px}.ttlcc-form-actions{display:flex;justify-content:flex-end;gap:7px}.ttlcc-form-title{font-size:14px;font-weight:800;margin-bottom:10px;color:#fff}
    .ttlcc-empty,.ttlcc-loading{padding:14px;color:var(--ttlcc-muted);text-align:center}.ttlcc-error-box{padding:10px;border:1px solid rgba(180,98,104,.5);background:rgba(180,98,104,.08);border-radius:9px;color:#dc9599}.ttlcc-error-box .ttlcc-btn{margin-top:8px}
    .ttlcc-bulk-layout{display:grid;grid-template-columns:340px minmax(0,1fr);gap:12px}.ttlcc-textarea{width:100%;min-height:240px;resize:vertical;border:1px solid var(--ttlcc-border);background:var(--ttlcc-input);color:var(--ttlcc-text);border-radius:9px;padding:9px;font:12px/1.5 Consolas,monospace}.ttlcc-inline-price{display:flex;gap:4px}.ttlcc-inline-price select{width:76px}.ttlcc-inline-price input{width:52px}.ttlcc-price-lock{color:#91b39a;font-weight:700}.ttlcc-state{font-weight:800;font-size:10px}.ttlcc-state.pending{color:#d1ad76}.ttlcc-state.ok{color:#88ad91}.ttlcc-state.bad{color:#d1858a}
    .ttlcc-log{height:165px;overflow:auto;background:#0d1319;border:1px solid #222e39;border-radius:9px;padding:8px;font:11px/1.5 Consolas,monospace}.ttlcc-log-line.ok{color:#8fb69a}.ttlcc-log-line.warn{color:#d0aa74}.ttlcc-log-line.error{color:#d4858a}.ttlcc-log-line.info{color:#abb6c2}
    #ttlcc-modal{position:fixed;z-index:2147483200;inset:0;background:rgba(0,0,0,.66);display:none;align-items:center;justify-content:center;padding:18px}#ttlcc-modal.open{display:flex}.ttlcc-modal-box{width:min(980px,96vw);max-height:92vh;display:flex;flex-direction:column;background:var(--ttlcc-bg);border:1px solid var(--ttlcc-border);border-radius:14px;box-shadow:var(--ttlcc-shadow)}.ttlcc-modal-head{display:flex;justify-content:space-between;align-items:center;padding:11px 13px;background:var(--ttlcc-panel2);border-bottom:1px solid var(--ttlcc-border);font-weight:800}.ttlcc-modal-body{overflow:auto;padding:12px}
    #ttlcc-toast-host{position:fixed;z-index:2147483300;right:22px;bottom:22px;display:flex;flex-direction:column;gap:7px;pointer-events:none}.ttlcc-toast{max-width:420px;padding:9px 11px;border-radius:9px;background:#25313d;color:#fff;box-shadow:0 10px 28px rgba(0,0,0,.35);opacity:1;transform:translateY(0);transition:.2s}.ttlcc-toast.ok{background:#355344}.ttlcc-toast.warn{background:#665235}.ttlcc-toast.error{background:#6a393e}.ttlcc-toast.out{opacity:0;transform:translateY(8px)}
    .ttlcc-revenue-top{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px}
    .ttlcc-revenue-summary{border:1px solid var(--ttlcc-border);background:var(--ttlcc-panel);border-radius:11px;padding:13px;min-width:0}
    .ttlcc-revenue-summary-label{font-size:11px;color:var(--ttlcc-muted);font-weight:700}
    .ttlcc-revenue-summary-value{margin-top:5px;font-size:21px;font-weight:850;color:#f4f7fa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ttlcc-revenue-summary-sub{margin-top:4px;font-size:11px;color:var(--ttlcc-soft);min-height:16px}
    .ttlcc-revenue-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}
    .ttlcc-revenue-meta{font-size:11px;color:var(--ttlcc-muted)}
    .ttlcc-revenue-story-list{display:flex;flex-direction:column;border:1px solid var(--ttlcc-border);border-radius:10px;overflow:hidden;background:var(--ttlcc-panel)}
    .ttlcc-revenue-story{display:grid;grid-template-columns:minmax(0,1fr) 95px 105px;gap:10px;align-items:center;padding:10px 12px;border-bottom:1px solid #293543;cursor:default}
    .ttlcc-revenue-story:last-child{border-bottom:0}
    .ttlcc-revenue-story[data-story-revenue-id]{cursor:pointer}
    .ttlcc-revenue-story[data-story-revenue-id]:hover{background:#19242e}
    .ttlcc-revenue-story.selected{background:#1b2b31;box-shadow:inset 3px 0 0 var(--ttlcc-primary)}
    .ttlcc-revenue-story-title{font-weight:750;color:var(--ttlcc-text);min-width:0;overflow:hidden;text-overflow:ellipsis}
    .ttlcc-current-chip{display:inline-flex;margin-left:6px;padding:2px 6px;border-radius:999px;background:rgba(95,149,161,.16);color:#94c1ca;font-size:9px;vertical-align:1px}
    .ttlcc-revenue-story-sales,.ttlcc-revenue-story-kc{text-align:right;font-weight:800}
    .ttlcc-revenue-story-sales span,.ttlcc-revenue-story-kc span{display:block;font-size:9px;color:var(--ttlcc-muted);font-weight:600}
    .ttlcc-revenue-story-kc{color:#9fc9d2}
    @media(max-width:900px){#ttlcc-panel{inset:7px;width:calc(100vw - 14px)}.ttlcc-grid2,.ttlcc-bulk-layout{grid-template-columns:1fr}.ttlcc-story-list{max-height:260px}.ttlcc-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.ttlcc-revenue-top{grid-template-columns:1fr}.ttlcc-choice-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.ttlcc-live-form{grid-template-columns:1fr}.ttlcc-field-wide{grid-column:1}.ttlcc-grid3{grid-template-columns:1fr}}
    @media(max-width:560px){.ttlcc-revenue-story{grid-template-columns:minmax(0,1fr) 70px 78px;padding:9px}.ttlcc-revenue-summary-value{font-size:18px}}
  `;

  function injectUi() {
    const old = $('#ttl-bulk-panel');
    if (old) {
      old.style.display = 'none';
      addLog('Phát hiện panel v0.7 cũ; đã ẩn UI cũ. Nên disable userscript v0.7 để tránh chạy nền trùng.', 'warn');
    }

    const style = document.createElement('style');
    style.id = 'ttlcc-style';
    style.textContent = CSS_TEXT;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'ttlcc-panel';
    panel.innerHTML = `
      <div class="ttlcc-head" id="ttlcc-head">
        <div class="ttlcc-head-main">
          <div class="ttlcc-head-title">Trích Tinh Lâu · Control Center</div>
          <div class="ttlcc-head-sub">v${VERSION} · form/route live-adapter · không hardcode vị trí cột</div>
        </div>
        <div class="ttlcc-head-actions">
          <span class="ttlcc-badge" id="ttlcc-story-badge">—</span>
          <button class="ttlcc-icon" id="ttlcc-refresh-all" type="button" title="Refresh">↻</button>
          <button class="ttlcc-icon" id="ttlcc-minimize" type="button" title="Thu gọn">−</button>
        </div>
      </div>

      <div class="ttlcc-selection">
        <div class="ttlcc-selection-main">
          <div class="ttlcc-selected-title" id="ttlcc-selected-title">Chưa chọn truyện</div>
          <div class="ttlcc-selected-sub" id="ttlcc-selected-sub">Đang khởi tạo…</div>
        </div>
        <div id="ttlcc-status" class="ttlcc-status">Đang khởi tạo…</div>
      </div>

      <div class="ttlcc-tabs">
        <button class="ttlcc-tab-btn active" data-tab="dashboard" type="button">Tổng quan</button>
        <button class="ttlcc-tab-btn" data-tab="stories" type="button">Truyện</button>
        <button class="ttlcc-tab-btn" data-tab="chapters" type="button">Chương</button>
        <button class="ttlcc-tab-btn" data-tab="bulk" type="button">Bulk</button>
        <button class="ttlcc-tab-btn" data-tab="revenue" type="button">Doanh thu</button>
        <button class="ttlcc-tab-btn" data-tab="log" type="button">Log</button>
      </div>

      <div class="ttlcc-main">
        <section class="ttlcc-pane active" data-pane="dashboard">
          <div class="ttlcc-stats">
            <div class="ttlcc-stat"><div class="ttlcc-stat-label">Truyện đang chọn</div><div class="ttlcc-stat-value" id="ttlcc-stat-story">—</div></div>
            <div class="ttlcc-stat"><div class="ttlcc-stat-label">Tổng chương</div><div class="ttlcc-stat-value" id="ttlcc-stat-chapters">0</div></div>
            <div class="ttlcc-stat"><div class="ttlcc-stat-label">Miễn phí</div><div class="ttlcc-stat-value" id="ttlcc-stat-free">0</div></div>
            <div class="ttlcc-stat"><div class="ttlcc-stat-label">Trả Sao</div><div class="ttlcc-stat-value" id="ttlcc-stat-stars">0</div></div>
            <div class="ttlcc-stat"><div class="ttlcc-stat-label">Trả KC</div><div class="ttlcc-stat-value" id="ttlcc-stat-diamonds">0</div></div>
          </div>
          <div id="ttlcc-dashboard-warning" class="ttlcc-warning" style="display:none"></div>
          <div class="ttlcc-card" style="margin-top:12px">
            <div class="ttlcc-card-title">
              <span>Kiểm tra nhanh</span>
              <span class="ttlcc-badge">Short-paid: <span id="ttlcc-stat-shortpaid">0</span></span>
            </div>
            <div class="ttlcc-head-sub" style="color:var(--ttlcc-muted)">
              Dashboard chỉ hiển thị trạng thái. Thao tác thật nằm đúng một nơi ở tab Truyện, Chương, Bulk hoặc Doanh thu.
            </div>
          </div>
        </section>

        <section class="ttlcc-pane" data-pane="stories">
          <div class="ttlcc-grid2">
            <div class="ttlcc-card">
              <div class="ttlcc-card-title"><span>Danh sách truyện</span><button class="ttlcc-btn ttlcc-btn-mini ttlcc-btn-primary" id="ttlcc-create-story" type="button">+ Tạo truyện</button></div>
              <div class="ttlcc-toolbar">
                <input class="ttlcc-input" id="ttlcc-story-filter" type="text" placeholder="Lọc tên / ID…" style="flex:1;min-width:120px">
                <button class="ttlcc-btn ttlcc-btn-soft" id="ttlcc-story-server-search" type="button">Tìm server</button>
                <button class="ttlcc-btn ttlcc-btn-soft" id="ttlcc-story-reload" type="button">↻</button>
              </div>
              <div class="ttlcc-story-list" id="ttlcc-story-list" style="margin-top:8px"></div>
            </div>
            <div class="ttlcc-card">
              <div class="ttlcc-card-title">
                <span>Thông tin truyện</span>
                <div class="ttlcc-toolbar">
                  <button class="ttlcc-btn ttlcc-btn-mini ttlcc-btn-soft" id="ttlcc-edit-story" type="button">Nạp form sửa</button>
                  <button class="ttlcc-btn ttlcc-btn-mini ttlcc-btn-soft" id="ttlcc-publish-story" type="button">Publish / Tạm ẩn</button>
                </div>
              </div>
              <div id="ttlcc-story-editor" class="ttlcc-empty">Chọn truyện rồi bấm “Nạp form sửa”.</div>
            </div>
          </div>
        </section>

        <section class="ttlcc-pane" data-pane="chapters">
          <div class="ttlcc-card">
            <div class="ttlcc-card-title">
              <span>Danh sách chương</span>
              <div class="ttlcc-toolbar">
                <button class="ttlcc-btn ttlcc-btn-primary" id="ttlcc-create-chapter" type="button">+ Chương mới</button>
                <button class="ttlcc-btn ttlcc-btn-soft" id="ttlcc-chapter-reload" type="button">Quét server</button>
              </div>
            </div>
            <div class="ttlcc-toolbar">
              <input class="ttlcc-input" id="ttlcc-chapter-filter" type="text" placeholder="Tên / slug / số chương…" style="min-width:230px">
              <label><input id="ttlcc-chapter-paid" type="checkbox"> Chỉ trả phí</label>
              <label><input id="ttlcc-chapter-short" type="checkbox"> Chỉ &lt;1000 từ</label>
            </div>
            <div class="ttlcc-table-wrap" style="margin-top:9px">
              <table class="ttlcc-table">
                <thead><tr><th>#</th><th>Tên chương</th><th>Trạng thái</th><th>Slug</th><th>Số từ</th><th>Pass</th><th>Mở khóa</th><th>Thao tác</th></tr></thead>
                <tbody id="ttlcc-chapter-body"><tr><td colspan="8" class="ttlcc-empty">Chưa tải chương.</td></tr></tbody>
              </table>
            </div>
          </div>
        </section>

        <section class="ttlcc-pane" data-pane="bulk">
          <div class="ttlcc-bulk-layout">
            <div>
              <div class="ttlcc-card">
                <div class="ttlcc-card-title">Bulk engine</div>
                <div class="ttlcc-field">
                  <div class="ttlcc-label">Tác vụ</div>
                  <select id="ttlcc-bulk-operation">
                    <option value="price_update">Fix giá CHƯƠNG cũ</option>
                    <option value="both">Cập nhật tên + nội dung</option>
                    <option value="title">Chỉ đổi tên</option>
                    <option value="content">Chỉ cập nhật nội dung</option>
                    <option value="create">Đăng CHƯƠNG mới</option>
                  </select>
                </div>
                <div class="ttlcc-grid3" style="margin-top:8px">
                  <div class="ttlcc-field"><div class="ttlcc-label">Từ chương</div><input id="ttlcc-bulk-from" type="number" min="1"></div>
                  <div class="ttlcc-field"><div class="ttlcc-label">Đến chương</div><input id="ttlcc-bulk-to" type="number" min="1"></div>
                  <div class="ttlcc-field"><div class="ttlcc-label">Delay ms</div><input id="ttlcc-bulk-delay" type="number" min="0" step="100" value="1100"></div>
                </div>
                <div class="ttlcc-toolbar" style="margin-top:8px">
                  <label><input id="ttlcc-bulk-verify" type="checkbox" checked> Re-check sau lưu</label>
                  <label><input id="ttlcc-bulk-stop-error" type="checkbox" checked> Dừng khi lỗi</label>
                </div>
              </div>

              <div class="ttlcc-card" id="ttlcc-bulk-txt-card" style="display:none">
                <div class="ttlcc-card-title"><span>TXT</span><span class="ttlcc-badge">CHƯƠNG X: Tên</span></div>
                <input id="ttlcc-bulk-file" type="file" accept=".txt,text/plain">
                <textarea id="ttlcc-bulk-text" class="ttlcc-textarea" placeholder="CHƯƠNG 96: Tên chương\n\nNội dung…"></textarea>
                <button class="ttlcc-btn ttlcc-btn-primary" id="ttlcc-bulk-parse" type="button" style="margin-top:8px">Phân tích TXT</button>
              </div>

              <div class="ttlcc-card" id="ttlcc-price-card">
                <div class="ttlcc-card-title">Giá mở khóa</div>
                <div class="ttlcc-grid3">
                  <div class="ttlcc-field"><div class="ttlcc-label">Từ</div><input id="ttlcc-price-from" type="number" min="1"></div>
                  <div class="ttlcc-field"><div class="ttlcc-label">Đến</div><input id="ttlcc-price-to" type="number" min="1"></div>
                  <div class="ttlcc-field"><div class="ttlcc-label">Loại</div><select id="ttlcc-price-type"><option value="free">FREE</option><option value="stars">Sao</option><option value="diamond">KC</option></select></div>
                </div>
                <div class="ttlcc-toolbar" style="margin-top:8px">
                  <input id="ttlcc-price-value" type="number" min="1" max="10" value="5" style="width:75px">
                  <button class="ttlcc-btn ttlcc-btn-primary" id="ttlcc-price-apply" type="button">Áp dụng</button>
                  <button class="ttlcc-btn ttlcc-btn-soft" id="ttlcc-price-alt-star" type="button">Sao → KC</button>
                  <button class="ttlcc-btn ttlcc-btn-soft" id="ttlcc-price-alt-kc" type="button">KC → Sao</button>
                </div>
                <div class="ttlcc-head-sub" style="margin-top:8px;color:var(--ttlcc-muted)">Dưới 1000 từ bị ép FREE. Sao 1–10. KC cố định 1.</div>
              </div>
            </div>

            <div class="ttlcc-card">
              <div class="ttlcc-card-title"><span>Preview / Re-check</span><span id="ttlcc-bulk-summary" class="ttlcc-badge">Chưa có dữ liệu</span></div>
              <div class="ttlcc-table-wrap" style="max-height:calc(100vh - 330px)">
                <table class="ttlcc-table">
                  <thead><tr><th>Ch.</th><th>Tên</th><th>Số từ</th><th>Giá</th><th>Trạng thái</th></tr></thead>
                  <tbody id="ttlcc-bulk-preview"></tbody>
                </table>
              </div>
              <div class="ttlcc-toolbar" style="margin-top:10px;justify-content:flex-end">
                <button class="ttlcc-btn ttlcc-btn-danger" id="ttlcc-bulk-cancel" type="button" disabled>Hủy</button>
                <button class="ttlcc-btn ttlcc-btn-primary" id="ttlcc-bulk-run" type="button">Chạy batch</button>
              </div>
            </div>
          </div>
        </section>

        <section class="ttlcc-pane" data-pane="revenue">
          <div class="ttlcc-revenue-top">
            <div class="ttlcc-revenue-summary">
              <div class="ttlcc-revenue-summary-label">Có thể rút</div>
              <div class="ttlcc-revenue-summary-value" id="ttlcc-revenue-withdrawable">—</div>
              <div class="ttlcc-revenue-summary-sub" id="ttlcc-revenue-withdrawable-sub">Số dư khả dụng: —</div>
            </div>

            <div class="ttlcc-revenue-summary">
              <div class="ttlcc-revenue-summary-label">Tổng KC đã thu</div>
              <div class="ttlcc-revenue-summary-value" id="ttlcc-revenue-total">—</div>
              <div class="ttlcc-revenue-summary-sub" id="ttlcc-revenue-total-sub">— lượt bán</div>
            </div>

            <div class="ttlcc-revenue-summary">
              <div class="ttlcc-revenue-summary-label">Tháng này</div>
              <div class="ttlcc-revenue-summary-value" id="ttlcc-revenue-month">—</div>
              <div class="ttlcc-revenue-summary-sub" id="ttlcc-revenue-period">Kỳ hiện tại</div>
            </div>
          </div>

          <div class="ttlcc-card">
            <div class="ttlcc-revenue-toolbar">
              <div>
                <div class="ttlcc-card-title" style="margin:0">Doanh thu theo truyện</div>
                <div class="ttlcc-revenue-meta" id="ttlcc-revenue-meta"></div>
              </div>
              <button class="ttlcc-btn ttlcc-btn-soft" id="ttlcc-revenue-refresh" type="button">↻ Refresh</button>
            </div>

            <div class="ttlcc-revenue-story-list" id="ttlcc-revenue-stories">
              <div class="ttlcc-empty">Mở tab để tải doanh thu.</div>
            </div>
          </div>
        </section>

        <section class="ttlcc-pane" data-pane="log">
          <div class="ttlcc-card">
            <div class="ttlcc-card-title"><span>Nhật ký</span><button class="ttlcc-btn ttlcc-btn-mini ttlcc-btn-soft" id="ttlcc-log-clear" type="button">Xóa log</button></div>
            <div id="ttlcc-log" class="ttlcc-log"></div>
          </div>
        </section>
      </div>
    `;
    document.body.appendChild(panel);

    const modal = document.createElement('div');
    modal.id = 'ttlcc-modal';
    modal.innerHTML = `
      <div class="ttlcc-modal-box">
        <div class="ttlcc-modal-head"><span id="ttlcc-modal-title">Modal</span><button class="ttlcc-icon" id="ttlcc-modal-close" type="button">×</button></div>
        <div class="ttlcc-modal-body" id="ttlcc-modal-body"></div>
      </div>`;
    document.body.appendChild(modal);

    const toastHost = document.createElement('div');
    toastHost.id = 'ttlcc-toast-host';
    document.body.appendChild(toastHost);

    bindUiEvents();

    const prefs = loadPrefs();
    if (prefs.minimized) panel.classList.add('ttlcc-minimized');
    if (prefs.activeTab) switchTab(prefs.activeTab);
  }

  function switchTab(tab) {
    state.activeTab = tab;
    $$('.ttlcc-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.ttlcc-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === tab));

    if (tab === 'revenue') {
      renderRevenue();

      if (!state.revenue.loaded) {
        loadRevenueData().catch(() => {});
      }
    }

    savePrefs();
  }

  function syncBulkOperationUi() {
    const op = bulkOperation();
    state.bulk.operation = op;
    const txt = $('#ttlcc-bulk-txt-card');
    const price = $('#ttlcc-price-card');
    if (txt) txt.style.display = op === 'price_update' ? 'none' : '';
    if (price) price.style.display = ['price_update', 'create'].includes(op) ? '' : 'none';

    if (op === 'price_update') {
      // Chuyển vào Fix giá => lấy server hiện tại làm baseline mới.
      initializeExistingPricing(true);
      const nums = state.chapters.map(x => x.chapterNo);
      if (nums.length) {
        const min = Math.min(...nums), max = Math.max(...nums);
        $('#ttlcc-bulk-from').value = min;
        $('#ttlcc-bulk-to').value = max;
        $('#ttlcc-price-from').value = min;
        $('#ttlcc-price-to').value = max;
      }
    } else if (state.bulk.parsed.length) {
      const nums = state.bulk.parsed.map(x => x.chapterNo);
      $('#ttlcc-bulk-from').value = Math.min(...nums);
      $('#ttlcc-bulk-to').value = Math.max(...nums);
      $('#ttlcc-price-from').value = Math.min(...nums);
      $('#ttlcc-price-to').value = Math.max(...nums);
    }

    renderBulkPreview();
  }

  function bindUiEvents() {
    $$('.ttlcc-tab-btn').forEach(btn => btn.onclick = () => switchTab(btn.dataset.tab));

    $('#ttlcc-minimize').onclick = e => {
      // Quan trọng: chặn click bubble lên header, nếu không header sẽ
      // mở panel trở lại ngay trong cùng một click.
      e.preventDefault();
      e.stopPropagation();

      $('#ttlcc-panel').classList.add('ttlcc-minimized');
      savePrefs();
    };

    $('#ttlcc-head').addEventListener('click', e => {
      const panel = $('#ttlcc-panel');

      // Khi đã thu nhỏ, click vào pill/header mini sẽ mở lại.
      if (panel.classList.contains('ttlcc-minimized')) {
        panel.classList.remove('ttlcc-minimized');
        savePrefs();
      }
    });

    $('#ttlcc-refresh-all').onclick = async () => {
      try {
        await loadStories();
        if (state.selectedStoryId) await loadChapters();
        toast('Refresh toàn bộ hoàn tất.', 'ok');
      } catch (err) {
        toast(`Refresh lỗi: ${err.message}`, 'error', 6000);
      }
    };

    $('#ttlcc-story-filter').addEventListener('input', renderStoryList);
    $('#ttlcc-story-reload').onclick = () => loadStories().catch(err => toast(err.message, 'error'));
    $('#ttlcc-story-server-search').onclick = () => {
      const q = $('#ttlcc-story-filter').value.trim();
      if (!q) return loadStories();
      loadStories({ serverSearch: true, query: q }).catch(err => toast(`Tìm server lỗi: ${err.message}`, 'error'));
    };
    $('#ttlcc-create-story').onclick = () => loadStoryEditor('create');
    $('#ttlcc-edit-story').onclick = () => loadStoryEditor('edit');
    $('#ttlcc-publish-story').onclick = togglePublishSelected;

    $('#ttlcc-chapter-filter').addEventListener('input', renderChapters);
    $('#ttlcc-chapter-paid').addEventListener('change', renderChapters);
    $('#ttlcc-chapter-short').addEventListener('change', renderChapters);
    $('#ttlcc-create-chapter').onclick = openCreateChapter;
    $('#ttlcc-chapter-reload').onclick = () => loadChapters().catch(err => toast(err.message, 'error'));

    $('#ttlcc-bulk-operation').onchange = syncBulkOperationUi;
    $('#ttlcc-bulk-from').oninput = () => {
      if (['price_update', 'create'].includes(bulkOperation())) $('#ttlcc-price-from').value = $('#ttlcc-bulk-from').value;
      renderBulkPreview();
    };
    $('#ttlcc-bulk-to').oninput = () => {
      if (['price_update', 'create'].includes(bulkOperation())) $('#ttlcc-price-to').value = $('#ttlcc-bulk-to').value;
      renderBulkPreview();
    };
    $('#ttlcc-bulk-file').onchange = async e => {
      const f = e.target.files?.[0];
      if (!f) return;
      $('#ttlcc-bulk-text').value = await f.text();
      toast(`Đã nạp ${f.name}`, 'ok');
    };
    $('#ttlcc-bulk-parse').onclick = () => {
      try {
        // TXT mới = batch mới. Không kế thừa giá create từ batch cũ.
        state.bulk.pricing.clear();
        state.bulk.parsed = parseTxtBatch($('#ttlcc-bulk-text').value);
        const nums = state.bulk.parsed.map(x => x.chapterNo);
        $('#ttlcc-bulk-from').value = Math.min(...nums);
        $('#ttlcc-bulk-to').value = Math.max(...nums);
        $('#ttlcc-price-from').value = Math.min(...nums);
        $('#ttlcc-price-to').value = Math.max(...nums);
        for (const item of state.bulk.parsed) getPricing(item.chapterNo);
        toast(`Parse OK: ${state.bulk.parsed.length} chương.`, 'ok');
        renderBulkPreview();
      } catch (err) {
        state.bulk.parsed = [];
        toast(`Parse TXT lỗi: ${err.message}`, 'error', 6000);
        renderBulkPreview();
      }
    };

    $('#ttlcc-price-type').onchange = () => {
      const t = $('#ttlcc-price-type').value;
      const v = $('#ttlcc-price-value');
      v.disabled = t !== 'stars';
      v.value = t === 'stars' ? (Number(v.value) || 5) : t === 'diamond' ? 1 : '';
    };
    $('#ttlcc-price-apply').onclick = applyPricingRange;
    $('#ttlcc-price-alt-star').onclick = () => applyAlternating('stars');
    $('#ttlcc-price-alt-kc').onclick = () => applyAlternating('diamond');
    $('#ttlcc-bulk-run').onclick = () => runBulk().catch(err => toast(err.message, 'error'));
    $('#ttlcc-bulk-cancel').onclick = () => {
      state.cancelled = true;
      toast('Đã nhận lệnh hủy; batch sẽ dừng trước request kế tiếp.', 'warn');
    };

    $('#ttlcc-revenue-refresh').onclick = () =>
      loadRevenueData({ force: true }).catch(() => {});

    $('#ttlcc-modal-close').onclick = closeModal;
    $('#ttlcc-modal').addEventListener('click', e => { if (e.target.id === 'ttlcc-modal') closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

    $('#ttlcc-log-clear').onclick = () => {
      state.log.length = 0;
      $('#ttlcc-log').innerHTML = '';
    };
  }

  // ==========================================================
  // START
  // ==========================================================

  async function start() {
    injectUi();
    addLog(`Control Center v${VERSION} khởi động.`);
    setStatus('Đang tải dữ liệu quản lý…');

    try {
      await loadStories();
      if (state.selectedStoryId && !state.chapters.length) await loadChapters();
      syncBulkOperationUi();
      renderDashboard();
      setStatus('Sẵn sàng.', 'ok');
    } catch (err) {
      setStatus(`Khởi tạo lỗi: ${err.message}`, 'error');
      toast(`Khởi tạo chưa đầy đủ: ${err.message}`, 'error', 7000);
    }
  }

  window.TTL_CONTROL_CENTER = {
    version: VERSION,
    state,
    refreshStories: () => loadStories(),
    refreshChapters: () => loadChapters(),
    selectStory,
    openChapter: openChapterEditor,
    createChapter: openCreateChapter,
    editStory: () => loadStoryEditor('edit'),
    createStory: () => loadStoryEditor('create'),
    openRevenue: () => {
      switchTab('revenue');
      return loadRevenueData({ force: true });
    },
    minimize() { $('#ttlcc-panel')?.classList.add('ttlcc-minimized'); savePrefs(); },
    restore() { $('#ttlcc-panel')?.classList.remove('ttlcc-minimized'); savePrefs(); },
  };

  start();
})();
