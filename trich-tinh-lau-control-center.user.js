// ==UserScript==
// @name         Yến Tinh Lâu - Control Center
// @namespace    local.ytl.control-center
// @version      0.3.3
// @description  Quản lý truyện/chương, bulk create native, bulk update rolling, verify/reconcile và thống kê cho yentinhlau.xyz.
// @match        https://yentinhlau.xyz/*
// @noframes
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  if (window.top !== window.self) return;
  if (window.__YTL_CONTROL_CENTER__) return;
  window.__YTL_CONTROL_CENTER__ = true;

  const VERSION = '0.3.3';
  const ORIGIN = location.origin;
  const STORE_KEY = 'ytl-control-center-v1';

  const CFG = {
    timeoutMs: 25000,
    getAttempts: 3,
    retryBaseMs: 900,

    // Rolling update an toàn. Có thể nâng sau khi đo thực tế.
    writeConcurrency: 2,
    writeGapMs: 350,
    verifyAttempts: 3,
    verifyDelayMs: 700,

    // Native bulk create: 1 POST/chunk, không bắn từng chương.
    createChunkSize: 100,

    maxLogLines: 500,
  };

  const state = {
    opened: false,
    activeTab: 'stories',
    theme: 'dark',
    running: false,
    cancelled: false,

    stories: new Map(),
    selectedStoryId: null,
    selectedStory: null,

    chapters: [],
    chapterMap: new Map(),

    stats: null,

    bulk: {
      parsed: [],
      mode: 'create',
      price: 0,
      password: '',
      hPassword: '',
      delayMs: 350,
    },

    log: [],
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function text(v) {
    return String(v ?? '')
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function nowTime() {
    return new Date().toLocaleTimeString('vi-VN');
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

    const host = $('#ytlcc-log');
    if (host) {
      const line = document.createElement('div');
      line.className = `ytlcc-log-line ${level}`;
      line.textContent = `[${item.time}] ${item.message}`;
      host.appendChild(line);
      while (host.children.length > CFG.maxLogLines) host.firstChild.remove();
      host.scrollTop = host.scrollHeight;
    }

    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
      '[YTL Control Center]',
      message
    );
  }

  function toast(message, level = 'info', timeout = 3200) {
    addLog(message, level);
    const host = $('#ytlcc-toast-host');
    if (!host) return;

    const el = document.createElement('div');
    el.className = `ytlcc-toast ${level}`;
    el.textContent = String(message);
    host.appendChild(el);

    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 180);
    }, timeout);
  }

  function setStatus(message, level = 'info') {
    const el = $('#ytlcc-status');
    if (!el) return;
    el.textContent = message;
    el.dataset.level = level;
  }

  function savePrefs() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          selectedStoryId: state.selectedStoryId,
          activeTab: state.activeTab,
          theme: state.theme,
          hPassword: state.bulk.hPassword,
        })
      );
    } catch {}
  }

  function loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function applyTheme(theme = state.theme) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-ytlcc-theme', state.theme);

    const btn = $('#ytlcc-theme-toggle');
    if (btn) {
      btn.textContent = state.theme === 'dark' ? 'Night' : 'Light';
      btn.title =
        state.theme === 'dark'
          ? 'Night mode đang bật. Bấm để chuyển sang Light.'
          : 'Light mode đang bật. Bấm để chuyển sang Night.';
      btn.setAttribute('aria-pressed', state.theme === 'dark' ? 'true' : 'false');
    }

    savePrefs();
  }

  function toggleTheme() {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  }

  function route(path) {
    return new URL(path, ORIGIN).href;
  }

  function csrfFrom(doc = document) {
    return (
      doc.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
      doc.querySelector('input[name="_token"]')?.value ||
      ''
    );
  }

  function retryable(status) {
    return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
  }

  function retryAfterMs(res) {
    const raw = res?.headers?.get('Retry-After');
    if (!raw) return 0;

    const sec = Number(raw);
    if (Number.isFinite(sec)) return Math.max(0, sec * 1000);

    const dt = Date.parse(raw);
    if (Number.isFinite(dt)) return Math.max(0, dt - Date.now());

    return 0;
  }

  async function fetchText(url, {
    method = 'GET',
    headers = {},
    body = undefined,
    attempts = CFG.getAttempts,
    label = method,
  } = {}) {
    let lastErr;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (state.cancelled) throw new Error('Đã hủy.');

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CFG.timeoutMs);

      try {
        const res = await fetch(url, {
          method,
          credentials: 'same-origin',
          cache: method === 'GET' ? 'no-store' : 'default',
          redirect: 'follow',
          headers,
          body,
          signal: ctrl.signal,
        });

        const raw = await res.text();

        if (!res.ok) {
          const err = new Error(`${label}: HTTP ${res.status}`);
          err.status = res.status;
          err.responseText = raw;

          if (retryable(res.status) && attempt < attempts) {
            const wait = Math.max(
              retryAfterMs(res),
              CFG.retryBaseMs * attempt
            );
            addLog(`${label}: HTTP ${res.status}, retry ${attempt}/${attempts} sau ${wait}ms`, 'warn');
            await sleep(wait);
            continue;
          }

          throw err;
        }

        return { res, raw, finalUrl: res.url };
      } catch (err) {
        lastErr = err;

        if (
          attempt < attempts &&
          (err?.name === 'AbortError' || !err?.status || retryable(err.status))
        ) {
          const wait = CFG.retryBaseMs * attempt;
          addLog(`${label}: retry ${attempt}/${attempts} sau lỗi ${err.message}`, 'warn');
          await sleep(wait);
          continue;
        }

        throw err;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastErr || new Error(`${label}: lỗi không xác định.`);
  }

  async function getJson(url, label = 'GET JSON') {
    const { raw, res } = await fetchText(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      },
      label,
    });

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`${label}: server không trả JSON hợp lệ (HTTP ${res.status}).`);
    }
    return data;
  }

  async function getDoc(url, label = 'GET page') {
    const { raw, finalUrl } = await fetchText(url, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Cache-Control': 'no-cache',
      },
      label,
    });

    return {
      html: raw,
      finalUrl,
      doc: new DOMParser().parseFromString(raw, 'text/html'),
    };
  }

  async function postForm(url, formData, label = 'POST form', { attempts = 2 } = {}) {
    const token = csrfFrom();
    if (!token) throw new Error('Không lấy được CSRF token hiện tại.');

    const { raw, res } = await fetchText(url, {
      method: 'POST',
      headers: {
        'X-CSRF-TOKEN': token,
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: formData,
      attempts,
      label,
    });

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`${label}: server trả dữ liệu không phải JSON.`);
    }

    if (!res.ok || data?.success === false) {
      throw new Error(data?.message || `${label}: thất bại.`);
    }

    return data;
  }

  async function postJson(url, payload, label = 'POST JSON') {
    const token = csrfFrom();
    if (!token) throw new Error('Không lấy được CSRF token hiện tại.');

    const { raw, res } = await fetchText(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': token,
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify(payload),
      attempts: 2,
      label,
    });

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`${label}: server trả dữ liệu không phải JSON.`);
    }

    if (!res.ok || data?.success === false) {
      let msg = data?.message || `${label}: thất bại.`;
      if (data?.errors) {
        const first = Object.values(data.errors).flat()[0];
        if (first) msg += ` (${first})`;
      }
      throw new Error(msg);
    }

    return data;
  }

  // ============================================================
  // STORIES
  // ============================================================

  function discoverStoryIds(doc, html) {
    const ids = new Set();

    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/profile\/stories\/(\d+)\/import-word(?:$|\?)/);
      if (m) ids.add(Number(m[1]));
    }

    const re = /\/profile\/stories\/(\d+)(?:\/|["'?#<\s])/g;
    let m;
    while ((m = re.exec(html))) {
      ids.add(Number(m[1]));
    }

    // Alpine openManageChaptersModal({ "id": ... })
    for (const el of doc.querySelectorAll('[\\@click], [x-on\\:click]')) {
      const raw =
        el.getAttribute('@click') ||
        el.getAttribute('x-on:click') ||
        '';
      if (!/openManageChaptersModal|openEditStory/.test(raw)) continue;

      const idMatch = raw.match(/["']?id["']?\s*:\s*(\d+)/);
      if (idMatch) ids.add(Number(idMatch[1]));
    }

    return [...ids].filter(Number.isFinite).sort((a, b) => a - b);
  }

  async function loadStories() {
    setStatus('Đang tải danh sách truyện...');
    const { doc, html } = await getDoc(route('/profile'), 'GET /profile');
    const ids = discoverStoryIds(doc, html);

    if (!ids.length) {
      state.stories.clear();
      renderStories();
      setStatus('Không tìm thấy truyện nào.', 'warn');
      return;
    }

    const stories = new Map();

    // GET chapters trả luôn story object, dùng làm nguồn canonical cho list.
    for (const id of ids) {
      if (state.cancelled) throw new Error('Đã hủy.');

      try {
        const data = await getJson(
          route(`/profile/stories/${id}/chapters`),
          `GET chapters #${id}`
        );

        if (data?.story) {
          stories.set(Number(id), {
            ...data.story,
            id: Number(data.story.id || id),
            chapters_count:
              Number(data.story.chapters_count ?? data.chapters?.length ?? 0),
          });
        } else {
          stories.set(Number(id), {
            id: Number(id),
            title: `Truyện #${id}`,
            chapters_count: Number(data?.chapters?.length || 0),
          });
        }
      } catch (err) {
        addLog(`Không đọc được metadata truyện #${id}: ${err.message}`, 'warn');
        stories.set(Number(id), {
          id: Number(id),
          title: `Truyện #${id}`,
          chapters_count: 0,
          load_error: err.message,
        });
      }

      await sleep(120);
    }

    state.stories = stories;

    if (
      state.selectedStoryId &&
      state.stories.has(Number(state.selectedStoryId))
    ) {
      state.selectedStory = state.stories.get(Number(state.selectedStoryId));
    } else {
      const first = [...state.stories.values()][0] || null;
      state.selectedStoryId = first?.id || null;
      state.selectedStory = first;
    }

    renderStories();
    renderSelectedStory();
    savePrefs();

    setStatus(`Đã tải ${state.stories.size} truyện.`);
    addLog(`Đã tải ${state.stories.size} truyện.`);
  }

  async function selectStory(id, { load = true } = {}) {
    id = Number(id);
    if (!state.stories.has(id)) return;

    state.selectedStoryId = id;
    state.selectedStory = state.stories.get(id);
    state.chapters = [];
    state.chapterMap.clear();
    // state.stats là tổng hợp toàn bộ truyện, không reset khi đổi truyện.
    state.bulk.parsed = [];

    renderStories();
    renderSelectedStory();
    renderChapters();
    renderBulkPreview();
    renderStats();
    savePrefs();

    if (load) {
      await loadChapters();
    }
  }

  function renderStories() {
    const host = $('#ytlcc-story-list');
    if (!host) return;

    const stories = [...state.stories.values()];

    if (!stories.length) {
      host.innerHTML = '<div class="ytlcc-empty">Chưa có dữ liệu truyện.</div>';
      return;
    }

    host.innerHTML = stories.map(story => {
      const active = Number(story.id) === Number(state.selectedStoryId);
      return `
        <button type="button"
          class="ytlcc-story-row ${active ? 'active' : ''}"
          data-story-id="${story.id}">
          <div class="ytlcc-story-main">
            <strong>${esc(story.title || `Truyện #${story.id}`)}</strong>
            <span>#${story.id} · ${Number(story.chapters_count || 0)} chương · ${esc(story.status || '')}</span>
          </div>
        </button>
      `;
    }).join('');

    for (const btn of host.querySelectorAll('[data-story-id]')) {
      btn.addEventListener('click', () => {
        selectStory(Number(btn.dataset.storyId)).catch(err => {
          toast(err.message, 'error', 5000);
        });
      });
    }
  }

  function renderSelectedStory() {
    const title = $('#ytlcc-selected-title');
    const sub = $('#ytlcc-selected-sub');

    if (!state.selectedStory) {
      if (title) title.textContent = 'Chưa chọn truyện';
      if (sub) sub.textContent = '';
      const overviewStory = $('#ytlcc-overview-story');
      const overviewChapters = $('#ytlcc-overview-chapters');
      if (overviewStory) overviewStory.textContent = '—';
      if (overviewChapters) overviewChapters.textContent = '—';
      return;
    }

    if (title) title.textContent = state.selectedStory.title || `Truyện #${state.selectedStoryId}`;
    if (sub) {
      sub.textContent =
        `#${state.selectedStoryId}` +
        (state.selectedStory.status ? ` · ${state.selectedStory.status}` : '') +
        (state.selectedStory.type ? ` · ${state.selectedStory.type}` : '');
    }

    const overviewStory = $('#ytlcc-overview-story');
    const overviewChapters = $('#ytlcc-overview-chapters');
    if (overviewStory) overviewStory.textContent = state.selectedStory.title || `#${state.selectedStoryId}`;
    if (overviewChapters) overviewChapters.textContent = `${Number(state.selectedStory.chapters_count || state.chapters.length || 0)} chương`;
  }

  function safeFileName(raw) {
    return String(raw || 'truyen')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'truyen';
  }

  function buildStoryTxt(chapters) {
    const sorted = [...chapters].sort(
      (a, b) => Number(a.chapter_number) - Number(b.chapter_number)
    );

    return sorted.map(ch => {
      const no = Number(ch.chapter_number);
      const title = String(ch.title || '').trim();
      const heading = title
        ? `Chương ${no}: ${title}`
        : `Chương ${no}`;

      const body = htmlToPlain(ch.content || '').trim();

      return `${heading}\n\n${body}`.trim();
    }).join('\n\n\n');
  }

  async function downloadStoryTxt() {
    if (!state.selectedStoryId) {
      throw new Error('Chưa chọn truyện.');
    }

    setStatus('Đang lấy nội dung mới nhất...');

    const snap = await fetchChapterSnapshot(state.selectedStoryId);
    const chapters = (snap.chapters || [])
      .sort((a, b) => Number(a.chapter_number) - Number(b.chapter_number));

    if (!chapters.length) {
      throw new Error('Truyện chưa có chương để tải.');
    }

    state.chapters = chapters;
    state.chapterMap = new Map(
      chapters.map(ch => [Number(ch.chapter_number), ch])
    );

    if (snap.story) {
      state.selectedStory = {
        ...(state.stories.get(Number(state.selectedStoryId)) || {}),
        ...snap.story,
        chapters_count: chapters.length,
      };
      state.stories.set(Number(state.selectedStoryId), state.selectedStory);
    }

    renderStories();
    renderSelectedStory();
    renderChapters();

    const txt = buildStoryTxt(chapters);
    const firstNo = Number(chapters[0].chapter_number);
    const lastNo = Number(chapters.at(-1).chapter_number);
    const storyTitle =
      state.selectedStory?.title ||
      snap.story?.title ||
      `Truyen-${state.selectedStoryId}`;

    const filename =
      `${safeFileName(storyTitle)} - Chương ${firstNo}-${lastNo}.txt`;

    const blob = new Blob(
      ['\uFEFF', txt],
      { type: 'text/plain;charset=utf-8' }
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    const msg = `Đã xuất ${chapters.length} chương: ${filename}`;
    setStatus(msg, 'success');
    toast(msg, 'success', 5000);
    addLog(msg, 'success');
  }

  // ============================================================
  // CHAPTERS
  // ============================================================

  function normalizeChapter(ch) {
    return {
      ...ch,
      id: Number(ch.id),
      story_id: Number(ch.story_id || state.selectedStoryId),
      chapter_number: Number(ch.chapter_number),
      title: String(ch.title || ''),
      content: String(ch.content || ''),
      password: String(ch.password || ''),
      stars_active: Number(ch.stars_active || 0),
      diamonds_active: Number(ch.diamonds_active || 0),
      word_count: Number(ch.word_count || 0),
      views_count: Number(ch.views_count || 0),
      status: String(ch.status || ''),
      published_at: ch.published_at || '',
    };
  }

  async function fetchChapterSnapshot(storyId = state.selectedStoryId) {
    storyId = Number(storyId);
    if (!storyId) throw new Error('Chưa chọn truyện.');

    const data = await getJson(
      route(`/profile/stories/${storyId}/chapters`),
      `GET chapters #${storyId}`
    );

    if (!data?.success && !Array.isArray(data?.chapters)) {
      throw new Error('Response chapters không đúng schema dự kiến.');
    }

    return {
      story: data.story || null,
      chapters: (data.chapters || []).map(normalizeChapter),
    };
  }

  async function loadChapters() {
    if (!state.selectedStoryId) {
      toast('Chưa chọn truyện.', 'warn');
      return;
    }

    setStatus(`Đang tải chương #${state.selectedStoryId}...`);

    const snap = await fetchChapterSnapshot();

    state.chapters = snap.chapters
      .sort((a, b) => Number(a.chapter_number) - Number(b.chapter_number));

    state.chapterMap = new Map(
      state.chapters.map(ch => [Number(ch.chapter_number), ch])
    );

    if (snap.story) {
      state.selectedStory = {
        ...(state.stories.get(Number(state.selectedStoryId)) || {}),
        ...snap.story,
        chapters_count: state.chapters.length,
      };
      state.stories.set(Number(state.selectedStoryId), state.selectedStory);
    }

    renderStories();
    renderSelectedStory();
    renderChapters();

    setStatus(`Đã tải ${state.chapters.length} chương.`);
    addLog(`Truyện #${state.selectedStoryId}: ${state.chapters.length} chương.`);
  }

  function renderChapters() {
    const body = $('#ytlcc-chapter-body');
    const count = $('#ytlcc-chapter-count');
    if (count) count.textContent = String(state.chapters.length);
    if (!body) return;

    if (!state.selectedStoryId) {
      body.innerHTML = '<tr><td colspan="7" class="ytlcc-empty">Chưa chọn truyện.</td></tr>';
      return;
    }

    if (!state.chapters.length) {
      body.innerHTML = '<tr><td colspan="7" class="ytlcc-empty">Chưa có chương hoặc chưa tải dữ liệu.</td></tr>';
      return;
    }

    body.innerHTML = state.chapters.map(ch => `
      <tr>
        <td>${esc(ch.chapter_number)}</td>
        <td class="ytlcc-title-cell" title="${esc(ch.title)}">${esc(ch.title)}</td>
        <td>${esc(ch.word_count)}</td>
        <td>${esc(ch.views_count)}</td>
        <td>${esc(ch.stars_active)}</td>
        <td>${esc(ch.status)}</td>
        <td><button type="button" class="ytlcc-mini" data-edit-ch="${ch.chapter_number}">Sửa</button></td>
      </tr>
    `).join('');

    for (const btn of body.querySelectorAll('[data-edit-ch]')) {
      btn.addEventListener('click', () => {
        openSingleChapterEditor(Number(btn.dataset.editCh));
      });
    }
  }

  function currentPublishFields(ch) {
    if (ch.status === 'scheduled' && ch.published_at) {
      return {
        publish_type: 'scheduled',
        published_at: String(ch.published_at).replace(' ', 'T').substring(0, 16),
      };
    }

    return {
      publish_type: 'now',
      published_at: '',
    };
  }

  async function updateChapter(ch, overrides = {}, label = '') {
    const publish = currentPublishFields(ch);

    const fd = new FormData();
    fd.set('_token', csrfFrom());
    fd.set('chapter_number', String(overrides.chapter_number ?? ch.chapter_number));
    fd.set('title', String(overrides.title ?? ch.title ?? ''));
    fd.set('content', String(overrides.content ?? ch.content ?? ''));
    fd.set('password', String(overrides.password ?? ch.password ?? ''));
    fd.set('stars_active', String(Number(overrides.stars_active ?? ch.stars_active ?? 0)));
    fd.set('publish_type', String(overrides.publish_type ?? publish.publish_type));
    fd.set('published_at', String(overrides.published_at ?? publish.published_at));

    return postForm(
      route(`/profile/stories/${state.selectedStoryId}/chapters/${ch.id}/update`),
      fd,
      label || `UPDATE chương ${ch.chapter_number}`
    );
  }

  function openSingleChapterEditor(chapterNo) {
    const ch = state.chapterMap.get(Number(chapterNo));
    if (!ch) return;

    const dlg = $('#ytlcc-editor-modal');
    if (!dlg) return;

    $('#ytlcc-edit-no').value = ch.chapter_number;
    $('#ytlcc-edit-title').value = ch.title;
    $('#ytlcc-edit-price').value = ch.stars_active;
    $('#ytlcc-edit-password').value = ch.password || '';
    $('#ytlcc-edit-content').value = htmlToPlain(ch.content);

    dlg.dataset.chapterNo = String(ch.chapter_number);
    dlg.classList.add('show');
  }

  async function saveSingleEditor() {
    const dlg = $('#ytlcc-editor-modal');
    const no = Number(dlg?.dataset.chapterNo || 0);
    const ch = state.chapterMap.get(no);
    if (!ch) return;

    if (!confirm(`Lưu thay đổi Chương ${no}?`)) return;

    try {
      setStatus(`Đang lưu Chương ${no}...`);
      await updateChapter(ch, {
        title: $('#ytlcc-edit-title').value.trim(),
        stars_active: Math.max(0, Number($('#ytlcc-edit-price').value || 0)),
        password: $('#ytlcc-edit-password').value,
        content: plainToHtml($('#ytlcc-edit-content').value),
      });

      toast(`Đã lưu Chương ${no}.`, 'success');
      dlg.classList.remove('show');
      await loadChapters();
    } catch (err) {
      toast(`Không lưu được Chương ${no}: ${err.message}`, 'error', 6000);
    }
  }

  function parseChapterSelector(raw, chapters = state.chapters) {
    const spec = String(raw || '').trim();
    if (!spec) {
      throw new Error('Chưa nhập phạm vi chương.');
    }

    const sorted = [...chapters].sort(
      (a, b) => Number(a.chapter_number) - Number(b.chapter_number)
    );
    const byNo = new Map(
      sorted.map(ch => [Number(ch.chapter_number), ch])
    );

    if (/^h$/i.test(spec)) {
      const selected = sorted.filter(ch => isHChapterTitle(ch.title));
      if (!selected.length) {
        throw new Error('Không tìm thấy chương có token H trong tên.');
      }
      return {
        chapters: selected,
        missing: [],
        label: 'H',
      };
    }

    if (/^(?:\*|all|tất\s*cả)$/iu.test(spec)) {
      if (!sorted.length) {
        throw new Error('Truyện chưa có chương.');
      }
      return {
        chapters: sorted,
        missing: [],
        label: '*',
      };
    }

    const wanted = new Set();
    const tokens = spec
      .split(/[,;\s]+/)
      .map(x => x.trim())
      .filter(Boolean);

    if (!tokens.length) {
      throw new Error('Phạm vi chương không hợp lệ.');
    }

    for (const token of tokens) {
      let m = token.match(/^(\d+)$/);
      if (m) {
        wanted.add(Number(m[1]));
        continue;
      }

      m = token.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
      if (m) {
        let a = Number(m[1]);
        let b = Number(m[2]);
        if (a > b) [a, b] = [b, a];

        // Chặn range nhập nhầm quá lớn.
        if (b - a > 10000) {
          throw new Error(`Range quá lớn: ${token}`);
        }

        for (let n = a; n <= b; n++) wanted.add(n);
        continue;
      }

      throw new Error(`Không hiểu phạm vi: "${token}"`);
    }

    const numbers = [...wanted].sort((a, b) => a - b);
    const selected = [];
    const missing = [];

    for (const no of numbers) {
      const ch = byNo.get(no);
      if (ch) selected.push(ch);
      else missing.push(no);
    }

    if (!selected.length) {
      throw new Error('Không có chương nào trong phạm vi tồn tại trên server.');
    }

    return {
      chapters: selected,
      missing,
      label: spec,
    };
  }

  function openBulkPassModal() {
    const modal = $('#ytlcc-pass-modal');
    if (!modal) return;

    const selector = $('#ytlcc-pass-range');
    const password = $('#ytlcc-pass-value');

    if (selector && !selector.value.trim()) {
      selector.value = 'H';
    }
    if (password) {
      password.value = getHPassword();
    }

    modal.classList.add('show');
    setTimeout(() => selector?.focus(), 0);
  }

  function closeBulkPassModal() {
    if (state.running) return;
    $('#ytlcc-pass-modal')?.classList.remove('show');
  }

  async function bulkSetExistingPassword({ clear = false } = {}) {
    if (!state.selectedStoryId) {
      throw new Error('Chưa chọn truyện.');
    }

    // Snapshot mới nhất trước khi lập target.
    await loadChapters();

    const spec = $('#ytlcc-pass-range')?.value || '';
    const selection = parseChapterSelector(spec, state.chapters);

    const passInput = $('#ytlcc-pass-value');
    const nextPassword = clear
      ? ''
      : String(passInput?.value || '');

    if (!clear && !nextPassword) {
      throw new Error('Pass không được để trống. Nếu muốn bỏ pass, dùng "Xóa pass".');
    }

    const targets = selection.chapters
      .filter(ch => String(ch.password || '') !== nextPassword)
      .map(ch => ({
        no: Number(ch.chapter_number),
        ch,
        overrides: { password: nextPassword },
      }));

    const unchangedCount = selection.chapters.length - targets.length;

    if (!targets.length) {
      const msg = clear
        ? `Các chương đã chọn đều không có pass.`
        : `Các chương đã chọn đã dùng đúng pass này.`;
      setStatus(msg, 'success');
      toast(msg, 'success');
      return;
    }

    const missingText = selection.missing.length
      ? `\nKhông tồn tại, sẽ bỏ qua: ${selection.missing.join(', ')}`
      : '';

    const action = clear ? 'XÓA PASS' : 'ĐỔI PASS';

    if (
      !confirm(
        `${action} hàng loạt\n\n` +
        `Phạm vi: ${selection.label}\n` +
        `Sẽ cập nhật: ${targets.length} chương\n` +
        `Đã đúng sẵn: ${unchangedCount} chương` +
        missingText +
        `\n\nTiếp tục?`
      )
    ) return;

    // Pass nhập trong modal cũng trở thành Pass H mặc định được lưu local.
    if (!clear) {
      state.bulk.hPassword = nextPassword;
      const mainPass = $('#ytlcc-h-password');
      if (mainPass) mainPass.value = nextPassword;
      savePrefs();
    }

    state.running = true;
    state.cancelled = false;
    renderRunState();

    try {
      let completed = 0;
      setStatus(`${action}: 0/${targets.length}...`);

      const results = await runPool(
        targets,
        CFG.writeConcurrency,
        async target => {
          if (state.cancelled) throw new Error('Đã hủy.');

          await updateChapter(
            target.ch,
            target.overrides,
            `${clear ? 'CLEAR PASS' : 'SET PASS'} Chương ${target.no}`
          );

          completed++;
          setStatus(`${action}: ${completed}/${targets.length}...`);
          addLog(
            `${clear ? 'CLEAR PASS' : 'SET PASS'} OK Chương ${target.no} (${completed}/${targets.length}).`
          );

          const delay = clamp(
            Number($('#ytlcc-bulk-delay')?.value || CFG.writeGapMs),
            180,
            5000
          );
          await sleep(delay);

          return target.no;
        }
      );

      const failed = targets.filter((_, i) => !results[i]?.ok);

      if (failed.length) {
        for (const target of failed) {
          const idx = targets.indexOf(target);
          addLog(
            `${action} FAIL Chương ${target.no}: ` +
            `${results[idx]?.error?.message || 'unknown'}`,
            'error'
          );
        }

        throw new Error(
          `${failed.length}/${targets.length} chương cập nhật pass thất bại.`
        );
      }

      setStatus('Đã ghi xong. Đang verify pass...');
      await sleep(450);

      const verify = await verifyTargets(targets);

      if (!verify.ok) {
        throw new Error(
          `VERIFY pass thất bại ở chương: ${verify.failed.map(x => x.no).join(', ')}`
        );
      }

      const msg =
        `${clear ? 'Xóa' : 'Đổi'} pass PASS ${targets.length}/${targets.length} chương.`;

      $('#ytlcc-pass-modal')?.classList.remove('show');
      setStatus(msg, 'success');
      toast(msg, 'success', 5000);
      addLog(msg, 'success');
    } finally {
      state.running = false;
      renderRunState();
    }
  }

  async function loadTxtFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;

    const invalid = files.filter(file => {
      const name = String(file?.name || '');
      return !/\.txt$/i.test(name) && file?.type && file.type !== 'text/plain';
    });

    if (invalid.length) {
      throw new Error(
        `Chỉ hỗ trợ TXT. File không hợp lệ: ${invalid.map(f => f.name || '(không tên)').join(', ')}`
      );
    }

    const loaded = [];

    for (const file of files) {
      let raw = await file.text();
      raw = String(raw || '').replace(/^\uFEFF/, '');

      let parsed;
      try {
        parsed = parseBulkText(raw);
      } catch (err) {
        throw new Error(`${file.name || 'TXT'}: ${err.message}`);
      }

      if (!parsed.length) {
        throw new Error(`${file.name || 'TXT'}: không có chương hợp lệ.`);
      }

      loaded.push({
        file,
        raw,
        parsed: parsed.map(item => ({
          ...item,
          sourceFile: String(file.name || 'TXT'),
        })),
        firstChapter: Math.min(...parsed.map(x => Number(x.chapterNo))),
        lastChapter: Math.max(...parsed.map(x => Number(x.chapterNo))),
      });
    }

    // Xếp file theo chương đầu để textarea và preview có thứ tự ổn định.
    loaded.sort((a, b) => {
      const d = a.firstChapter - b.firstChapter;
      if (d) return d;
      return String(a.file.name || '').localeCompare(String(b.file.name || ''), 'vi');
    });

    // Kiểm tra trùng chapter_number giữa các file trước khi thay state/UI.
    const ownerByChapter = new Map();
    const duplicates = [];

    for (const entry of loaded) {
      for (const item of entry.parsed) {
        const no = Number(item.chapterNo);
        const previous = ownerByChapter.get(no);

        if (previous) {
          duplicates.push({
            no,
            first: previous,
            second: entry.file.name || 'TXT',
          });
        } else {
          ownerByChapter.set(no, entry.file.name || 'TXT');
        }
      }
    }

    if (duplicates.length) {
      const detail = duplicates
        .slice(0, 12)
        .map(x => `Chương ${x.no}: "${x.first}" ↔ "${x.second}"`)
        .join('; ');

      const more = duplicates.length > 12
        ? `; ... +${duplicates.length - 12} lỗi trùng`
        : '';

      throw new Error(`Trùng chương giữa các TXT: ${detail}${more}`);
    }

    const merged = loaded
      .flatMap(entry => entry.parsed)
      .sort((a, b) => Number(a.chapterNo) - Number(b.chapterNo));

    // Gộp raw theo thứ tự file đã chuẩn hóa. Không chèn tên file vào raw
    // để tránh làm bẩn nội dung chương cuối của từng file.
    const combinedRaw = loaded
      .map(entry => entry.raw.trim())
      .filter(Boolean)
      .join('\n\n\n');

    const input = $('#ytlcc-bulk-input');
    if (!input) throw new Error('Không tìm thấy ô dữ liệu TXT.');

    input.value = combinedRaw;
    state.bulk.parsed = merged;

    const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    const fileLabel = $('#ytlcc-txt-file-name');

    if (fileLabel) {
      const names = loaded.map(x => x.file.name || 'TXT');
      const shortNames =
        names.length <= 2
          ? names.join(' + ')
          : `${names[0]} + ${names[1]} +${names.length - 2}`;

      fileLabel.textContent =
        `${files.length} TXT · ${shortNames} · ` +
        `${(totalBytes / 1024).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} KB`;

      fileLabel.title = names.join('\n');
    }

    renderBulkPreview();

    const first = merged[0]?.chapterNo;
    const last = merged.at(-1)?.chapterNo;
    const hCount = merged.filter(x => x.isH).length;

    addLog(
      `Đã nạp ${files.length} TXT: ${merged.length} chương` +
      (first != null ? ` (${first}→${last})` : '') +
      (hCount ? `, H=${hCount}` : '') +
      '.'
    );

    toast(
      `Đã gộp ${files.length} TXT · ${merged.length} chương.`,
      'success',
      4200
    );
  }

  async function loadTxtFile(file) {
    // Giữ compatibility nếu code cũ hoặc thao tác khác còn gọi hàm single-file.
    return loadTxtFiles(file ? [file] : []);
  }


  function isHChapterTitle(rawTitle) {
    const title = String(rawTitle ?? '')
      .normalize('NFKC')
      .replace(/\u00A0/g, ' ')
      .trim();

    if (!title) return false;

    // H phải là token độc lập. Match H, [H], (H), "- H -", "H cao", ...
    // Không match chữ h nằm trong từ khác như "Hoa", "Hệ thống", "Hạ".
    return /(^|[\s\[\](){}<>:;,.!?\-–—_/\\|])H(?=$|[\s\[\](){}<>:;,.!?\-–—_/\\|])/iu.test(title);
  }

  function getHPassword() {
    const input = $('#ytlcc-h-password');
    if (input) {
      state.bulk.hPassword = String(input.value || '');
    }
    return String(state.bulk.hPassword || '');
  }

  // ============================================================
  // BULK PARSER
  // ============================================================

  function htmlToPlain(html) {
    const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
    const root = doc.body.firstElementChild;
    if (!root) return '';

    for (const br of root.querySelectorAll('br')) br.replaceWith('\n');

    for (const p of root.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,blockquote')) {
      p.insertAdjacentText('beforeend', '\n');
    }

    return (root.textContent || '')
      .replace(/\u00A0/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function plainToHtml(raw) {
    raw = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
    if (!raw) return '';

    return raw
      .split(/\n{2,}/)
      .map(block => {
        const lines = block
          .split('\n')
          .map(line => esc(line))
          .join('<br>');
        return `<p>${lines}</p>`;
      })
      .join('\n');
  }

  function parseBulkText(raw) {
    raw = String(raw ?? '').replace(/\r\n?/g, '\n');

    const heading =
      /^\s*(?:chương|chuong|chapter|ch\.?)\s+(\d+(?:\.\d+)?)\s*(?:[:.\-–—]\s*(.*?))?\s*$/gim;

    const matches = [...raw.matchAll(heading)];
    if (!matches.length) {
      throw new Error('Không tìm thấy heading dạng "Chương N" / "Chapter N".');
    }

    const items = [];

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const start = m.index + m[0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
      const no = Number(m[1]);
      const suffix = String(m[2] || '').trim();
      const body = raw.slice(start, end).trim();

      if (!Number.isFinite(no)) continue;

      const isH = isHChapterTitle(suffix);

      items.push({
        chapterNo: no,

        // YTL lưu số chương riêng ở chapter_number.
        title: suffix,
        shortTitle: suffix,
        createTitle: suffix || `Chương ${no}`,
        isH,

        contentPlain: body,
        contentHtml: plainToHtml(body),
        charCount: body.length,
      });
    }

    // Reject duplicate chapter numbers.
    const seen = new Set();
    for (const item of items) {
      if (seen.has(item.chapterNo)) {
        throw new Error(`Trùng số chương ${item.chapterNo}.`);
      }
      seen.add(item.chapterNo);
    }

    return items.sort((a, b) => a.chapterNo - b.chapterNo);
  }

  function parseBulkFromUi() {
    try {
      const raw = $('#ytlcc-bulk-input')?.value || '';
      state.bulk.parsed = parseBulkText(raw);
      renderBulkPreview();
      toast(`Đã parse ${state.bulk.parsed.length} chương.`, 'success');
    } catch (err) {
      state.bulk.parsed = [];
      renderBulkPreview();
      toast(err.message, 'error', 5000);
    }
  }

  function renderBulkPreview() {
    const body = $('#ytlcc-bulk-preview-body');
    const summary = $('#ytlcc-bulk-summary');
    if (!body || !summary) return;

    const items = state.bulk.parsed || [];

    if (!items.length) {
      summary.textContent = 'Chưa parse dữ liệu.';
      body.innerHTML =
        '<tr><td colspan="5" class="ytlcc-empty">Nạp TXT hoặc dán nội dung rồi Phân tích.</td></tr>';
      return;
    }

    const first = items[0]?.chapterNo;
    const last = items.at(-1)?.chapterNo;
    const hCount = items.filter(x => x.isH).length;

    summary.textContent =
      `${items.length} chương · ${first} → ${last} · ` +
      `${items.reduce((n, x) => n + x.charCount, 0).toLocaleString('vi-VN')} ký tự` +
      (hCount ? ` · H: ${hCount}` : '');

    body.innerHTML = items.slice(0, 250).map(x => `
      <tr>
        <td>${x.chapterNo}</td>
        <td class="ytlcc-title-cell">${esc(x.title || '(không có tên chương)')}</td>
        <td>${x.charCount.toLocaleString('vi-VN')}</td>
        <td>${x.isH ? '<span class="ytlcc-h-badge">H</span>' : ''}</td>
        <td>${state.chapterMap.has(Number(x.chapterNo)) ? 'Đã có' : 'Mới'}</td>
      </tr>
    `).join('');
  }

  function ensureContiguous(items) {
    if (!items.length) return false;
    for (let i = 1; i < items.length; i++) {
      if (Number(items[i].chapterNo) !== Number(items[i - 1].chapterNo) + 1) {
        return false;
      }
    }
    return true;
  }

  // ============================================================
  // SMART TXT SYNC
  // Có thì cập nhật, thiếu thì đăng. Mapping bằng chapter_number.
  // ============================================================

  function normalizePlainText(raw) {
    return String(raw ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u00A0/g, ' ')
      .split('\n')
      .map(line => line.replace(/[ \t]+/g, ' ').trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function chapterContentComparable(ch) {
    return normalizePlainText(htmlToPlain(ch?.content || ''));
  }

  function itemContentComparable(item) {
    return normalizePlainText(item?.contentPlain || '');
  }

  function titleComparable(raw) {
    return String(raw ?? '')
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function createChapter(item) {
    const storyId = Number(state.selectedStoryId);
    if (!storyId) throw new Error('Chưa chọn truyện.');

    const fd = new FormData();
    fd.set('_token', csrfFrom());
    fd.set('chapter_number', String(item.chapterNo));
    fd.set('title', String(item.createTitle || item.title || `Chương ${item.chapterNo}`));
    fd.set('content', String(item.contentHtml || ''));
    fd.set('password', item.isH ? getHPassword() : '');
    fd.set(
      'stars_active',
      String(Math.max(0, Number($('#ytlcc-bulk-price')?.value || 0)))
    );
    fd.set('publish_type', 'now');
    fd.set('published_at', '');

    // CREATE không blind retry. Timeout/5xx có thể đã ghi thành công,
    // nên nếu lỗi phải reconcile trước khi quyết định.
    try {
      return await postForm(
        route(`/profile/stories/${storyId}/chapters`),
        fd,
        `CREATE Chương ${item.chapterNo}`,
        { attempts: 1 }
      );
    } catch (err) {
      addLog(
        `CREATE Chương ${item.chapterNo} trả lỗi/không rõ trạng thái; đang reconcile trước khi dừng.`,
        'warn'
      );

      try {
        await sleep(500);
        const snap = await fetchChapterSnapshot(storyId);
        const actual = snap.chapters.find(
          ch => Number(ch.chapter_number) === Number(item.chapterNo)
        );

        if (actual) {
          const titleOk =
            !item.title ||
            titleComparable(actual.title) === titleComparable(item.title);

          const contentOk =
            chapterContentComparable(actual) === itemContentComparable(item);

          const hPassword = getHPassword();
          const passwordOk =
            !item.isH ||
            !hPassword ||
            String(actual.password || '') === hPassword;

          if (titleOk && contentOk && passwordOk) {
            addLog(
              `RECONCILE CREATE Chương ${item.chapterNo}: server đã có dữ liệu đúng, coi là PASS.`,
              'warn'
            );
            return { success: true, reconciled: true };
          }

          throw new Error(
            `Chương ${item.chapterNo} đã xuất hiện sau lỗi CREATE nhưng dữ liệu không khớp. Dừng để tránh ghi đè mù.`
          );
        }
      } catch (reconcileErr) {
        if (/đã xuất hiện/.test(String(reconcileErr?.message || ''))) {
          throw reconcileErr;
        }
        addLog(
          `Reconcile Chương ${item.chapterNo} cũng lỗi: ${reconcileErr.message || reconcileErr}`,
          'warn'
        );
      }

      throw err;
    }
  }

  function buildSmartSyncPlan(mode) {
    const parsed = state.bulk.parsed || [];
    if (!parsed.length) throw new Error('Chưa parse TXT.');

    const plan = {
      mode,
      updates: [],
      creates: [],
      unchanged: [],
      skippedExisting: [],
      skippedMissing: [],
    };

    for (const item of parsed) {
      const no = Number(item.chapterNo);
      const existing = state.chapterMap.get(no);

      if (existing) {
        if (mode === 'missing_only') {
          plan.skippedExisting.push(no);
          continue;
        }

        const overrides = {};

        const currentContent = chapterContentComparable(existing);
        const incomingContent = itemContentComparable(item);

        if (currentContent !== incomingContent) {
          overrides.content = item.contentHtml;
        }

        // Chỉ đổi tên khi TXT thật sự có tên chương.
        // TXT chỉ ghi "Chương 12" sẽ không xóa tên hiện tại.
        if (
          item.title &&
          titleComparable(existing.title) !== titleComparable(item.title)
        ) {
          overrides.title = item.title;
        }

        const hPassword = getHPassword();
        if (
          item.isH &&
          hPassword &&
          String(existing.password || '') !== hPassword
        ) {
          overrides.password = hPassword;
        }

        if (Object.keys(overrides).length) {
          plan.updates.push({
            no,
            ch: existing,
            item,
            overrides,
          });
        } else {
          plan.unchanged.push(no);
        }
      } else {
        if (mode === 'existing_only') {
          plan.skippedMissing.push(no);
          continue;
        }

        plan.creates.push({
          no,
          item,
        });
      }
    }

    return plan;
  }

  async function verifySmartSync(plan) {
    const snap = await fetchChapterSnapshot();
    const map = new Map(
      snap.chapters.map(ch => [Number(ch.chapter_number), ch])
    );

    const failed = [];

    for (const target of plan.updates) {
      const actual = map.get(Number(target.no));
      if (!actual || !matchesExpected(actual, target.overrides)) {
        failed.push({
          no: target.no,
          type: 'update',
        });
      }
    }

    for (const target of plan.creates) {
      const actual = map.get(Number(target.no));
      if (!actual) {
        failed.push({
          no: target.no,
          type: 'create-missing',
        });
        continue;
      }

      const titleOk =
        !target.item.title ||
        titleComparable(actual.title) === titleComparable(target.item.title);

      const contentOk =
        chapterContentComparable(actual) === itemContentComparable(target.item);

      const hPassword = getHPassword();
      const passwordOk =
        !target.item.isH ||
        !hPassword ||
        String(actual.password || '') === hPassword;

      if (!titleOk || !contentOk || !passwordOk) {
        failed.push({
          no: target.no,
          type: 'create-mismatch',
        });
      }
    }

    state.chapters = snap.chapters.sort(
      (a, b) => Number(a.chapter_number) - Number(b.chapter_number)
    );
    state.chapterMap = map;

    if (snap.story) {
      state.selectedStory = {
        ...(state.stories.get(Number(state.selectedStoryId)) || {}),
        ...snap.story,
        chapters_count: state.chapters.length,
      };
      state.stories.set(Number(state.selectedStoryId), state.selectedStory);
    }

    renderStories();
    renderSelectedStory();
    renderChapters();
    renderBulkPreview();

    return {
      ok: failed.length === 0,
      failed,
    };
  }

  async function smartSyncTxt() {
    if (!state.selectedStoryId) throw new Error('Chưa chọn truyện.');
    if (!state.bulk.parsed.length) throw new Error('Chưa parse TXT.');

    // Snapshot ngay trước khi lập plan để tránh dùng mapping cũ.
    await loadChapters();

    const mode =
      $('#ytlcc-sync-mode')?.value ||
      'upsert';

    const plan = buildSmartSyncPlan(mode);

    const totalActions = plan.updates.length + plan.creates.length;

    if (!totalActions) {
      const msg =
        `Không có gì cần ghi. ` +
        `${plan.unchanged.length} chương đã khớp` +
        (plan.skippedExisting.length
          ? `, bỏ qua ${plan.skippedExisting.length} chương đã có`
          : '') +
        (plan.skippedMissing.length
          ? `, bỏ qua ${plan.skippedMissing.length} chương chưa có`
          : '') +
        '.';

      setStatus(msg, 'success');
      toast(msg, 'success', 4500);
      return;
    }

    const modeLabel = {
      upsert: 'Có thì cập nhật, thiếu thì đăng',
      missing_only: 'Chỉ đăng chương còn thiếu',
      existing_only: 'Chỉ cập nhật chương đã có',
    }[mode] || mode;

    const confirmText =
      `${modeLabel}\n\n` +
      `Cập nhật: ${plan.updates.length}\n` +
      `Đăng mới: ${plan.creates.length}\n` +
      `Đã khớp, không ghi: ${plan.unchanged.length}\n` +
      `Bỏ qua: ${plan.skippedExisting.length + plan.skippedMissing.length}\n\n` +
      `Truyện: ${state.selectedStory?.title || `#${state.selectedStoryId}`}\n\n` +
      `Tiếp tục?`;

    if (!confirm(confirmText)) return;

    state.running = true;
    state.cancelled = false;
    renderRunState();

    try {
      let updateDone = 0;
      let createDone = 0;

      // 1) Update chapter đã có bằng rolling pool.
      if (plan.updates.length) {
        setStatus(`Đang cập nhật 0/${plan.updates.length} chương...`);

        const results = await runPool(
          plan.updates,
          CFG.writeConcurrency,
          async target => {
            if (state.cancelled) throw new Error('Đã hủy.');

            await updateChapter(
              target.ch,
              target.overrides,
              `SYNC UPDATE Chương ${target.no}`
            );

            updateDone++;
            setStatus(
              `Đang cập nhật ${updateDone}/${plan.updates.length} chương...`
            );

            const changed = [];
            if ('content' in target.overrides) changed.push('nội dung');
            if ('title' in target.overrides) changed.push('tên');
            if ('password' in target.overrides) changed.push('pass H');

            addLog(
              `SYNC UPDATE OK Chương ${target.no}: ${changed.join(' + ')}.`
            );

            const delay = clamp(
              Number($('#ytlcc-bulk-delay')?.value || CFG.writeGapMs),
              180,
              5000
            );
            await sleep(delay);

            return target.no;
          }
        );

        const failedUpdates = plan.updates.filter((_, i) => !results[i]?.ok);
        if (failedUpdates.length) {
          for (const target of failedUpdates) {
            const idx = plan.updates.indexOf(target);
            addLog(
              `SYNC UPDATE FAIL Chương ${target.no}: ` +
              `${results[idx]?.error?.message || 'unknown'}`,
              'error'
            );
          }

          throw new Error(
            `${failedUpdates.length}/${plan.updates.length} chương cập nhật thất bại. Dừng trước bước đăng mới.`
          );
        }
      }

      // 2) Missing chapter: create tuần tự.
      // CREATE ưu tiên an toàn hơn tốc độ để tránh race chapter_number.
      if (plan.creates.length) {
        for (const target of plan.creates) {
          if (state.cancelled) throw new Error('Đã hủy.');

          setStatus(
            `Đang đăng chương mới ${createDone + 1}/${plan.creates.length}: Chương ${target.no}...`
          );

          await createChapter(target.item);

          createDone++;
          addLog(
            `SYNC CREATE OK Chương ${target.no} (${createDone}/${plan.creates.length}).`
          );

          const delay = clamp(
            Number($('#ytlcc-bulk-delay')?.value || CFG.writeGapMs),
            180,
            5000
          );
          await sleep(delay);
        }
      }

      // 3) Verify toàn bộ phần đã tác động bằng snapshot mới.
      setStatus('Đã ghi xong. Đang verify toàn bộ...');
      await sleep(450);

      const verify = await verifySmartSync(plan);

      if (!verify.ok) {
        const detail = verify.failed
          .map(x => `${x.no} (${x.type})`)
          .join(', ');

        throw new Error(`VERIFY thất bại: ${detail}`);
      }

      const msg =
        `SYNC PASS. Cập nhật ${plan.updates.length}, ` +
        `đăng mới ${plan.creates.length}, ` +
        `giữ nguyên ${plan.unchanged.length}.`;

      setStatus(msg, 'success');
      toast(msg, 'success', 6000);
      addLog(msg, 'success');
    } finally {
      state.running = false;
      renderRunState();
    }
  }

  // ============================================================
  // BULK CREATE
  // ============================================================

  async function preflightNativeBulk() {
    const storyId = Number(state.selectedStoryId);
    if (!storyId) throw new Error('Chưa chọn truyện.');

    const { html, doc, finalUrl } = await getDoc(
      route(`/profile/stories/${storyId}/import-word`),
      `GET preflight import-word #${storyId}`
    );

    if (!finalUrl.startsWith(ORIGIN)) {
      throw new Error('Trang Import Word redirect ngoài domain.');
    }

    if (!csrfFrom(doc)) {
      throw new Error('Trang Import Word không có CSRF token.');
    }

    if (!html.includes('import-word-commit')) {
      throw new Error(
        'Native Import Word đã đổi: không còn thấy route import-word-commit.'
      );
    }

    return {
      endpoint: route(`/profile/stories/${storyId}/import-word-commit`),
    };
  }

  async function bulkCreate() {
    const items = state.bulk.parsed;
    if (!items.length) throw new Error('Chưa parse batch.');

    await loadChapters();

    if (!ensureContiguous(items)) {
      throw new Error('Bulk create yêu cầu số chương liên tục.');
    }

    const maxExisting = state.chapters.length
      ? Math.max(...state.chapters.map(x => Number(x.chapter_number) || 0))
      : 0;

    const expectedFirst = maxExisting + 1;
    if (Number(items[0].chapterNo) !== expectedFirst) {
      throw new Error(
        `Bulk create native chỉ append. Chương đầu batch phải là ${expectedFirst}, nhưng hiện là ${items[0].chapterNo}.`
      );
    }

    if (
      !confirm(
        `BULK CREATE ${items.length} chương cho "${state.selectedStory?.title || state.selectedStoryId}"?\n\n` +
        `Server hiện có đến Chương ${maxExisting}.\n` +
        `Batch sẽ append Chương ${items[0].chapterNo} → ${items.at(-1).chapterNo}.\n\n` +
        `Tiếp tục?`
      )
    ) return;

    const { endpoint } = await preflightNativeBulk();

    state.running = true;
    state.cancelled = false;
    renderRunState();

    try {
      const chunks = [];
      for (let i = 0; i < items.length; i += CFG.createChunkSize) {
        chunks.push(items.slice(i, i + CFG.createChunkSize));
      }

      let done = 0;

      for (const chunk of chunks) {
        if (state.cancelled) throw new Error('Đã hủy.');

        const payload = {
          chapters: chunk.map(item => ({
            name: item.title,
            content: item.contentHtml,
            password: null,
            stars_active: Math.max(0, Number($('#ytlcc-bulk-price')?.value || 0)),
          })),
          publish_type: 'now',
          published_at: '',
          schedule_interval_hours: 1,
        };

        setStatus(`Bulk create ${done + 1} → ${done + chunk.length}/${items.length}...`);

        await postJson(
          endpoint,
          payload,
          `BULK CREATE ${chunk[0].chapterNo}-${chunk.at(-1).chapterNo}`
        );

        done += chunk.length;
        addLog(`Bulk create ACK: ${done}/${items.length}.`);

        // Reconcile sau mỗi chunk, chống partial success.
        await sleep(600);
        const snap = await fetchChapterSnapshot();

        const map = new Map(
          snap.chapters.map(ch => [Number(ch.chapter_number), ch])
        );

        for (const expected of items.slice(0, done)) {
          const actual = map.get(Number(expected.chapterNo));
          if (!actual) {
            throw new Error(
              `Reconcile thất bại: chưa thấy Chương ${expected.chapterNo} sau commit.`
            );
          }
        }

        state.chapters = snap.chapters.sort(
          (a, b) => a.chapter_number - b.chapter_number
        );
        state.chapterMap = map;
        renderChapters();
        renderBulkPreview();
      }

      toast(`Bulk create hoàn tất ${items.length} chương.`, 'success', 5000);
      setStatus(`Bulk create hoàn tất ${items.length} chương.`, 'success');
    } finally {
      state.running = false;
      renderRunState();
    }
  }

  // ============================================================
  // BULK UPDATE
  // ============================================================

  async function runPool(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;

    async function runner(workerId) {
      while (true) {
        if (state.cancelled) return;
        const i = cursor++;
        if (i >= items.length) return;

        try {
          results[i] = {
            ok: true,
            value: await worker(items[i], i, workerId),
          };
        } catch (err) {
          results[i] = {
            ok: false,
            error: err,
          };
        }
      }
    }

    const n = Math.min(
      Math.max(1, Number(concurrency || 1)),
      items.length || 1
    );

    await Promise.all(Array.from({ length: n }, (_, i) => runner(i)));
    return results;
  }

  function buildBulkUpdatePlan(mode) {
    const parsed = state.bulk.parsed;
    const targets = [];

    if (mode === 'price' || mode === 'password') {
      // Nếu có parsed, dùng range parsed. Nếu không, áp dụng toàn bộ chapter đang load.
      const source = parsed.length
        ? parsed.map(x => Number(x.chapterNo))
        : state.chapters.map(x => Number(x.chapter_number));

      for (const no of source) {
        const ch = state.chapterMap.get(no);
        if (!ch) {
          throw new Error(`Không map được Chương ${no} trên server.`);
        }

        const overrides = {};
        if (mode === 'price') {
          overrides.stars_active = Math.max(
            0,
            Number($('#ytlcc-bulk-price')?.value || 0)
          );
        } else {
          overrides.password = getHPassword();
        }

        targets.push({ no, ch, overrides });
      }

      return targets;
    }

    if (!parsed.length) {
      throw new Error('Update nội dung/title cần parse batch trước.');
    }

    for (const item of parsed) {
      const ch = state.chapterMap.get(Number(item.chapterNo));
      if (!ch) {
        throw new Error(`Không tìm thấy Chương ${item.chapterNo} trên server.`);
      }

      const overrides = {};
      if (mode === 'content') overrides.content = item.contentHtml;
      if (mode === 'title') overrides.title = item.title;
      if (mode === 'content_title') {
        overrides.content = item.contentHtml;
        overrides.title = item.title;
      }

      targets.push({
        no: Number(item.chapterNo),
        ch,
        item,
        overrides,
      });
    }

    return targets;
  }

  function matchesExpected(ch, overrides) {
    if (!ch) return false;

    if ('title' in overrides && String(ch.title || '') !== String(overrides.title || '')) {
      return false;
    }

    if (
      'stars_active' in overrides &&
      Number(ch.stars_active || 0) !== Number(overrides.stars_active || 0)
    ) {
      return false;
    }

    if (
      'password' in overrides &&
      String(ch.password || '') !== String(overrides.password || '')
    ) {
      return false;
    }

    if ('content' in overrides) {
      const a = normalizeHtml(ch.content || '');
      const b = normalizeHtml(overrides.content || '');
      if (a !== b) return false;
    }

    return true;
  }

  function normalizeHtml(html) {
    const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
    return (doc.body.firstElementChild?.innerHTML || '')
      .replace(/\s+/g, ' ')
      .replace(/>\s+</g, '><')
      .trim();
  }

  async function verifyTargets(targets) {
    let last = null;

    for (let attempt = 1; attempt <= CFG.verifyAttempts; attempt++) {
      if (state.cancelled) throw new Error('Đã hủy.');

      const snap = await fetchChapterSnapshot();
      const map = new Map(
        snap.chapters.map(ch => [Number(ch.chapter_number), ch])
      );

      const failed = targets.filter(t => {
        const actual = map.get(Number(t.no));
        return !matchesExpected(actual, t.overrides);
      });

      if (!failed.length) {
        state.chapters = snap.chapters.sort(
          (a, b) => a.chapter_number - b.chapter_number
        );
        state.chapterMap = map;
        renderChapters();
        renderBulkPreview();
        return { ok: true, failed: [] };
      }

      last = failed;

      if (attempt < CFG.verifyAttempts) {
        addLog(
          `VERIFY ${attempt}/${CFG.verifyAttempts}: còn ${failed.length} chương chưa khớp, retry...`,
          'warn'
        );
        await sleep(CFG.verifyDelayMs * attempt);
      }
    }

    return { ok: false, failed: last || targets };
  }

  async function bulkUpdate(mode) {
    await loadChapters();
    const targets = buildBulkUpdatePlan(mode);

    if (!targets.length) throw new Error('Không có chương cần update.');

    const modeLabel = {
      content: 'nội dung',
      title: 'tiêu đề',
      content_title: 'nội dung + tiêu đề',
      price: 'giá Kim Cương',
      password: 'mật khẩu',
    }[mode] || mode;

    if (
      !confirm(
        `BULK UPDATE ${modeLabel} cho ${targets.length} chương?\n\n` +
        `Rolling write concurrency = ${CFG.writeConcurrency}.\n` +
        `Sau ghi sẽ GET toàn danh sách để verify.`
      )
    ) return;

    state.running = true;
    state.cancelled = false;
    renderRunState();

    try {
      let completed = 0;
      setStatus(`Đang update ${targets.length} chương...`);

      const results = await runPool(
        targets,
        CFG.writeConcurrency,
        async target => {
          if (state.cancelled) throw new Error('Đã hủy.');

          await updateChapter(
            target.ch,
            target.overrides,
            `UPDATE Chương ${target.no}`
          );

          completed++;
          setStatus(`Đã ghi ${completed}/${targets.length} chương...`);
          addLog(`WRITE OK Chương ${target.no} (${completed}/${targets.length}).`);

          const delay = clamp(
            Number($('#ytlcc-bulk-delay')?.value || CFG.writeGapMs),
            180,
            5000
          );
          await sleep(delay);

          return target.no;
        }
      );

      const failedWrites = targets.filter((_, i) => !results[i]?.ok);

      if (failedWrites.length) {
        for (const t of failedWrites) {
          const idx = targets.indexOf(t);
          addLog(
            `WRITE FAIL Chương ${t.no}: ${results[idx]?.error?.message || 'unknown'}`,
            'error'
          );
        }

        throw new Error(
          `${failedWrites.length}/${targets.length} chương ghi thất bại. Dừng trước VERIFY toàn batch.`
        );
      }

      setStatus('Đã ghi xong. Đang verify...');
      await sleep(500);

      const verify = await verifyTargets(targets);
      if (!verify.ok) {
        const nums = verify.failed.map(x => x.no).join(', ');
        throw new Error(`VERIFY thất bại ở chương: ${nums}`);
      }

      toast(`Bulk update ${modeLabel} PASS ${targets.length}/${targets.length}.`, 'success', 5200);
      setStatus(`PASS ${targets.length}/${targets.length}.`, 'success');
    } finally {
      state.running = false;
      renderRunState();
    }
  }

  // ============================================================
  // STATS - ALL STORIES
  // ============================================================

  function emptyStatsSummary() {
    return {
      total_diamonds: 0,
      total_combos: 0,
      total_chapters: 0,
      total_sales: 0,
      month_diamonds: 0,
      month_combos: 0,
      month_chapters: 0,
      month_sales: 0,
    };
  }

  function addStatsSummary(target, source = {}) {
    for (const key of Object.keys(target)) {
      target[key] += Number(source?.[key] || 0);
    }
    return target;
  }

  async function loadStats() {
    // Doanh thu là toàn bộ thư viện truyện, không phụ thuộc selectedStoryId.
    if (!state.stories.size) {
      await loadStories();
    }

    const stories = [...state.stories.values()]
      .sort((a, b) => Number(a.id) - Number(b.id));

    if (!stories.length) {
      state.stats = {
        aggregate: emptyStatsSummary(),
        items: [],
        loadedAt: new Date().toISOString(),
      };
      renderStats();
      setStatus('Không có truyện để tải doanh thu.', 'warn');
      return;
    }

    setStatus(`Đang tải doanh thu 0/${stories.length} truyện...`);

    let completed = 0;

    // GET-only: có thể đọc song song nhẹ để tránh chậm khi có nhiều truyện.
    const results = await runPool(
      stories,
      3,
      async story => {
        const data = await getJson(
          route(`/profile/stories/${story.id}/stats`),
          `GET stats #${story.id}`
        );

        completed++;
        setStatus(`Đang tải doanh thu ${completed}/${stories.length} truyện...`);

        return {
          storyId: Number(story.id),
          title: story.title || `Truyện #${story.id}`,
          status: story.status || '',
          summary: {
            ...emptyStatsSummary(),
            ...(data?.summary || {}),
          },
          type: data?.type || '',
          unit: data?.unit || '',
          chartTitle: data?.title || '',
          labels: Array.isArray(data?.labels) ? data.labels : [],
          data: Array.isArray(data?.data) ? data.data : [],
        };
      }
    );

    const items = [];
    const aggregate = emptyStatsSummary();

    for (let i = 0; i < stories.length; i++) {
      const story = stories[i];
      const result = results[i];

      if (result?.ok && result.value) {
        items.push(result.value);
        addStatsSummary(aggregate, result.value.summary);
      } else {
        items.push({
          storyId: Number(story.id),
          title: story.title || `Truyện #${story.id}`,
          status: story.status || '',
          summary: emptyStatsSummary(),
          error: result?.error?.message || 'Không tải được thống kê.',
        });

        addLog(
          `Stats FAIL #${story.id} ${story.title || ''}: ${result?.error?.message || 'unknown'}`,
          'warn'
        );
      }
    }

    state.stats = {
      aggregate,
      items,
      loadedAt: new Date().toISOString(),
    };

    renderStats();

    const failed = items.filter(x => x.error).length;
    if (failed) {
      setStatus(
        `Đã tải doanh thu ${items.length - failed}/${items.length} truyện; ${failed} lỗi.`,
        'warn'
      );
      toast(
        `Doanh thu: ${failed} truyện không tải được stats. Xem danh sách để biết chi tiết.`,
        'warn',
        5000
      );
    } else {
      setStatus(`Đã tải doanh thu toàn bộ ${items.length} truyện.`, 'success');
      addLog(`Stats toàn bộ: ${items.length}/${items.length} truyện.`);
    }
  }

  function renderStats() {
    const host = $('#ytlcc-stats');
    if (!host) return;

    if (!state.stats) {
      host.innerHTML = '<div class="ytlcc-empty">Chưa tải thống kê.</div>';
      return;
    }

    const a = state.stats.aggregate || emptyStatsSummary();
    const items = state.stats.items || [];

    host.innerHTML = `
      <div class="ytlcc-card">
        <h3>Tổng doanh thu tất cả truyện</h3>
        <div class="ytlcc-stat-grid">
          <div class="ytlcc-stat">
            <span>Tổng Kim Cương</span>
            <strong>${Number(a.total_diamonds || 0).toLocaleString('vi-VN')}</strong>
          </div>
          <div class="ytlcc-stat">
            <span>Kim Cương tháng này</span>
            <strong>${Number(a.month_diamonds || 0).toLocaleString('vi-VN')}</strong>
          </div>
          <div class="ytlcc-stat">
            <span>Tổng lượt bán</span>
            <strong>${Number(a.total_sales || 0).toLocaleString('vi-VN')}</strong>
          </div>
          <div class="ytlcc-stat">
            <span>Lượt bán tháng này</span>
            <strong>${Number(a.month_sales || 0).toLocaleString('vi-VN')}</strong>
          </div>
          <div class="ytlcc-stat">
            <span>Tổng combo</span>
            <strong>${Number(a.total_combos || 0).toLocaleString('vi-VN')}</strong>
          </div>
          <div class="ytlcc-stat">
            <span>Tổng chương lẻ đã bán</span>
            <strong>${Number(a.total_chapters || 0).toLocaleString('vi-VN')}</strong>
          </div>
        </div>
      </div>

      <div class="ytlcc-card ytlcc-mt">
        <div class="ytlcc-toolbar" style="margin-bottom:8px">
          <h3 style="margin:0;flex:1">Chi tiết từng truyện</h3>
          <span class="ytlcc-muted">${items.length} truyện</span>
        </div>

        <div class="ytlcc-table-wrap">
          <table class="ytlcc-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Truyện</th>
                <th>Tổng KC</th>
                <th>KC tháng</th>
                <th>Tổng lượt bán</th>
                <th>Bán tháng</th>
                <th>Combo</th>
                <th>Chương lẻ</th>
              </tr>
            </thead>
            <tbody>
              ${
                items.length
                  ? items.map(item => {
                      const s = item.summary || emptyStatsSummary();
                      return `
                        <tr>
                          <td>${esc(item.storyId)}</td>
                          <td class="ytlcc-title-cell" title="${esc(item.title)}">
                            ${esc(item.title)}
                            ${item.error ? `<div class="ytlcc-muted" style="color:var(--yt-danger)">${esc(item.error)}</div>` : ''}
                          </td>
                          <td>${Number(s.total_diamonds || 0).toLocaleString('vi-VN')}</td>
                          <td>${Number(s.month_diamonds || 0).toLocaleString('vi-VN')}</td>
                          <td>${Number(s.total_sales || 0).toLocaleString('vi-VN')}</td>
                          <td>${Number(s.month_sales || 0).toLocaleString('vi-VN')}</td>
                          <td>${Number(s.total_combos || 0).toLocaleString('vi-VN')}</td>
                          <td>${Number(s.total_chapters || 0).toLocaleString('vi-VN')}</td>
                        </tr>
                      `;
                    }).join('')
                  : '<tr><td colspan="8" class="ytlcc-empty">Không có dữ liệu.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ============================================================
  // UI
  // ============================================================

  function tab(name) {
    state.activeTab = name;
    savePrefs();

    for (const btn of $$('.ytlcc-tab-btn')) {
      btn.classList.toggle('active', btn.dataset.tab === name);
    }

    for (const pane of $$('.ytlcc-tab-pane')) {
      pane.classList.toggle('active', pane.dataset.pane === name);
    }

    if (name === 'chapters' && state.selectedStoryId && !state.chapters.length) {
      loadChapters().catch(err => toast(err.message, 'error', 5000));
    }

    if (name === 'stats' && state.selectedStoryId && !state.stats) {
      loadStats().catch(err => toast(err.message, 'error', 5000));
    }
  }

  function renderRunState() {
    for (const el of $$('[data-run-action]')) {
      el.disabled = !!state.running;
    }

    const cancel = $('#ytlcc-cancel-run');
    if (cancel) cancel.disabled = !state.running;
  }

  function openPanel() {
    state.opened = true;
    $('#ytlcc-overlay')?.classList.add('show');
  }

  function closePanel() {
    if (state.running) {
      toast('Đang chạy tác vụ. Hãy Hủy trước khi đóng.', 'warn');
      return;
    }

    state.opened = false;
    $('#ytlcc-overlay')?.classList.remove('show');
  }

  function bindUi() {
    $('#ytlcc-launch')?.addEventListener('click', openPanel);
    $('#ytlcc-close')?.addEventListener('click', closePanel);
    $('#ytlcc-theme-toggle')?.addEventListener('click', toggleTheme);

    for (const btn of $$('.ytlcc-tab-btn')) {
      btn.addEventListener('click', () => tab(btn.dataset.tab));
    }

    $('#ytlcc-refresh-stories')?.addEventListener('click', () => {
      loadStories().catch(err => toast(err.message, 'error', 6000));
    });

    $('#ytlcc-refresh-chapters')?.addEventListener('click', () => {
      loadChapters().catch(err => toast(err.message, 'error', 6000));
    });

    $('#ytlcc-download-txt')?.addEventListener('click', () => {
      downloadStoryTxt().catch(err => {
        toast(`Không tải được TXT: ${err.message}`, 'error', 6000);
        setStatus(err.message, 'error');
      });
    });

    $('#ytlcc-open-pass-bulk')?.addEventListener('click', openBulkPassModal);
    $('#ytlcc-pass-close')?.addEventListener('click', closeBulkPassModal);
    $('#ytlcc-pass-cancel')?.addEventListener('click', closeBulkPassModal);

    $('#ytlcc-pass-apply')?.addEventListener('click', () => {
      bulkSetExistingPassword({ clear: false }).catch(err => {
        toast(err.message, 'error', 7000);
        setStatus(err.message, 'error');
      });
    });

    $('#ytlcc-pass-clear')?.addEventListener('click', () => {
      bulkSetExistingPassword({ clear: true }).catch(err => {
        toast(err.message, 'error', 7000);
        setStatus(err.message, 'error');
      });
    });

    const bulkPassInput = $('#ytlcc-pass-value');
    if (bulkPassInput) {
      bulkPassInput.addEventListener('input', () => {
        state.bulk.hPassword = String(bulkPassInput.value || '');
        const mainPass = $('#ytlcc-h-password');
        if (mainPass) mainPass.value = state.bulk.hPassword;
        savePrefs();
      });
    }

    $('#ytlcc-load-stats')?.addEventListener('click', () => {
      loadStats().catch(err => toast(err.message, 'error', 6000));
    });

    const hPasswordInput = $('#ytlcc-h-password');
    if (hPasswordInput) {
      const persistHPassword = () => {
        state.bulk.hPassword = String(hPasswordInput.value || '');
        savePrefs();

        const saved = $('#ytlcc-h-pass-saved');
        if (saved) {
          saved.textContent = 'Đã lưu';
          clearTimeout(saved._ytlTimer);
          saved._ytlTimer = setTimeout(() => {
            saved.textContent = '';
          }, 1200);
        }
      };

      hPasswordInput.addEventListener('input', persistHPassword);
      hPasswordInput.addEventListener('change', persistHPassword);
    }

    $('#ytlcc-load-txt')?.addEventListener('click', () => {
      const input = $('#ytlcc-txt-file');
      if (!input) return;
      input.value = '';
      input.click();
    });

    $('#ytlcc-txt-file')?.addEventListener('change', event => {
      const files = [...(event.target?.files || [])];
      if (!files.length) return;

      loadTxtFiles(files).catch(err => {
        state.bulk.parsed = [];
        renderBulkPreview();
        toast(`Không nạp được TXT: ${err.message}`, 'error', 8000);
        setStatus(err.message, 'error');
      });
    });

    const bulkInput = $('#ytlcc-bulk-input');
    if (bulkInput) {
      bulkInput.addEventListener('dragover', event => {
        if (!event.dataTransfer?.types?.includes('Files')) return;
        event.preventDefault();
        bulkInput.classList.add('ytlcc-drop-active');
      });

      bulkInput.addEventListener('dragleave', () => {
        bulkInput.classList.remove('ytlcc-drop-active');
      });

      bulkInput.addEventListener('drop', event => {
        const files = [...(event.dataTransfer?.files || [])];
        if (!files.length) return;
        event.preventDefault();
        bulkInput.classList.remove('ytlcc-drop-active');

        loadTxtFiles(files).catch(err => {
          state.bulk.parsed = [];
          renderBulkPreview();
          toast(`Không nạp được TXT: ${err.message}`, 'error', 8000);
          setStatus(err.message, 'error');
        });
      });
    }

    $('#ytlcc-bulk-parse')?.addEventListener('click', parseBulkFromUi);

    $('#ytlcc-smart-sync')?.addEventListener('click', () => {
      smartSyncTxt().catch(err => {
        toast(err.message, 'error', 7000);
        setStatus(err.message, 'error');
      });
    });

    const updateActions = {
      'ytlcc-update-price': 'price',
    };

    for (const [id, mode] of Object.entries(updateActions)) {
      $(`#${id}`)?.addEventListener('click', () => {
        bulkUpdate(mode).catch(err => {
          toast(err.message, 'error', 7000);
          setStatus(err.message, 'error');
        });
      });
    }

    $('#ytlcc-cancel-run')?.addEventListener('click', () => {
      if (!state.running) return;
      state.cancelled = true;
      setStatus('Đang hủy...', 'warn');
      addLog('Người dùng yêu cầu hủy.', 'warn');
    });

    $('#ytlcc-clear-log')?.addEventListener('click', () => {
      state.log = [];
      const host = $('#ytlcc-log');
      if (host) host.innerHTML = '';
    });

    $('#ytlcc-editor-close')?.addEventListener('click', () => {
      $('#ytlcc-editor-modal')?.classList.remove('show');
    });

    $('#ytlcc-editor-save')?.addEventListener('click', () => {
      saveSingleEditor().catch(err => toast(err.message, 'error', 6000));
    });
  }

  function injectCss() {
    if ($('#ytlcc-style')) return;

    const style = document.createElement('style');
    style.id = 'ytlcc-style';
    style.textContent = `
      #ytlcc-shell,
      #ytlcc-editor-modal .ytlcc-editor-box,
      #ytlcc-pass-modal .ytlcc-pass-box{
        --bg:#f3f5f8;
        --panel:#ffffff;
        --panel2:#f7f8fa;
        --panel3:#edf0f4;
        --text:#29313d;
        --soft:#566273;
        --muted:#8691a1;
        --line:#d8dee7;
        --line2:#e7ebf0;
        --input:#ffffff;
        --hover:#f0eef8;
        --active:#e8e3f4;
        --accent:#7768a8;
        --accent2:#675894;
        --accentText:#faf8ff;
        --green:#477a61;
        --green2:#3f6d57;
        --danger:#a55f66;
        --yt-danger:#a55f66;
        --shadow:rgba(24,34,48,.18);
        --code:#202630;
        --codeText:#d6dde6;

        --h-top:48px;
        --h-tabs:42px;
        --h-control:36px;
        --radius:8px;
      }

      html[data-ytlcc-theme="dark"] #ytlcc-shell,
      html[data-ytlcc-theme="dark"] #ytlcc-editor-modal .ytlcc-editor-box,
      html[data-ytlcc-theme="dark"] #ytlcc-pass-modal .ytlcc-pass-box{
        --bg:#11161d;
        --panel:#181e26;
        --panel2:#1d242d;
        --panel3:#242d38;
        --text:#d7dde5;
        --soft:#b5bfca;
        --muted:#7f8b9a;
        --line:#2e3744;
        --line2:#252e39;
        --input:#141a21;
        --hover:#212936;
        --active:#302c45;
        --accent:#8c7db8;
        --accent2:#7768a3;
        --accentText:#f1edf9;
        --green:#4c7f66;
        --green2:#406c57;
        --danger:#b16b71;
        --yt-danger:#b16b71;
        --shadow:rgba(0,0,0,.42);
        --code:#0f141a;
        --codeText:#cbd3dd;
      }

      #ytlcc-launch{
        position:fixed;right:18px;bottom:18px;z-index:2147483600;
        height:38px;padding:0 14px;border:1px solid rgba(255,255,255,.10);
        border-radius:9px;background:#7465a4;color:#f2eefb;
        box-shadow:0 10px 28px rgba(0,0,0,.28);
        font:800 12px/1 system-ui,sans-serif;cursor:pointer
      }

      #ytlcc-overlay{
        display:none;position:fixed;inset:0;z-index:2147483601;
        padding:10px;background:rgba(7,10,14,.84);backdrop-filter:blur(4px)
      }
      #ytlcc-overlay.show{display:block}

      #ytlcc-shell{
        width:min(1580px,100%);height:calc(100vh - 20px);margin:0 auto;
        display:grid;grid-template-rows:var(--h-top) minmax(0,1fr);
        overflow:hidden;background:var(--bg);color:var(--text);
        border:1px solid var(--line);border-radius:12px;
        box-shadow:0 24px 72px var(--shadow);
        font:13px/1.4 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
        color-scheme:light
      }
      html[data-ytlcc-theme="dark"] #ytlcc-shell,
      html[data-ytlcc-theme="dark"] #ytlcc-editor-modal .ytlcc-editor-box,
      html[data-ytlcc-theme="dark"] #ytlcc-pass-modal .ytlcc-pass-box{color-scheme:dark}

      /* HEADER: một hàng cố định, không co giãn chiều cao */
      .ytlcc-top{
        height:var(--h-top);display:grid;
        grid-template-columns:128px minmax(220px,1fr) minmax(180px,320px) 62px 64px 36px;
        align-items:center;gap:8px;padding:0 9px 0 12px;
        box-sizing:border-box;background:var(--panel);border-bottom:1px solid var(--line)
      }
      .ytlcc-brand{
        min-width:0;color:var(--accent);font-weight:900;font-size:12px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis
      }
      .ytlcc-selected{
        min-width:0;height:30px;display:flex;flex-direction:column;justify-content:center;
        padding-left:10px;border-left:1px solid var(--line)
      }
      #ytlcc-selected-title{
        min-width:0;font-weight:800;font-size:12.5px;line-height:15px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis
      }
      #ytlcc-selected-sub{
        min-width:0;height:13px;margin:0;color:var(--muted);font-size:10.5px;line-height:13px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis
      }
      #ytlcc-status{
        height:30px;min-width:0;display:flex;align-items:center;
        padding:0 9px;box-sizing:border-box;border:1px solid var(--line);border-radius:7px;
        background:var(--panel2);color:var(--soft);font-size:11px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis
      }
      #ytlcc-status[data-level="success"]{color:#7db495}
      #ytlcc-status[data-level="warn"]{color:#d0a36d}
      #ytlcc-status[data-level="error"]{color:#d68c92}

      /* BODY: sidebar và main cùng baseline */
      .ytlcc-body{
        min-height:0;display:grid;grid-template-columns:230px minmax(0,1fr)
      }
      .ytlcc-side{
        min-width:0;min-height:0;display:grid;grid-template-rows:var(--h-tabs) minmax(0,1fr);
        background:var(--panel);border-right:1px solid var(--line)
      }
      .ytlcc-side-head{
        height:var(--h-tabs);display:flex;align-items:center;justify-content:space-between;
        gap:8px;padding:0 8px 0 10px;box-sizing:border-box;border-bottom:1px solid var(--line)
      }
      .ytlcc-side-title{
        color:var(--muted);font-size:10px;font-weight:850;letter-spacing:.07em;text-transform:uppercase
      }
      .ytlcc-story-list{
        min-height:0;overflow:auto;padding:6px
      }
      .ytlcc-story-row{
        width:100%;height:50px;margin:0 0 4px;padding:0 9px;
        display:flex;align-items:center;box-sizing:border-box;
        border:1px solid transparent;border-radius:7px;
        background:transparent;color:var(--text);text-align:left;cursor:pointer
      }
      .ytlcc-story-row:hover{background:var(--hover)}
      .ytlcc-story-row.active{background:var(--active);border-color:var(--accent2)}
      .ytlcc-story-main{min-width:0;width:100%;display:grid;grid-template-rows:17px 14px;align-content:center}
      .ytlcc-story-main strong{
        min-width:0;font-size:12px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis
      }
      .ytlcc-story-main span{
        min-width:0;color:var(--muted);font-size:10px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis
      }

      .ytlcc-main{
        min-width:0;min-height:0;display:grid;grid-template-rows:var(--h-tabs) minmax(0,1fr)
      }
      .ytlcc-tabs{
        height:var(--h-tabs);display:flex;align-items:center;gap:4px;
        padding:0 9px;box-sizing:border-box;background:var(--panel);border-bottom:1px solid var(--line);
        overflow-x:auto;overflow-y:hidden
      }
      .ytlcc-tab-btn{
        height:32px;display:inline-flex;align-items:center;justify-content:center;gap:6px;
        padding:0 11px;box-sizing:border-box;border:1px solid transparent;border-radius:7px;
        background:transparent;color:var(--muted);
        font:760 12px/1 system-ui,sans-serif;white-space:nowrap;cursor:pointer
      }
      .ytlcc-tab-btn:hover{background:var(--hover);color:var(--text)}
      .ytlcc-tab-btn.active{
        background:var(--active);border-color:var(--accent2);color:var(--text)
      }
      .ytlcc-count-badge{
        height:18px;min-width:19px;padding:0 5px;display:inline-flex;align-items:center;justify-content:center;
        box-sizing:border-box;border-radius:999px;background:var(--panel3);color:var(--soft);
        font-size:10px;font-weight:850
      }

      .ytlcc-content{
        min-width:0;min-height:0;overflow:auto;padding:10px;box-sizing:border-box;background:var(--bg)
      }
      .ytlcc-tab-pane{display:none}
      .ytlcc-tab-pane.active{display:block}

      /* CONTROLS: mọi nút và input cùng 36px */
      .ytlcc-btn,.ytlcc-mini,.ytlcc-close,.ytlcc-theme-toggle{
        height:var(--h-control);box-sizing:border-box;
        display:inline-flex;align-items:center;justify-content:center;
        padding:0 11px;border:1px solid var(--line);border-radius:var(--radius);
        background:var(--panel2);color:var(--text);
        font:760 12px/1 system-ui,sans-serif;white-space:nowrap;cursor:pointer
      }
      .ytlcc-btn:hover,.ytlcc-mini:hover,.ytlcc-close:hover,.ytlcc-theme-toggle:hover{
        border-color:var(--accent);background:var(--hover)
      }
      .ytlcc-btn.primary{background:var(--accent2);border-color:var(--accent2);color:var(--accentText)}
      .ytlcc-btn.green{background:var(--green2);border-color:var(--green);color:#edf5f0}
      .ytlcc-btn.red{background:#633e43;border-color:#7b4b51;color:#ead7d9}
      .ytlcc-btn:disabled,.ytlcc-mini:disabled{opacity:.35;cursor:not-allowed}
      .ytlcc-mini{height:30px;min-width:50px;padding:0 8px}
      .ytlcc-close{width:36px;padding:0;font-size:15px}
      .ytlcc-theme-toggle{width:62px;padding:0}
      .ytlcc-icon-btn{width:32px;height:30px;padding:0;font-size:15px}

      .ytlcc-toolbar{
        min-height:36px;display:flex;align-items:center;gap:6px;flex-wrap:nowrap;margin:0 0 8px
      }
      .ytlcc-toolbar.compact{margin:0}
      .ytlcc-spacer{flex:1}

      .ytlcc-input,.ytlcc-select,.ytlcc-textarea{
        width:100%;box-sizing:border-box;border:1px solid var(--line);
        border-radius:var(--radius);background:var(--input);color:var(--text);
        font:12px/1.35 Inter,system-ui,sans-serif;caret-color:var(--accent)
      }
      .ytlcc-input,.ytlcc-select{height:var(--h-control);padding:0 9px}
      .ytlcc-textarea{
        padding:10px;resize:vertical;font-family:Consolas,ui-monospace,monospace;line-height:1.5
      }
      .ytlcc-input:focus,.ytlcc-select:focus,.ytlcc-textarea:focus{
        outline:0;border-color:var(--accent);box-shadow:0 0 0 2px rgba(139,123,183,.12)
      }
      .ytlcc-input::placeholder,.ytlcc-textarea::placeholder{color:var(--muted);opacity:.72}
      .ytlcc-textarea.ytlcc-drop-active{border-color:var(--accent);background:var(--active)}

      /* PANELS */
      .ytlcc-card,.ytlcc-panel{
        background:var(--panel);border:1px solid var(--line);border-radius:9px;color:var(--text)
      }
      .ytlcc-card{padding:10px}
      .ytlcc-card.flat{padding:0;overflow:hidden}
      .ytlcc-card h3{margin:0;font-size:12px;font-weight:850;color:var(--soft)}
      .ytlcc-panel{min-width:0;overflow:hidden}
      .ytlcc-panel-head{
        height:42px;display:flex;align-items:center;gap:6px;padding:0 8px 0 10px;
        box-sizing:border-box;border-bottom:1px solid var(--line);background:var(--panel2)
      }
      .ytlcc-panel-title{font-size:11px;font-weight:850;color:var(--soft)}

      /* BULK: tuyệt đối không để helper text thay đổi chiều cao control */
      .ytlcc-bulk-layout{
        min-width:0;display:grid;grid-template-columns:minmax(0,3fr) minmax(420px,2fr);
        gap:10px;align-items:start
      }
      .ytlcc-bulk-left,.ytlcc-bulk-right{min-width:0}
      #ytlcc-bulk-input{
        height:430px;min-height:430px;max-height:430px;
        border:0;border-radius:0;box-shadow:none;resize:none
      }
      .ytlcc-filebar{
        height:34px;display:flex;align-items:center;gap:6px;
        padding:0 8px;box-sizing:border-box;border-top:1px solid var(--line);background:var(--panel2)
      }
      .ytlcc-meta-chip{
        min-width:0;max-width:280px;height:22px;display:inline-flex;align-items:center;
        padding:0 7px;box-sizing:border-box;border:1px solid var(--line);border-radius:999px;
        background:var(--panel);color:var(--muted);font-size:10px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis
      }
      .ytlcc-meta-chip:empty{display:none}

      .ytlcc-syncbar{
        margin-top:8px;padding:8px;display:grid;
        grid-template-columns:minmax(250px,1fr) 82px minmax(150px,190px) 82px 100px 82px;
        gap:7px;align-items:end;
        background:var(--panel);border:1px solid var(--line);border-radius:9px
      }
      .ytlcc-field{
        min-width:0;height:54px;display:grid;grid-template-rows:14px var(--h-control);gap:4px;
        position:relative
      }
      .ytlcc-field>span:first-child{
        height:14px;line-height:14px;color:var(--muted);
        font-size:10px;font-weight:820;letter-spacing:.025em
      }
      .ytlcc-save-dot{
        position:absolute;right:6px;top:18px;height:var(--h-control);
        display:flex;align-items:center;pointer-events:none;
        color:#7fb395;font-size:0
      }
      .ytlcc-save-dot:not(:empty)::after{
        content:'✓';font-size:11px;font-weight:900
      }
      .ytlcc-action-cell{
        height:54px;display:flex;align-items:flex-end
      }
      .ytlcc-action-cell>.ytlcc-btn{width:100%}
      .ytlcc-sync-main{width:100%}

      /* TABLES */
      .ytlcc-table-wrap{
        min-width:0;overflow:auto;background:var(--panel);
        border:1px solid var(--line);border-radius:8px
      }
      .ytlcc-panel>.ytlcc-table-wrap,.ytlcc-card.flat>.ytlcc-table-wrap{
        border:0;border-radius:0
      }
      .ytlcc-bulk-right .ytlcc-table-wrap{height:472px}
      .ytlcc-table{
        width:100%;border-collapse:collapse;table-layout:auto;color:var(--text);font-size:12px
      }
      .ytlcc-table th,.ytlcc-table td{
        height:38px;box-sizing:border-box;padding:0 8px;
        border-bottom:1px solid var(--line2);text-align:left;white-space:nowrap;vertical-align:middle
      }
      .ytlcc-table th{
        position:sticky;top:0;z-index:1;background:var(--panel2);color:var(--muted);
        font-size:10px;font-weight:850;letter-spacing:.025em;text-transform:uppercase
      }
      .ytlcc-table tbody tr:hover{background:var(--hover)}
      .ytlcc-title-cell{max-width:460px;overflow:hidden;text-overflow:ellipsis}
      .ytlcc-empty{padding:24px!important;text-align:center!important;color:var(--muted);font-size:11px}
      .ytlcc-muted{color:var(--muted);font-size:10px}
      .ytlcc-mt{margin-top:8px}
      .ytlcc-h-badge{
        min-width:20px;height:18px;padding:0 5px;display:inline-flex;align-items:center;justify-content:center;
        border-radius:999px;background:#3a2529;color:#d9979c;border:1px solid #654047;
        font-size:10px;font-weight:900
      }

      /* OVERVIEW + STATS */
      .ytlcc-overview{
        display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px
      }
      .ytlcc-kpi,.ytlcc-stat{
        min-width:0;height:72px;box-sizing:border-box;
        display:flex;flex-direction:column;justify-content:center;gap:3px;
        padding:9px 11px;background:var(--panel);border:1px solid var(--line);border-radius:8px
      }
      .ytlcc-kpi span,.ytlcc-stat span{
        color:var(--muted);font-size:10px;line-height:13px
      }
      .ytlcc-kpi strong,.ytlcc-stat strong{
        min-width:0;color:var(--text);font-size:15px;line-height:20px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis
      }
      .ytlcc-stat strong{color:var(--accent)}
      .ytlcc-stat-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:7px}
      .ytlcc-series>div{
        height:32px;display:flex;align-items:center;justify-content:space-between;
        border-bottom:1px solid var(--line2)
      }

      /* LOG */
      #ytlcc-log{
        height:calc(100vh - 160px);min-height:360px;overflow:auto;
        padding:9px;box-sizing:border-box;background:var(--code);color:var(--codeText);
        border:1px solid var(--line);border-radius:8px;
        font:11.5px/1.5 Consolas,ui-monospace,monospace
      }
      .ytlcc-log-line{padding:2px 0;border-bottom:1px solid rgba(150,160,175,.07)}
      .ytlcc-log-line.warn{color:#d5b17a}
      .ytlcc-log-line.error{color:#d4898f}
      .ytlcc-log-line.success{color:#8ebda0}

      /* TOAST */
      #ytlcc-toast-host{
        position:fixed;top:14px;right:14px;z-index:2147483647;
        display:flex;flex-direction:column;gap:6px;max-width:390px
      }
      .ytlcc-toast{
        padding:8px 10px;border:1px solid #3a4452;border-radius:8px;
        background:#252c36;color:#d9dee6;box-shadow:0 10px 30px rgba(0,0,0,.3);
        transition:.18s;font-size:12px
      }
      .ytlcc-toast.success{background:#294437;color:#cfe2d6;border-color:#456957}
      .ytlcc-toast.warn{background:#493923;color:#ead7b8;border-color:#70583a}
      .ytlcc-toast.error{background:#4b2b2e;color:#ead0d2;border-color:#74464a}
      .ytlcc-toast.out{opacity:0;transform:translateX(16px)}

      /* EDITOR */
      #ytlcc-editor-modal{
        display:none;position:fixed;inset:0;z-index:2147483640;padding:16px;
        background:rgba(7,10,14,.84);align-items:center;justify-content:center
      }
      #ytlcc-editor-modal.show{display:flex}
      .ytlcc-editor-box{
        width:min(980px,100%);max-height:92vh;overflow:hidden;
        display:grid;grid-template-rows:46px auto minmax(320px,55vh) 52px;
        padding:0;background:var(--panel);color:var(--text);
        border:1px solid var(--line);border-radius:10px;box-shadow:0 24px 70px var(--shadow)
      }
      .ytlcc-editor-head{
        height:46px;display:flex;align-items:center;gap:8px;padding:0 9px 0 11px;
        box-sizing:border-box;border-bottom:1px solid var(--line)
      }
      .ytlcc-editor-fields{
        display:grid;grid-template-columns:88px minmax(240px,1fr) 90px 160px;
        gap:7px;padding:9px
      }
      #ytlcc-edit-content{
        width:100%;height:100%;min-height:0;border-radius:0;border-left:0;border-right:0;resize:none
      }
      .ytlcc-editor-foot{
        height:52px;display:flex;align-items:center;justify-content:flex-end;gap:7px;padding:0 9px
      }

      /* BULK PASS */
      #ytlcc-pass-modal{
        display:none;position:fixed;inset:0;z-index:2147483642;
        padding:16px;background:rgba(7,10,14,.84);
        align-items:center;justify-content:center
      }
      #ytlcc-pass-modal.show{display:flex}
      .ytlcc-pass-box{
        width:min(470px,100%);overflow:hidden;
        background:var(--panel);color:var(--text);
        border:1px solid var(--line);border-radius:10px;
        box-shadow:0 24px 70px var(--shadow)
      }
      .ytlcc-pass-head{
        height:46px;display:flex;align-items:center;gap:8px;
        padding:0 9px 0 11px;box-sizing:border-box;
        border-bottom:1px solid var(--line)
      }
      .ytlcc-pass-body{
        display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px
      }
      .ytlcc-pass-foot{
        height:54px;display:flex;align-items:center;justify-content:flex-end;
        gap:7px;padding:0 12px;border-top:1px solid var(--line)
      }

      #ytlcc-shell *{scrollbar-width:thin;scrollbar-color:var(--line) transparent}
      #ytlcc-shell *::-webkit-scrollbar{width:9px;height:9px}
      #ytlcc-shell *::-webkit-scrollbar-thumb{
        background:var(--line);border:2px solid transparent;background-clip:padding-box;border-radius:999px
      }

      @media(max-width:1180px){
        .ytlcc-bulk-layout{grid-template-columns:1fr}
        .ytlcc-bulk-right .ytlcc-table-wrap{height:360px}
        .ytlcc-syncbar{
          grid-template-columns:minmax(230px,1fr) 82px minmax(150px,1fr) 82px 100px 82px
        }
        .ytlcc-stat-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
      }

      @media(max-width:900px){
        #ytlcc-overlay{padding:0}
        #ytlcc-shell{height:100vh;border-radius:0}
        .ytlcc-top{
          grid-template-columns:100px minmax(160px,1fr) 62px 36px
        }
        #ytlcc-status,#ytlcc-cancel-run{display:none}
        .ytlcc-body{grid-template-columns:190px minmax(0,1fr)}
        .ytlcc-syncbar{grid-template-columns:1fr 82px 1fr 82px}
        .ytlcc-action-cell{height:36px}
        .ytlcc-overview{grid-template-columns:repeat(2,minmax(0,1fr))}
        .ytlcc-editor-fields{grid-template-columns:1fr 1fr}
      }
    `;
    document.head.appendChild(style);
  }

  function mountUi() {
    injectCss();

    const launch = document.createElement('button');
    launch.id = 'ytlcc-launch';
    launch.type = 'button';
    launch.textContent = 'YTL Control';
    document.body.appendChild(launch);

    const overlay = document.createElement('div');
    overlay.id = 'ytlcc-overlay';
    overlay.innerHTML = `
      <div id="ytlcc-shell">
        <header class="ytlcc-top">
          <div class="ytlcc-brand">YTL ${VERSION}</div>

          <div class="ytlcc-selected">
            <div id="ytlcc-selected-title">Chưa chọn truyện</div>
            <div id="ytlcc-selected-sub"></div>
          </div>

          <div id="ytlcc-status">Khởi động...</div>
          <button id="ytlcc-theme-toggle" class="ytlcc-theme-toggle" type="button" aria-pressed="true">Night</button>
          <button id="ytlcc-cancel-run" class="ytlcc-btn red" type="button" disabled>Hủy</button>
          <button id="ytlcc-close" class="ytlcc-close" type="button" title="Đóng">×</button>
        </header>

        <div class="ytlcc-body">
          <aside class="ytlcc-side">
            <div class="ytlcc-side-head">
              <span class="ytlcc-side-title">Truyện</span>
              <button id="ytlcc-refresh-stories" class="ytlcc-btn ytlcc-icon-btn" type="button" title="Tải lại">↻</button>
            </div>

            <div id="ytlcc-story-list" class="ytlcc-story-list">
              <div class="ytlcc-empty">Đang tải...</div>
            </div>
          </aside>

          <main class="ytlcc-main">
            <nav class="ytlcc-tabs">
              <button class="ytlcc-tab-btn" data-tab="stories" type="button">Tổng quan</button>
              <button class="ytlcc-tab-btn" data-tab="chapters" type="button">
                Chương
                <span id="ytlcc-chapter-count" class="ytlcc-count-badge">0</span>
              </button>
              <button class="ytlcc-tab-btn" data-tab="bulk" type="button">Đồng bộ</button>
              <button class="ytlcc-tab-btn" data-tab="stats" type="button">Doanh thu</button>
              <button class="ytlcc-tab-btn" data-tab="log" type="button">Log</button>
            </nav>

            <div class="ytlcc-content">
              <section class="ytlcc-tab-pane" data-pane="stories">
                <div class="ytlcc-overview">
                  <div class="ytlcc-kpi">
                    <span>Truyện</span>
                    <strong id="ytlcc-overview-story">Đang chọn</strong>
                  </div>
                  <div class="ytlcc-kpi">
                    <span>Chương</span>
                    <strong id="ytlcc-overview-chapters">0</strong>
                  </div>
                  <div class="ytlcc-kpi">
                    <span>Đồng bộ</span>
                    <strong>TXT Smart Sync</strong>
                  </div>
                  <div class="ytlcc-kpi">
                    <span>Phiên bản</span>
                    <strong>${VERSION}</strong>
                  </div>
                </div>
              </section>

              <section class="ytlcc-tab-pane" data-pane="chapters">
                <div class="ytlcc-toolbar">
                  <button id="ytlcc-refresh-chapters" class="ytlcc-btn primary" type="button">Làm mới</button>
                  <button id="ytlcc-download-txt" class="ytlcc-btn" type="button">Tải TXT</button>
                  <button id="ytlcc-open-pass-bulk" data-run-action class="ytlcc-btn" type="button">Pass hàng loạt</button>
                </div>

                <div class="ytlcc-table-wrap">
                  <table class="ytlcc-table">
                    <thead>
                      <tr>
                        <th>Ch.</th><th>Tiêu đề</th><th>Từ</th><th>View</th><th>KC</th><th>Status</th><th></th>
                      </tr>
                    </thead>
                    <tbody id="ytlcc-chapter-body">
                      <tr><td colspan="7" class="ytlcc-empty">Chưa có dữ liệu.</td></tr>
                    </tbody>
                  </table>
                </div>
              </section>

              <section class="ytlcc-tab-pane" data-pane="bulk">
                <div class="ytlcc-bulk-layout">
                  <div class="ytlcc-bulk-left">
                    <div class="ytlcc-panel">
                      <div class="ytlcc-panel-head">
                        <span class="ytlcc-panel-title">TXT</span>
                        <span class="ytlcc-spacer"></span>

                        <input id="ytlcc-txt-file" type="file" accept=".txt,text/plain" multiple hidden>
                        <button id="ytlcc-load-txt" class="ytlcc-btn" type="button">Nạp nhiều TXT</button>
                        <button id="ytlcc-bulk-parse" class="ytlcc-btn" type="button">Phân tích</button>
                      </div>

                      <textarea
                        id="ytlcc-bulk-input"
                        class="ytlcc-textarea"
                        placeholder="Chương 11: Tên chương&#10;&#10;Nội dung...&#10;&#10;Chương 12: Tên chương&#10;&#10;Nội dung..."
                      ></textarea>

                      <div class="ytlcc-filebar">
                        <span id="ytlcc-txt-file-name" class="ytlcc-meta-chip"></span>
                        <span id="ytlcc-bulk-summary" class="ytlcc-meta-chip"></span>
                      </div>
                    </div>

                    <div class="ytlcc-syncbar">
                      <label class="ytlcc-field">
                        <span>Chế độ</span>
                        <select id="ytlcc-sync-mode" class="ytlcc-select">
                          <option value="upsert" selected>Có thì cập nhật, thiếu thì đăng</option>
                          <option value="missing_only">Chỉ đăng chương còn thiếu</option>
                          <option value="existing_only">Chỉ cập nhật chương đã có</option>
                        </select>
                      </label>

                      <label class="ytlcc-field">
                        <span>KC</span>
                        <input id="ytlcc-bulk-price" class="ytlcc-input" type="number" min="0" value="0">
                      </label>

                      <label class="ytlcc-field">
                        <span>Pass H</span>
                        <input id="ytlcc-h-password" class="ytlcc-input" type="text" value="" autocomplete="off" placeholder="Pass">
                        <span id="ytlcc-h-pass-saved" class="ytlcc-save-dot"></span>
                      </label>

                      <label class="ytlcc-field">
                        <span>Delay</span>
                        <input id="ytlcc-bulk-delay" class="ytlcc-input" type="number" min="180" value="${CFG.writeGapMs}">
                      </label>

                      <div class="ytlcc-action-cell">
                        <button id="ytlcc-smart-sync" data-run-action class="ytlcc-btn green ytlcc-sync-main" type="button">Đồng bộ</button>
                      </div>

                      <div class="ytlcc-action-cell">
                        <button id="ytlcc-update-price" data-run-action class="ytlcc-btn" type="button">Đặt giá</button>
                      </div>
                    </div>
                  </div>

                  <div class="ytlcc-bulk-right">
                    <div class="ytlcc-panel">
                      <div class="ytlcc-panel-head">
                        <span class="ytlcc-panel-title">Preview</span>
                      </div>

                      <div class="ytlcc-table-wrap">
                        <table class="ytlcc-table">
                          <thead>
                            <tr><th>Ch.</th><th>Tiêu đề</th><th>Ký tự</th><th>H</th><th>Server</th></tr>
                          </thead>
                          <tbody id="ytlcc-bulk-preview-body">
                            <tr><td colspan="5" class="ytlcc-empty">Chưa phân tích.</td></tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <section class="ytlcc-tab-pane" data-pane="stats">
                <div class="ytlcc-toolbar">
                  <button id="ytlcc-load-stats" class="ytlcc-btn primary" type="button">Làm mới</button>
                </div>
                <div id="ytlcc-stats">
                  <div class="ytlcc-empty">Chưa tải dữ liệu.</div>
                </div>
              </section>

              <section class="ytlcc-tab-pane" data-pane="log">
                <div class="ytlcc-toolbar">
                  <button id="ytlcc-clear-log" class="ytlcc-btn" type="button">Xóa</button>
                </div>
                <div id="ytlcc-log"></div>
              </section>
            </div>
          </main>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const toastHost = document.createElement('div');
    toastHost.id = 'ytlcc-toast-host';
    document.body.appendChild(toastHost);

    const editor = document.createElement('div');
    editor.id = 'ytlcc-editor-modal';
    editor.innerHTML = `
      <div class="ytlcc-editor-box">
        <div class="ytlcc-editor-head">
          <strong style="flex:1">Sửa chương</strong>
          <button id="ytlcc-editor-close" class="ytlcc-close" type="button">×</button>
        </div>

        <div class="ytlcc-editor-fields">
          <label class="ytlcc-field">
            <span>Chương</span>
            <input id="ytlcc-edit-no" class="ytlcc-input" type="text" readonly>
          </label>

          <label class="ytlcc-field">
            <span>Tiêu đề</span>
            <input id="ytlcc-edit-title" class="ytlcc-input" type="text">
          </label>

          <label class="ytlcc-field">
            <span>KC</span>
            <input id="ytlcc-edit-price" class="ytlcc-input" type="number" min="0">
          </label>

          <label class="ytlcc-field">
            <span>Pass</span>
            <input id="ytlcc-edit-password" class="ytlcc-input" type="text">
          </label>
        </div>

        <textarea id="ytlcc-edit-content" class="ytlcc-textarea"></textarea>

        <div class="ytlcc-editor-foot">
          <button id="ytlcc-editor-save" class="ytlcc-btn green" type="button">Lưu</button>
        </div>
      </div>
    `;

    document.body.appendChild(editor);

    const passModal = document.createElement('div');
    passModal.id = 'ytlcc-pass-modal';
    passModal.innerHTML = `
      <div class="ytlcc-pass-box">
        <div class="ytlcc-pass-head">
          <strong style="flex:1">Pass hàng loạt</strong>
          <button id="ytlcc-pass-close" class="ytlcc-close" type="button">×</button>
        </div>

        <div class="ytlcc-pass-body">
          <label class="ytlcc-field">
            <span>Chương</span>
            <input
              id="ytlcc-pass-range"
              class="ytlcc-input"
              type="text"
              value="H"
              autocomplete="off"
              placeholder="H hoặc 15,18-22,30"
            >
          </label>

          <label class="ytlcc-field">
            <span>Pass</span>
            <input
              id="ytlcc-pass-value"
              class="ytlcc-input"
              type="text"
              value=""
              autocomplete="off"
              placeholder="Pass mới"
            >
          </label>
        </div>

        <div class="ytlcc-pass-foot">
          <button id="ytlcc-pass-clear" data-run-action class="ytlcc-btn red" type="button">Xóa pass</button>
          <span class="ytlcc-spacer"></span>
          <button id="ytlcc-pass-cancel" class="ytlcc-btn" type="button">Hủy</button>
          <button id="ytlcc-pass-apply" data-run-action class="ytlcc-btn green" type="button">Áp dụng</button>
        </div>
      </div>
    `;
    document.body.appendChild(passModal);

    bindUi();
  }

  async function init() {
    mountUi();

    const prefs = loadPrefs();
    if (prefs.selectedStoryId) {
      state.selectedStoryId = Number(prefs.selectedStoryId);
    }
    if (prefs.activeTab) {
      state.activeTab = prefs.activeTab;
    }

    state.bulk.hPassword = String(prefs.hPassword || '');
    const hPasswordInput = $('#ytlcc-h-password');
    if (hPasswordInput) {
      hPasswordInput.value = state.bulk.hPassword;
    }
    const bulkPassInput = $('#ytlcc-pass-value');
    if (bulkPassInput) {
      bulkPassInput.value = state.bulk.hPassword;
    }

    state.theme = prefs.theme === 'light' ? 'light' : 'dark';
    applyTheme(state.theme);

    tab(state.activeTab || 'stories');
    renderRunState();

    try {
      await loadStories();
      if (state.selectedStoryId) {
        await loadChapters();
      }
      setStatus('Sẵn sàng.', 'success');
    } catch (err) {
      setStatus(err.message, 'error');
      addLog(err.message, 'error');
    }
  }

  init();
})();
