(function () {
  const scriptEl = document.currentScript;

  function getBaseUrl() {
    try {
      const u = new URL(scriptEl.src);
      return u.origin;
    } catch (e) {
      return '';
    }
  }

  const baseUrl = getBaseUrl();

  const autoOpen =
    scriptEl.dataset.autoOpen === 'true' ||
    scriptEl.getAttribute('data-auto-open') === 'true';

  const openDelay = Number(
    scriptEl.dataset.openDelay ||
      scriptEl.getAttribute('data-open-delay') ||
      300
  );

  const pageMeta = {
    source_site: scriptEl.dataset.site || '',
    source_title: scriptEl.dataset.title || document.title || '',
    source_campaign: scriptEl.dataset.campaign || '',
    source_url: location.href,
    source_referrer: document.referrer || ''
  };

  const params = new URLSearchParams(location.search);
  pageMeta.utm_source = params.get('utm_source') || '';
  pageMeta.utm_medium = params.get('utm_medium') || '';
  pageMeta.utm_campaign = params.get('utm_campaign') || pageMeta.source_campaign;

  function randomCode(len) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < len; i++) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  function getDeviceInfo() {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const language = navigator.language || '';
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const screenSize = `${window.screen.width}x${window.screen.height}`;

    let deviceType = '電腦';
    let deviceModel = 'Unknown Device';
    let os = 'Unknown OS';
    let browser = 'Unknown Browser';

    if (/iPhone/i.test(ua)) {
      deviceType = '手機';
      deviceModel = 'iPhone';
      os = 'iOS';
    } else if (/iPad/i.test(ua)) {
      deviceType = '平板';
      deviceModel = 'iPad';
      os = 'iPadOS';
    } else if (/Android/i.test(ua)) {
      deviceType = /Mobile/i.test(ua) ? '手機' : '平板';
      os = 'Android';

      const androidMatch = ua.match(/\(([^)]+)\)/);
      if (androidMatch && androidMatch[1]) {
        const parts = androidMatch[1].split(';').map((x) => x.trim());
        deviceModel = parts[parts.length - 1] || 'Android';
      } else {
        deviceModel = 'Android';
      }
    } else if (/Windows/i.test(ua)) {
      deviceType = '電腦';
      deviceModel = 'Windows PC';
      os = 'Windows';
    } else if (/Macintosh|Mac OS/i.test(ua)) {
      deviceType = '電腦';
      deviceModel = 'Mac';
      os = 'macOS';
    } else if (/Linux/i.test(ua)) {
      deviceType = '電腦';
      deviceModel = 'Linux PC';
      os = 'Linux';
    }

    if (/Edg/i.test(ua)) browser = 'Edge';
    else if (/Chrome/i.test(ua) && !/Edg/i.test(ua)) browser = 'Chrome';
    else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
    else if (/Firefox/i.test(ua)) browser = 'Firefox';

    const connection =
      navigator.connection ||
      navigator.mozConnection ||
      navigator.webkitConnection ||
      {};

    return {
      device_type: deviceType,
      device_model: deviceModel,
      os,
      browser,
      platform,
      language,
      timezone,
      screen_size: screenSize,
      user_agent: ua,
      network_type: connection.effectiveType || '',
      network_downlink: String(connection.downlink || ''),
      network_rtt: String(connection.rtt || ''),
      network_save_data: connection.saveData ? '1' : '0'
    };
  }

  const deviceInfo = getDeviceInfo();
  const visitorCode = randomCode(6);
  const autoVisitorName = `${deviceInfo.device_model || deviceInfo.device_type}-${visitorCode}`;

  const storageKey = 'ccs_conversation_id_' + (pageMeta.source_site || location.pathname || 'default');
  const visitorNameKey = storageKey + '_visitor_name';

  let conversationId = localStorage.getItem(storageKey) || '';
  let visitorName = localStorage.getItem(visitorNameKey) || autoVisitorName;
  let socketLoaded = false;
  let socket = null;
  let config = null;
  let isOpen = false;
  let openInProgress = false;
  let messagesLoaded = false;

  localStorage.setItem(visitorNameKey, visitorName);

  const css = `
  :root{
    --ccs-safe-bottom: env(safe-area-inset-bottom, 0px);
    --ccs-vh: 100dvh;
  }

  #ccs-btn{
    position:fixed;
    right:18px;
    bottom:18px;
    z-index:999999;
    width:72px;
    height:72px;
    border-radius:50%;
    border:0;
    background:linear-gradient(135deg,#f6d66c,#d4a81e);
    box-shadow:0 8px 24px rgba(0,0,0,.35);
    font-size:34px;
    cursor:pointer;
    display:flex;
    align-items:center;
    justify-content:center;
  }

  #ccs-btn.hide{
    display:none !important;
  }

  #ccs-overlay{
    display:none;
    position:fixed;
    inset:0;
    z-index:999997;
    background:rgba(0,0,0,.45);
  }

  #ccs-overlay.show{
    display:block;
  }

  #ccs-box{
    display:none;
    position:fixed;
    right:18px;
    bottom:100px;
    z-index:999998;
    width:360px;
    max-width:calc(100vw - 24px);
    height:620px;
    max-height:calc(var(--ccs-vh) - 120px);
    background:#111;
    color:#fff;
    font-family:Arial,"Noto Sans TC",sans-serif;
    border-radius:18px;
    overflow:hidden;
    border:1px solid #ddb13d;
    box-shadow:0 12px 36px rgba(0,0,0,.45);
    display:flex;
    flex-direction:column;
  }

  #ccs-box.show{
    display:flex;
  }

  #ccs-head{
    flex:0 0 auto;
    padding:14px 16px;
    background:linear-gradient(135deg,#e6bf49,#c79a17);
    color:#111;
    font-weight:700;
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:10px;
  }

  #ccs-title{
    font-size:16px;
    font-weight:900;
    line-height:1.2;
  }

  #ccs-head-actions{
    display:flex;
    align-items:center;
    gap:8px;
  }

  #ccs-status{
    font-size:12px;
    border-radius:999px;
    padding:4px 10px;
    background:#113d25;
    color:#0f6;
    white-space:nowrap;
  }

  #ccs-status.off{
    background:#432222;
    color:#ffb1b1;
  }

  #ccs-close{
    width:30px;
    height:30px;
    border:0;
    border-radius:50%;
    background:rgba(0,0,0,.18);
    color:#111;
    font-size:18px;
    font-weight:900;
    cursor:pointer;
    display:flex;
    align-items:center;
    justify-content:center;
  }

  #ccs-visitor{
    flex:0 0 auto;
    padding:10px 14px;
    background:#151515;
    border-bottom:1px solid #333;
    font-size:12px;
    color:#bbb;
  }

  #ccs-msgs{
    flex:1 1 auto;
    min-height:0;
    overflow:auto;
    padding:14px;
    background:#181818;
    -webkit-overflow-scrolling:touch;
    scroll-behavior:smooth;
  }

  .ccs-msg{
    padding:12px 14px;
    margin:0 0 10px;
    border-radius:14px;
    font-size:16px;
    line-height:1.45;
    white-space:pre-wrap;
    word-break:break-word;
  }

  .ccs-v{
    background:#f4c542;
    color:#111;
    margin-left:42px;
  }

  .ccs-a{
    background:#2b2b2b;
    color:#fff;
    margin-right:42px;
  }

  #ccs-input{
    flex:0 0 auto;
    display:flex;
    align-items:center;
    gap:8px;
    padding:10px 10px calc(10px + var(--ccs-safe-bottom));
    border-top:1px solid #333;
    background:#111;
  }

  #ccs-text{
    flex:1;
    min-width:0;
    height:48px;
    border:0;
    outline:0;
    padding:0 14px;
    border-radius:12px;
    background:#222;
    color:#fff;
    font-size:16px;
    -webkit-appearance:none;
    appearance:none;
  }

  #ccs-text::placeholder{
    color:#888;
    font-size:16px;
  }

  #ccs-send{
    flex:0 0 auto;
    height:48px;
    min-width:78px;
    border:0;
    background:#f4c542;
    color:#111;
    font-weight:700;
    font-size:16px;
    cursor:pointer;
    border-radius:12px;
    padding:0 16px;
  }

  @media (max-width: 768px){
    #ccs-box{
      left:0;
      right:0;
      bottom:0;
      width:100vw;
      max-width:100vw;
      height:var(--ccs-vh);
      max-height:var(--ccs-vh);
      border-radius:0;
      border-left:0;
      border-right:0;
      border-bottom:0;
    }

    #ccs-btn{
      width:68px;
      height:68px;
      right:16px;
      bottom:calc(16px + var(--ccs-safe-bottom));
    }

    #ccs-msgs{
      padding-bottom:14px;
    }
  }
  `;

  document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);

  document.body.insertAdjacentHTML(
    'beforeend',
    `
    <div id="ccs-overlay"></div>

    <button id="ccs-btn" type="button" aria-label="Open chat">💬</button>

    <div id="ccs-box" role="dialog" aria-modal="true">
      <div id="ccs-head">
        <div id="ccs-title">领取10USDT窗口</div>
        <div id="ccs-head-actions">
          <span id="ccs-status">在線</span>
          <button id="ccs-close" type="button" aria-label="Close chat">×</button>
        </div>
      </div>

      <div id="ccs-visitor">訪客：${escapeHtml(visitorName)}</div>

      <div id="ccs-msgs"></div>

      <div id="ccs-input">
        <input id="ccs-text" type="text" placeholder="请输入您的问题..." />
        <button id="ccs-send" type="button">发送</button>
      </div>
    </div>
  `
  );

  const btn = document.getElementById('ccs-btn');
  const overlay = document.getElementById('ccs-overlay');
  const box = document.getElementById('ccs-box');
  const msgs = document.getElementById('ccs-msgs');
  const input = document.getElementById('ccs-text');
  const send = document.getElementById('ccs-send');
  const closeBtn = document.getElementById('ccs-close');

  function updateViewportHeight() {
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--ccs-vh', vh + 'px');
  }

  updateViewportHeight();

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateViewportHeight);
    window.visualViewport.addEventListener('scroll', updateViewportHeight);
  }

  window.addEventListener('resize', updateViewportHeight);
  window.addEventListener('orientationchange', () => {
    setTimeout(updateViewportHeight, 200);
  });

  function scrollMsgsToBottom() {
    msgs.scrollTop = msgs.scrollHeight;
  }

  function add(text, type, name) {
    const d = document.createElement('div');
    d.className = 'ccs-msg ' + (type === 'visitor' ? 'ccs-v' : 'ccs-a');

    let prefix = '';
    if (type === 'agent' && name) {
      prefix = name + ': ';
    }

    d.innerHTML = escapeHtml(prefix + text);
    msgs.appendChild(d);
    scrollMsgsToBottom();
  }

  async function getConfig() {
    config = await fetch(baseUrl + '/config?v=' + Date.now(), {
      cache: 'no-store'
    })
      .then((r) => r.json())
      .catch(() => ({
        title: '领取10USDT窗口',
        support_status: 'online',
        online_greeting: '你好,领取10U体验金吗？',
        offline_greeting: '目前非工作时间,请留下联系方式我们会与你联系协助你领取体验金。'
      }));

    const titleEl = document.getElementById('ccs-title');
    const statusEl = document.getElementById('ccs-status');

    titleEl.textContent = config.title || '领取10USDT窗口';

    if (config.support_status === 'offline') {
      statusEl.textContent = '離線';
      statusEl.classList.add('off');
    } else {
      statusEl.textContent = '在線';
      statusEl.classList.remove('off');
    }

    return config;
  }

  async function checkConversationExists(id) {
    if (!id) return false;

    try {
      const res = await fetch(
        baseUrl + '/api/widget/conversations/' + encodeURIComponent(id) + '/messages?v=' + Date.now(),
        { cache: 'no-store' }
      );

      return res.ok;
    } catch (e) {
      return false;
    }
  }

  async function createConversation() {
    const payload = Object.assign({}, pageMeta, deviceInfo, {
      visitor_name: visitorName,
      visitor_contact: '',
      visitor_account: ''
    });

    const r = await fetch(baseUrl + '/api/widget/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const j = await r.json();

    if (!j || !j.id) {
      throw new Error('create conversation failed');
    }

    conversationId = j.id;
    localStorage.setItem(storageKey, conversationId);

    return conversationId;
  }

  async function ensureConversation() {
    if (conversationId) {
      const exists = await checkConversationExists(conversationId);

      if (exists) {
        return conversationId;
      }

      localStorage.removeItem(storageKey);
      conversationId = '';
      socketLoaded = false;
      socket = null;
      messagesLoaded = false;
    }

    return await createConversation();
  }

  async function loadMessages() {
    await getConfig();
    await ensureConversation();

    msgs.innerHTML = '';

    const greeting =
      config.support_status === 'offline'
        ? config.offline_greeting
        : config.online_greeting;

    const list = await fetch(
      baseUrl + '/api/widget/conversations/' + encodeURIComponent(conversationId) + '/messages?v=' + Date.now(),
      { cache: 'no-store' }
    )
      .then((r) => r.json())
      .catch(() => []);

    if (!list.length) {
      add(greeting, 'agent', '');
    } else {
      list.forEach((m) => add(m.body, m.sender_type, m.sender_name));
    }

    messagesLoaded = true;
  }

  function loadSocket() {
    if (socketLoaded || !conversationId) return;

    socketLoaded = true;

    const s = document.createElement('script');
    s.src = baseUrl + '/socket.io/socket.io.js?v=' + Date.now();

    s.onload = function () {
      socket = io(baseUrl);
      socket.emit('visitor_join', conversationId);

      socket.on('message', (m) => {
        if (m.sender_type === 'agent') {
          add(m.body, 'agent', m.sender_name);
        }
      });

      socket.on('settings_updated', () => getConfig());
    };

    document.head.appendChild(s);
  }

  async function openChat() {
    if (openInProgress) return;

    openInProgress = true;

    isOpen = true;
    box.classList.add('show');
    overlay.classList.add('show');
    btn.classList.add('hide');

    try {
      await loadMessages();
      loadSocket();

      setTimeout(() => {
        updateViewportHeight();
        scrollMsgsToBottom();
      }, 50);
    } finally {
      openInProgress = false;
    }
  }

  function closeChat() {
    isOpen = false;
    box.classList.remove('show');
    overlay.classList.remove('show');
    btn.classList.remove('hide');
  }

  function toggleChat() {
    if (isOpen) closeChat();
    else openChat();
  }

  window.CustomerChat = {
    open: openChat,
    close: closeChat,
    toggle: toggleChat
  };

  btn.onclick = toggleChat;
  closeBtn.onclick = closeChat;
  overlay.onclick = closeChat;

  async function submit() {
    const body = input.value.trim();
    if (!body) return;

    input.value = '';

    await ensureConversation();

    add(body, 'visitor', '');

    await fetch(baseUrl + '/api/widget/conversations/' + encodeURIComponent(conversationId) + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    });

    setTimeout(() => {
      updateViewportHeight();
      scrollMsgsToBottom();
    }, 50);
  }

  send.onclick = submit;

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });

  input.addEventListener('focus', () => {
    setTimeout(() => {
      updateViewportHeight();
      scrollMsgsToBottom();
    }, 350);
  });

  input.addEventListener('click', () => {
    setTimeout(() => {
      updateViewportHeight();
      scrollMsgsToBottom();
    }, 150);
  });

  if (autoOpen) {
    setTimeout(() => {
      openChat();
    }, Number.isFinite(openDelay) ? openDelay : 300);
  }
})();
