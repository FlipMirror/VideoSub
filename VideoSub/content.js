(() => {
  'use strict';
  if (window.__subtitlePiPInstalled) return;
  window.__subtitlePiPInstalled = true;

  let pipActive = false;
  let currentVideo = null;
  let pipVideo = null;
  let frameCallbackId = null;
  let cleanupHandlers = [];
  let pipStream = null;
  let leavingPip = false;
  let sourceVisualState = null;
  let currentCanvas = null;
  let currentCtx = null;
  let subtitleState = { text: '', html: '', source: null };
  let mediaSessionInstalled = false;

  const SUBTITLE_SELECTORS = [
    '[aria-live="polite"]', '[aria-live="assertive"]',
    '.subtitle', '.subtitles', '.subtitle-text', '.subtitleText',
    '.captions', '.caption', '.caption-text', '.captionText',
    '.vtt', '.webvtt', '.text-track', '[data-subtitle]', '[data-captions]'
  ];

  function getRectArea(video) {
    const r = video.getBoundingClientRect();
    return Math.max(0, r.width) * Math.max(0, r.height);
  }

  function isVisible(video) {
    const r = video.getBoundingClientRect();
    const s = getComputedStyle(video);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' &&
      r.width >= 120 && r.height >= 70 && r.bottom > 0 && r.right > 0 &&
      r.left < innerWidth && r.top < innerHeight;
  }

  function collectVideos(root, out = [], seen = new Set()) {
    if (!root || seen.has(root)) return out;
    seen.add(root);
    try {
      root.querySelectorAll('video').forEach(v => out.push(v));
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) collectVideos(el.shadowRoot, out, seen);
      });
    } catch (_) {}
    return out;
  }

  function getActiveVideo() {
    const candidates = collectVideos(document, []).filter(v => {
      if (!isVisible(v) || v.ended || v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
      return true;
    });
    if (!candidates.length) return null;
    const score = (v) => {
      const r = v.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const centerPenalty = Math.hypot(cx - innerWidth / 2, cy - innerHeight / 2);
      let s = getRectArea(v);
      if (!v.paused && !v.ended) s += 1e12;
      if (!v.muted) s += 1e8;
      if (v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) s += 1e7;
      if (document.activeElement === v) s += 1e6;
      s -= centerPenalty * 1000;
      return s;
    };
    candidates.sort((a, b) => score(b) - score(a));
    return candidates[0];
  }

  function normalizeText(s) {
    return String(s || '').replace(/\r/g, '').split('\n').map(x => x.trim()).filter(Boolean).join('\n').trim();
  }

  function getActiveTextTrackText(video) {
    const tracks = Array.from(video.textTracks || []);
    // Never change track.mode: the player owns subtitle selection.
    // IMPORTANT: if the browser/player exposes ANY track as "showing",
    // that is the authoritative selection. We must return its current text
    // (including an empty string) and NEVER fall back to DOM/other tracks.
    // Otherwise a player can briefly expose no active cue while another
    // language remains present in its DOM, producing Russian + English.
    const showing = tracks.filter(track => {
      try { return track.mode === 'showing'; } catch (_) { return false; }
    });

    if (showing.length) {
      // Prefer a single showing track. In normal browser/player behavior
      // there should be one selected subtitle track. If several are exposed,
      // choose the first one with active cues; never combine their texts.
      const withCues = showing.find(track => {
        try { return track.activeCues && track.activeCues.length > 0; } catch (_) { return false; }
      });
      const selected = withCues || showing[0];
      try {
        return Array.from(new Set(Array.from(selected.activeCues || [])
          .map(cue => normalizeText(cue.text))
          .filter(Boolean))).join('\n');
      } catch (_) {
        return '';
      }
    }

    // Only use the conservative fallback when there is NO showing track at
    // all. This supports custom players that keep the chosen track enabled
    // without exposing it as mode="showing". Still choose exactly one track.
    const fallback = tracks
      .filter(track => {
        try { return track.mode !== 'disabled' && track.activeCues && track.activeCues.length; }
        catch (_) { return false; }
      })
      .sort((a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)))[0];

    if (fallback) {
      try {
        return Array.from(new Set(Array.from(fallback.activeCues || [])
          .map(cue => normalizeText(cue.text))
          .filter(Boolean))).join('\n');
      } catch (_) {}
    }
    return '';
  }

  // ===== DONATE NOTICE =====
  // Shows once per site/tab after the first extension click. It is completely
  // independent from PiP: it never starts/stops/toggles video and subsequent
  // extension clicks do not touch it.
  const DONATE_URL = 'https://dalink.to/flipmirror';

  function isTopFrame() {
    try { return window === window.top; } catch (_) { return false; }
  }

  function showDonateNoticeOnce() {
    if (!isTopFrame()) return;
    // Show at most once per loaded page. A full page reload creates a new
    // document, so the notice will be eligible to appear again after the
    // first extension click on the reloaded page.
    if (window.__subtitlePiPDonateShown) return;
    window.__subtitlePiPDonateShown = true;

    if (document.getElementById('__subtitle-pip-donate-host')) return;

    const host = document.createElement('div');
    host.id = '__subtitle-pip-donate-host';
    host.setAttribute('aria-label', 'Поддержать VideoSub');
    host.style.cssText = [
      'position:fixed','left:18px','bottom:18px','z-index:2147483647',
      'pointer-events:auto','font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    ].join(';');

    const shadow = host.attachShadow ? host.attachShadow({mode:'closed'}) : host;
    const card = document.createElement('div');
    card.innerHTML = `
      <style>
        :host { all: initial; }
        .card {
          box-sizing: border-box;
          width: min(340px, calc(100vw - 32px));
          padding: 16px 16px 14px;
          border: 1px solid rgba(255,255,255,.12);
          border-radius: 16px;
          background: linear-gradient(145deg, rgba(24,27,35,.97), rgba(12,14,19,.97));
          color: #f7f8fb;
          box-shadow: 0 12px 34px rgba(0,0,0,.38), 0 2px 10px rgba(0,0,0,.22);
          backdrop-filter: blur(16px);
        }
        .top { display:flex; align-items:flex-start; gap:12px; }
        .icon {
          flex:0 0 40px; width:40px; height:40px; border-radius:12px;
          display:grid; place-items:center; font-size:20px;
          background: linear-gradient(135deg,#2f6cff,#7b61ff);
          box-shadow: inset 0 1px 0 rgba(255,255,255,.18);
        }
        .copy { min-width:0; padding-top:1px; padding-right:24px; }
        .title { font-size:15px; font-weight:700; line-height:1.25; letter-spacing:.1px; }
        .text { margin-top:4px; font-size:13px; line-height:1.4; color:rgba(247,248,251,.72); }
        .close {
          position:absolute; top:9px; right:10px; border:0; background:transparent;
          color:rgba(247,248,251,.5); cursor:pointer; width:28px; height:28px;
          border-radius:8px; font-size:20px; line-height:28px; padding:0;
        }
        .close:hover { background:rgba(255,255,255,.08); color:#fff; }
        .actions { margin-top:13px; display:flex; align-items:center; justify-content:space-between; gap:10px; }
        .hint { font-size:11px; color:rgba(247,248,251,.42); }
        .donate {
          display:inline-flex; align-items:center; gap:7px; border:0; cursor:pointer;
          padding:8px 13px; border-radius:10px; font-weight:700; font-size:12px;
          color:#fff; background:linear-gradient(135deg,#ff4f81,#ff7a59);
          box-shadow:0 4px 14px rgba(255,79,129,.25);
        }
        .donate:hover { filter:brightness(1.06); transform:translateY(-1px); }
        .donate:active { transform:translateY(0); }
        .heart { font-size:13px; }
        @media (max-width: 480px) {
          .card { width: calc(100vw - 24px); }
          host { left:12px !important; bottom:12px !important; }
        }
      </style>
      <div class="card" role="dialog" aria-label="Поддержать разработчика">
        <button class="close" type="button" aria-label="Закрыть">×</button>
        <div class="top">
          <div class="icon">▶</div>
          <div class="copy">
            <div class="title">Нравится VideoSub?</div>
            <div class="text">Если понравилось расширение, то можно поддержать автора ❤️</div>
          </div>
        </div>
        <div class="actions">
          <span class="hint">Спасибо за поддержку</span>
          <button class="donate" type="button"><span class="heart">♥</span> Donate</button>
        </div>
      </div>
    `;

    // Shadow DOM keeps the notice isolated from page CSS and vice versa.
    (shadow || host).appendChild(card);
    document.documentElement.appendChild(host);

    const close = card.querySelector('.close');
    const donate = card.querySelector('.donate');
    close?.addEventListener('click', () => host.remove());
    donate?.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = DONATE_URL;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.display = 'none';
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
    });
  }

  function isSpecialSubtitleSite() {
    const h = location.hostname.toLowerCase();
    return h === 'videovak.com' || h.endsWith('.videovak.com') ||
           h === 'lookmovie0.to' || h.endsWith('.lookmovie0.to') ||
           h === '2sub.movie' || h.endsWith('.2sub.movie');
  }

  function getSpecialSiteTrackText(video) {
    if (!isSpecialSubtitleSite()) return '';
    try {
      const tracks = Array.from(video.textTracks || []);
      const now = Number(video.currentTime || 0);
      const showing = tracks.filter(t => {
        try { return t.mode === 'showing' && t.activeCues && t.activeCues.length; } catch (_) { return false; }
      });
      if (showing.length) {
        const parts = showing.map(t => {
          try { return Array.from(t.activeCues || []).map(c => normalizeText(c.text)).filter(Boolean).join('\n'); }
          catch (_) { return ''; }
        }).filter(Boolean);
        return Array.from(new Set(parts)).join('\n');
      }

      // Some players render a selected WebVTT track without exposing it as
      // mode="showing". Prefer cues covering the exact current time.
      const candidates = [];
      for (const t of tracks) {
        try {
          const cues = t.cues ? Array.from(t.cues) : [];
          const active = cues.filter(c => now >= c.startTime - 0.05 && now <= c.endTime + 0.05)
            .map(c => normalizeText(c.text)).filter(Boolean);
          if (active.length) candidates.push({ track: t, text: Array.from(new Set(active)).join('\n') });
        } catch (_) {}
      }
      if (!candidates.length) return '';

      // For 2SUB, simultaneous English+Russian tracks are an intentional
      // player feature, so preserve all currently active tracks there. For
      // the other sites prefer one track when the player doesn't expose a
      // selected state.
      if (/2sub\.movie$/i.test(location.hostname)) {
        return Array.from(new Set(candidates.map(x => x.text).filter(Boolean))).join('\n');
      }
      return candidates[0].text;
    } catch (_) { return ''; }
  }

  function getGenericPlayerCaptionText(video) {
    if (!isSpecialSubtitleSite()) return '';
    try {
      const vr = video.getBoundingClientRect();
      const roots = [];
      let a = video.parentElement;
      for (let i = 0; i < 6 && a; i++, a = a.parentElement) {
        roots.push(a);
        if (a.shadowRoot) roots.push(a.shadowRoot);
      }
      const selectors = [
        '[class*="subtitle"]','[class*="caption"]','[class*="sub-title"]','[class*="captions"]',
        '[data-subtitle]','[data-caption]','[data-testid*="subtitle"]','[data-testid*="caption"]',
        '.jw-text-track-display','.jw-captions','.vjs-text-track-display','.vjs-text-track-cue',
        '.plyr__captions','.media-player-subtitles','.shaka-text-container'
      ];
      const seen = new Set(), vals = [];
      const bad = /^(play|pause|mute|unmute|volume|settings?|quality|speed|fullscreen|exit fullscreen|subtitles?|captions?|cc|auto|english|russian|en|ru)$/i;
      const visit = root => {
        if (!root || seen.has(root)) return;
        seen.add(root);
        try {
          const els = root.querySelectorAll ? root.querySelectorAll(selectors.join(',')) : [];
          for (const el of els) {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            const text = normalizeText(el.innerText || el.textContent);
            if (!text || bad.test(text)) continue;
            if (st.display==='none' || st.visibility==='hidden' || Number(st.opacity)===0) continue;
            if (r.width < 25 || r.height < 8) continue;
            if (r.right < vr.left || r.left > vr.right || r.bottom < vr.top || r.top > vr.bottom) continue;
            if (r.top < vr.top + vr.height * 0.50) continue;
            if (text.length > 240) continue;
            const meta = [el.className, el.id, el.getAttribute('aria-label'), el.getAttribute('role'), el.getAttribute('title')].filter(Boolean).join(' ');
            if (/(control|button|menu|toolbar|timeline|progress|seek|volume|setting|player-title)/i.test(meta)) continue;
            vals.push({text, score: Math.abs((r.top+r.height/2)-(vr.top+vr.height*.84))});
            if (el.shadowRoot) visit(el.shadowRoot);
          }
          root.querySelectorAll?.('*').forEach(el => { if (el.shadowRoot) visit(el.shadowRoot); });
        } catch (_) {}
      };
      roots.forEach(visit);
      vals.sort((a,b)=>a.score-b.score);
      return vals[0]?.text || '';
    } catch (_) { return ''; }
  }


  function getYouTubeSubtitleText(video) {
    try {
      const host = video.closest('#movie_player, .html5-video-player');
      if (!host) return '';
      const root = host.querySelector('#ytp-caption-window-container');
      if (!root) return '';
      const segments = Array.from(root.querySelectorAll('.ytp-caption-segment'))
        .map(n => normalizeText(n.textContent))
        .filter(Boolean);
      if (segments.length) return Array.from(new Set(segments)).join('\n');
      const text = normalizeText(root.innerText || root.textContent);
      return text;
    } catch (_) { return ''; }
  }

  function getSubtitleDOMText(video) {
    const container = video.parentElement;
    if (!container) return '';
    let nodes = [];
    try { nodes = Array.from(container.querySelectorAll(SUBTITLE_SELECTORS.join(','))); } catch (_) {}
    // Search a few ancestors too, because many players place captions beside the video.
    let a = container;
    for (let i = 0; i < 3 && a; i++, a = a.parentElement) {
      try { nodes.push(...a.querySelectorAll(SUBTITLE_SELECTORS.join(','))); } catch (_) {}
    }
    const candidates = nodes.filter(n => {
      const t = normalizeText(n.innerText || n.textContent);
      if (!t) return false;
      const st = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0' && r.width > 20 && r.height > 5;
    });
    // Prefer caption-looking nodes nearest the bottom of the video.
    const vr = video.getBoundingClientRect();
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const da = Math.abs((ra.top + ra.height / 2) - (vr.top + vr.height * 0.84));
      const db = Math.abs((rb.top + rb.height / 2) - (vr.top + vr.height * 0.84));
      return da - db || (rb.width * rb.height) - (ra.width * ra.height);
    });
    return candidates[0] ? normalizeText(candidates[0].innerText || candidates[0].textContent) : '';
  }

  function getEntalkSubtitleText(video) {
    if (!/entalk\.io$/i.test(location.hostname)) return '';
    try {
      const vr = video.getBoundingClientRect();
      const roots = [];
      let a = video.parentElement;
      for (let i = 0; i < 5 && a; i++, a = a.parentElement) {
        roots.push(a);
        if (a.shadowRoot) roots.push(a.shadowRoot);
      }
      const candidates = [];
      const seen = new Set();

      const badMeta = /(subtitle|caption|translation|transcript|language|settings|option|menu|checkbox|select|english|russian|русск|англ|current[- ]?time|duration|remaining[- ]?time|seek|rewind|forward|skip|mute|unmute|volume|playback|fullscreen|picture[- ]?in[- ]?picture|pip|loaded|loading|buffering|quality|speed|autoplay|controls?)/i;
      const badRole = /^(button|menuitem|option|tab|checkbox|combobox|slider|spinbutton|progressbar|status|alert|tooltip)$/i;
      const badText = /^(current time|duration|remaining time|rewind(?: \d+ seconds?)?|forward(?: \d+ seconds?)?|skip|mute|unmute|volume|play|pause|loaded|loading|buffering|settings?|quality|speed|fullscreen|picture[- ]?in[- ]?picture|pip|autoplay|captions?|subtitles?|english|russian|русский|английский)$/i;

      const visit = (root) => {
        if (!root || seen.has(root)) return;
        seen.add(root);
        try {
          const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (const el of all) {
            if (el.shadowRoot) visit(el.shadowRoot);
            const text = normalizeText(el.innerText || el.textContent);
            if (!text) continue;
            // EnTalk briefly exposes long movie/lesson descriptions in the same
            // lower overlay where captions appear. They are not subtitle cues.
            // Normal dialogue captions are short; reject synopsis-like blocks
            // with many words or multiple sentence boundaries.
            const wordCount = text.split(/\s+/).filter(Boolean).length;
            const sentenceCount = (text.match(/[.!?](?:\s|$)/g) || []).length;
            if (text.length > 170 || wordCount > 26 || sentenceCount > 1) continue;
            if (badText.test(text)) continue;
            // EnTalk may put synopsis/lesson-description text in the same
            // overlay as the caption. Keep only plausible subtitle lines.
            const lines = text.split('\n').map(x => normalizeText(x)).filter(Boolean);
            const keptLines = lines.filter(line => {
              const wc = line.split(/\s+/).filter(Boolean).length;
              const sc = (line.match(/[.!?](?:\s|$)/g) || []).length;
              if (line.length > 120 || wc > 20 || sc > 1) return false;
              if (/^(?:the|a|an)\s+(?:early|life|story|history|film|movie|episode|series)\b/i.test(line)) return false;
              return !badText.test(line);
            });
            if (!keptLines.length) continue;
            if (/\b(current time|loaded|loading|rewind|forward|mute|volume|play|pause|settings?|fullscreen)\b/i.test(text) && text.length < 80) continue;
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            if (r.width < 30 || r.height < 8) continue;
            if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
            if (r.right < vr.left || r.left > vr.right || r.bottom < vr.top || r.top > vr.bottom) continue;
            const cy = r.top + r.height / 2;
            if (cy < vr.top + vr.height * 0.55) continue;
            if (badRole.test(el.getAttribute('role') || '')) continue;
            if (/^(BUTTON|INPUT|SELECT|TEXTAREA|OPTION|LABEL)$/i.test(el.tagName)) continue;
            const meta = [el.className, el.id, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid')].filter(Boolean).join(' ');
            if (badMeta.test(meta)) continue;

            // Prefer leaf-ish text nodes. Large container text often includes
            // accessibility labels from player controls in addition to the cue.
            const directText = Array.from(el.childNodes || [])
              .filter(n => n.nodeType === Node.TEXT_NODE)
              .map(n => normalizeText(n.textContent))
              .filter(Boolean)
              .join(' ');
            if (directText && directText.length >= 2 && directText.length <= 220) {
              const normalizedDirect = normalizeText(directText);
              if (badText.test(normalizedDirect)) continue;
            }

            // Language selector/menu labels should never be used as captions.
            const parentText = normalizeText(el.parentElement?.innerText || '');
            if (parentText && parentText.length < 80 && /^(English|Russian|русский|английский|en|ru)$/i.test(text)) continue;

            const pos = st.position;
            let score = 0;
            if (pos === 'absolute' || pos === 'fixed') score += 40;
            if (r.width >= vr.width * 0.15) score += 10;
            if (r.width <= vr.width * 1.05) score += 5;
            score -= Math.abs((cy - (vr.top + vr.height * 0.82)) / Math.max(1, vr.height)) * 50;
            score += Math.min(20, text.length / 25);
            candidates.push({text, score, el});
          }
        } catch (_) {}
      };

      roots.forEach(visit);
      candidates.sort((a,b) => b.score - a.score);
      return candidates[0]?.text || '';
    } catch (_) { return ''; }
  }



  function isOroroSite() {
    const h = location.hostname.toLowerCase();
    return h === 'ororo.tv' || h.endsWith('.ororo.tv');
  }

  function getOroroSubtitleText(video) {
    if (!isOroroSite()) return '';
    try {
      // Prefer the player's own timed text when it exposes WebVTT/TextTrack.
      const tracks = Array.from(video.textTracks || []);
      const now = Number(video.currentTime || 0);
      const candidates = [];
      for (const track of tracks) {
        try {
          const active = Array.from(track.activeCues || [])
            .map(c => normalizeText(c.text))
            .filter(Boolean);
          if (active.length) candidates.push({ text: Array.from(new Set(active)).join('\\n'), score: track.mode === 'showing' ? 100 : 80 });
        } catch (_) {}
        try {
          const cues = track.cues ? Array.from(track.cues) : [];
          const active = cues
            .filter(c => now >= c.startTime - 0.08 && now <= c.endTime + 0.08)
            .map(c => normalizeText(c.text))
            .filter(Boolean);
          if (active.length) candidates.push({ text: Array.from(new Set(active)).join('\\n'), score: 70 });
        } catch (_) {}
      }
      if (candidates.length) {
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0].text;
      }

      // Ororo also has its own DOM subtitle layer. Search deeper around the
      // active video than the generic fallback and reject episode metadata.
      const vr = video.getBoundingClientRect();
      const selectors = [
        '[class*="subtitle"]','[id*="subtitle"]','[class*="caption"]','[id*="caption"]',
        '[data-subtitle]','[data-caption]','[data-testid*="subtitle"]','[data-testid*="caption"]',
        '.subtitle','.subtitles','.captions','.subtitle-text','.caption-text',
        '.video-subtitle','.player-subtitle','.cc-text','.vjs-text-track-display',
        '.plyr__captions','.jw-text-track-display'
      ];
      const nodes = [];
      const seen = new Set();
      let root = video.parentElement;
      for (let depth = 0; depth < 7 && root; depth++, root = root.parentElement) {
        try {
          for (const n of root.querySelectorAll(selectors.join(','))) {
            if (!seen.has(n)) { seen.add(n); nodes.push(n); }
          }
          if (root.shadowRoot) {
            for (const n of root.shadowRoot.querySelectorAll(selectors.join(','))) {
              if (!seen.has(n)) { seen.add(n); nodes.push(n); }
            }
          }
        } catch (_) {}
      }

      const episodeMeta = /^S\d{1,2}E\d{1,3}\s+(?:Episode|Ep\.?\b)/i;
      // Ororo leaves the selected subtitle language marker in the same
      // overlay when there is no active dialogue. Never treat language
      // markers such as "en", "ru", "en-US", etc. as subtitles.
      const badExact = /^(?:season|episode|s\d{1,2}e\d{1,3}|en|ru|de|fr|es|it|pt|pl|ja|ko|zh|ar|tr|uk|en[-_]us|en[-_]gb|ru[-_]ru|de[-_]de|fr[-_]fr|es[-_]es|d\^rk|1358670|etrusca|merci beaucoup36)$/i;
      const badLine = /^(?:season|episode|s\d{1,2}e\d{1,3}(?:\s+episode)?|en|ru|de|fr|es|it|pt|pl|ja|ko|zh|ar|tr|uk|en[-_]us|en[-_]gb|ru[-_]ru|de[-_]de|fr[-_]fr|es[-_]es|d\^rk|dark|1358670|etrusca|merci beaucoup36)$/i;
      const cleanOroroLines = (text) => normalizeText(text)
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !badLine.test(line) && !/^nigrum\s+flos$/i.test(line))
        .join('\n');
      const filtered = nodes.map(el => {
        const rawText = normalizeText(el.innerText || el.textContent);
        if (!rawText) return null;
        // Ororo sometimes puts the dialogue and player labels into one overlay container.
        // Filter only the individual label lines; keep the complete dialogue line intact.
        const text = cleanOroroLines(rawText);
        if (!text) return null;
        if (/^nigrum\s+flos$/i.test(text)) return null;
        if (/nigrum\s+flos/i.test(text) && text.length <= 64) return null;
        if (episodeMeta.test(text) || badExact.test(text)) return null;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return null;
        if (r.width < 20 || r.height < 5) return null;
        if (r.right < vr.left || r.left > vr.right || r.bottom < vr.top || r.top > vr.bottom) return null;
        const cy = r.top + r.height / 2;
        if (cy < vr.top + vr.height * 0.55) return null;
        const meta = [el.className, el.id, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid')].filter(Boolean).join(' ');
        const hasCaptionMeta = /(subtitle|caption|cc|text[-_ ]?track)/i.test(meta);
        if (/episode|season|playlist|metadata|series[-_ ]title|show[-_ ]title/i.test(meta) && !hasCaptionMeta) return null;

        // Reject static page/player labels even when they are visually over the video.
        // A subtitle DOM node should change while the video progresses; episode titles
        // such as "nigrum flos" normally remain unchanged.
        const pageTitle = normalizeText(document.title || '');
        const h1Text = normalizeText(document.querySelector('h1')?.innerText || '');
        const ogTitle = normalizeText(document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '');
        const titleAttr = normalizeText(el.getAttribute('title') || '');
        const staticText = !hasCaptionMeta && [pageTitle, h1Text, ogTitle, titleAttr].filter(Boolean).some(t => text === t);
        if (staticText) return null;

        // Track per-element text history. Do not surface a stable label as a subtitle.
        let hist = el.__subtitlePiPHistory || (el.__subtitlePiPHistory = { text: '', since: performance.now(), changes: 0 });
        if (hist.text !== text) {
          hist.text = text;
          hist.since = performance.now();
          hist.changes = Math.min(hist.changes + 1, 10);
        }
        const age = performance.now() - hist.since;
        if (!hasCaptionMeta && hist.changes === 0 && age > 1200) return null;

        let score = (hasCaptionMeta ? 120 : 30);
        if (/background|rgba|caption|subtitle/i.test([st.backgroundColor, st.color, st.fontFamily].join(' '))) score += 10;
        score -= Math.abs(cy - (vr.top + vr.height * 0.84)) / Math.max(1, vr.height) * 50;
        score += Math.min(15, text.length / 30);
        return { el, text, score };
      }).filter(Boolean);
      filtered.sort((a,b) => b.score - a.score);
      return filtered[0]?.text || '';
    } catch (_) { return ''; }
  }

  function getAniSubSubtitleText(video) {
    try {
      if (!location.hostname.endsWith('anisub.tv')) return '';
      const root = document.querySelector('#pjs_episode_video_subtitle');
      if (!root) return '';

      // AniSub exposes the currently visible translated dialogue in this
      // dedicated player subtitle container. Prefer the visible span(s).
      const spans = Array.from(root.querySelectorAll('span')).filter(el => {
        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return st.display !== 'none' && st.visibility !== 'hidden' &&
          st.opacity !== '0' && r.width > 0 && r.height > 0;
      });

      const text = normalizeText(spans.map(s => s.innerText || s.textContent).join('\n'));
      if (text) return text;

      return normalizeText(root.innerText || root.textContent);
    } catch (_) {
      return '';
    }
  }

  function getSubtitleText(video) {
    const aniText = getAniSubSubtitleText(video);
    if (aniText) return { text: aniText, source: 'anisub-dom' };

    const tracks = Array.from(video.textTracks || []);
    const hasShowingTrack = tracks.some(track => {
      try { return track.mode === 'showing'; } catch (_) { return false; }
    });
    const trackText = getActiveTextTrackText(video);
    if (hasShowingTrack) return { text: trackText, source: 'track' };
    if (trackText) return { text: trackText, source: 'track' };

    const isOroro = isOroroSite();
    const ororoText = getOroroSubtitleText(video);
    if (isOroro) {
      return ororoText ? { text: ororoText, source: 'ororo' } : { text: '', source: null };
    }

    const isEntalk = /entalk\.io$/i.test(location.hostname);
    const entalkText = getEntalkSubtitleText(video);
    if (isEntalk) {
      return entalkText ? { text: entalkText, source: 'entalk-dom' } : { text: '', source: null };
    }
    if (entalkText) return { text: entalkText, source: 'entalk-dom' };

    if (isSpecialSubtitleSite()) {
      const specialTrack = getSpecialSiteTrackText(video);
      if (specialTrack) return { text: specialTrack, source: 'special-track' };
      const specialDom = getGenericPlayerCaptionText(video);
      if (specialDom) return { text: specialDom, source: 'special-dom' };
    }

    const ytText = getYouTubeSubtitleText(video);
    if (ytText) return { text: ytText, source: 'youtube-dom' };

    const domText = getSubtitleDOMText(video);
    if (domText) return { text: domText, source: 'dom' };
    return { text: '', source: null };
  }

  function drawSubtitle(ctx, text, w, h) {
    if (!text) return;
    const maxWidth = Math.max(240, w * 0.86);
    const fontSize = Math.max(18, Math.round(h * 0.045));
    ctx.font = `600 ${fontSize}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const lines = [];
    for (const paragraph of text.split('\n')) {
      const words = paragraph.split(/\s+/).filter(Boolean);
      let line = '';
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && line) {
          lines.push(line);
          line = word;
        } else {
          line = test;
        }
      }
      if (line) lines.push(line);
    }

    const lineHeight = fontSize * 1.22;
    const bottom = h * 0.90;
    const startY = bottom - (lines.length - 1) * lineHeight;
    for (let i = 0; i < lines.length; i++) {
      const y = startY + i * lineHeight;
      const metrics = ctx.measureText(lines[i]);
      const padX = fontSize * 0.34;
      const padY = fontSize * 0.16;
      const boxW = metrics.width + padX * 2;
      const boxH = fontSize + padY * 2;
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      ctx.fillRect(w / 2 - boxW / 2, y - boxH / 2, boxW, boxH);
      ctx.lineWidth = Math.max(2, fontSize * 0.08);
      ctx.strokeStyle = 'rgba(0,0,0,0.95)';
      ctx.strokeText(lines[i], w / 2, y);
      ctx.fillStyle = '#fff';
      ctx.fillText(lines[i], w / 2, y);
    }
  }

  function drawFrame(video, canvas, ctx) {
    if (!video.videoWidth || !video.videoHeight) return;
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const st = getSubtitleText(video);
    subtitleState = st;
    drawSubtitle(ctx, st.text, canvas.width, canvas.height);
  }

  function startRenderLoop(video, canvas, ctx) {
    stopRenderLoop(video);
    const loop = () => {
      if (!pipActive || currentVideo !== video) return;
      try { drawFrame(video, canvas, ctx); } catch (_) {}
      if (video.requestVideoFrameCallback) frameCallbackId = video.requestVideoFrameCallback(loop);
      else frameCallbackId = requestAnimationFrame(loop);
    };
    if (video.requestVideoFrameCallback) frameCallbackId = video.requestVideoFrameCallback(loop);
    else frameCallbackId = requestAnimationFrame(loop);
  }

  function stopRenderLoop(video) {
    if (!frameCallbackId) return;
    try {
      if (video?.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameCallbackId);
      else cancelAnimationFrame(frameCallbackId);
    } catch (_) {}
    frameCallbackId = null;
  }

  function clearHandlers() {
    for (const fn of cleanupHandlers.splice(0)) { try { fn(); } catch (_) {} }
  }

  function hideSourceVideo(video) {
    if (!video || sourceVisualState) return;
    sourceVisualState = { video, opacity: video.style.opacity, pointerEvents: video.style.pointerEvents, transition: video.style.transition };
    video.style.transition = 'none';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
  }

  function restoreSourceVideo() {
    const state = sourceVisualState;
    sourceVisualState = null;
    if (!state?.video) return;
    try {
      state.video.style.opacity = state.opacity;
      state.video.style.pointerEvents = state.pointerEvents;
      state.video.style.transition = state.transition;
    } catch (_) {}
  }

  function installMediaSessionControls(video) {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', () => {
        try {
          video.play().catch(() => {});
          ms.playbackState = 'playing';
        } catch (_) {}
      });
    } catch (_) {}
    try {
      ms.setActionHandler('pause', () => {
        try {
          video.pause();
          ms.playbackState = 'paused';
        } catch (_) {}
      });
    } catch (_) {}
    try { ms.playbackState = video.paused ? 'paused' : 'playing'; } catch (_) {}
    mediaSessionInstalled = true;
  }

  function uninstallMediaSessionControls() {
    if (!mediaSessionInstalled || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try { ms.setActionHandler('play', null); } catch (_) {}
    try { ms.setActionHandler('pause', null); } catch (_) {}
    try { ms.playbackState = 'none'; } catch (_) {}
    mediaSessionInstalled = false;
  }

  async function stopPiP() {
    if (leavingPip) return;
    leavingPip = true;
    pipActive = false;
    try { stopRenderLoop(currentVideo); } catch (_) {}
    uninstallMediaSessionControls();
    restoreSourceVideo();
    clearHandlers();
    try { if (pipStream) pipStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { if (pipVideo) { pipVideo.pause(); pipVideo.srcObject = null; } } catch (_) {}
    if (currentCanvas) { try { currentCanvas.width = 1; currentCanvas.height = 1; } catch (_) {} }
    currentCanvas = null;
    currentCtx = null;
    currentVideo = null;
    pipVideo = null;
    pipStream = null;
    subtitleState = { text: '', source: null };
    leavingPip = false;
  }

  function isTwoSubTvSpace() {
    const h = location.hostname.toLowerCase();
    return h === '2sub-tv.space' || h.endsWith('.2sub-tv.space');
  }

  function prepareTwoSubTvIframePip() {
    if (!isTwoSubTvSpace()) return;
    try {
      document.querySelectorAll('iframe').forEach(frame => {
        const current = String(frame.getAttribute('allow') || '');
        if (!/\bpicture-in-picture\b/i.test(current)) {
          frame.setAttribute('allow', current ? `${current}; picture-in-picture` : 'picture-in-picture');
        }
      });
    } catch (_) {}
  }

  async function tryNativeSitePiP(video) {
    if (!isTwoSubTvSpace() || !video || typeof video.requestPictureInPicture !== 'function') return false;
    try {
      if (video.disablePictureInPicture) video.disablePictureInPicture = false;
    } catch (_) {}
    try {
      installMediaSessionControls(video);
      const wasPaused = video.paused;
      const originalMuted = video.muted;
      const originalOpacity = video.style.opacity;
      const originalPointerEvents = video.style.pointerEvents;

      const onLeave = () => {
        try {
          video.style.opacity = originalOpacity;
          video.style.pointerEvents = originalPointerEvents;
        } catch (_) {}
        uninstallMediaSessionControls();
        if (currentVideo === video) currentVideo = null;
        pipVideo = null;
        pipActive = false;
      };

      video.addEventListener('leavepictureinpicture', onLeave, { once: true });
      cleanupHandlers.push(() => video.removeEventListener('leavepictureinpicture', onLeave));

      currentVideo = video;
      pipActive = true;
      video.muted = false;
      // Do not force a paused source to play. Some players interpret this as
      // a user play action when PiP is requested from the extension icon.
      // requestPictureInPicture() itself is allowed on a paused video.
      await video.requestPictureInPicture();
      if (wasPaused) {
        // A site may resume playback as part of its own PiP transition; restore
        // the exact pre-PiP state on the next task as a final guard.
        setTimeout(() => {
          try { if (!video.paused) video.pause(); } catch (_) {}
        }, 0);
      }

      // Hide only the page copy; the video element itself keeps playing.
      video.style.opacity = '0';
      video.style.pointerEvents = 'none';
      return true;
    } catch (_) {
      try { video.muted = false; } catch (_) {}
      pipActive = false;
      currentVideo = null;
      uninstallMediaSessionControls();
      return false;
    }
  }

  function isLordfilmSite() {
    const h = location.hostname.toLowerCase();
    return h.includes('lordfilm') || h.includes('lordserial');
  }

  async function tryNativeLordfilmPiP(video) {
    if (!isLordfilmSite() || !video || typeof video.requestPictureInPicture !== 'function') return false;
    try {
      if (video.disablePictureInPicture) video.disablePictureInPicture = false;
      const wasPaused = video.paused;
      currentVideo = video;
      pipActive = true;
      installMediaSessionControls(video);
      await video.requestPictureInPicture();
      if (wasPaused) {
        try { video.pause(); } catch (_) {}
        setTimeout(() => { try { video.pause(); } catch (_) {} }, 0);
      }
      hideSourceVideo(video);
      return true;
    } catch (_) {
      pipActive = false;
      currentVideo = null;
      uninstallMediaSessionControls();
      return false;
    }
  }

  function isLordfilmHost() {
    const h = location.hostname.toLowerCase();
    return h.includes('lordfilm') || h.includes('lordserial');
  }

  // Lordfilm lazy-loads Player 1 behind a hidden iframe. The site's own tab
  // switch code initializes that iframe only after a Player 1 -> Player 2 ->
  // Player 1 transition. Do that once, after the page is fully loaded, so the
  // extension can address Player 1 immediately afterwards. This is deliberately
  // limited to the top Lordfilm document and never runs inside player frames.
  function findLordfilmPlayerTab(num) {
    if (!isLordfilmHost() || window !== window.top) return null;
    const want = String(num);
    const nodes = Array.from(document.querySelectorAll('a,button,[role="tab"],[onclick],div,span'))
      .filter(el => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return new RegExp('^Плеер\\s*' + want + '$', 'i').test(text);
      });
    for (const el of nodes) {
      if (el.matches('a,button,[role="tab"],[onclick]')) return el;
      const parent = el.closest('a,button,[role="tab"],[onclick]');
      if (parent) return parent;
    }
    return nodes[0] || null;
  }

  function lordfilmClickTab(el) {
    if (!el) return false;
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch (_) {
      try { el.click(); return true; } catch (__) { return false; }
    }
  }

  function initLordfilmPlayer1Once() {
    if (!isLordfilmHost() || window !== window.top) return;
    if (window.__subtitlePiPLordfilmPlayerInitStarted) return;
    window.__subtitlePiPLordfilmPlayerInitStarted = true;

    const run = () => {
      const p1 = findLordfilmPlayerTab(1);
      const p2 = findLordfilmPlayerTab(2);
      if (!p1 || !p2) {
        window.__subtitlePiPLordfilmPlayerInitStarted = false;
        return;
      }

      // Only the site tab switch is used; no iframe style is force-changed.
      // This lets the site's own code initialize the hidden Player 1 iframe.
      lordfilmClickTab(p1);
      setTimeout(() => {
        lordfilmClickTab(p2);
        setTimeout(() => {
          lordfilmClickTab(p1);
          window.__subtitlePiPLordfilmPlayerInitDone = true;
        }, 180);
      }, 180);
    };

    if (document.readyState === 'complete') setTimeout(run, 80);
    else window.addEventListener('load', () => setTimeout(run, 80), { once: true });
  }

  if (isLordfilmHost() && window === window.top) {
    initLordfilmPlayer1Once();
  }

  function getActiveLordfilmIframe() {
    if (!isLordfilmHost()) return null;
    try {
      const explicit = [
        document.querySelector('#player2-iframe'),
        document.querySelector('#player1-iframe')
      ].filter(Boolean);

      const isUsable = (frame) => {
        if (!frame) return false;
        const st = getComputedStyle(frame);
        const r = frame.getBoundingClientRect();
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
        if (r.width < 250 || r.height < 140) return false;
        const src = String(frame.getAttribute('src') || '').toLowerCase();
        const meta = `${src} ${frame.id || ''} ${frame.className || ''}`.toLowerCase();
        if (/doubleclick|googlesyndication|adnxs|adsystem|advert|banner|promo|vast|vmap/.test(meta)) return false;
        return true;
      };

      // First choice remains the site's explicit player iframes. This preserves
      // the working behaviour on the original Lordfilm layout.
      const explicitVisible = explicit.find(isUsable);
      if (explicitVisible) return explicitVisible;
      if (explicit.length) return explicit[0];

      // Some Lordfilm mirrors do not use #player1-iframe/#player2-iframe at all.
      // On those pages there is usually a single large iframe for the actual
      // movie player. Pick that frame as a safe fallback, ignoring obvious ads.
      const fallback = Array.from(document.querySelectorAll('iframe'))
        .filter(isUsable)
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return (rb.width * rb.height) - (ra.width * ra.height);
        });
      return fallback[0] || null;
    } catch (_) {
      return null;
    }
  }

  async function relayLordfilmToggle() {
    const frame = getActiveLordfilmIframe();
    if (!frame || !frame.contentWindow) return false;

    const message = { type: 'SUBTITLE_PIP_LORDFILM_TOGGLE' };
    try {
      // Send exactly one toggle to the currently active player iframe.
      // Repeating the toggle can turn PiP on and immediately back off
      // (especially on Lordfilm, where both player frames are live).
      frame.contentWindow.postMessage(message, '*');
      showDonateNoticeOnce();
      return true;
    } catch (_) {
      return false;
    }
  }

  if (isLordfilmHost()) {
    window.__subtitlePiPLordfilmToggle = relayLordfilmToggle;
  }

  // The player iframes on Lordfilm can be cross-origin (for example an
  // external video host). Such a frame does not satisfy isLordfilmHost(),
  // but it still needs to receive the parent-page PiP command. Keep this
  // listener generic so both Player 1 and Player 2 can be controlled.
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    if (event.data?.type !== 'SUBTITLE_PIP_LORDFILM_TOGGLE') return;
    if (typeof window.__subtitlePiPToggle === 'function') {
      void window.__subtitlePiPToggle();
    }
  });

  async function startPiP() {
    if (pipActive && !document.pictureInPictureElement) await stopPiP();
    if (pipActive || document.pictureInPictureElement) return;
    prepareTwoSubTvIframePip();
    const video = getActiveVideo();
    if (!video) return;
    if (isTwoSubTvSpace()) {
      if (await tryNativeSitePiP(video)) return;
    }
    const width = video.videoWidth || Math.max(640, Math.round(video.getBoundingClientRect().width));
    const height = video.videoHeight || Math.max(360, Math.round(video.getBoundingClientRect().height));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    currentVideo = video; currentCanvas = canvas; currentCtx = ctx; pipActive = true;
    try {
      drawFrame(video, canvas, ctx);
      startRenderLoop(video, canvas, ctx);
    } catch (_) {
      await stopPiP();
      if (await tryNativeLordfilmPiP(video)) return;
      return;
    }

    let stream;
    try { stream = canvas.captureStream(60); pipStream = stream; }
    catch (_) { await stopPiP(); if (await tryNativeLordfilmPiP(video)) return; return; }

    const tempVideo = document.createElement('video');
    tempVideo.controls = true;
    tempVideo.setAttribute('controls', '');
    tempVideo.srcObject = stream; tempVideo.muted = true; tempVideo.playsInline = true; pipVideo = tempVideo;
    let syncing = false;
    const wasPausedBeforePiP = video.paused;
    const onPipPlay = () => {
      if (!syncing) { syncing = true; if (currentVideo?.paused) currentVideo.play().catch(() => {}); syncing = false; }
      try { navigator.mediaSession.playbackState = 'playing'; } catch (_) {}
    };
    const onPipPause = () => {
      if (!syncing) { syncing = true; if (currentVideo && !currentVideo.paused) currentVideo.pause(); syncing = false; }
      try { navigator.mediaSession.playbackState = 'paused'; } catch (_) {}
    };
    const onSourcePlay = () => {
      if (!syncing) { syncing = true; if (pipVideo?.paused) pipVideo.play().catch(() => {}); syncing = false; }
      try { navigator.mediaSession.playbackState = 'playing'; } catch (_) {}
    };
    const onSourcePause = () => {
      if (!syncing) { syncing = true; if (pipVideo && !pipVideo.paused) pipVideo.pause(); syncing = false; }
      try { navigator.mediaSession.playbackState = 'paused'; } catch (_) {}
    };
    tempVideo.addEventListener('play', onPipPlay); tempVideo.addEventListener('pause', onPipPause);
    video.addEventListener('play', onSourcePlay); video.addEventListener('pause', onSourcePause);
    cleanupHandlers.push(() => tempVideo.removeEventListener('play', onPipPlay));
    cleanupHandlers.push(() => tempVideo.removeEventListener('pause', onPipPause));
    cleanupHandlers.push(() => video.removeEventListener('play', onSourcePlay));
    cleanupHandlers.push(() => video.removeEventListener('pause', onSourcePause));
    const onLeave = () => { void stopPiP(); };
    tempVideo.addEventListener('leavepictureinpicture', onLeave);
    cleanupHandlers.push(() => tempVideo.removeEventListener('leavepictureinpicture', onLeave));

    // Chrome omits the standard PiP Play/Pause control for MediaStream video
    // such as canvas.captureStream(). Media Session action handlers explicitly
    // request those controls and route them back to the real page video.
    installMediaSessionControls(video);

    try {
      // MediaStream PiP needs its temporary video to be started, but starting it
      // must not cause a paused source video to resume through the play-sync handler.
      syncing = true;
      await tempVideo.play().catch(() => {});
      syncing = false;
      await tempVideo.requestPictureInPicture();
      if (wasPausedBeforePiP) {
        syncing = true;
        try { video.pause(); } catch (_) {}
        try { tempVideo.pause(); } catch (_) {}
        syncing = false;
        // A page/player may react asynchronously to entering PiP. Restore the
        // exact paused state once more on the next task.
        setTimeout(() => {
          syncing = true;
          try { video.pause(); } catch (_) {}
          try { tempVideo.pause(); } catch (_) {}
          syncing = false;
        }, 0);
      }
      hideSourceVideo(video);
    } catch (e) {
      await stopPiP();
      if (await tryNativeLordfilmPiP(video)) return;
      console.warn('[Subtitle PiP] request failed:', e?.name, e?.message);
      return;
    }
  }

  async function togglePiP() {
    if (document.pictureInPictureElement || pipActive) {
      try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); } catch (_) {}
      await stopPiP();
      showDonateNoticeOnce();
      return;
    }
    await startPiP();
    showDonateNoticeOnce();
  }

  document.addEventListener('leavepictureinpicture', () => { if (pipActive) void stopPiP(); });
  window.__subtitlePiPToggle = togglePiP;
  window.__subtitlePiPStart = startPiP;
  window.__subtitlePiPStop = stopPiP;
})();
