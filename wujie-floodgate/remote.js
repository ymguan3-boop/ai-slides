// 簡報手機遙控（沿用 audit-assistant-skills 的 slides-qr-remote 協定）
// QR → mobile.html?room=… ；Ably 頻道 slide-remote-<room>；手機發 nav／cmd，主控端回 sync
(() => {
  const ABLY_KEY = 'y9S__A.igJ5VQ:OI-7oLz4u4V4NdOoTRK90nUxJLhPo5s6KpQxKnWdFdc'; // 公開用 client key（與 road-audit-ai 簡報相同），會出現在公開頁面原始碼
  const BASE = 'https://ymguan3-boop.github.io/ai-slides/wujie-floodgate/';
  const room = 'wujie-' + Math.random().toString(36).slice(2, 8);
  window.__roomId = room;
  const url = BASE + 'mobile.html?room=' + room;
  const IDLE = 10 * 60 * 1000;

  // ---- QR（第一頁、最後一頁右上角，以及 H 說明面板）----
  document.querySelectorAll('.qrbox').forEach((el) => {
    const size = +el.dataset.size || 200;
    try { new QRCode(el, { text: url, width: size, height: size, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.H }); } catch (e) { console.warn('QR failed', e); }
  });

  // 工具說明頁：開啟 APP 的 QR
  document.querySelectorAll('.qrlink').forEach((el) => {
    const size = +el.dataset.size || 150;
    try { new QRCode(el, { text: el.dataset.url, width: size, height: size, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M }); } catch (e) {}
  });

  let ch = null, client = null, idleTimer = null;
  const light = document.getElementById('hostconn');
  const setConn = (on) => { light.textContent = on ? '📱 手機已連線' : '📱 手機未連線'; light.classList.toggle('on', !!on); };
  const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(close, IDLE); };
  function close() { setConn(false); try { ch.presence.leave(); } catch (e) {} try { client.close(); } catch (e) {} }
  const sync = () => { if (ch) try { ch.publish('sync', window.DECK.state()); } catch (e) {} };
  const mobiles = (members) => members.filter((x) => x.clientId && x.clientId.indexOf('mobile-') === 0);

  function init() {
    try {
      client = new Ably.Realtime({ key: ABLY_KEY, clientId: 'host-' + Date.now() });
      ch = client.channels.get('slide-remote-' + room);
      ch.subscribe('nav', (m) => { const h = m.data && m.data.h; if (typeof h === 'number') { DECK.go(h); resetIdle(); } });
      ch.subscribe('cmd', (m) => { const d = m.data || {}; if (d.c === 'model') { DECK.modelCmd(d.m); resetIdle(); return; } if (d.c) { DECK.act(d.c); resetIdle(); sync(); } });
      ch.presence.subscribe('enter', (m) => { if (m.clientId && m.clientId.indexOf('mobile-') === 0) { setConn(true); sync(); resetIdle(); } });
      ch.presence.subscribe('leave', (m) => { if (m.clientId && m.clientId.indexOf('mobile-') === 0) checkMobile(); });
      client.connection.on('connected', () => {
        ch.presence.enter(); checkMobile(); resetIdle();
        clearInterval(window.__presenceTimer); window.__presenceTimer = setInterval(checkMobile, 10000);
      });
      document.addEventListener('deckchange', () => { sync(); resetIdle(); });
      addEventListener('pagehide', () => { try { ch.presence.leave(); } catch (e) {} try { client.close(); } catch (e) {} });
    } catch (e) { console.warn('Ably init failed', e); }
  }
  function checkMobile() { if (!ch) return; ch.presence.get((err, members) => { if (!err) { const on = mobiles(members).length > 0; setConn(on); if (on) sync(); } }); }

  // Ably 由 CDN 載入；離線時簡報其餘功能不受影響
  const s = document.createElement('script');
  s.src = 'https://cdn.ably.com/lib/ably.min-2.js';
  s.onload = init;
  s.onerror = () => console.warn('Ably CDN 無法載入，手機遙控停用');
  document.head.appendChild(s);
})();
