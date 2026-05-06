(function(){
  const scriptEl = document.currentScript;

  function getBaseUrl() {
    try { return new URL(scriptEl.src).origin; } catch (e) { return ''; }
  }

  const baseUrl = getBaseUrl();
  const autoOpen = scriptEl.dataset.autoOpen === 'true' || scriptEl.getAttribute('data-auto-open') === 'true';
  const openDelay = Number(scriptEl.dataset.openDelay || scriptEl.getAttribute('data-open-delay') || 300);

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
    for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
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

    if (/iPhone/i.test(ua)) { deviceType = '手機'; deviceModel = 'iPhone'; os = 'iOS'; }
    else if (/iPad/i.test(ua)) { deviceType = '平板'; deviceModel = 'iPad'; os = 'iPadOS'; }
    else if (/Android/i.test(ua)) {
      deviceType = /Mobile/i.test(ua) ? '手機' : '平板';
      os = 'Android';
      const m = ua.match(/\(([^)]+)\)/);
      if (m && m[1]) {
        const parts = m[1].split(';').map(x => x.trim()).filter(Boolean);
        deviceModel = parts[parts.length - 1] || 'Android';
      } else deviceModel = 'Android';
    }
    else if (/Windows/i.test(ua)) { deviceType = '電腦'; deviceModel = 'Windows PC'; os = 'Windows'; }
    else if (/Macintosh|Mac OS/i.test(ua)) { deviceType = '電腦'; deviceModel = 'Mac'; os = 'macOS'; }
    else if (/Linux/i.test(ua)) { deviceType = '電腦'; deviceModel = 'Linux PC'; os = 'Linux'; }

    if (/Edg/i.test(ua)) browser = 'Edge';
    else if (/Chrome/i.test(ua) && !/Edg/i.test(ua)) browser = 'Chrome';
    else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
    else if (/Firefox/i.test(ua)) browser = 'Firefox';

    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
    return {
      visitor_code: randomCode(6),
      device_type: deviceType,
      device_model: deviceModel,
      device_os: os,
      browser,
      platform,
      language,
      timezone,
      screen_size: screenSize,
      user_agent: ua,
      network_type: connection.type || '',
      network_effective_type: connection.effectiveType || '',
      network_downlink: String(connection.downlink || ''),
      network_rtt: String(connection.rtt || '')
    };
  }

  const deviceInfo = getDeviceInfo();
  const generatedName = `${deviceInfo.device_model || deviceInfo.device_type}-${deviceInfo.visitor_code}`;
  const storageKey = 'ccs_conversation_id_' + (pageMeta.source_site || location.pathname || 'default');
  const visitorNameKey = storageKey + '_visitor_name';

  let conversationId = localStorage.getItem(storageKey) || '';
  let visitorName = localStorage.getItem(visitorNameKey) || generatedName;
  let socketLoaded = false;
  let socket = null;
  let config = null;
  let openInProgress = null;
  let createConversationPromise = null;
  let greetingRenderedFor = '';

  localStorage.setItem(visitorNameKey, visitorName);

  const css = `
  #ccs-btn{position:fixed;right:18px;bottom:18px;z-index:999999;width:62px;height:62px;border-radius:50%;border:0;background:linear-gradient(135deg,#ffd45a,#d99300);box-shadow:0 8px 24px rgba(0,0,0,.35);font-size:28px;cursor:pointer;touch-action:manipulation}
  #ccs-box{display:none;position:fixed;right:18px;bottom:90px;z-index:999999;width:350px;max-width:calc(100vw - 30px);height:520px;max-height:calc(100vh - 120px);border-radius:18px;overflow:hidden;background:#111;color:#fff;font-family:Arial,'Noto Sans TC',sans-serif;box-shadow:0 12px 36px rgba(0,0,0,.45);border:1px solid #e2b13c}
  #ccs-head{padding:14px 16px;background:linear-gradient(135deg,#f4c542,#b8860b);color:#111;font-weight:700;display:flex;align-items:center;justify-content:space-between}
  #ccs-title{font-size:16px;font-weight:900}#ccs-status{font-size:12px;border-radius:999px;padding:3px 8px;background:#113d25;color:#0f6}#ccs-status.off{background:#432222;color:#ff9c9c}
  #ccs-visitor{padding:8px 14px;background:#151515;border-bottom:1px solid #333;font-size:12px;color:#bbb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #ccs-msgs{height:388px;overflow:auto;padding:14px;background:#181818}.ccs-msg{padding:10px 12px;margin:0 0 10px;border-radius:12px;font-size:14px;line-height:1.35;white-space:pre-wrap}.ccs-v{background:#f4c542;color:#111;margin-left:45px}.ccs-a{background:#2b2b2b;color:#fff;margin-right:45px}
  #ccs-input{display:flex;border-top:1px solid #333;background:#111;padding:8px;gap:6px}#ccs-text{flex:1;border:0;outline:0;padding:12px;border-radius:10px;background:#222;color:#fff;font-size:16px;line-height:20px}#ccs-send{width:72px;border:0;background:#f4c542;color:#111;font-weight:700;cursor:pointer;border-radius:10px;font-size:16px;touch-action:manipulation}
  @media(max-width:480px){#ccs-box{right:10px;bottom:84px;width:calc(100vw - 20px);height:calc(100vh - 110px);max-height:calc(100vh - 110px)}#ccs-msgs{height:calc(100vh - 245px)}}`;

  document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);
  document.body.insertAdjacentHTML('beforeend', `
    <button id="ccs-btn" type="button">💬</button>
    <div id="ccs-box">
      <div id="ccs-head"><span id="ccs-title">领取10USDT窗口</span><span id="ccs-status">在線</span></div>
      <div id="ccs-visitor">訪客：${escapeHtml(visitorName)}</div>
      <div id="ccs-msgs"></div>
      <div id="ccs-input"><input id="ccs-text" placeholder="请输入您的问题..."/><button id="ccs-send" type="button">发送</button></div>
    </div>`);

  const btn = document.getElementById('ccs-btn');
  const box = document.getElementById('ccs-box');
  const msgs = document.getElementById('ccs-msgs');
  const input = document.getElementById('ccs-text');
  const send = document.getElementById('ccs-send');

  function escapeHtml(s){ return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function add(text,type,name){ const d=document.createElement('div'); d.className='ccs-msg '+(type==='visitor'?'ccs-v':'ccs-a'); d.innerHTML=escapeHtml((type==='agent'&&name?name+': ':'')+text); msgs.appendChild(d); msgs.scrollTop=msgs.scrollHeight; }

  async function getConfig(){
    config = await fetch(baseUrl + '/config?v=' + Date.now(), { cache:'no-store' }).then(r=>r.json()).catch(()=>({title:'领取10USDT窗口',support_status:'online',online_greeting:'你好,领取10U体验金吗？',offline_greeting:'目前非工作时间,请留下联系方式我们会与你联系协助你领取体验金。'}));
    document.getElementById('ccs-title').textContent = config.title || '领取10USDT窗口';
    const st=document.getElementById('ccs-status');
    if(config.support_status==='offline'){ st.textContent='離線'; st.classList.add('off'); } else { st.textContent='在線'; st.classList.remove('off'); }
    return config;
  }

  async function ensureConversation(){
    if(conversationId) return conversationId;
    if(createConversationPromise) return createConversationPromise;
    createConversationPromise = (async()=>{
      const payload = Object.assign({}, pageMeta, deviceInfo, { visitor_name: visitorName, visitor_contact:'', visitor_account:'' });
      const r = await fetch(baseUrl + '/api/widget/conversations', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
      const j = await r.json();
      conversationId = j.id;
      localStorage.setItem(storageKey, conversationId);
      return conversationId;
    })();
    try { return await createConversationPromise; } finally { createConversationPromise = null; }
  }

  async function loadMessages(){
    await getConfig();
    await ensureConversation();
    const list = await fetch(baseUrl + '/api/widget/conversations/' + conversationId + '/messages?v=' + Date.now(), { cache:'no-store' }).then(r=>r.json()).catch(()=>[]);
    msgs.innerHTML = '';
    if(!list.length){
      const greeting = config.support_status === 'offline' ? config.offline_greeting : config.online_greeting;
      const key = conversationId + ':' + greeting;
      greetingRenderedFor = key;
      add(greeting, 'agent', '');
    } else {
      greetingRenderedFor = '';
      list.forEach(m => add(m.body, m.sender_type, m.sender_name));
    }
  }

  function loadSocket(){
    if(socketLoaded || !conversationId) return;
    socketLoaded = true;
    const s = document.createElement('script');
    s.src = baseUrl + '/socket.io/socket.io.js';
    s.onload = function(){
      socket = io(baseUrl);
      socket.emit('visitor_join', conversationId);
      socket.on('message', m => { if(m.sender_type === 'agent') add(m.body, 'agent', m.sender_name); });
      socket.on('settings_updated', () => getConfig());
    };
    document.head.appendChild(s);
  }

  async function openChat(){
    if(openInProgress) return openInProgress;
    openInProgress = (async()=>{
      box.style.display = 'block';
      await loadMessages();
      loadSocket();
      setTimeout(()=>input.focus({preventScroll:true}), 250);
    })();
    try { return await openInProgress; } finally { openInProgress = null; }
  }
  function closeChat(){ box.style.display='none'; }
  function toggleChat(){ if(box.style.display==='block') closeChat(); else openChat(); }

  window.CustomerChat = { open: openChat, close: closeChat, toggle: toggleChat };
  btn.onclick = toggleChat;

  async function submit(){
    const body = input.value.trim();
    if(!body) return;
    input.value = '';
    await ensureConversation();
    add(body, 'visitor', '');
    await fetch(baseUrl + '/api/widget/conversations/' + conversationId + '/messages', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ body }) });
  }
  send.onclick = submit;
  input.addEventListener('keydown', e => { if(e.key === 'Enter') submit(); });

  if(autoOpen){ setTimeout(() => openChat(), Number.isFinite(openDelay) ? openDelay : 300); }
})();
