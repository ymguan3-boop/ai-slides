// 五結防潮閘門動態簡報｜控制程式（無外部相依）
(() => {
  const stage = document.getElementById('stage');
  const slides = [...document.querySelectorAll('.slide')];
  const hud = document.getElementById('hud');
  const notes = document.getElementById('notes');
  const help = document.getElementById('help');
  let cur = -1, step = 0, jumpBuf = '';

  // ---------- 舞台等比縮放 ----------
  function fit() {
    const s = Math.min(innerWidth / 1920, innerHeight / 1080);
    stage.style.transform = `scale(${s}) translate(-50%, -50%)`;
    stage.style.transformOrigin = '0 0';
    stage.style.left = '50%'; stage.style.top = '50%';
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
    stage.style.transformOrigin = 'center center';
  }
  addEventListener('resize', fit); fit();

  // ---------- 數字跳動 ----------
  function countUp(root) {
    root.querySelectorAll('.count').forEach((el) => {
      const to = +el.dataset.to, dec = +(el.dataset.dec || 0), t0 = performance.now(), dur = 1600;
      const delay = parseFloat(getComputedStyle(el.closest('.an') || el).getPropertyValue('--d')) || 0;
      const fmt = (v) => v.toLocaleString('zh-TW', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      el.textContent = fmt(0);
      const tick = (now) => {
        const p = Math.min(1, Math.max(0, (now - t0 - delay * 1000) / dur));
        el.textContent = fmt(to * (1 - Math.pow(1 - p, 3)));
        if (p < 1 && root.classList.contains('active')) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  // ---------- 故事線自動點亮 ----------
  let storyTimer;
  function story(root) {
    clearInterval(storyTimer);
    const nodes = [...root.querySelectorAll('.node')];
    nodes.forEach((n) => n.classList.remove('hot'));
    let i = 0;
    storyTimer = setTimeout(function go() {
      if (!root.classList.contains('active')) return;
      if (i < nodes.length) { nodes[i++].classList.add('hot'); storyTimer = setTimeout(go, 430); }
    }, 600);
  }

  // ---------- 照片輪播 ----------
  let carTimer;
  function carousel(root) {
    clearInterval(carTimer);
    const figs = [...root.querySelectorAll('.carousel figure')], th = [...root.querySelectorAll('.thumb')];
    let i = 0;
    const show = (k) => { i = k; figs.forEach((f, j) => f.classList.toggle('on', j === k)); th.forEach((t, j) => t.classList.toggle('on', j === k)); };
    th.forEach((t, j) => t.onclick = () => { show(j); clearInterval(carTimer); carTimer = setInterval(() => show((i + 1) % figs.length), 5000); });
    show(0);
    carTimer = setInterval(() => show((i + 1) % figs.length), 5000);
  }

  // ---------- 模型 iframe：只在當頁建立，離頁移除釋放 WebGL ----------
  function mountModel(root) {
    const wrap = root.querySelector('.modelwrap');
    const fb = wrap.querySelector('.fallback');
    fb.style.backgroundImage = `url("${root.dataset.fallback}")`;
    fb.dataset.msg = '模型載入中…';
    // 本機（埠號 8770 的三站）或 GitHub Pages（相對路徑）
    // 與簡報同源（本機 server.mjs 與 GitHub Pages 皆提供 models/），手機才能遙控模型
    const url = root.dataset.modelRel;
    const f = document.createElement('iframe');
    f.title = root.querySelector('.kicker').textContent;
    f.allow = 'fullscreen';
    f.src = url;
    let ok = false;
    f.onload = () => { ok = true; f.classList.add('ready'); };
    setTimeout(() => { if (!ok) fb.dataset.msg = '模型未能載入，目前顯示預錄截圖'; }, 9000);
    wrap.appendChild(f);
  }
  // ---------- 手機遙控 3D 模型（同源 iframe：直接操作模型自身的按鈕；旋轉／縮放以模擬滑鼠） ----------
  function modelCmd(m) {
    const s = slides[cur]; if (!s.dataset.model || !m) return false;
    const f = s.querySelector('.modelwrap iframe'); if (!f) return false;
    let doc, win; try { doc = f.contentDocument; win = f.contentWindow; } catch (e) { return false; }
    if (!doc) return false;
    const btn = (label) => [...doc.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').trim() === label || b.textContent.trim() === label);
    const canvas = doc.querySelector('canvas');
    if (m.t === 'btn') { const b = btn(m.label); if (b) b.click(); return !!b; }
    if (m.t === 'sel') { const el = [...doc.querySelectorAll('select')].find((x) => x.getAttribute('aria-label') === m.label); if (!el) return false; el.value = m.value; el.dispatchEvent(new win.Event('change', { bubbles: true })); el.dispatchEvent(new win.Event('input', { bubbles: true })); return true; }
    if (m.t === 'cp') { const row = doc.querySelectorAll('#risk-table-body tr')[m.i]; const td = row && row.querySelector('td'); if (td) td.click(); return !!td; }
    if (!canvas) return false;
    const r = canvas.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (m.t === 'zoom') { canvas.dispatchEvent(new win.WheelEvent('wheel', { deltaY: m.dir > 0 ? -240 : 240, clientX: cx, clientY: cy, bubbles: true, cancelable: true })); return true; }
    if (m.t === 'rot') {
      canvas.setPointerCapture = () => {}; canvas.releasePointerCapture = () => {}; canvas.hasPointerCapture = () => true;
      const ev = (type, x, y, buttons) => new win.PointerEvent(type, { pointerId: 77, pointerType: 'mouse', isPrimary: true, button: 0, buttons, clientX: x, clientY: y, bubbles: true, cancelable: true, view: win });
      const dx = Math.max(-260, Math.min(260, m.dx)), dy = Math.max(-200, Math.min(200, m.dy));
      canvas.dispatchEvent(ev('pointerdown', cx, cy, 1));
      for (let k = 1; k <= 4; k++) { canvas.dispatchEvent(ev('pointermove', cx + dx * k / 4, cy + dy * k / 4, 1)); }
      canvas.dispatchEvent(ev('pointerup', cx + dx, cy + dy, 0));
      return true;
    }
    return false;
  }
  function unmountModel(root) { root.querySelectorAll('.modelwrap iframe').forEach((f) => { f.src = 'about:blank'; f.remove(); }); }

  // ---------- 影片播放器（依旁白時間軸驅動場景與字幕） ----------
  const players = {};
  const emit = () => document.dispatchEvent(new CustomEvent('deckchange'));
  function makePlayer(el) {
    const id = el.dataset.filmId, data = window.FILMS && window.FILMS[id];
    const audio = new Audio(`media/film-${id}.mp3`);
    audio.preload = 'auto';
    const scenes = [...el.querySelectorAll('.scene')];
    const sub = el.querySelector('.sub'), c1 = el.querySelector('.chap .c1'), c2 = el.querySelector('.chap .c2');
    const bar = el.querySelector('.track i'), track = el.querySelector('.track'), time = el.querySelector('.time');
    const playBtn = el.querySelector('[data-act=play]');
    let active = null, raf;
    data.scenes.forEach((s) => { const u = document.createElement('u'); u.style.left = (s.start / data.duration * 100) + '%'; track.appendChild(u); });
    const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    function setScene(t, force) {
      const idx = Math.max(0, data.scenes.findIndex((s) => t >= s.start && t < s.end));
      const s = data.scenes[idx === -1 ? data.scenes.length - 1 : idx];
      if (active === s.id && !force) return;
      active = s.id;
      scenes.forEach((sc) => {
        const on = sc.dataset.scene === s.id;
        sc.classList.remove('on');
        if (on) { sc.style.setProperty('--off', `${Math.max(0, t - s.start).toFixed(2)}s`); void sc.offsetWidth; sc.classList.add('on'); }
      });
      c1.textContent = `${String(data.scenes.indexOf(s) + 1).padStart(2, '0')} / ${String(data.scenes.length).padStart(2, '0')}`;
      c2.textContent = s.label;
    }
    function render() {
      const t = audio.currentTime;
      setScene(t);
      const cue = data.cues.find((c) => t >= c.start && t < c.end + 0.15);
      sub.textContent = cue ? cue.text : '';
      bar.style.width = (t / data.duration * 100) + '%';
      time.textContent = `${mmss(t)} / ${mmss(data.duration)}`;
      if (!audio.paused) raf = requestAnimationFrame(render);
    }
    function play() { audio.play().then(() => { el.classList.remove('paused'); playBtn.textContent = '❚❚'; render(); emit(); }).catch(() => el.classList.add('paused')); }
    function pause() { audio.pause(); el.classList.add('paused'); playBtn.textContent = '▶'; cancelAnimationFrame(raf); emit(); }
    function toggle() { audio.paused ? play() : pause(); }
    function seek(t) { audio.currentTime = Math.max(0, Math.min(data.duration - 0.05, t)); active = null; setScene(audio.currentTime, true); render(); }
    function restart() { seek(0); play(); }
    audio.addEventListener('ended', () => { pause(); });
    el.querySelector('.bigplay').onclick = play;
    playBtn.onclick = toggle;
    el.querySelector('[data-act=restart]').onclick = restart;
    el.querySelector('[data-act=cc]').onclick = () => el.classList.toggle('nocc');
    track.onclick = (e) => { const r = track.getBoundingClientRect(); seek((e.clientX - r.left) / r.width * data.duration); };
    return { el, play, pause, toggle, restart, seek, reset() { pause(); seek(0); }, get paused() { return audio.paused; } };
  }
  document.querySelectorAll('.film').forEach((f) => players[f.dataset.filmId] = makePlayer(f));

  // ---------- 第8頁：整理參數計算式（自動短暫顯示，點「整理參數」可再看） ----------
  let calcTimers = [];
  const CALC_SEC = 12;
  function calcShow(root, sec = CALC_SEC) {
    const pop = root.querySelector('.calcpop'); if (!pop) return;
    calcTimers.forEach(clearTimeout); calcTimers = [];
    pop.style.setProperty('--calc', sec + 's');
    pop.classList.remove('show'); void pop.offsetWidth; pop.classList.add('show');
    calcTimers.push(setTimeout(() => pop.classList.remove('show'), sec * 1000));
  }
  function calcHide(root) { calcTimers.forEach(clearTimeout); calcTimers = []; const p = root.querySelector('.calcpop'); if (p) p.classList.remove('show'); }
  document.querySelectorAll('.slide[data-calc]').forEach((root) => {
    const pop = root.querySelector('.calcpop');
    if (pop && !pop.querySelector('.timer')) pop.insertAdjacentHTML('beforeend', '<div class="timer"><i></i></div>');
    root.querySelector('.calc-trigger').addEventListener('click', () => (pop.classList.contains('show') ? calcHide(root) : calcShow(root)));
    pop.addEventListener('click', () => calcHide(root));
  });
  // 工具說明頁的影片
  const slideVideo = (s) => s && s.dataset.video ? s.querySelector('video') : null;
  document.querySelectorAll('.slide[data-video] video').forEach((v) => { v.addEventListener('play', emit); v.addEventListener('pause', emit); });

  // ---------- 換頁 ----------
  function stepsOf(s) { return Math.max(0, ...[...s.querySelectorAll('[data-step]')].map((e) => +e.dataset.step)); }
  function applySteps(s) { s.querySelectorAll('[data-step]').forEach((e) => e.classList.toggle('shown', +e.dataset.step <= step)); }
  function go(n, toStep = 0) {
    n = Math.max(0, Math.min(slides.length - 1, n));
    if (n === cur) { step = toStep; applySteps(slides[n]); return; }
    const prev = slides[cur];
    if (prev) {
      prev.classList.remove('active');
      if (prev.dataset.model) unmountModel(prev);
      if (prev.dataset.film) players[prev.dataset.film].pause();
      if (prev.dataset.calc) calcHide(prev);
      const pv = slideVideo(prev); if (pv) pv.pause();
    }
    cur = n; step = toStep;
    const s = slides[cur];
    s.querySelectorAll('.an').forEach((e) => { e.style.animation = 'none'; void e.offsetWidth; e.style.animation = ''; });
    s.classList.add('active');
    applySteps(s);
    countUp(s);
    if (s.dataset.autoStory) story(s);
    if (s.dataset.carousel) carousel(s); else clearInterval(carTimer);
    if (s.dataset.model) mountModel(s);
    if (s.dataset.calc) calcTimers.push(setTimeout(() => { if (slides[cur] === s) calcShow(s); }, 3200));
    const sv = slideVideo(s); if (sv) { sv.currentTime = 0; setTimeout(() => { if (slides[cur] === s) sv.play().catch(() => {}); }, 900); }
    if (s.dataset.film) { const p = players[s.dataset.film]; p.reset(); setTimeout(() => { if (slides[cur] === s) p.play(); }, 700); }
    hud.querySelector('.sec').textContent = s.dataset.sec || '';
    hud.querySelector('.pg').textContent = `${cur + 1} / ${slides.length}`;
    hud.querySelector('.bar i').style.width = ((cur + 1) / slides.length * 100) + '%';
    notes.querySelector('.body').textContent = s.dataset.notes || '（無備註）';
    history.replaceState(null, '', '#' + (cur + 1));
    emit();
  }
  function next() { const s = slides[cur]; if (step < stepsOf(s)) { step++; applySteps(s); emit(); } else go(cur + 1); }
  function prev() { const s = slides[cur]; if (step > 0) { step--; applySteps(s); emit(); } else if (cur > 0) { go(cur - 1); const p = slides[cur]; step = stepsOf(p); applySteps(p); } }

  // ---------- 指令（鍵盤與手機遙控共用） ----------
  const curFilm = () => { const s = slides[cur]; return s.dataset.film ? players[s.dataset.film] : null; };
  function act(name) {
    const film = curFilm();
    switch (name) {
      case 'next': next(); break;
      case 'prev': prev(); break;
      case 'first': go(0); break;
      case 'last': go(slides.length - 1); break;
      case 'play': { const v = slideVideo(slides[cur]); if (film) film.toggle(); else if (v) { v.paused ? v.play().catch(() => {}) : v.pause(); } } break;
      case 'cc': if (film) { film.el.classList.toggle('nocc'); emit(); } break;
      case 'restart': { const v = slideVideo(slides[cur]); if (film) film.restart(); else if (v) { v.currentTime = 0; v.play().catch(() => {}); } } break;
      case 'notes': notes.classList.toggle('show'); emit(); break;
      case 'help': help.classList.toggle('show'); emit(); break;
      case 'close': help.classList.remove('show'); notes.classList.remove('show'); emit(); break;
      case 'motion': document.body.classList.toggle('reduced'); emit(); break;
      case 'full': document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}); break;
    }
  }
  addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const film = curFilm();
    const k = e.key;
    if (/^d$/.test(k)) { jumpBuf += k; return; }
    if (k === 'Enter' && jumpBuf) { go(+jumpBuf - 1); jumpBuf = ''; return; }
    jumpBuf = '';
    if ((film || slideVideo(slides[cur])) && (k === ' ' || k === 'k')) { e.preventDefault(); act('play'); return; }
    if (slideVideo(slides[cur]) && (k === 'r' || k === 'R')) { act('restart'); return; }
    if (film && (k === 'c' || k === 'C')) { act('cc'); return; }
    if (film && (k === 'r' || k === 'R')) { act('restart'); return; }
    if (['ArrowRight', 'PageDown', ' ', 'ArrowDown'].includes(k)) { e.preventDefault(); act('next'); }
    else if (['ArrowLeft', 'PageUp', 'ArrowUp', 'Backspace'].includes(k)) { e.preventDefault(); act('prev'); }
    else if (k === 'Home') act('first');
    else if (k === 'End') act('last');
    else if (k === 'n' || k === 'N') act('notes');
    else if (k === 'h' || k === 'H' || k === '?') act('help');
    else if (k === 'Escape') act('close');
    else if (k === 'f' || k === 'F') act('full');
    else if (k === 'm' || k === 'M') act('motion');
  });
  document.getElementById('nextbtn').onclick = next;
  document.getElementById('prevbtn').onclick = prev;
  help.onclick = () => help.classList.remove('show');
  // 點模型以外區域：取回鍵盤焦點，避免方向鍵留在 iframe
  stage.addEventListener('pointerdown', (e) => { if (!e.target.closest('iframe')) { document.activeElement && document.activeElement.blur && document.activeElement.blur(); window.focus(); } });

  const fromHash = () => Math.max(0, (parseInt(location.hash.slice(1), 10) || 1) - 1);
  addEventListener("hashchange", () => { if (fromHash() !== cur) go(fromHash()); });
  go(fromHash());
  const state = () => { const f = curFilm(), v = slideVideo(slides[cur]); return { h: cur, total: slides.length, step, steps: stepsOf(slides[cur]), film: !!(f || v), playing: f ? !f.paused : v ? !v.paused : false, cc: f ? !f.el.classList.contains('nocc') : false, notes: notes.classList.contains('show'), help: help.classList.contains('show'), reduced: document.body.classList.contains('reduced'), model: slides[cur].dataset.model === '8771' ? 'risk' : slides[cur].dataset.model === '8772' ? 'audit' : null }; };
  window.DECK = { go, next, prev, act, state, modelCmd, players, get cur() { return cur; }, slides };
})();
