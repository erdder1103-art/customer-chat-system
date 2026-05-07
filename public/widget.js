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

  const urlParamsForChat = new URLSearchParams(location.search);
  const shouldOpenFromNotification =
    urlParamsForChat.get('ccs_open') === '1' ||
    location.hash === '#customer-chat';

  const pageMeta = {
    source_site: scriptEl.dataset.site || '',
    source_title: scriptEl.dataset.title || document.title || '',
    source_campaign: scriptEl.dataset.campaign || '',
    source_group: scriptEl.dataset.sourceGroup || scriptEl.getAttribute('data-source-group') || scriptEl.dataset.campaign || '',
    source_label: scriptEl.dataset.sourceLabel || scriptEl.getAttribute('data-source-label') || scriptEl.dataset.title || document.title || '',
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

  #ccs-push-box{
    flex:0 0 auto;
    display:none;
    align-items:center;
    justify-content:space-between;
    gap:8px;
    padding:9px 12px;
    background:#101010;
    border-bottom:1px solid #333;
    color:#ddd;
    font-size:12px;
  }

  #ccs-push-box.show{
    display:flex;
  }

  #ccs-push-btn{
    border:0;
    border-radius:999px;
    background:#f4c542;
    color:#111;
    padding:6px 10px;
    font-size:12px;
    font-weight:800;
    cursor:pointer;
    white-space:nowrap;
  }

  #ccs-push-btn.done{
    background:#145c36;
    color:#39ff88;
  }



  #ccs-push-guide{
    display:none;
    position:absolute;
    inset:0;
    z-index:5;
    align-items:center;
    justify-content:center;
    padding:18px;
    background:rgba(0,0,0,.68);
    backdrop-filter:blur(3px);
  }
  #ccs-push-guide.show{display:flex;}
  .ccs-push-card{
    width:100%;
    max-width:320px;
    border-radius:18px;
    overflow:hidden;
    background:#151515;
    border:1px solid rgba(244,197,66,.65);
    box-shadow:0 20px 60px rgba(0,0,0,.6);
  }
  .ccs-push-card-head{
    padding:15px 16px;
    background:linear-gradient(135deg,#f4c542,#b98408);
    color:#111;
    font-weight:1000;
    font-size:17px;
    line-height:1.25;
  }
  .ccs-push-card-body{
    padding:15px 16px;
    color:#ddd;
    font-size:14px;
    line-height:1.55;
  }
  .ccs-push-card-body strong{color:#ffd45a;}
  .ccs-push-card-actions{
    display:grid;
    gap:8px;
    padding:0 16px 16px;
  }
  .ccs-push-main-btn,
  .ccs-push-later-btn{
    height:44px;
    border:0;
    border-radius:12px;
    font-weight:1000;
    cursor:pointer;
    font-size:15px;
  }
  .ccs-push-main-btn{background:#f4c542;color:#111;}
  .ccs-push-later-btn{background:#2a2a2a;color:#fff;border:1px solid #444;}

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

  #ccs-file-btn{
    flex:0 0 auto;
    width:48px;
    height:48px;
    border:0;
    background:#2b2b2b;
    color:#fff;
    font-weight:700;
    font-size:20px;
    cursor:pointer;
    border-radius:12px;
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

  .ccs-attach{margin-top:8px;}
  .ccs-attach img{max-width:100%;border-radius:10px;display:block;}
  .ccs-attach video{max-width:100%;border-radius:10px;display:block;background:#000;}
  .ccs-attach a{color:#4da3ff;text-decoration:underline;word-break:break-all;}
  .ccs-file-name{display:none;}
  #ccs-file-preview{display:none;flex:0 0 auto;padding:8px 10px;background:#111;border-top:1px solid #333;color:#f4c542;font-size:12px;}
  #ccs-file-preview.show{display:block;}
  .ccs-preview-card{display:flex;align-items:center;gap:10px;}
  .ccs-preview-img{width:68px;height:68px;object-fit:cover;border-radius:10px;border:1px solid #444;}
  .ccs-preview-video{width:110px;height:68px;object-fit:cover;border-radius:10px;background:#000;border:1px solid #444;}
  .ccs-preview-file{max-width:190px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#ddd;background:#222;border:1px solid #444;border-radius:8px;padding:8px;}
  .ccs-preview-remove{border:0;background:#333;color:#fff;border-radius:8px;padding:7px 10px;cursor:pointer;}

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

  

  #ccs-push-guide{
    display:none;
    position:absolute;
    inset:0;
    z-index:5;
    align-items:center;
    justify-content:center;
    padding:18px;
    background:rgba(0,0,0,.68);
    backdrop-filter:blur(3px);
  }
  #ccs-push-guide.show{display:flex;}
  .ccs-push-card{
    width:100%;
    max-width:320px;
    border-radius:18px;
    overflow:hidden;
    background:#151515;
    border:1px solid rgba(244,197,66,.65);
    box-shadow:0 20px 60px rgba(0,0,0,.6);
  }
  .ccs-push-card-head{
    padding:15px 16px;
    background:linear-gradient(135deg,#f4c542,#b98408);
    color:#111;
    font-weight:1000;
    font-size:17px;
    line-height:1.25;
  }
  .ccs-push-card-body{
    padding:15px 16px;
    color:#ddd;
    font-size:14px;
    line-height:1.55;
  }
  .ccs-push-card-body strong{color:#ffd45a;}
  .ccs-push-card-actions{
    display:grid;
    gap:8px;
    padding:0 16px 16px;
  }
  .ccs-push-main-btn,
  .ccs-push-later-btn{
    height:44px;
    border:0;
    border-radius:12px;
    font-weight:1000;
    cursor:pointer;
    font-size:15px;
  }
  .ccs-push-main-btn{background:#f4c542;color:#111;}
  .ccs-push-later-btn{background:#2a2a2a;color:#fff;border:1px solid #444;}

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

      <div id="ccs-push-box">
        <span id="ccs-push-text">離線也想收到客服回覆通知？</span>
        <button id="ccs-push-btn" type="button">開啟通知</button>
      </div>

      <div id="ccs-msgs"></div>

      <div id="ccs-file-preview"></div>

      <div id="ccs-input">
        <input id="ccs-file" type="file" accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.zip" style="display:none" />
        <button id="ccs-file-btn" type="button" title="上传图片/文件">＋</button>
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
  const fileInput = document.getElementById('ccs-file');
  const fileBtn = document.getElementById('ccs-file-btn');
  const filePreview = document.getElementById('ccs-file-preview');
  const input = document.getElementById('ccs-text');
  const send = document.getElementById('ccs-send');
  const closeBtn = document.getElementById('ccs-close');
  const pushBox = document.getElementById('ccs-push-box');
  const pushText = document.getElementById('ccs-push-text');
  const pushBtn = document.getElementById('ccs-push-btn');
  const pushGuide = document.getElementById('ccs-push-guide');
  const pushGuideTitle = document.getElementById('ccs-push-guide-title');
  const pushGuideBody = document.getElementById('ccs-push-guide-body');
  const pushGuideEnable = document.getElementById('ccs-push-guide-enable');
  const pushGuideLater = document.getElementById('ccs-push-guide-later');
  let pushGuideShown = false;

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

  function linkifyEscapedText(text) {
    const escaped = escapeHtml(text);
    return escaped.replace(/(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi, function(url) {
      const cleanUrl = url.replace(/[),.;!?]+$/g, '');
      const tail = url.slice(cleanUrl.length);
      const href = cleanUrl.startsWith('www.') ? 'https://' + cleanUrl : cleanUrl;
      return '<a href="' + href + '" target="_blank" rel="noopener noreferrer" style="color:#4da3ff;text-decoration:underline;word-break:break-all;">' + cleanUrl + '</a>' + tail;
    });
  }


  function absoluteAttachmentUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('//')) return location.protocol + raw;
    if (raw.startsWith('/')) return baseUrl + raw;
    return baseUrl + '/' + raw.replace(/^\/+/, '');
  }

  function isImageAttachment(a) {
    const type = String(a.attachment_type || '').toLowerCase();
    const mime = String(a.attachment_mime || '').toLowerCase();
    const url = String(a.attachment_url || '').toLowerCase().split('?')[0];
    return type === 'image' || mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(url);
  }

  function isVideoAttachment(a) {
    const type = String(a.attachment_type || '').toLowerCase();
    const mime = String(a.attachment_mime || '').toLowerCase();
    const url = String(a.attachment_url || '').toLowerCase().split('?')[0];
    return type === 'video' || mime.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(url);
  }

  function attachmentHtml(a) {
    if (!a || !a.attachment_url) return '';
    const url = absoluteAttachmentUrl(a.attachment_url);
    const name = escapeHtml(a.attachment_name || '附件');

    if (isImageAttachment(a)) {
      return `<div class="ccs-attach"><a href="${url}" target="_blank" rel="noopener noreferrer"><img src="${url}" alt="" loading="lazy" /></a></div>`;
    }

    if (isVideoAttachment(a)) {
      return `<div class="ccs-attach"><video src="${url}" controls playsinline preload="metadata"></video></div>`;
    }

    return `<div class="ccs-attach"><a href="${url}" target="_blank" rel="noopener noreferrer">📎 ${name}</a></div>`;
  }

  function add(text, type, name, attachment) {
    const d = document.createElement('div');
    d.className = 'ccs-msg ' + (type === 'visitor' ? 'ccs-v' : 'ccs-a');

    let prefix = '';
    if (type === 'agent' && name) {
      prefix = name + ': ';
    }

    const bodyHtml = text ? linkifyEscapedText(prefix + text) : (prefix ? escapeHtml(prefix) : '');
    d.innerHTML = bodyHtml + attachmentHtml(attachment || {});
    msgs.appendChild(d);
    scrollMsgsToBottom();
  }

  async function uploadAttachment(file) {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(baseUrl + '/api/upload', { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'upload failed');
    return j;
  }




  function getPushEnvironment() {
    const ua = navigator.userAgent || '';
    const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
    const isInApp = /FBAN|FBAV|Instagram|Line|MicroMessenger|Twitter|TikTok|Telegram|Pinterest/i.test(ua);
    const hasApi = ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);

    if (isInApp) {
      return {
        supported: false,
        reason: 'inapp',
        title: '目前瀏覽器不支援推播',
        body: '您目前可能在 LINE / FB / IG / Telegram / App 內建瀏覽器中開啟。\n\n若要收到離線通知，請使用 Chrome 或 Safari 重新開啟此頁。'
      };
    }

    if (isIOS && !isStandalone) {
      return {
        supported: false,
        reason: 'ios_home',
        title: 'iPhone 需加入主畫面',
        body: 'iPhone 開啟推播通常需要：\n1. 使用 Safari 開啟此頁\n2. 點分享\n3. 加入主畫面\n4. 從桌面圖示重新打開\n5. 再點開啟通知'
      };
    }

    if (!hasApi) {
      return {
        supported: false,
        reason: 'api',
        title: '此瀏覽器不支援推播',
        body: '目前瀏覽器未提供推播功能。建議使用 Android Chrome / Edge / Samsung Internet，或留下 Telegram / 其他聯絡方式。'
      };
    }

    return {
      supported: true,
      reason: 'ok',
      title: '開啟客服通知',
      body: '開啟後，即使您離開網頁，客服回覆時也可以收到通知提醒。\n\n點「立即開啟通知」後，請在瀏覽器提示中按允許。'
    };
  }

  async function reportPushStatus(status) {
    if (!conversationId) return;
    try {
      await fetch(baseUrl + '/api/widget/conversations/' + encodeURIComponent(conversationId) + '/push-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
    } catch (e) {}
  }

  function hidePushGuide() {
    if (pushGuide) pushGuide.classList.remove('show');
  }

  async function showPushGuide(status) {
    if (!pushGuide || !pushGuideTitle || !pushGuideBody || !pushGuideEnable || !pushGuideLater) return;
    if (pushGuideShown) return;
    if (status === 'enabled' || status === 'denied') return;

    pushGuideShown = true;
    const env = getPushEnvironment();
    pushGuideTitle.textContent = env.title;
    pushGuideBody.textContent = env.body;
    pushGuideEnable.textContent = env.supported ? '立即開啟通知' : '我知道了';
    pushGuideLater.textContent = env.supported ? '稍後再說' : '稍後再看';
    pushGuide.classList.add('show');

    if (!env.supported) {
      await reportPushStatus('unsupported');
    }
  }

  async function refreshPushStatus() {
    if (!conversationId || !pushBox || !pushBtn || !pushText) return;

    try {
      const r = await fetch(baseUrl + '/api/widget/conversations/' + encodeURIComponent(conversationId) + '/push-status?v=' + Date.now(), {
        cache: 'no-store'
      });
      const j = await r.json();

      pushBox.classList.add('show');
      const status = j.status || 'none';

      if (status === 'enabled') {
        pushText.textContent = '通知已開啟，離線也能收到客服回覆。';
        pushBtn.textContent = '已開啟';
        pushBtn.classList.add('done');
        pushBtn.disabled = true;
      } else if (status === 'denied') {
        pushText.textContent = '通知已被拒絕，可到瀏覽器網站設定重新開啟。';
        pushBtn.textContent = '已拒絕';
        pushBtn.classList.add('done');
        pushBtn.disabled = true;
      } else if (status === 'unsupported') {
        pushText.textContent = '此瀏覽器不支援推播，請改用 Chrome/Safari 或留下聯絡方式。';
        pushBtn.textContent = '不支援';
        pushBtn.classList.add('done');
        pushBtn.disabled = true;
      } else {
        pushText.textContent = '離線也想收到客服回覆通知？';
        pushBtn.textContent = '開啟通知';
        pushBtn.classList.remove('done');
        pushBtn.disabled = false;
      }
      return status;
    } catch (e) { return 'none'; }
  }

  async function openPushSetup() {
    await ensureConversation();
    const env = getPushEnvironment();

    if (!env.supported) {
      if (pushGuideTitle && pushGuideBody && pushGuide) {
        pushGuideTitle.textContent = env.title;
        pushGuideBody.textContent = env.body;
        pushGuideEnable.textContent = '我知道了';
        pushGuideLater.textContent = '關閉';
        pushGuide.classList.add('show');
      }
      await reportPushStatus('unsupported');
      setTimeout(refreshPushStatus, 600);
      return;
    }

    const notifyUrl = baseUrl + '/notify.html?cid=' + encodeURIComponent(conversationId) + '&return=' + encodeURIComponent(location.href);
    const w = window.open(notifyUrl, '_blank', 'width=430,height=720');

    if (!w) {
      location.href = notifyUrl;
      return;
    }

    setTimeout(refreshPushStatus, 2500);
  }

  window.addEventListener('message', function (event) {
    try {
      if (event.origin !== baseUrl) return;
      if (event.data && event.data.type === 'ccs_push_status') {
        refreshPushStatus();
      }
    } catch (e) {}
  });

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
    refreshPushStatus();

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
      list.forEach((m) => add(m.body, m.sender_type, m.sender_name, m));
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
          add(m.body, 'agent', m.sender_name, m);
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
      const currentPushStatus = await refreshPushStatus();
      setTimeout(() => showPushGuide(currentPushStatus), 250);

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
  if (pushBtn) pushBtn.onclick = openPushSetup;
  if (pushGuideEnable) pushGuideEnable.onclick = function(){ const env=getPushEnvironment(); if(env.supported) openPushSetup(); else hidePushGuide(); };
  if (pushGuideLater) pushGuideLater.onclick = hidePushGuide;

  function clearFilePreview() {
    if (fileInput) fileInput.value = '';
    if (filePreview) {
      filePreview.classList.remove('show');
      filePreview.innerHTML = '';
    }
    input.placeholder = '请输入您的问题...';
  }

  function updateFilePreview() {
    const f = fileInput.files && fileInput.files[0];
    if (!f || !filePreview) {
      clearFilePreview();
      return;
    }
    const type = f.type && f.type.startsWith('image/') ? 'image' : (f.type && f.type.startsWith('video/') ? 'video' : 'file');
    let preview = '';
    if (type === 'image') {
      const url = URL.createObjectURL(f);
      preview = '<img class="ccs-preview-img" src="' + url + '" alt="圖片預覽" onload="setTimeout(()=>URL.revokeObjectURL(this.src),500)">';
    } else if (type === 'video') {
      const url = URL.createObjectURL(f);
      preview = '<video class="ccs-preview-video" src="' + url + '" controls playsinline onloadeddata="setTimeout(()=>URL.revokeObjectURL(this.src),500)"></video>';
    } else {
      preview = '<div class="ccs-preview-file">📎 ' + escapeHtml(f.name) + '</div>';
    }
    filePreview.classList.add('show');
    filePreview.innerHTML = '<div class="ccs-preview-card"><div>已選擇附件，按發送後上傳</div>' + preview + '<button class="ccs-preview-remove" type="button" id="ccs-clear-file">移除</button></div>';
    const clearBtn = document.getElementById('ccs-clear-file');
    if (clearBtn) clearBtn.onclick = clearFilePreview;
    input.placeholder = '可輸入文字後送出';
  }

  async function submit() {
    const body = input.value.trim();
    const file = fileInput.files && fileInput.files[0];
    if (!body && !file) return;

    input.value = '';
    if (!file) input.placeholder = '请输入您的问题...';

    await ensureConversation();

    let attachment = null;
    if (file) {
      try {
        attachment = await uploadAttachment(file);
      } catch (e) {
        alert('上传失败：' + (e.message || '请稍后再试'));
        return;
      } finally {
        clearFilePreview();
      }
    }

    add(body, 'visitor', '', attachment || {});

    await fetch(baseUrl + '/api/widget/conversations/' + encodeURIComponent(conversationId) + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, attachment })
    });

    setTimeout(() => {
      updateViewportHeight();
      scrollMsgsToBottom();
    }, 50);
  }

  fileBtn.onclick = () => fileInput.click();

  fileInput.addEventListener('change', updateFilePreview);

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

  if (autoOpen || shouldOpenFromNotification) {
    setTimeout(() => {
      openChat();
    }, Number.isFinite(openDelay) ? openDelay : 300);
  }
})();