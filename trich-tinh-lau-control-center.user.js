// ==UserScript==
// @name         Trích Tinh Lâu - Control Center Toàn Diện
// @namespace    https://github.com/caccac11/TTL
// @version      1.4.3
// @description  TTL Control: giao diện phẳng một trục cuộn, bulk native an toàn, update pipeline no-follow, quản lý truyện/chương/doanh thu.
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

  const VERSION = '1.4.3';
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
    bulkCreateTimeoutMs: 180000,
    bulkUpdatePrepareConcurrency: 2,
    bulkUpdateWriteConcurrency: 2,
    bulkUpdateVerifyConcurrency: 2,
    bulkUpdateRequestGapMs: 360,
    bulkUpdatePhaseCooldownMs: 450,
    bulkUpdateJobAttempts: 3,
    bulkUpdateVerifyAttempts: 3,
    bulkUpdateRetryBaseMs: 1200,
    bulkCreateReconcileAttempts: 5,
    bulkCreateReconcileBaseMs: 900,
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
    storyLoadSeq: 0,
    selectedStoryId: null,
    selectedStory: null,
    storyEditorModel: null,
    chapterCreateModel: null,
    chapters: [],
    chapterMap: new Map(),
    chapterHeaderMap: {},
    chapterLoading: false,
    chapterLoadSeq: 0,
    chapterLoadingStoryId: null,
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
    activeTab: 'stories',

    // Monotonic counter used only for adaptive update health telemetry.
    // Any GET retry/fallback increments this so a job that eventually succeeds
    // can still be classified as DEGRADED rather than CLEAN.
    netRetrySeq: 0,

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
          minimized: $('#ttlcc-panel')?.classList.contains('ttlcc-minimized') || false,
        })
      );
    } catch {}
  }

  function loadPrefs() {
    try {
      const prefs = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');

      // Tab đang mở không còn được lưu. Mỗi lần khởi động UI luôn bắt đầu ở Danh sách.
      delete prefs.activeTab;
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
        state.netRetrySeq++;
        addLog(`${label}: HTTP ${res.status}; retry ${attempt + 1}/${CFG.getAttempts} sau ${Math.ceil(wait / 1000)}s`, 'warn');
        try { await res.body?.cancel(); } catch {}
        await sleep(wait);
      } catch (err) {
        clearTimeout(timer);
        last = err;
        if (attempt === CFG.getAttempts) break;
        state.netRetrySeq++;
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
      state.netRetrySeq++;
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

  async function postOnce(url, {
    body,
    headers = {},
    label = 'POST',
    rawMethod = 'POST',
    redirectMode = 'follow',
    acceptManualRedirect = false,
  } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CFG.getTimeoutMs);

    try {
      const res = await fetch(url, {
        method: rawMethod,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: redirectMode,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5',
          ...headers,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Với redirect:'manual', browser có thể trả:
      // - status 3xx same-origin, hoặc
      // - type='opaqueredirect', status=0.
      // Trong cả hai trường hợp request ghi đã tới server, còn redirect GET bị chặn
      // có chủ đích. Caller vẫn VERIFY trạng thái thật ở pha sau.
      if (
        acceptManualRedirect &&
        redirectMode === 'manual' &&
        (
          res.type === 'opaqueredirect' ||
          (res.status >= 300 && res.status < 400)
        )
      ) {
        return res;
      }

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

  async function submitRenderedForm(
    form,
    model,
    label,
    { noFollowRedirect = false } = {}
  ) {
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
      ...(noFollowRedirect
        ? { redirectMode: 'manual', acceptManualRedirect: true }
        : {}),
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
    // Search cần form thật của server. Nếu chưa có, nạp danh sách một lần trước.
    if (serverSearch && !state.storySearchForm) {
      await loadStories();
    }

    const requestSeq = ++state.storyLoadSeq;
    setStatus(serverSearch ? 'Đang tìm truyện…' : 'Đang tải truyện…');

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

    // Refresh/search cũ không được ghi đè kết quả mới hơn.
    if (requestSeq !== state.storyLoadSeq) {
      addLog(`Bỏ kết quả story stale (request ${requestSeq}).`, 'info');
      return found;
    }

    if (!serverSearch) state.stories.clear();
    mergeStories(found);

    renderStoryList();
    setStatus(`${state.stories.size} truyện đã sẵn sàng.`, 'ok');

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

    const frag = document.createDocumentFragment();

    for (const story of rows) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `ttlcc-story-item ${Number(state.selectedStoryId) === story.id ? 'active' : ''}`;
      el.innerHTML = `
        <span class="ttlcc-story-title">${esc(story.title)}</span>
        <span class="ttlcc-story-id">#${story.id}</span>
      `;
      el.onclick = () => selectStory(story.id, { loadChaptersNow: true });
      frag.appendChild(el);
    }

    body.appendChild(frag);
  }

  function resetBulkForStoryChange() {
    state.bulk.parsed = [];
    state.bulk.pricing.clear();
    state.bulk.existingPricing.clear();
    state.snapshotCache.clear();

    const txt = $('#ttlcc-bulk-text');
    if (txt) txt.value = '';

    const file = $('#ttlcc-bulk-file');
    if (file) file.value = '';

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

    if (state.running && previousStoryId && previousStoryId !== id) {
      toast('Batch đang chạy. Hãy dừng hoặc chờ hoàn tất trước khi đổi truyện.', 'warn', 4500);
      return false;
    }

    if (previousStoryId && previousStoryId !== id) {
      // Invalidate mọi GET chapter cũ ngay khi context truyện đổi.
      state.chapterLoadSeq++;
      state.chapterLoading = false;
      state.chapterLoadingStoryId = null;
      resetBulkForStoryChange();

      // Không để bảng/chỉ số/chapter template của truyện cũ tồn tại
      // trong lúc truyện mới đang được tải.
      state.chapters = [];
      state.chapterMap.clear();
      state.chapterHeaderMap = {};
      state.chapterCreateModel = null;
      state.storyEditorModel = null;

      addLog(
        `Đổi truyện #${previousStoryId} → #${id}. Đã làm sạch dữ liệu batch của truyện cũ.`,
        'info'
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

    return true;
  }

  function renderStoryHeader() {
    const story = state.selectedStory;
    const title = $('#ttlcc-selected-title');
    const sub = $('#ttlcc-selected-sub');
    if (title) title.textContent = story ? story.title : 'Chưa chọn truyện';
    if (sub) sub.textContent = story ? `#${story.id}` : '';

    const badge = $('#ttlcc-story-badge');
    if (badge) badge.textContent = story ? `#${story.id}` : '—';

    renderDashboard();
  }

  async function loadStoryEditor() {
    const host = $('#ttlcc-story-editor');
    if (!host) return;

    if (!state.selectedStoryId) {
      return toast('Chưa chọn truyện.', 'warn');
    }

    host.innerHTML =
      '<div class="ttlcc-loading">Đang đọc form thật từ server…</div>';

    const url =
      routeUrl(`/truyen/${state.selectedStoryId}/edit`);

    try {
      const { doc, finalUrl } =
        await fetchDoc(
          url,
          'GET form sửa truyện'
        );

      const form =
        [...doc.forms].find(f => {
          const action =
            new URL(
              f.getAttribute('action') || '',
              finalUrl
            ).pathname;

          return (
            f.querySelector('[name="tentruyen"]') &&
            /^\/truyen\/\d+$/.test(action)
          );
        });

      if (!form) {
        throw new Error(
          'Không tìm thấy form sửa truyện có field tentruyen.'
        );
      }

      const model =
        formToModel(form, finalUrl);

      state.storyEditorModel = model;

      renderLiveForm(host, model, {
        title:
          `Sửa truyện #${state.selectedStoryId}`,
        submitText: 'Lưu thay đổi',

        onSubmit:
          async (
            uiForm,
            liveModel,
            btn
          ) => {
            const action =
              `LƯU TRUYỆN #${state.selectedStoryId}`;

            if (
              !confirm(
                `${action}\n\n` +
                'Script sẽ gửi đúng form vừa đọc từ server. Tiếp tục?'
              )
            ) {
              return;
            }

            btn.disabled = true;

            try {
              await submitRenderedForm(
                uiForm,
                liveModel,
                action,
                { noFollowRedirect: true }
              );

              toast(
                `${action}: server đã nhận yêu cầu. Đang re-check…`,
                'ok'
              );

              await sleep(500);
              await loadStories();
              await loadStoryEditor();
            } catch (err) {
              toast(
                `${action} lỗi: ${err.message}`,
                'error',
                6000
              );
            } finally {
              btn.disabled = false;
            }
          },
      });
    } catch (err) {
      host.innerHTML = `
        <div class="ttlcc-error-box">
          Không mở được trình chỉnh sửa: ${esc(err.message)}
          <button
            class="ttlcc-btn ttlcc-btn-soft"
            id="ttlcc-story-native-fallback"
            type="button"
          >
            Mở form gốc
          </button>
        </div>`;

      $('#ttlcc-story-native-fallback')
        ?.addEventListener(
          'click',
          () =>
            openNativeTool(
              url,
              'Form truyện gốc'
            )
        );
    }
  }

  async function togglePublishSelected() {
    if (state.running) return toast('Batch đang chạy. Không thể đổi trạng thái truyện lúc này.', 'warn');
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
        redirectMode: 'manual',
        acceptManualRedirect: true,
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
    storyId = Number(storyId || 0);
    if (!storyId) throw new Error('Chưa chọn truyện.');

    const requestSeq = ++state.chapterLoadSeq;
    state.chapterLoading = true;
    state.chapterLoadingStoryId = storyId;

    const listBody = $('#ttlcc-chapter-body');
    if (listBody && Number(state.selectedStoryId) === storyId) {
      listBody.innerHTML = '<tr><td colspan="5" class="ttlcc-loading">Đang tải chương…</td></tr>';
    }

    try {
      const url = routeUrl(`/chapter/${storyId}`);
      const { doc, finalUrl } = await fetchDoc(url, `GET chương truyện #${storyId}`);
      const parsed = parseChapterList(doc, finalUrl, storyId);

      // Chỉ request mới nhất của đúng truyện đang chọn mới được phép commit state.
      // Đây là guard chống race khi user đổi truyện nhanh trong lúc GET cũ còn bay.
      if (
        requestSeq !== state.chapterLoadSeq ||
        Number(state.selectedStoryId) !== storyId
      ) {
        addLog(
          `Bỏ kết quả chapter stale của truyện #${storyId} (request ${requestSeq}).`,
          'info'
        );
        return false;
      }

      state.chapters = parsed.rows;
      state.chapterMap = new Map(parsed.rows.map(r => [r.chapterNo, r]));
      state.chapterHeaderMap = parsed.headerMap;
      state.snapshotCache.clear();

      initializeExistingPricing();
      renderChapters();
      renderDashboard();
      renderBulkPreview();
      setStatus(`${state.chapters.length} chương đã sẵn sàng.`, 'ok');
      return true;
    } finally {
      if (requestSeq === state.chapterLoadSeq) {
        state.chapterLoading = false;
        state.chapterLoadingStoryId = null;
      }
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
      body.innerHTML = '<tr><td colspan="5" class="ttlcc-empty">Không có chương phù hợp.</td></tr>';
      return;
    }

    const frag = document.createDocumentFragment();

    for (const r of rows) {
      const price = r.diamonds > 0 ? `${r.diamonds} KC` : r.stars > 0 ? `${r.stars} sao` : 'FREE';
      const shortPaid = r.wordCount > 0 && r.wordCount < CFG.pricing.minPaidWords && (r.stars > 0 || r.diamonds > 0);
      const status = r.status && r.status !== '—'
        ? `<span class="ttlcc-meta-chip">${esc(r.status)}</span>`
        : '';
      const tr = document.createElement('tr');
      if (shortPaid) tr.classList.add('ttlcc-row-warn');

      tr.innerHTML = `
        <td class="ttlcc-num">${r.chapterNo}</td>
        <td class="ttlcc-left">
          <div class="ttlcc-chapter-title">${esc(r.title)}</div>
          ${status ? `<div class="ttlcc-chapter-meta">${status}</div>` : ''}
        </td>
        <td>${r.wordCount.toLocaleString()}</td>
        <td>
          <span class="ttlcc-price-chip ${r.diamonds > 0 ? 'diamond' : r.stars > 0 ? 'stars' : 'free'}">${esc(price)}</span>
          ${shortPaid ? '<span class="ttlcc-alert-dot" title="Dưới 1000 từ nhưng đang trả phí">!</span>' : ''}
        </td>
        <td>
          <div class="ttlcc-row-actions">
            <button type="button" class="ttlcc-btn ttlcc-btn-mini ttlcc-btn-soft" data-edit="${r.chapterNo}">Sửa</button>
            <button type="button" class="ttlcc-btn ttlcc-btn-mini ttlcc-btn-ghost-danger" data-delete="${r.chapterNo}" ${r.deleteModel ? '' : 'disabled'}>Xóa</button>
          </div>
        </td>
      `;
      frag.appendChild(tr);
    }

    body.appendChild(frag);

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
    if (state.running) return toast('Batch đang chạy. Không thể sửa chương lúc này.', 'warn');
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
            await submitRenderedForm(
              uiForm,
              liveModel,
              `PUT CHƯƠNG ${chapterNo}`,
              { noFollowRedirect: true }
            );
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
    if (state.running) return toast('Batch đang chạy. Không thể tạo chương lúc này.', 'warn');
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
            await submitRenderedForm(
              uiForm,
              liveModel,
              'POST tạo chương',
              { noFollowRedirect: true }
            );
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
    if (state.running) return toast('Batch đang chạy. Không thể xóa chương lúc này.', 'warn');
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
        redirectMode: 'manual',
        acceptManualRedirect: true,
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

  function applyParsedTxtBatch(parsed, message = '') {
    const rows = [...(parsed || [])].sort((a, b) => a.chapterNo - b.chapterNo);
    if (!rows.length) throw new Error('Batch TXT không có chương hợp lệ.');

    // TXT mới = batch mới. Không kế thừa giá create từ batch cũ.
    state.bulk.pricing.clear();
    state.bulk.parsed = rows;

    const nums = rows.map(x => x.chapterNo);
    const first = Math.min(...nums);
    const last = Math.max(...nums);

    $('#ttlcc-bulk-from').value = first;
    $('#ttlcc-bulk-to').value = last;
    $('#ttlcc-price-from').value = first;
    $('#ttlcc-price-to').value = last;

    for (const item of rows) getPricing(item.chapterNo);

    renderBulkPreview();

    if (message) toast(message, 'ok');
  }

  async function loadBulkTxtFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;

    const invalid = files.filter(file => {
      const name = String(file?.name || '');
      return !/\.txt$/i.test(name) && file?.type && file.type !== 'text/plain';
    });

    if (invalid.length) {
      throw new Error(
        `Chỉ hỗ trợ TXT: ${invalid.map(f => f.name || '(không tên)').join(', ')}`
      );
    }

    const batches = [];

    // Parse từng file RIÊNG bằng parser TTL gốc.
    for (const file of files) {
      const raw = String(await file.text())
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n');

      let parsed;
      try {
        parsed = parseTxtBatch(raw);
      } catch (err) {
        throw new Error(`${file.name || 'TXT'}: ${err.message}`);
      }

      batches.push({
        file,
        raw,
        parsed: parsed.map(item => ({
          ...item,
          sourceFile: String(file.name || 'TXT'),
        })),
        first: parsed[0]?.chapterNo ?? Number.MAX_SAFE_INTEGER,
        last: parsed.at(-1)?.chapterNo ?? 0,
      });
    }

    // Sắp theo chương đầu để kết quả không phụ thuộc thứ tự user chọn file.
    batches.sort((a, b) =>
      (a.first - b.first) ||
      String(a.file.name || '').localeCompare(String(b.file.name || ''), 'vi')
    );

    // Fail-closed khi 2 file chứa cùng chapter_number.
    const owner = new Map();
    const duplicates = [];

    for (const batch of batches) {
      for (const item of batch.parsed) {
        const no = Number(item.chapterNo);

        if (owner.has(no)) {
          duplicates.push({
            no,
            first: owner.get(no),
            second: batch.file.name || 'TXT',
          });
        } else {
          owner.set(no, batch.file.name || 'TXT');
        }
      }
    }

    if (duplicates.length) {
      const detail = duplicates
        .slice(0, 12)
        .map(x => `CHƯƠNG ${x.no}: "${x.first}" ↔ "${x.second}"`)
        .join('; ');

      throw new Error(
        `Trùng chương giữa các file: ${detail}` +
        (duplicates.length > 12 ? `; ... +${duplicates.length - 12}` : '')
      );
    }

    const merged = batches
      .flatMap(batch => batch.parsed)
      .sort((a, b) => a.chapterNo - b.chapterNo);

    // Textarea chỉ để user xem/chỉnh tay.
    // State parsed đã lấy trực tiếp từ từng file nên không bị lỗi ranh giới file.
    $('#ttlcc-bulk-text').value = batches
      .map(batch => batch.raw.trim())
      .filter(Boolean)
      .join('\n\n\n');

    const first = merged[0]?.chapterNo;
    const last = merged.at(-1)?.chapterNo;

    applyParsedTxtBatch(
      merged,
      `Đã nạp ${files.length} TXT · ${merged.length} chương` +
      (first != null ? ` · CHƯƠNG ${first}–${last}` : '')
    );

    addLog(
      `Multi-TXT: ${files.length} file, ${merged.length} chương` +
      (first != null ? ` (${first}–${last})` : '') +
      '.'
    );
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

    const frag = document.createDocumentFragment();

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
      frag.appendChild(tr);
    }

    body.appendChild(frag);

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

    // Chapter update endpoint thường redirect sau khi commit. Nếu fetch follow redirect,
    // mỗi PUT/POST update vô tình sinh thêm một GET tải trang đích. Khi GET đó rớt,
    // browser báo "Failed to fetch" dù server đã ghi thành công.
    //
    // Ta chặn follow redirect tại đây. Trạng thái chapter được VERIFY độc lập bằng
    // fetchChapterSnapshot()/verifyChapter(), nên không cần tải trang redirect.
    return postOnce(snapshot.model.action, {
      rawMethod: snapshot.model.rawMethod || 'POST',
      body: params.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      label,
      redirectMode: 'manual',
      acceptManualRedirect: true,
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

  function htmlToPlainText(html) {
    const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
    return text(doc.body.textContent || '');
  }

  function makeBulkExcerpt(html, maxLen = 100) {
    const plain = htmlToPlainText(html);
    if (plain.length <= maxLen) return plain;
    return `${plain.slice(0, maxLen).trimEnd()}...`;
  }

  async function getNativeBulkContext() {
    const storyId = Number(state.selectedStoryId);
    if (!storyId) throw new Error('Chưa chọn truyện.');

    const url = routeUrl(`/chapter/upload-word/${storyId}`);
    const { doc, html, finalUrl } = await fetchDoc(url, `GET preflight native bulk #${storyId}`);
    if (!finalUrl.startsWith(ORIGIN)) throw new Error('Preflight bulk bị redirect ngoài domain.');

    const expectedPath = `/chapter/bulk-store/${storyId}`;
    const hasEndpoint = String(html).includes(expectedPath);
    const hasParsedArray = /chapters\s*:\s*parsedChapters\b/.test(String(html));
    const storyMatch = String(html).match(/\bconst\s+truyenId\s*=\s*(\d+)\s*;/);
    const countMatch = String(html).match(/\bconst\s+currentChapterCount\s*=\s*(\d+)\s*;/);
    const token = doc.querySelector('meta[name="csrf-token"]')?.getAttribute('content')
      || doc.querySelector('input[name="_token"]')?.value
      || '';

    if (!hasEndpoint) throw new Error(`Web không còn expose ${expectedPath}; dừng để tránh POST sai route.`);
    if (!hasParsedArray) throw new Error('Cơ chế bulk web đã đổi: không còn chapters: parsedChapters.');
    if (storyMatch && Number(storyMatch[1]) !== storyId) {
      throw new Error(`Preflight bulk trả sai truyện: web=${storyMatch[1]}, cần=${storyId}.`);
    }
    if (!token) throw new Error('Không lấy được CSRF token từ trang native bulk.');

    const currentChapterCount = countMatch ? Number(countMatch[1]) : null;
    return {
      storyId,
      endpoint: routeUrl(expectedPath),
      token,
      currentChapterCount,
    };
  }

  function buildNativeBulkParams(items, token) {
    const params = new URLSearchParams();
    params.append('_token', token);

    items.forEach((item, index) => {
      const base = `chapters[${index}]`;
      params.append(`${base}[title]`, sanitizeChapterTitle(item.title, item.chapterNo));
      params.append(`${base}[content]`, item.htmlContent);
      params.append(`${base}[excerpt]`, makeBulkExcerpt(item.htmlContent));
      params.append(`${base}[publish_at]`, '');
      params.append(`${base}[has_warning]`, 'false');
    });

    return params;
  }

  async function postNativeBulkCreate(context, items) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CFG.bulkCreateTimeoutMs);
    const startedAt = performance.now();

    try {
      const body = buildNativeBulkParams(items, context.token).toString();
      const res = await fetch(context.endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'follow',
        headers: {
          Accept: 'application/json,text/plain;q=0.9,*/*;q=0.5',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body,
        signal: controller.signal,
      });

      const durationMs = Math.round(performance.now() - startedAt);
      const raw = await res.text();
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch {}

      if (!res.ok) {
        const msg = json?.message || text(raw).slice(0, 240) || `HTTP ${res.status}`;
        throw new Error(`NATIVE BULK HTTP ${res.status}: ${msg}`);
      }
      if (json && json.success === false) {
        throw new Error(`NATIVE BULK từ chối: ${json.message || 'success=false'}`);
      }

      return {
        status: res.status,
        durationMs,
        json,
        finalUrl: res.url || context.endpoint,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function inspectBulkCreateResult(baseline, items) {
    const expectedNos = items.map(x => x.chapterNo);
    const expectedSet = new Set(expectedNos);
    const baselineIds = baseline.ids;
    const newRows = state.chapters.filter(r => !baselineIds.has(r.chapterId));
    const countDelta = state.chapters.length - baseline.count;
    const mappingErrors = [];

    if (countDelta !== items.length) {
      mappingErrors.push(`delta count=${countDelta}, cần=${items.length}`);
    }
    if (newRows.length !== items.length) {
      mappingErrors.push(`ID mới=${newRows.length}, cần=${items.length}`);
    }

    for (const item of items) {
      const row = state.chapterMap.get(item.chapterNo);
      if (!row) {
        mappingErrors.push(`thiếu CHƯƠNG ${item.chapterNo}`);
        continue;
      }
      if (baselineIds.has(row.chapterId)) {
        mappingErrors.push(`CHƯƠNG ${item.chapterNo} vẫn trỏ ID cũ ${row.chapterId}`);
        continue;
      }

      let actualTitle = '';
      let expectedTitle = '';
      try { actualTitle = sanitizeChapterTitle(row.title, null); } catch { actualTitle = text(row.title); }
      try { expectedTitle = sanitizeChapterTitle(item.title, item.chapterNo); } catch { expectedTitle = text(item.title); }
      if (actualTitle !== expectedTitle) {
        mappingErrors.push(`CHƯƠNG ${item.chapterNo} sai tên: web="${row.title}" cần="${expectedTitle}"`);
      }
    }

    for (const row of newRows) {
      if (!expectedSet.has(row.chapterNo)) {
        mappingErrors.push(`xuất hiện ID mới ngoài dải: STT ${row.chapterNo}, ID ${row.chapterId}`);
      }
    }

    return {
      ok: mappingErrors.length === 0,
      countDelta,
      newRows,
      mappingErrors,
    };
  }

  async function reconcileNativeBulkCreate(baseline, items) {
    let last = null;
    let lastLoadError = null;

    for (let attempt = 1; attempt <= CFG.bulkCreateReconcileAttempts; attempt++) {
      if (attempt > 1) {
        await sleep(CFG.bulkCreateReconcileBaseMs * attempt + jitter(280));
      } else {
        await sleep(650);
      }

      try {
        await loadChapters();
        lastLoadError = null;
      } catch (err) {
        lastLoadError = err;
        addLog(`Reconcile bulk lần ${attempt}: GET danh sách lỗi: ${err.message}`, 'warn');
        continue;
      }

      last = inspectBulkCreateResult(baseline, items);
      if (last.ok) return last;

      // Có nhiều record mới hơn dự kiến là dấu hiệu mutation ngoài batch hoặc duplicate.
      // Không chờ thêm vì tiếp tục có thể che mất sự cố.
      if (last.countDelta > items.length || last.newRows.length > items.length) break;

      // Đã đủ số lượng mà mapping vẫn sai thì đây không còn là độ trễ eventual-consistency.
      if (last.countDelta === items.length && last.newRows.length === items.length) break;

      addLog(
        `Reconcile bulk lần ${attempt}: chưa ổn (${last.mappingErrors.join('; ')}), sẽ kiểm tra lại.`,
        'warn'
      );
    }

    if (!last && lastLoadError) throw lastLoadError;
    return last || {
      ok: false,
      countDelta: 0,
      newRows: [],
      mappingErrors: ['không đọc được trạng thái server sau native bulk'],
    };
  }

  async function applyCreatePricingWithExistingEngine(items, verify, stopError, delayMs, labels) {
    let ok = 0;
    let errors = 0;

    for (let i = 0; i < items.length; i++) {
      if (state.cancelled) {
        addLog('Đã hủy sau khi tạo batch; dừng trước request giá kế tiếp. Các chương đã tạo vẫn còn trên server.', 'warn');
        break;
      }

      const item = items[i];
      const row = state.chapterMap.get(item.chapterNo);
      if (!row) {
        errors++;
        const err = new Error(`Không map được CHƯƠNG ${item.chapterNo} sau native bulk.`);
        addLog(`${labels.create} LỖI CHƯƠNG ${item.chapterNo}: ${err.message}`, 'error');
        if (stopError) throw err;
        continue;
      }

      const targetP = getPricing(item.chapterNo);
      try {
        if (!priceMatchesRow(targetP, row)) {
          setStatus(`ÁP GIÁ ${i + 1}/${items.length}: CHƯƠNG ${item.chapterNo}`);
          const snap = await fetchChapterSnapshot(row, true);
          const pf = pricingFields(targetP, item.chapterNo);
          const expected = {
            stars: Number(pf.stars_active || 0),
            diamonds: Number(pf.diamonds_active || 0),
          };

          await submitChapterOverrides(snap, {
            stars_active: pf.stars_active,
            diamonds_active: pf.diamonds_active,
          }, `GIÁ CHƯƠNG ${item.chapterNo}`);

          if (verify) {
            await sleep(350 + jitter(180));
            await verifyChapter(row, expected);
          }
        }

        ok++;
        addLog(`${labels.create} OK: CHƯƠNG ${item.chapterNo} · ${pricingLabel(targetP)}`, 'ok');
      } catch (err) {
        errors++;
        addLog(`ÁP GIÁ LỖI CHƯƠNG ${item.chapterNo}: ${err.message}`, 'error');
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

    return { ok, errors };
  }

  async function runNativeBulkCreate(items, verify, stopError, delayMs, labels) {
    const sorted = [...items].sort((a, b) => a.chapterNo - b.chapterNo);
    const baseline = {
      count: state.chapters.length,
      maxNo: state.chapters.length ? Math.max(...state.chapters.map(x => x.chapterNo)) : 0,
      ids: new Set(state.chapters.map(x => x.chapterId)),
    };

    setStatus(`PREFLIGHT NATIVE BULK: ${sorted.length} chương...`);
    const context = await getNativeBulkContext();

    if (context.currentChapterCount !== null && context.currentChapterCount !== baseline.count) {
      throw new Error(
        `Preflight count lệch: trang bulk=${context.currentChapterCount}, danh sách=${baseline.count}. ` +
        'Có thể server vừa đổi; hãy quét lại trước khi đăng.'
      );
    }

    // Re-check dải ngay trước POST để giảm cửa sổ race giữa validation và write.
    if (sorted[0].chapterNo !== baseline.maxNo + 1) {
      throw new Error(`Dải tạo không còn bắt đầu tại ${baseline.maxNo + 1}.`);
    }
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].chapterNo !== baseline.maxNo + 1 + i) {
        throw new Error(`Dải native bulk không liên tục tại CHƯƠNG ${sorted[i].chapterNo}.`);
      }
    }

    setStatus(`NATIVE BULK: đang gửi 1 request tạo ${sorted.length} chương...`);
    addLog(
      `Native bulk bắt đầu: truyện #${context.storyId}, ${sorted[0].chapterNo}-${sorted.at(-1).chapterNo}, ` +
      `${sorted.length} chương. Pricing chưa gửi trong request create.`,
      'info'
    );

    let writeResult = null;
    let writeError = null;
    try {
      writeResult = await postNativeBulkCreate(context, sorted);
      addLog(
        `Native bulk HTTP OK: ${writeResult.status}, ${writeResult.durationMs} ms` +
        (writeResult.json?.message ? `, ${writeResult.json.message}` : ''),
        'ok'
      );
    } catch (err) {
      writeError = err;
      addLog(`Native bulk response bất định/lỗi: ${err.message}. Không retry; đang reconcile server.`, 'warn');
    }

    setStatus('NATIVE BULK: đang đối chiếu số lượng, ID, STT và tên chương...');
    const recon = await reconcileNativeBulkCreate(baseline, sorted);

    if (!recon.ok) {
      const detail = recon.mappingErrors.join('; ');
      if (recon.countDelta === 0 && recon.newRows.length === 0) {
        throw new Error(
          `Native bulk không tạo được chương sau ${CFG.bulkCreateReconcileAttempts} lần kiểm tra. ` +
          `${writeError ? `Lỗi request: ${writeError.message}. ` : ''}` +
          'Không tự retry để tránh duplicate nếu server còn xử lý chậm.'
        );
      }
      throw new Error(
        `Native bulk ở trạng thái KHÔNG AN TOÀN: ${detail}. ` +
        'Đã dừng trước bước áp giá; tuyệt đối không tự chạy lại create cho đến khi kiểm tra danh sách.'
      );
    }

    if (writeError) {
      addLog('Request bulk từng báo lỗi/bất định nhưng server đã có đủ batch đúng mapping; tiếp tục hậu kiểm giá.', 'warn');
    }

    addLog(
      `Reconcile native bulk PASS: +${recon.countDelta} chương, ${recon.newRows.length} ID mới, mapping đúng ${sorted.length}/${sorted.length}.`,
      'ok'
    );

    if (state.cancelled) {
      throw new Error('Batch đã được tạo đầy đủ nhưng người dùng đã yêu cầu hủy; chưa chạy bước áp giá.');
    }

    return applyCreatePricingWithExistingEngine(sorted, verify, stopError, delayMs, labels);
  }


  function isParallelChapterUpdateOperation(op) {
    return ['both', 'title', 'content'].includes(op);
  }

  function isTransientUpdateError(err) {
    const msg = String(err?.message || err || '');
    return (
      /failed to fetch|networkerror|load failed|aborterror|timeout|navigation fallback/i.test(msg) ||
      /HTTP\s+(408|425|429|500|502|503|504)\b/i.test(msg)
    );
  }

  function buildExistingChapterUpdate(item, op) {
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

    if (!Object.keys(overrides).length) {
      throw new Error(`Operation "${op}" không có field update hợp lệ.`);
    }
    return { overrides, expected };
  }

  async function verifyChapterWithRetry(row, expected, label, attempts = CFG.bulkUpdateVerifyAttempts) {
    let last = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // Đợi ngắn trước mỗi GET verify để server hoàn tất commit/flush.
        await sleep((attempt === 1 ? 500 : 850) + jitter(220));
        await verifyChapter(row, expected);
        return { attempts: attempt };
      } catch (err) {
        last = err;
        if (attempt >= attempts) break;

        const wait = CFG.bulkUpdateRetryBaseMs * attempt + jitter(450);
        addLog(
          `${label}: verify chưa PASS (${err.message}); thử lại ${attempt + 1}/${attempts} sau ${Math.ceil(wait / 1000)}s.`,
          'warn'
        );
        await sleep(wait);
      }
    }

    throw last || new Error(`${label}: verify thất bại.`);
  }

  async function updateExistingChapterOne(item, op, verify, workerLabel = '') {
    const row = state.chapterMap.get(item.chapterNo);
    if (!row) throw new Error(`Không map được CHƯƠNG ${item.chapterNo} trên web.`);

    const { overrides, expected } = buildExistingChapterUpdate(item, op);
    const maxAttempts = Math.max(1, Number(CFG.bulkUpdateJobAttempts || 3));
    const netSeqAtStart = Number(state.netRetrySeq || 0);
    const healthReasons = new Set();
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prefix = `${workerLabel ? `${workerLabel} · ` : ''}CHƯƠNG ${item.chapterNo}`;

      if (attempt > 1) healthReasons.add(`job-retry-${attempt}`);

      try {
        // Lấy form edit mới ở mỗi attempt. Không tái sử dụng hidden fields/token
        // của attempt lỗi trước.
        const snap = await fetchChapterSnapshot(row, true);

        try {
          await submitChapterOverrides(
            snap,
            overrides,
            `UPDATE CHƯƠNG ${item.chapterNo} · attempt ${attempt}/${maxAttempts}`
          );
        } catch (writeErr) {
          lastError = writeErr;
          healthReasons.add('put-response-error');

          // Failed to fetch trên PUT là trạng thái mơ hồ: server có thể đã commit nhưng
          // response bị rớt. Không retry ngay. Đọc lại chapter trước.
          addLog(
            `${prefix}: PUT báo "${writeErr.message}". Đang hậu kiểm server trước khi retry.`,
            'warn'
          );

          try {
            const verifyRecovery = await verifyChapterWithRetry(
              row,
              expected,
              `${prefix} hậu kiểm PUT bất định`,
              Math.min(2, CFG.bulkUpdateVerifyAttempts)
            );
            if (verifyRecovery.attempts > 1) healthReasons.add('recovery-verify-retry');
            healthReasons.add('recovered-put-response');

            if (Number(state.netRetrySeq || 0) > netSeqAtStart) {
              healthReasons.add('network-get-retry');
            }

            addLog(`${prefix}: PUT response bị rớt nhưng server đã commit đúng.`, 'ok');
            return {
              row,
              expected,
              recoveredAfterWriteError: true,
              attempts: attempt,
              degraded: true,
              healthReasons: [...healthReasons],
            };
          } catch (verifyAfterWriteErr) {
            lastError = new Error(
              `${writeErr.message}; hậu kiểm chưa xác nhận commit: ${verifyAfterWriteErr.message}`
            );
          }

          if (attempt < maxAttempts) {
            const wait = CFG.bulkUpdateRetryBaseMs * (2 ** (attempt - 1)) + jitter(550);
            addLog(
              `${prefix}: retry idempotent ${attempt + 1}/${maxAttempts} sau ${Math.ceil(wait / 1000)}s.`,
              'warn'
            );
            await sleep(wait);
            continue;
          }

          throw lastError;
        }

        if (verify) {
          try {
            const verifyResult = await verifyChapterWithRetry(row, expected, `${prefix} verify`);
            if (verifyResult.attempts > 1) healthReasons.add('verify-retry');
          } catch (verifyErr) {
            lastError = verifyErr;
            healthReasons.add('verify-failed-before-job-retry');

            // PUT đã trả HTTP OK nhưng verify chưa đúng. Có thể là commit chậm hoặc
            // response/form stale. Chỉ retry cùng payload vì update theo chapter ID
            // là idempotent.
            if (attempt < maxAttempts) {
              const wait = CFG.bulkUpdateRetryBaseMs * (2 ** (attempt - 1)) + jitter(550);
              addLog(
                `${prefix}: PUT HTTP OK nhưng verify chưa PASS (${verifyErr.message}); ` +
                `retry cùng payload ${attempt + 1}/${maxAttempts} sau ${Math.ceil(wait / 1000)}s.`,
                'warn'
              );
              await sleep(wait);
              continue;
            }
            throw verifyErr;
          }
        }

        if (Number(state.netRetrySeq || 0) > netSeqAtStart) {
          healthReasons.add('network-get-retry');
        }

        return {
          row,
          expected,
          attempts: attempt,
          degraded: healthReasons.size > 0,
          healthReasons: [...healthReasons],
        };
      } catch (err) {
        lastError = err;

        // Lỗi GET form/snapshot ở đầu attempt: retry có backoff nếu còn lượt.
        if (attempt < maxAttempts && isTransientUpdateError(err)) {
          healthReasons.add('transient-job-error');
          const wait = CFG.bulkUpdateRetryBaseMs * (2 ** (attempt - 1)) + jitter(550);
          addLog(
            `${prefix}: lỗi network "${err.message}", retry ${attempt + 1}/${maxAttempts} sau ${Math.ceil(wait / 1000)}s.`,
            'warn'
          );
          await sleep(wait);
          continue;
        }

        throw err;
      }
    }

    throw lastError || new Error(`CHƯƠNG ${item.chapterNo}: update thất bại.`);
  }

  async function runSmoothUpdatePhase({
    name,
    entries,
    concurrency,
    startGapMs,
    task,
    respectCancel = true,
    stopOnTaskError = false,
  }) {
    const list = [...entries];
    const limit = Math.max(1, Math.min(Number(concurrency || 1), list.length || 1));
    const gap = Math.max(120, Number(startGapMs || 300));
    let cursor = 0;
    let nextStartAt = 0;
    let stopped = false;
    let firstError = null;

    async function reserveStart() {
      const now = Date.now();
      const planned = Math.max(now, nextStartAt);
      nextStartAt = planned + gap;
      if (planned > now) await sleep(planned - now);
    }

    async function worker(workerId) {
      while (true) {
        if (stopped) return;
        if (respectCancel && state.cancelled) return;

        const idx = cursor++;
        if (idx >= list.length) return;

        await reserveStart();

        if (stopped) return;
        if (respectCancel && state.cancelled) return;

        const entry = list[idx];

        try {
          await task(entry, workerId, idx);
        } catch (err) {
          entry.phaseError = err;
          firstError ||= err;
          if (stopOnTaskError) stopped = true;
        }
      }
    }

    addLog(
      `${name}: ${list.length} mục · ${limit} luồng · start-gap=${gap}ms.`,
      'info'
    );

    await Promise.all(
      Array.from({ length: Math.min(limit, list.length) }, (_, i) => worker(i + 1))
    );

    return {
      firstError,
      stopped,
      processed: list.filter(x => x.phaseTouched).length,
    };
  }

  async function runParallelChapterUpdates(items, op, verify, stopError, delayMs, labels) {
    /*
     * v1.3.4: tách read/write/read thành ba pha riêng.
     *
     * Lý do:
     * v1.3.3 cho thấy host không thích GET form/PUT/GET verify của nhiều chapter
     * chồng chéo nhau. Hai full-pipeline worker vẫn tạo burst hỗn hợp và rớt response.
     *
     * Pipeline mới:
     * 1) PREPARE: GET form edit cho toàn batch.
     * 2) WRITE: chỉ PUT, không GET hậu kiểm chen vào.
     * 3) VERIFY: sau khi write lắng xuống mới GET kiểm chứng.
     * 4) RECOVERY: chỉ những chapter thật sự chưa PASS mới retry tuần tự.
     *
     * PUT "Failed to fetch" KHÔNG được retry ngay vì server có thể đã commit.
     * Nó được đánh dấu AMBIGUOUS và giải quyết ở VERIFY.
     */
    const requestGap = Math.max(180, Number(CFG.bulkUpdateRequestGapMs || 300));
    const phaseCooldown = Math.max(400, Number(CFG.bulkUpdatePhaseCooldownMs || 650));
    const prepareConcurrency = clamp(Number(CFG.bulkUpdatePrepareConcurrency || 2), 1, 2);
    const writeConcurrency = clamp(Number(CFG.bulkUpdateWriteConcurrency || 2), 1, 2);
    const verifyConcurrency = clamp(Number(CFG.bulkUpdateVerifyConcurrency || 2), 1, 2);

    // Delay UI vẫn có tác dụng, nhưng không để default 1000ms làm pipeline giật cục.
    // Nó chỉ có thể nâng pacing request lên tối đa 600ms.
    const effectiveGap = Math.max(
      requestGap,
      Math.min(Math.max(0, Number(delayMs || 0)), 450)
    );

    const entries = items.map(item => {
      const row = state.chapterMap.get(item.chapterNo);
      if (!row) throw new Error(`Không map được CHƯƠNG ${item.chapterNo} trên web.`);
      const { overrides, expected } = buildExistingChapterUpdate(item, op);
      return {
        item,
        row,
        overrides,
        expected,
        snapshot: null,
        prepared: false,
        writeAttempted: false,
        writeResponseOk: false,
        writeError: null,
        verified: false,
        recovered: false,
        finalError: null,
        degraded: false,
        healthReasons: new Set(),
      };
    });

    addLog(
      `${labels[op]}: pipeline mượt PREPARE→WRITE→VERIFY · ` +
      `GET=${prepareConcurrency}, PUT=${writeConcurrency}, VERIFY=${verifyConcurrency} luồng · ` +
      `no-follow-redirect=ON · gap=${effectiveGap}ms · ${items.length} chương · ` +
      `verify=${verify ? 'ON' : 'OFF'}.`,
      'info'
    );

    // -------------------- PHASE 1: PREPARE --------------------
    setStatus(`${labels[op]} · PREPARE form 0/${entries.length}`);

    let preparedCount = 0;
    let prepareFailed = 0;

    await runSmoothUpdatePhase({
      name: `${labels[op]} PREPARE`,
      entries,
      concurrency: prepareConcurrency,
      startGapMs: effectiveGap,
      stopOnTaskError: false,
      respectCancel: true,
      task: async (entry, workerId) => {
        entry.phaseTouched = true;
        const seqBefore = Number(state.netRetrySeq || 0);

        try {
          entry.snapshot = await fetchChapterSnapshot(entry.row, true);
          entry.prepared = true;
          preparedCount++;

          if (Number(state.netRetrySeq || 0) > seqBefore) {
            entry.degraded = true;
            entry.healthReasons.add('prepare-get-retry');
          }

          addLog(
            `${labels[op]} PREPARE OK: CHƯƠNG ${entry.item.chapterNo}` +
            `${entry.degraded ? ' · DEGRADED' : ''}`,
            entry.degraded ? 'warn' : 'ok'
          );
        } catch (err) {
          entry.finalError = err;
          prepareFailed++;
          addLog(
            `${labels[op]} PREPARE LỖI CHƯƠNG ${entry.item.chapterNo}: ${err.message}`,
            'error'
          );
        }
      },
    });

    // Clear marker so later phases can count independently.
    entries.forEach(e => { delete e.phaseTouched; });

    if (state.cancelled) {
      throw new Error(
        `${labels[op]} đã hủy trong PREPARE. Chưa có PUT nào được gửi.`
      );
    }

    if (prepareFailed && stopError) {
      throw new Error(
        `${labels[op]} dừng ở PREPARE: ${prepareFailed}/${entries.length} chương không lấy được form. ` +
        `Chưa có nội dung nào bị ghi.`
      );
    }

    const writable = entries.filter(e => e.prepared && !e.finalError);

    if (!writable.length) {
      throw new Error(`${labels[op]}: không có chapter nào đủ điều kiện WRITE.`);
    }

    addLog(
      `${labels[op]} PREPARE hoàn tất: ${writable.length}/${entries.length} form sẵn sàng.`,
      prepareFailed ? 'warn' : 'ok'
    );

    await sleep(phaseCooldown + jitter(180));

    // -------------------- PHASE 2: WRITE --------------------
    setStatus(`${labels[op]} · WRITE 0/${writable.length}`);

    let writeDone = 0;
    let ambiguousWrites = 0;

    await runSmoothUpdatePhase({
      name: `${labels[op]} WRITE`,
      entries: writable,
      concurrency: writeConcurrency,
      startGapMs: effectiveGap,
      stopOnTaskError: false,
      respectCancel: true,
      task: async (entry) => {
        entry.phaseTouched = true;
        entry.writeAttempted = true;
        const seqBefore = Number(state.netRetrySeq || 0);

        try {
          await submitChapterOverrides(
            entry.snapshot,
            entry.overrides,
            `UPDATE CHƯƠNG ${entry.item.chapterNo} · phased-write`
          );
          entry.writeResponseOk = true;
          writeDone++;

          if (Number(state.netRetrySeq || 0) > seqBefore) {
            entry.degraded = true;
            entry.healthReasons.add('write-network-retry');
          }

          addLog(
            `${labels[op]} WRITE OK: CHƯƠNG ${entry.item.chapterNo}`,
            'ok'
          );
        } catch (err) {
          // Không retry ở đây. Response rớt không đồng nghĩa server chưa commit.
          entry.writeError = err;
          entry.degraded = true;
          entry.healthReasons.add('put-response-error');
          ambiguousWrites++;
          writeDone++;

          addLog(
            `${labels[op]} WRITE AMBIGUOUS CHƯƠNG ${entry.item.chapterNo}: ${err.message}. ` +
            `Không retry ngay; chờ VERIFY xác định trạng thái server.`,
            'warn'
          );
        }

        setStatus(
          `${labels[op]} · WRITE ${writeDone}/${writable.length} · ambiguous ${ambiguousWrites}`
        );
      },
    });

    entries.forEach(e => { delete e.phaseTouched; });

    // Nếu user hủy giữa WRITE, tuyệt đối không ghi thêm, nhưng vẫn VERIFY
    // những request đã thực sự được gửi để biết server đang ở trạng thái nào.
    const written = writable.filter(e => e.writeAttempted);

    addLog(
      `${labels[op]} WRITE hoàn tất: ${written.length} đã gửi · ` +
      `${ambiguousWrites} response bất định.`,
      ambiguousWrites ? 'warn' : 'ok'
    );

    await sleep(phaseCooldown + jitter(220));

    // -------------------- PHASE 3: VERIFY --------------------
    // Verify=OFF vẫn bắt buộc hậu kiểm những PUT response bị rớt.
    const verifyTargets = written.filter(e => verify || e.writeError);

    let verifiedCount = 0;
    let verifyFailed = 0;

    if (verifyTargets.length) {
      setStatus(`${labels[op]} · VERIFY 0/${verifyTargets.length}`);

      await runSmoothUpdatePhase({
        name: `${labels[op]} VERIFY`,
        entries: verifyTargets,
        concurrency: verifyConcurrency,
        startGapMs: effectiveGap,
        stopOnTaskError: false,
        respectCancel: false, // Đã WRITE thì cancel cũng phải hậu kiểm.
        task: async (entry) => {
          entry.phaseTouched = true;
          const seqBefore = Number(state.netRetrySeq || 0);

          try {
            const vr = await verifyChapterWithRetry(
              entry.row,
              entry.expected,
              `CHƯƠNG ${entry.item.chapterNo} phased-verify`
            );

            entry.verified = true;
            verifiedCount++;

            if (vr.attempts > 1) {
              entry.degraded = true;
              entry.healthReasons.add('verify-retry');
            }
            if (Number(state.netRetrySeq || 0) > seqBefore) {
              entry.degraded = true;
              entry.healthReasons.add('verify-get-retry');
            }

            if (entry.writeError) {
              entry.recovered = true;
              entry.healthReasons.add('put-response-lost-but-committed');
              addLog(
                `${labels[op]} VERIFY PASS: CHƯƠNG ${entry.item.chapterNo} · ` +
                `PUT response bị rớt nhưng server đã commit đúng.`,
                'warn'
              );
            } else {
              addLog(
                `${labels[op]} VERIFY PASS: CHƯƠNG ${entry.item.chapterNo}` +
                `${entry.degraded ? ' · DEGRADED' : ''}`,
                entry.degraded ? 'warn' : 'ok'
              );
            }
          } catch (err) {
            entry.finalError = err;
            verifyFailed++;
            addLog(
              `${labels[op]} VERIFY CHƯA PASS CHƯƠNG ${entry.item.chapterNo}: ${err.message}`,
              'error'
            );
          }

          setStatus(
            `${labels[op]} · VERIFY ${verifiedCount + verifyFailed}/${verifyTargets.length} · ` +
            `PASS ${verifiedCount} · cần recovery ${verifyFailed}`
          );
        },
      });

      verifyTargets.forEach(e => { delete e.phaseTouched; });
    }

    // verify OFF: PUT HTTP OK được coi là hoàn tất; ambiguous vẫn đã verify ở trên.
    if (!verify) {
      for (const entry of written) {
        if (!entry.writeError && !entry.finalError) entry.verified = true;
      }
    }

    // -------------------- PHASE 4: RECOVERY --------------------
    const recoveryTargets = written.filter(e => !e.verified);

    if (recoveryTargets.length) {
      addLog(
        `${labels[op]} RECOVERY: ${recoveryTargets.length} chương chưa PASS. ` +
        `Chuyển sang 1 luồng, retry idempotent từng chapter.`,
        'warn'
      );

      await sleep(Math.max(900, phaseCooldown) + jitter(250));

      for (let i = 0; i < recoveryTargets.length; i++) {
        const entry = recoveryTargets[i];

        if (state.cancelled) {
          entry.finalError ||= new Error('Đã hủy trước recovery.');
          continue;
        }

        try {
          const result = await updateExistingChapterOne(
            entry.item,
            op,
            true,
            `RECOVERY ${i + 1}/${recoveryTargets.length}`
          );

          entry.verified = true;
          entry.recovered = true;
          entry.finalError = null;
          entry.degraded = true;
          entry.healthReasons.add('sequential-recovery');

          addLog(
            `${labels[op]} RECOVERY PASS: CHƯƠNG ${entry.item.chapterNo}`,
            'ok'
          );

          // Recovery là tín hiệu server vừa chập chờn, cho host nghỉ ngắn.
          if (i + 1 < recoveryTargets.length) {
            await sleep(700 + jitter(250));
          }
        } catch (err) {
          entry.finalError = err;
          addLog(
            `${labels[op]} RECOVERY LỖI CHƯƠNG ${entry.item.chapterNo}: ${err.message}`,
            'error'
          );

          if (stopError) break;
        }
      }
    }

    const successful = written.filter(e => e.verified && !e.finalError);
    const failed = entries.filter(e => e.finalError || (e.writeAttempted && !e.verified));
    const notWritten = entries.filter(e => !e.writeAttempted);

    const clean = successful.filter(e => !e.degraded).length;
    const degraded = successful.length - clean;

    addLog(
      `${labels[op]} pipeline hoàn tất: ${successful.length} PASS ` +
      `(${clean} CLEAN, ${degraded} DEGRADED/recovered) · ${failed.length} lỗi · ` +
      `${notWritten.length} chưa ghi.`,
      failed.length ? 'warn' : 'ok'
    );

    if (failed.length && stopError) {
      const first = failed[0];
      throw new Error(
        `${labels[op]} còn ${failed.length} chương chưa PASS. ` +
        `Đầu tiên: CHƯƠNG ${first.item.chapterNo} · ${first.finalError?.message || 'verify failed'}`
      );
    }

    return {
      ok: successful.length,
      errors: failed.length,
      completed: successful.length + failed.length,
      unstarted: notWritten.length,
      clean,
      degraded,
      ambiguousWrites,
    };
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
      // Snapshot trước native bulk. Chỉ một POST create cho toàn batch.
      await loadChapters();
    } else if (isParallelChapterUpdateOperation(op)) {
      // Refresh mapping chapterNo -> chapterId ngay trước update pipeline.
      // Parsed TXT vẫn giữ nguyên; chỉ trạng thái server/mapping được làm mới.
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
      items = sorted;
    }

    const labels = {
      price_update: 'FIX GIÁ CHƯƠNG CŨ',
      both: 'CẬP NHẬT TÊN + NỘI DUNG',
      title: 'CHỈ ĐỔI TÊN',
      content: 'CHỈ CẬP NHẬT NỘI DUNG',
      create: 'ĐĂNG CHƯƠNG MỚI',
    };

    const confirmExtra = op === 'create'
      ? '\n\nChương sẽ được tạo hàng loạt, kiểm tra lại, rồi áp giá đã chọn.'
      : isParallelChapterUpdateOperation(op)
        ? '\n\nNội dung sẽ được cập nhật và kiểm tra lại sau khi lưu.'
        : '';
    if (!confirm(`${labels[op]}\n\nTruyện #${state.selectedStoryId} · ${items.length} chương${confirmExtra}\n\nTiếp tục?`)) return;

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
      if (op === 'create') {
        const result = await runNativeBulkCreate(items, verify, stopError, delayMs, labels);
        ok += result.ok;
        errors += result.errors;
      } else if (isParallelChapterUpdateOperation(op)) {
        const result = await runParallelChapterUpdates(items, op, verify, stopError, delayMs, labels);
        ok += result.ok;
        errors += result.errors;
      } else {
        // price_update giữ nguyên engine tuần tự cũ để không thay semantics pricing trong patch này.
        for (let i = 0; i < items.length; i++) {
          if (state.cancelled) {
            addLog('Bulk: đã hủy trước request kế tiếp.', 'warn');
            break;
          }

          const item = items[i];
          setStatus(`${labels[op]} ${i + 1}/${items.length}: CHƯƠNG ${item.chapterNo}`);

          try {
            const row = state.chapterMap.get(item.chapterNo);
            const snap = await fetchChapterSnapshot(row, true);
            const overrides = {};
            const expected = {};

            if (op === 'price_update') {
              const pf = pricingFields(getPricing(item.chapterNo), item.chapterNo);
              overrides.stars_active = pf.stars_active;
              overrides.diamonds_active = pf.diamonds_active;
              expected.stars = Number(pf.stars_active || 0);
              expected.diamonds = Number(pf.diamonds_active || 0);
            } else {
              throw new Error(`Operation "${op}" chưa có engine xử lý.`);
            }

            await submitChapterOverrides(snap, overrides, `UPDATE CHƯƠNG ${item.chapterNo}`);
            if (verify) {
              await sleep(350 + jitter(180));
              await verifyChapter(row, expected);
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
      }

      // Cho server lắng ngắn trước khi quét lại danh sách sau update.
      if (isParallelChapterUpdateOperation(op)) {
        await sleep(900 + jitter(300));
      }
      await loadChapters();
      setStatus(`Bulk hoàn tất: thành công ${ok}, lỗi ${errors}.`, errors ? 'warn' : 'ok');
      toast(`Bulk hoàn tất: ${ok} OK / ${errors} lỗi.`, errors ? 'warn' : 'ok', 5000);
    } catch (err) {
      setStatus(`Bulk dừng: ${err.message}`, 'error');
      toast(`Bulk dừng: ${err.message}`, 'error', 7500);
      // Sau lỗi vẫn refresh trạng thái thật, nhưng cho host nghỉ ngắn trước GET.
      try {
        if (isParallelChapterUpdateOperation(op)) await sleep(1800 + jitter(500));
        await loadChapters();
      } catch {}
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
    const warnText = $('#ttlcc-dashboard-warning-text');
    if (warn) warn.style.display = shortPaid ? '' : 'none';
    if (warnText) {
      warnText.textContent = shortPaid
        ? `${shortPaid} chương dưới 1000 từ đang có giá mở khóa.`
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
    :root{
      --ttlcc-bg:#0b1016;
      --ttlcc-surface:#111821;
      --ttlcc-surface2:#151e28;
      --ttlcc-surface3:#1a2531;
      --ttlcc-input:#0e151d;
      --ttlcc-border:#263341;
      --ttlcc-border-soft:#1d2833;
      --ttlcc-text:#e2e8ef;
      --ttlcc-soft:#aeb9c5;
      --ttlcc-muted:#748292;
      --ttlcc-primary:#6f9fac;
      --ttlcc-primary-hover:#82b0bb;
      --ttlcc-primary-soft:rgba(111,159,172,.13);
      --ttlcc-ok:#7fa58a;
      --ttlcc-warn:#c49b60;
      --ttlcc-danger:#b96a70;
      --ttlcc-shadow:0 24px 70px rgba(0,0,0,.48);
      --ttlcc-radius:12px;
    }

    #ttlcc-panel,#ttlcc-panel *{box-sizing:border-box}
    #ttlcc-panel{
      position:fixed;z-index:2147483000;top:16px;right:16px;
      width:min(1040px,calc(100vw - 32px));height:min(760px,calc(100vh - 32px));
      max-height:calc(100vh - 32px);display:flex;flex-direction:column;overflow:hidden;
      background:var(--ttlcc-bg);color:var(--ttlcc-text);
      border:1px solid var(--ttlcc-border);border-radius:16px;box-shadow:var(--ttlcc-shadow);
      font:12px/1.45 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;
    }
    #ttlcc-panel button,#ttlcc-panel input,#ttlcc-panel select,#ttlcc-panel textarea{font:inherit}
    #ttlcc-panel ::-webkit-scrollbar{width:8px;height:8px}
    #ttlcc-panel ::-webkit-scrollbar-thumb{background:#2c3947;border-radius:8px}
    #ttlcc-panel ::-webkit-scrollbar-track{background:transparent}

    #ttlcc-panel.ttlcc-minimized{
      top:auto;right:18px;bottom:18px;width:62px;height:38px;max-height:38px;border-radius:12px;cursor:pointer
    }
    #ttlcc-panel.ttlcc-minimized .ttlcc-main,
    #ttlcc-panel.ttlcc-minimized .ttlcc-tabs,
    #ttlcc-panel.ttlcc-minimized .ttlcc-context{display:none!important}
    #ttlcc-panel.ttlcc-minimized .ttlcc-head{height:36px;min-height:36px;padding:0;justify-content:center;border:0}
    #ttlcc-panel.ttlcc-minimized .ttlcc-brand{display:flex;align-items:center;justify-content:center}
    #ttlcc-panel.ttlcc-minimized .ttlcc-brand-name{font-size:0}
    #ttlcc-panel.ttlcc-minimized .ttlcc-brand-name::after{content:"TTL";font-size:12px;font-weight:900;letter-spacing:.7px}
    #ttlcc-panel.ttlcc-minimized .ttlcc-brand-ver,
    #ttlcc-panel.ttlcc-minimized .ttlcc-head-actions{display:none!important}

    .ttlcc-head{
      min-height:52px;display:flex;align-items:center;justify-content:space-between;gap:12px;
      padding:10px 13px;border-bottom:1px solid var(--ttlcc-border-soft);background:#0e141c
    }
    .ttlcc-brand{min-width:0;display:flex;align-items:baseline;gap:8px}
    .ttlcc-brand-name{font-size:15px;font-weight:850;letter-spacing:.1px;color:#f1f5f8}
    .ttlcc-brand-ver{font-size:10px;color:var(--ttlcc-muted);font-weight:700}
    .ttlcc-head-actions{display:flex;align-items:center;gap:5px}
    .ttlcc-story-badge{
      display:inline-flex;align-items:center;height:28px;padding:0 9px;border-radius:8px;
      background:var(--ttlcc-surface2);border:1px solid var(--ttlcc-border);color:var(--ttlcc-soft);
      font-size:10.5px;font-weight:800
    }
    .ttlcc-icon{
      width:30px;height:30px;display:inline-grid;place-items:center;border-radius:8px;
      border:1px solid var(--ttlcc-border);background:var(--ttlcc-surface2);color:var(--ttlcc-soft);
      cursor:pointer;transition:.15s ease
    }
    .ttlcc-icon:hover{background:var(--ttlcc-surface3);color:#fff;border-color:#3a4b5c}

    .ttlcc-context{
      min-height:44px;display:flex;align-items:center;justify-content:space-between;gap:12px;
      padding:7px 12px;background:var(--ttlcc-surface);border-bottom:1px solid var(--ttlcc-border-soft)
    }
    .ttlcc-selection-main{min-width:0;display:flex;align-items:baseline;gap:8px;flex:1}
    .ttlcc-selected-title{font-size:12.5px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ttlcc-selected-sub{font-size:10.5px;color:var(--ttlcc-muted);white-space:nowrap}
    .ttlcc-status{
      max-width:52%;padding:5px 9px;border-radius:8px;background:#16212a;color:#aebfc9;
      border:1px solid transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:10.5px
    }
    .ttlcc-status.ok{color:#a8c8b0;background:rgba(127,165,138,.09)}
    .ttlcc-status.warn{color:#d8b47d;background:rgba(196,155,96,.09)}
    .ttlcc-status.error{color:#dd969b;background:rgba(185,106,112,.10)}

    .ttlcc-tabs{
      display:flex;gap:4px;padding:6px 12px;background:#0d131a;border-bottom:1px solid var(--ttlcc-border-soft);overflow-x:auto;overflow-y:hidden;scrollbar-width:none
    }
    .ttlcc-tabs::-webkit-scrollbar{display:none}
    .ttlcc-tab-btn{
      min-height:30px;border:0;background:transparent;color:var(--ttlcc-muted);padding:5px 10px;border-radius:8px;
      cursor:pointer;white-space:nowrap;font-weight:750;font-size:11.5px;transition:.15s ease
    }
    .ttlcc-tab-btn:hover{color:var(--ttlcc-text);background:rgba(255,255,255,.035)}
    .ttlcc-tab-btn.active{background:var(--ttlcc-primary-soft);color:#c8dfe4}

    .ttlcc-main{min-height:0;flex:1;overflow-y:auto;overflow-x:hidden;padding:14px 16px 24px;scrollbar-gutter:stable}
    .ttlcc-pane{display:none}.ttlcc-pane.active{display:block}

    .ttlcc-card{
      background:transparent;border:0;border-radius:0;
      padding:0 0 14px;margin:0 0 14px;border-bottom:1px solid var(--ttlcc-border-soft)
    }
    .ttlcc-card:last-child{border-bottom:0;margin-bottom:0;padding-bottom:0}
    .ttlcc-card-title{
      min-height:24px;margin-bottom:9px;display:flex;align-items:center;justify-content:space-between;gap:8px;
      font-size:12px;font-weight:850;color:#e9eef3
    }
    .ttlcc-section-sub{font-size:10.5px;color:var(--ttlcc-muted);font-weight:600}
    .ttlcc-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .ttlcc-toolbar + .ttlcc-toolbar{margin-top:7px}
    .ttlcc-grid2{display:grid;grid-template-columns:minmax(250px,310px) minmax(0,1fr);gap:10px}
    .ttlcc-grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}

    .ttlcc-input,.ttlcc-card input[type="text"],.ttlcc-card input[type="number"],
    .ttlcc-card input[type="date"],.ttlcc-card input[type="datetime-local"],.ttlcc-card input[type="url"],
    .ttlcc-card input[type="file"],.ttlcc-card select,.ttlcc-live-form input,.ttlcc-live-form select,.ttlcc-live-form textarea{
      min-height:32px;border:1px solid var(--ttlcc-border);background:var(--ttlcc-input);color:var(--ttlcc-text);
      border-radius:8px;padding:6px 8px;outline:none;max-width:100%;font-size:11.5px
    }
    .ttlcc-input:focus,.ttlcc-card input:focus,.ttlcc-card select:focus,.ttlcc-card textarea:focus,
    .ttlcc-live-form input:focus,.ttlcc-live-form select:focus,.ttlcc-live-form textarea:focus{
      border-color:var(--ttlcc-primary);box-shadow:0 0 0 3px rgba(111,159,172,.10)
    }

    .ttlcc-btn{
      border:1px solid transparent;border-radius:8px;padding:5px 9px;min-height:30px;cursor:pointer;
      font-weight:760;background:var(--ttlcc-surface2);color:var(--ttlcc-text);font-size:11.5px;transition:.15s ease
    }
    .ttlcc-btn:hover:not(:disabled){background:var(--ttlcc-surface3)}
    .ttlcc-btn:disabled{opacity:.4;cursor:not-allowed}
    .ttlcc-btn-primary{background:var(--ttlcc-primary);color:#081015}
    .ttlcc-btn-primary:hover:not(:disabled){background:var(--ttlcc-primary-hover)}
    .ttlcc-btn-soft{border-color:var(--ttlcc-border)}
    .ttlcc-btn-danger{background:var(--ttlcc-danger);color:white}
    .ttlcc-btn-ghost-danger{border-color:rgba(185,106,112,.35);background:transparent;color:#c98a8f}
    .ttlcc-btn-ghost-danger:hover:not(:disabled){background:rgba(185,106,112,.10)}
    .ttlcc-btn-mini{min-height:27px;padding:4px 7px;font-size:10.5px}
    .ttlcc-btn-wide{width:100%}

    .ttlcc-overview-hero{
      display:flex;align-items:center;justify-content:space-between;gap:14px;
      padding:14px 15px;border-radius:14px;background:linear-gradient(135deg,#121c25,#14212a);
      border:1px solid var(--ttlcc-border-soft);margin-bottom:10px
    }
    .ttlcc-overview-story{min-width:0}
    .ttlcc-overview-kicker{font-size:10px;color:var(--ttlcc-muted);font-weight:750;text-transform:uppercase;letter-spacing:.6px}
    .ttlcc-overview-title{margin-top:3px;font-size:18px;font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ttlcc-quick-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
    .ttlcc-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:10px}
    .ttlcc-stat{border:1px solid var(--ttlcc-border-soft);background:var(--ttlcc-surface);border-radius:11px;padding:10px 11px}
    .ttlcc-stat-label{font-size:10px;color:var(--ttlcc-muted);font-weight:700}
    .ttlcc-stat-value{font-size:18px;font-weight:850;margin-top:2px;overflow:hidden;text-overflow:ellipsis}
    #ttlcc-stat-story{font-size:18px}
    .ttlcc-warning{
      display:flex;align-items:center;justify-content:space-between;gap:10px;
      border:1px solid rgba(196,155,96,.28);background:rgba(196,155,96,.07);color:#d8b47d;
      padding:9px 11px;border-radius:10px;margin-bottom:10px
    }

    .ttlcc-story-list{display:flex;flex-direction:column;gap:4px}
    .ttlcc-story-item{
      width:100%;border:1px solid transparent;background:transparent;color:var(--ttlcc-text);border-radius:9px;
      padding:8px 9px;text-align:left;cursor:pointer;display:flex;align-items:center;gap:7px
    }
    .ttlcc-story-item:hover{background:rgba(255,255,255,.025)}
    .ttlcc-story-item.active{border-color:rgba(111,159,172,.35);background:var(--ttlcc-primary-soft)}
    .ttlcc-story-title{flex:1;font-weight:720;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ttlcc-story-id{color:var(--ttlcc-muted);font-size:10px}

    .ttlcc-table-wrap{overflow-x:auto;overflow-y:visible;max-height:none;border:1px solid var(--ttlcc-border-soft);border-radius:10px}
    .ttlcc-table{width:100%;border-collapse:collapse;font-size:11.25px}
    .ttlcc-table th{position:sticky;top:0;z-index:2;background:#121a23;color:#8f9dab;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.35px;box-shadow:0 1px 0 var(--ttlcc-border-soft)}
    .ttlcc-table th,.ttlcc-table td{padding:7px 8px;border-bottom:1px solid var(--ttlcc-border-soft);vertical-align:middle}
    .ttlcc-table tr:last-child td{border-bottom:0}
    .ttlcc-table tr:hover td{background:rgba(255,255,255,.018)}
    .ttlcc-table td:not(.ttlcc-left){white-space:nowrap}
    .ttlcc-num{font-variant-numeric:tabular-nums;color:var(--ttlcc-soft);font-weight:760}
    .ttlcc-chapter-title{font-weight:720;color:var(--ttlcc-text)}
    .ttlcc-chapter-meta{margin-top:3px;display:flex;gap:4px;flex-wrap:wrap}
    .ttlcc-meta-chip{font-size:9px;color:var(--ttlcc-muted)}
    .ttlcc-row-actions{display:flex;gap:4px;justify-content:flex-end}
    .ttlcc-row-warn td{background:rgba(196,155,96,.025)}
    .ttlcc-price-chip{display:inline-flex;align-items:center;padding:2px 6px;border-radius:999px;font-size:9.5px;font-weight:800}
    .ttlcc-price-chip.free{background:rgba(127,165,138,.10);color:#9fc3a8}
    .ttlcc-price-chip.stars{background:rgba(196,155,96,.10);color:#d1ad76}
    .ttlcc-price-chip.diamond{background:rgba(111,159,172,.13);color:#9bc5cf}
    .ttlcc-alert-dot{
      display:inline-grid;place-items:center;margin-left:4px;width:15px;height:15px;border-radius:50%;
      background:rgba(196,155,96,.14);color:#d8b47d;font-size:9px;font-weight:900
    }

    .ttlcc-live-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .ttlcc-field{display:flex;flex-direction:column;gap:4px}
    .ttlcc-field-wide{grid-column:1/-1}
    .ttlcc-label{font-weight:750;color:var(--ttlcc-soft);font-size:10.5px}
    .ttlcc-live-form textarea{width:100%;resize:vertical}
    .ttlcc-code-area{font:11.5px/1.5 Consolas,"SFMono-Regular",monospace}
    .ttlcc-choice-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}
    .ttlcc-choice{display:flex;gap:5px;align-items:flex-start;padding:6px;border:1px solid var(--ttlcc-border-soft);border-radius:7px;background:var(--ttlcc-input);font-size:10px}
    .ttlcc-form-actions{display:flex;justify-content:flex-end;gap:6px}
    .ttlcc-form-title{font-size:13px;font-weight:850;margin-bottom:8px;color:#fff}

    .ttlcc-empty,.ttlcc-loading{padding:18px;color:var(--ttlcc-muted);text-align:center}
    .ttlcc-error-box{padding:10px;border:1px solid rgba(185,106,112,.35);background:rgba(185,106,112,.07);border-radius:10px;color:#d7989c}
    .ttlcc-error-box .ttlcc-btn{margin-top:8px}

    .ttlcc-bulk-layout{display:block}
    .ttlcc-bulk-stack{display:block}
    .ttlcc-bulk-stack .ttlcc-card{margin-bottom:0}
    .ttlcc-bulk-command{
      display:grid;grid-template-columns:minmax(190px,1.4fr) minmax(110px,.7fr) minmax(110px,.7fr) auto;
      gap:10px;align-items:end;padding:2px 0 14px;border-bottom:1px solid var(--ttlcc-border-soft)
    }
    .ttlcc-bulk-command .ttlcc-advanced{
      margin:0;padding:0;border:0;align-self:center;justify-self:end
    }
    .ttlcc-bulk-command .ttlcc-advanced[open]{
      grid-column:1/-1;justify-self:stretch;padding-top:10px;border-top:1px solid var(--ttlcc-border-soft)
    }
    .ttlcc-bulk-command .ttlcc-advanced[open] summary{margin-bottom:8px}
    .ttlcc-bulk-section{
      padding:14px 0;border-bottom:1px solid var(--ttlcc-border-soft)
    }
    .ttlcc-bulk-section:last-child{border-bottom:0}
    .ttlcc-bulk-section-head{
      display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px
    }
    .ttlcc-bulk-section-title{font-size:12px;font-weight:850;color:#e9eef3}
    .ttlcc-bulk-price-row{
      display:grid;grid-template-columns:110px 110px 120px 80px auto;
      gap:8px;align-items:end
    }
    .ttlcc-bulk-price-actions{display:flex;gap:6px;align-items:end;flex-wrap:wrap}
    .ttlcc-bulk-preview-head{
      display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px
    }
    .ttlcc-bulk-preview-actions{display:flex;align-items:center;gap:7px}
    .ttlcc-bulk-preview .ttlcc-table-wrap{border-radius:8px}
    .ttlcc-bulk-preview .ttlcc-table th{top:-1px}
    .ttlcc-bulk-preview .ttlcc-table td{padding-top:8px;padding-bottom:8px}
    .ttlcc-bulk-preview .ttlcc-table tbody tr{background:transparent}
    .ttlcc-bulk-preview .ttlcc-table tbody tr:nth-child(even){background:rgba(255,255,255,.012)}
    .ttlcc-bulk-preview .ttlcc-table tbody tr:hover td{background:rgba(255,255,255,.025)}
    .ttlcc-bulk-txt-inner{display:grid;grid-template-columns:minmax(260px,360px) minmax(0,1fr);gap:10px;align-items:start}
    .ttlcc-bulk-txt-inner .ttlcc-textarea{min-height:150px}
    .ttlcc-bulk-filebox{display:flex;flex-direction:column;gap:8px}
    .ttlcc-bulk-filebox .ttlcc-file-row{align-items:stretch}
    .ttlcc-bulk-note{font-size:10px;color:var(--ttlcc-muted)}

    .ttlcc-textarea{
      width:100%;min-height:200px;resize:vertical;border:1px solid var(--ttlcc-border);background:var(--ttlcc-input);
      color:var(--ttlcc-text);border-radius:8px;padding:8px;font:11.25px/1.5 Consolas,monospace
    }
    .ttlcc-inline-price{display:flex;gap:4px}
    .ttlcc-inline-price select{width:70px}.ttlcc-inline-price input{width:50px}
    .ttlcc-price-lock{color:#91b39a;font-weight:750}
    .ttlcc-state{font-weight:850;font-size:9px}
    .ttlcc-state.pending{color:#d1ad76}.ttlcc-state.ok{color:#88ad91}.ttlcc-state.bad{color:#d1858a}
    .ttlcc-advanced{
      margin-top:9px;border-top:1px solid var(--ttlcc-border-soft);padding-top:7px;color:var(--ttlcc-soft)
    }
    .ttlcc-advanced summary{cursor:pointer;font-size:10.5px;font-weight:750;color:var(--ttlcc-muted);user-select:none}
    .ttlcc-advanced[open] summary{margin-bottom:8px}
    .ttlcc-check-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:10.5px;color:var(--ttlcc-soft)}
    .ttlcc-file-row{display:flex;gap:6px;align-items:center}
    .ttlcc-file-row input[type=file]{flex:1;min-width:0}

    .ttlcc-log{
      min-height:360px;overflow:visible;background:#090e13;border:1px solid var(--ttlcc-border-soft);
      border-radius:9px;padding:8px;font:10.5px/1.5 Consolas,monospace
    }
    .ttlcc-log-line.ok{color:#8fb69a}.ttlcc-log-line.warn{color:#d0aa74}.ttlcc-log-line.error{color:#d4858a}.ttlcc-log-line.info{color:#99a7b5}

    #ttlcc-modal{position:fixed;z-index:2147483200;inset:0;background:rgba(0,0,0,.68);display:none;align-items:center;justify-content:center;padding:14px}
    #ttlcc-modal.open{display:flex}
    .ttlcc-modal-box{
      width:min(900px,95vw);max-height:90vh;display:flex;flex-direction:column;background:var(--ttlcc-bg);
      border:1px solid var(--ttlcc-border);border-radius:14px;box-shadow:var(--ttlcc-shadow);overflow:hidden
    }
    .ttlcc-modal-head{display:flex;justify-content:space-between;align-items:center;padding:9px 11px;background:var(--ttlcc-surface2);border-bottom:1px solid var(--ttlcc-border);font-weight:850}
    .ttlcc-modal-body{overflow:auto;padding:11px}

    #ttlcc-toast-host{position:fixed;z-index:2147483300;right:22px;bottom:22px;display:flex;flex-direction:column;gap:7px;pointer-events:none}
    .ttlcc-toast{max-width:420px;padding:9px 11px;border-radius:9px;background:#25313d;color:#fff;box-shadow:0 10px 28px rgba(0,0,0,.35);opacity:1;transform:translateY(0);transition:.2s}
    .ttlcc-toast.ok{background:#355344}.ttlcc-toast.warn{background:#665235}.ttlcc-toast.error{background:#6a393e}.ttlcc-toast.out{opacity:0;transform:translateY(8px)}

    .ttlcc-revenue-top{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:10px}
    .ttlcc-revenue-summary{border:1px solid var(--ttlcc-border-soft);background:var(--ttlcc-surface);border-radius:11px;padding:11px;min-width:0}
    .ttlcc-revenue-summary-label{font-size:10px;color:var(--ttlcc-muted);font-weight:720}
    .ttlcc-revenue-summary-value{margin-top:3px;font-size:19px;font-weight:850;color:#f2f5f8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ttlcc-revenue-summary-sub{margin-top:2px;font-size:10px;color:var(--ttlcc-soft);min-height:14px}
    .ttlcc-revenue-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}
    .ttlcc-revenue-meta{font-size:10.5px;color:var(--ttlcc-muted)}
    .ttlcc-revenue-story-list{display:flex;flex-direction:column;border:1px solid var(--ttlcc-border-soft);border-radius:10px;overflow:hidden;background:var(--ttlcc-surface)}
    .ttlcc-revenue-story{display:grid;grid-template-columns:minmax(0,1fr) 80px 90px;gap:7px;align-items:center;padding:8px 9px;border-bottom:1px solid var(--ttlcc-border-soft);cursor:default}
    .ttlcc-revenue-story:last-child{border-bottom:0}
    .ttlcc-revenue-story[data-story-revenue-id]{cursor:pointer}
    .ttlcc-revenue-story[data-story-revenue-id]:hover{background:#16212a}
    .ttlcc-revenue-story.selected{background:var(--ttlcc-primary-soft);box-shadow:inset 3px 0 0 var(--ttlcc-primary)}
    .ttlcc-revenue-story-title{font-weight:750;color:var(--ttlcc-text);min-width:0;overflow:hidden;text-overflow:ellipsis}
    .ttlcc-current-chip{display:inline-flex;margin-left:6px;padding:2px 6px;border-radius:999px;background:var(--ttlcc-primary-soft);color:#9bc5cf;font-size:9px;vertical-align:1px}
    .ttlcc-revenue-story-sales,.ttlcc-revenue-story-kc{text-align:right;font-weight:800}
    .ttlcc-revenue-story-sales span,.ttlcc-revenue-story-kc span{display:block;font-size:9px;color:var(--ttlcc-muted);font-weight:600}
    .ttlcc-revenue-story-kc{color:#9fc9d2}

    @media(max-width:900px){
      #ttlcc-panel{top:7px;right:7px;width:calc(100vw - 14px);height:calc(100vh - 14px);max-height:calc(100vh - 14px)}
      .ttlcc-grid2{grid-template-columns:1fr}
      .ttlcc-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
      .ttlcc-revenue-top{grid-template-columns:1fr}.ttlcc-choice-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .ttlcc-live-form{grid-template-columns:1fr}.ttlcc-field-wide{grid-column:1}.ttlcc-grid3{grid-template-columns:1fr}
      .ttlcc-overview-hero{align-items:flex-start;flex-direction:column}.ttlcc-quick-actions{justify-content:flex-start}
      .ttlcc-bulk-command{grid-template-columns:1fr 1fr}
      .ttlcc-bulk-command > .ttlcc-field:first-child{grid-column:1/-1}
      .ttlcc-bulk-command .ttlcc-advanced{grid-column:1/-1;justify-self:start}
      .ttlcc-bulk-price-row{grid-template-columns:1fr 1fr}
      .ttlcc-bulk-price-actions{grid-column:1/-1}
      .ttlcc-bulk-txt-inner{grid-template-columns:1fr}
    }
    @media(max-width:560px){
      .ttlcc-context{align-items:flex-start;flex-direction:column}.ttlcc-status{max-width:100%;width:100%}
      .ttlcc-revenue-story{grid-template-columns:minmax(0,1fr) 70px 78px;padding:9px}
      .ttlcc-revenue-summary-value{font-size:18px}.ttlcc-stats{grid-template-columns:1fr 1fr}
    }

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
        <div class="ttlcc-brand">
          <span class="ttlcc-brand-name">TTL Control</span>
          <span class="ttlcc-brand-ver">v${VERSION}</span>
        </div>
        <div class="ttlcc-head-actions">
          <span class="ttlcc-story-badge" id="ttlcc-story-badge">—</span>
          <button class="ttlcc-icon" id="ttlcc-open-log" type="button" title="Nhật ký" aria-label="Nhật ký">≡</button>
          <button class="ttlcc-icon" id="ttlcc-refresh-all" type="button" title="Làm mới" aria-label="Làm mới">↻</button>
          <button class="ttlcc-icon" id="ttlcc-minimize" type="button" title="Thu gọn" aria-label="Thu gọn">−</button>
        </div>
      </div>

      <div class="ttlcc-context">
        <div class="ttlcc-selection-main">
          <div class="ttlcc-selected-title" id="ttlcc-selected-title">Chưa chọn truyện</div>
          <div class="ttlcc-selected-sub" id="ttlcc-selected-sub"></div>
        </div>
        <div id="ttlcc-status" class="ttlcc-status" aria-live="polite">Đang khởi tạo…</div>
      </div>

      <div class="ttlcc-tabs">
        <button class="ttlcc-tab-btn active" data-tab="stories" type="button">Danh sách</button>
        <button class="ttlcc-tab-btn" data-tab="dashboard" type="button">Tổng quan</button>
        <button class="ttlcc-tab-btn" data-tab="chapters" type="button">Chương</button>
        <button class="ttlcc-tab-btn" data-tab="bulk" type="button">Hàng loạt</button>
        <button class="ttlcc-tab-btn" data-tab="revenue" type="button">Doanh thu</button>
      </div>

      <div class="ttlcc-main">
        <section class="ttlcc-pane" data-pane="dashboard">
          <div class="ttlcc-overview-hero">
            <div class="ttlcc-overview-story">
              <div class="ttlcc-overview-kicker">Truyện đang chọn</div>
              <div class="ttlcc-overview-title" id="ttlcc-stat-story">—</div>
            </div>
            <div class="ttlcc-quick-actions">
              <button class="ttlcc-btn ttlcc-btn-soft" type="button" data-jump-tab="chapters">Chương</button>
              <button class="ttlcc-btn ttlcc-btn-primary" type="button" data-jump-tab="bulk">Hàng loạt</button>
              <button class="ttlcc-btn ttlcc-btn-soft" type="button" data-jump-tab="revenue">Doanh thu</button>
            </div>
          </div>

          <div class="ttlcc-stats">
            <div class="ttlcc-stat"><div class="ttlcc-stat-label">Tổng chương</div><div class="ttlcc-stat-value" id="ttlcc-stat-chapters">0</div></div>
            <div class="ttlcc-stat"><div class="ttlcc-stat-label">Miễn phí</div><div class="ttlcc-stat-value" id="ttlcc-stat-free">0</div></div>
            <div class="ttlcc-stat"><div class="ttlcc-stat-label">Trả Sao</div><div class="ttlcc-stat-value" id="ttlcc-stat-stars">0</div></div>
            <div class="ttlcc-stat"><div class="ttlcc-stat-label">Trả KC</div><div class="ttlcc-stat-value" id="ttlcc-stat-diamonds">0</div></div>
          </div>

          <div id="ttlcc-dashboard-warning" class="ttlcc-warning" style="display:none">
            <span id="ttlcc-dashboard-warning-text"></span>
            <button class="ttlcc-btn ttlcc-btn-mini ttlcc-btn-soft" id="ttlcc-dashboard-fix-short" type="button">Sửa giá</button>
          </div>

          <span id="ttlcc-stat-shortpaid" hidden>0</span>
        </section>

        <section class="ttlcc-pane active" data-pane="stories">
          <div class="ttlcc-grid2">
            <div class="ttlcc-card">
              <div class="ttlcc-card-title">Danh sách truyện</div>
              <div class="ttlcc-toolbar">
                <input class="ttlcc-input" id="ttlcc-story-filter" type="text" placeholder="Tên hoặc ID" style="flex:1;min-width:120px">
                <button class="ttlcc-btn ttlcc-btn-soft" id="ttlcc-story-server-search" type="button">Tìm</button>
                <button class="ttlcc-btn ttlcc-btn-soft" id="ttlcc-story-reload" type="button" title="Làm mới">↻</button>
              </div>
              <div class="ttlcc-story-list" id="ttlcc-story-list" style="margin-top:9px"></div>
            </div>

            <div class="ttlcc-card">
              <div class="ttlcc-card-title">
                <span>Chi tiết</span>
                <div class="ttlcc-toolbar">
                  <button class="ttlcc-btn ttlcc-btn-mini ttlcc-btn-primary" id="ttlcc-edit-story" type="button">Sửa truyện</button>
                  <button class="ttlcc-btn ttlcc-btn-mini ttlcc-btn-soft" id="ttlcc-publish-story" type="button">Hiện / Ẩn</button>
                </div>
              </div>
              <div id="ttlcc-story-editor" class="ttlcc-empty">Chọn truyện để chỉnh sửa.</div>
            </div>
          </div>
        </section>

        <section class="ttlcc-pane" data-pane="chapters">
          <div class="ttlcc-card">
            <div class="ttlcc-card-title">
              <span>Chương</span>
              <div class="ttlcc-toolbar">
                <button class="ttlcc-btn ttlcc-btn-primary" id="ttlcc-create-chapter" type="button">+ Thêm chương</button>
                <button class="ttlcc-btn ttlcc-btn-soft" id="ttlcc-chapter-reload" type="button" title="Làm mới">↻</button>
              </div>
            </div>
            <div class="ttlcc-toolbar">
              <input class="ttlcc-input" id="ttlcc-chapter-filter" type="text" placeholder="Tìm chương…" style="min-width:230px;flex:1">
              <label class="ttlcc-check-row"><span><input id="ttlcc-chapter-paid" type="checkbox"> Trả phí</span></label>
              <label class="ttlcc-check-row"><span><input id="ttlcc-chapter-short" type="checkbox"> Dưới 1000 từ</span></label>
            </div>
            <div class="ttlcc-table-wrap" style="margin-top:10px">
              <table class="ttlcc-table">
                <thead><tr><th>#</th><th>Chương</th><th>Từ</th><th>Giá</th><th style="text-align:right">Thao tác</th></tr></thead>
                <tbody id="ttlcc-chapter-body"><tr><td colspan="5" class="ttlcc-empty">Chưa tải chương.</td></tr></tbody>
              </table>
            </div>
          </div>
        </section>

        <section class="ttlcc-pane" data-pane="bulk">
          <div class="ttlcc-bulk-layout">
            <div class="ttlcc-bulk-command">
              <div class="ttlcc-field">
                <div class="ttlcc-label">Tác vụ</div>
                <select id="ttlcc-bulk-operation" aria-label="Tác vụ hàng loạt">
                  <option value="price_update">Cập nhật giá</option>
                  <option value="content">Cập nhật nội dung</option>
                  <option value="both">Cập nhật tên + nội dung</option>
                  <option value="title">Đổi tên chương</option>
                  <option value="create">Đăng chương mới</option>
                </select>
              </div>

              <div class="ttlcc-field">
                <div class="ttlcc-label">Từ chương</div>
                <input id="ttlcc-bulk-from" type="number" min="1">
              </div>

              <div class="ttlcc-field">
                <div class="ttlcc-label">Đến chương</div>
                <input id="ttlcc-bulk-to" type="number" min="1">
              </div>

              <details class="ttlcc-advanced">
                <summary>Tùy chọn</summary>
                <div class="ttlcc-toolbar">
                  <div class="ttlcc-field" style="width:150px">
                    <div class="ttlcc-label">Khoảng nghỉ (ms)</div>
                    <input id="ttlcc-bulk-delay" type="number" min="0" step="100" value="1100">
                  </div>
                  <label class="ttlcc-check-row"><input id="ttlcc-bulk-verify" type="checkbox" checked> Xác minh sau lưu</label>
                  <label class="ttlcc-check-row"><input id="ttlcc-bulk-stop-error" type="checkbox" checked> Dừng khi lỗi</label>
                </div>
              </details>
            </div>

            <div class="ttlcc-bulk-section" id="ttlcc-bulk-txt-card" style="display:none">
              <div class="ttlcc-bulk-section-head">
                <div class="ttlcc-bulk-section-title">Dữ liệu TXT</div>
              </div>
              <div class="ttlcc-bulk-txt-inner">
                <div class="ttlcc-bulk-filebox">
                  <div class="ttlcc-file-row">
                    <input id="ttlcc-bulk-file" type="file" accept=".txt,text/plain" multiple>
                    <button class="ttlcc-btn ttlcc-btn-primary" id="ttlcc-bulk-parse" type="button">Đọc dữ liệu</button>
                  </div>
                  <div class="ttlcc-bulk-note">Có thể chọn nhiều TXT cùng lúc hoặc dán trực tiếp nội dung.</div>
                </div>
                <textarea id="ttlcc-bulk-text" class="ttlcc-textarea" placeholder="CHƯƠNG 96: Tên chương&#10;&#10;Nội dung…"></textarea>
              </div>
            </div>

            <div class="ttlcc-bulk-section" id="ttlcc-price-card">
              <div class="ttlcc-bulk-section-head">
                <div class="ttlcc-bulk-section-title">Giá mở khóa</div>
              </div>
              <div class="ttlcc-bulk-price-row">
                <div class="ttlcc-field">
                  <div class="ttlcc-label">Từ</div>
                  <input id="ttlcc-price-from" type="number" min="1">
                </div>
                <div class="ttlcc-field">
                  <div class="ttlcc-label">Đến</div>
                  <input id="ttlcc-price-to" type="number" min="1">
                </div>
                <div class="ttlcc-field">
                  <div class="ttlcc-label">Loại</div>
                  <select id="ttlcc-price-type">
                    <option value="free">FREE</option>
                    <option value="stars">Sao</option>
                    <option value="diamond">KC</option>
                  </select>
                </div>
                <div class="ttlcc-field">
                  <div class="ttlcc-label">Giá</div>
                  <input id="ttlcc-price-value" type="number" min="1" max="10" value="5">
                </div>
                <div class="ttlcc-bulk-price-actions">
                  <button class="ttlcc-btn ttlcc-btn-primary" id="ttlcc-price-apply" type="button">Áp dụng</button>
                  <button class="ttlcc-btn ttlcc-btn-soft" id="ttlcc-price-alt-star" type="button">Sao → KC</button>
                  <button class="ttlcc-btn ttlcc-btn-soft" id="ttlcc-price-alt-kc" type="button">KC → Sao</button>
                </div>
              </div>
            </div>

            <div class="ttlcc-bulk-section ttlcc-bulk-preview">
              <div class="ttlcc-bulk-preview-head">
                <div class="ttlcc-toolbar">
                  <div class="ttlcc-bulk-section-title">Kiểm tra</div>
                  <span id="ttlcc-bulk-summary" class="ttlcc-story-badge">Chưa có dữ liệu</span>
                </div>
                <div class="ttlcc-bulk-preview-actions">
                  <button class="ttlcc-btn ttlcc-btn-soft" id="ttlcc-bulk-cancel" type="button" disabled>Dừng</button>
                  <button class="ttlcc-btn ttlcc-btn-primary" id="ttlcc-bulk-run" type="button">Chạy</button>
                </div>
              </div>

              <div class="ttlcc-table-wrap">
                <table class="ttlcc-table">
                  <thead>
                    <tr><th>Ch.</th><th>Tên</th><th>Từ</th><th>Giá</th><th>Trạng thái</th></tr>
                  </thead>
                  <tbody id="ttlcc-bulk-preview"></tbody>
                </table>
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
                <div class="ttlcc-card-title" style="margin:0">Theo truyện</div>
                <div class="ttlcc-revenue-meta" id="ttlcc-revenue-meta"></div>
              </div>
              <button class="ttlcc-btn ttlcc-btn-soft" id="ttlcc-revenue-refresh" type="button">↻ Làm mới</button>
            </div>
            <div class="ttlcc-revenue-story-list" id="ttlcc-revenue-stories">
              <div class="ttlcc-empty">Mở tab để tải doanh thu.</div>
            </div>
          </div>
        </section>

        <section class="ttlcc-pane" data-pane="log">
          <div class="ttlcc-card" style="margin-bottom:0">
            <div class="ttlcc-card-title">
              <span>Nhật ký</span>
              <button class="ttlcc-btn ttlcc-btn-mini ttlcc-btn-soft" id="ttlcc-log-clear" type="button">Xóa</button>
            </div>
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

    // Luôn bắt đầu ở tab đầu tiên để người dùng xác nhận context truyện trước.
    // Không phục hồi tab cũ từ phiên trước.
    switchTab('stories');
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

    const runBtn = $('#ttlcc-bulk-run');
    if (runBtn) {
      runBtn.textContent = ({
        price_update: 'Cập nhật giá',
        content: 'Cập nhật nội dung',
        both: 'Cập nhật',
        title: 'Đổi tên',
        create: 'Đăng chương',
      })[op] || 'Chạy';
    }

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
    $$('[data-jump-tab]').forEach(btn => {
      btn.onclick = () => switchTab(btn.dataset.jumpTab);
    });

    $('#ttlcc-open-log').onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      switchTab('log');
    };

    $('#ttlcc-dashboard-fix-short').onclick = () => {
      switchTab('bulk');
      $('#ttlcc-bulk-operation').value = 'price_update';
      syncBulkOperationUi();
    };

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
      if (state.running) return toast('Batch đang chạy. Chờ hoàn tất trước khi làm mới.', 'warn');
      try {
        await loadStories();
        if (state.selectedStoryId) await loadChapters();
        toast('Refresh toàn bộ hoàn tất.', 'ok');
      } catch (err) {
        toast(`Refresh lỗi: ${err.message}`, 'error', 6000);
      }
    };

    $('#ttlcc-story-filter').addEventListener('input', renderStoryList);
    $('#ttlcc-story-reload').onclick = () => {
      if (state.running) return toast('Batch đang chạy.', 'warn');
      loadStories().catch(err => toast(err.message, 'error'));
    };
    $('#ttlcc-story-server-search').onclick = () => {
      if (state.running) return toast('Batch đang chạy.', 'warn');
      const q = $('#ttlcc-story-filter').value.trim();
      if (!q) return loadStories();
      loadStories({ serverSearch: true, query: q }).catch(err => toast(`Tìm server lỗi: ${err.message}`, 'error'));
    };
    $('#ttlcc-edit-story').onclick = () => loadStoryEditor();
    $('#ttlcc-publish-story').onclick = togglePublishSelected;

    $('#ttlcc-chapter-filter').addEventListener('input', renderChapters);
    $('#ttlcc-chapter-paid').addEventListener('change', renderChapters);
    $('#ttlcc-chapter-short').addEventListener('change', renderChapters);
    $('#ttlcc-create-chapter').onclick = openCreateChapter;
    $('#ttlcc-chapter-reload').onclick = () => {
      if (state.running) return toast('Batch đang chạy.', 'warn');
      loadChapters().catch(err => toast(err.message, 'error'));
    };

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
      const files = [...(e.target.files || [])];
      if (!files.length) return;

      try {
        await loadBulkTxtFiles(files);
      } catch (err) {
        state.bulk.parsed = [];
        state.bulk.pricing.clear();
        toast(`Nạp TXT lỗi: ${err.message}`, 'error', 8000);
        renderBulkPreview();
      }
    };

    $('#ttlcc-bulk-parse').onclick = () => {
      try {
        const parsed = parseTxtBatch($('#ttlcc-bulk-text').value);
        applyParsedTxtBatch(parsed, `Parse OK: ${parsed.length} chương.`);
      } catch (err) {
        state.bulk.parsed = [];
        state.bulk.pricing.clear();
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
      toast('Đã yêu cầu dừng. Tác vụ đang xử lý sẽ hoàn tất an toàn trước khi dừng.', 'warn');
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
    editStory: () => loadStoryEditor(),
    openRevenue: () => {
      switchTab('revenue');
      return loadRevenueData({ force: true });
    },
    minimize() { $('#ttlcc-panel')?.classList.add('ttlcc-minimized'); savePrefs(); },
    restore() { $('#ttlcc-panel')?.classList.remove('ttlcc-minimized'); savePrefs(); },
  };

  start();
})();
