(function(){
  const scriptEl = document.currentScript;
  const baseUrl = scriptEl.src.replace('/widget.js','');
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

  const storageKey = 'ccs_conversation_id_' + (pageMeta.source_site || location.pathname || 'default');
  let conversationId = localStorage.getItem(storageKey) || '';
  let profile = {};
  try { profile = JSON.parse(localStorage.getItem(storageKey + '_profile') || '{}'); } catch(_) { profile = {}; }
  let socketLoaded=false, socket=null, config=null, profileSaved=!!profile.visitor_name;

  const css = `
  #ccs-btn{position:fixed;right:18px;bottom:18px;z-index:999999;width:62px;height:62px;border-radius:50%;border:0;background:linear-gradient(135deg,#ffd45a,#d99300);box-shadow:0 8px 24px rgba(0,0,0,.35);font-size:28px;cursor:pointer}
  #ccs-box{display:none;position:fixed;right:18px;bottom:90px;z-index:999999;width:350px;max-width:calc(100vw - 30px);height:520px;max-height:calc(100vh - 120px);border-radius:18px;overflow:hidden;background:#111;color:#fff;font-family:Arial,sans-serif;box-shadow:0 12px 36px rgba(0,0,0,.45);border:1px solid #e2b13c}
  #ccs-head{padding:14px 16px;background:linear-gradient(135deg,#f4c542,#b8860b);color:#111;font-weight:700;display:flex;align-items:center;justify-content:space-between}
  #ccs-status{font-size:12px;border-radius:999px;padding:3px 8px;background:#113d25;color:#0f6}
  #ccs-status.off{background:#432222;color:#ff9c9c}
  #ccs-profile{padding:14px;background:#181818;border-bottom:1px solid #333}
  #ccs-profile input{display:block;width:100%;box-sizing:border-box;margin:0 0 8px;padding:11px;border-radius:10px;border:1px solid #333;background:#222;color:#fff;outline:0}
  #ccs-profile button,#ccs-send{border:0;background:#f4c542;color:#111;font-weight:700;cursor:pointer;border-radius:10px}
  #ccs-profile button{width:100%;padding:11px}
  #ccs-msgs{height:350px;overflow:auto;padding:14px;background:#181818}.ccs-msg{padding:10px 12px;margin:0 0 10px;border-radius:12px;font-size:14px;line-height:1.35;white-space:pre-wrap}.ccs-v{background:#f4c542;color:#111;margin-left:45px}.ccs-a{background:#2b2b2b;color:#fff;margin-right:45px}.ccs-meta{display:block;font-size:11px;opacity:.65;margin-top:4px}
  #ccs-input{display:flex;border-top:1px solid #333;background:#111;padding:8px;gap:6px}#ccs-text{flex:1;border:0;outline:0;padding:12px;border-radius:10px;background:#222;color:#fff}#ccs-send{width:72px}
  .ccs-hide{display:none!important}`;
  document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);
  document.body.insertAdjacentHTML('beforeend', `<button id="ccs-btn">💬</button><div id="ccs-box"><div id="ccs-head"><span id="ccs-title">Suporte Online</span><span id="ccs-status">在線</span></div><div id="ccs-profile"><input id="ccs-name" placeholder="Nome / 姓名" maxlength="80"><input id="ccs-contact" placeholder="Contato / 聯絡方式（選填）" maxlength="120"><input id="ccs-account" placeholder="ID da conta / 會員帳號（選填）" maxlength="120"><button id="ccs-start">開始聊天</button></div><div id="ccs-msgs"></div><div id="ccs-input"><input id="ccs-text" placeholder="Digite sua mensagem..."/><button id="ccs-send">Enviar</button></div></div>`);

  const btn=document.getElementById('ccs-btn'), box=document.getElementById('ccs-box'), msgs=document.getElementById('ccs-msgs'), input=document.getElementById('ccs-text'), send=document.getElementById('ccs-send');
  const profileBox=document.getElementById('ccs-profile'), startBtn=document.getElementById('ccs-start'), nameInput=document.getElementById('ccs-name'), contactInput=document.getElementById('ccs-contact'), accountInput=document.getElementById('ccs-account');
  nameInput.value=profile.visitor_name||''; contactInput.value=profile.visitor_contact||''; accountInput.value=profile.visitor_account||'';

  function add(text,type,name){ const d=document.createElement('div'); d.className='ccs-msg '+(type==='visitor'?'ccs-v':'ccs-a'); const who=(name&&type==='agent')?name+': ':''; d.innerHTML=escapeHtml(who+text); msgs.appendChild(d); msgs.scrollTop=msgs.scrollHeight; }
  function escapeHtml(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  async function getConfig(){ config=await fetch(baseUrl+'/config').then(r=>r.json()).catch(()=>({title:'Suporte Online',support_status:'online',online_greeting:'Ola! Como podemos ajudar?',offline_greeting:'Atendimento offline no momento. Deixe sua mensagem e responderemos em breve.'})); document.getElementById('ccs-title').textContent=config.title||'Suporte Online'; const st=document.getElementById('ccs-status'); if(config.support_status==='offline'){ st.textContent='離線'; st.classList.add('off'); } else { st.textContent='在線'; st.classList.remove('off'); } return config; }
  async function ensureConversation(){
    if(conversationId) return conversationId;
    const payload=Object.assign({}, pageMeta, profile);
    const r=await fetch(baseUrl+'/api/widget/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const j=await r.json(); conversationId=j.id; localStorage.setItem(storageKey,conversationId); return conversationId;
  }
  async function saveProfile(){
    profile={ visitor_name:nameInput.value.trim(), visitor_contact:contactInput.value.trim(), visitor_account:accountInput.value.trim() };
    if(!profile.visitor_name){ nameInput.focus(); return false; }
    localStorage.setItem(storageKey + '_profile', JSON.stringify(profile));
    profileSaved=true;
    await ensureConversation();
    await fetch(baseUrl+'/api/widget/conversations/'+conversationId+'/profile',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(profile)}).catch(()=>{});
    profileBox.classList.add('ccs-hide');
    return true;
  }
  async function loadMessages(){
    await getConfig();
    msgs.innerHTML='';
    if(profileSaved) profileBox.classList.add('ccs-hide'); else profileBox.classList.remove('ccs-hide');
    if(profileSaved) await ensureConversation();
    const greeting = config.support_status==='offline' ? config.offline_greeting : config.online_greeting;
    if(!conversationId){ add(greeting,'agent',''); return; }
    const list=await fetch(baseUrl+'/api/widget/conversations/'+conversationId+'/messages').then(r=>r.json()).catch(()=>[]);
    if(!list.length) add(greeting,'agent','');
    list.forEach(m=>add(m.body,m.sender_type,m.sender_name));
  }
  function loadSocket(){ if(socketLoaded || !conversationId) return; socketLoaded=true; const s=document.createElement('script'); s.src=baseUrl+'/socket.io/socket.io.js'; s.onload=function(){ socket=io(baseUrl); socket.emit('visitor_join',conversationId); socket.on('message',m=>{ if(m.sender_type==='agent') add(m.body,'agent',m.sender_name); }); socket.on('settings_updated',()=>getConfig()); }; document.head.appendChild(s); }
  btn.onclick=async()=>{ box.style.display=box.style.display==='block'?'none':'block'; if(box.style.display==='block'){ await loadMessages(); if(profileSaved){ await ensureConversation(); loadSocket(); } } };
  startBtn.onclick=async()=>{ const ok=await saveProfile(); if(ok){ await loadMessages(); loadSocket(); } };
  async function submit(){ const body=input.value.trim(); if(!body) return; if(!profileSaved){ const ok=await saveProfile(); if(!ok) return; loadSocket(); } input.value=''; await ensureConversation(); add(body,'visitor',''); await fetch(baseUrl+'/api/widget/conversations/'+conversationId+'/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body})}); }
  send.onclick=submit; input.addEventListener('keydown',e=>{ if(e.key==='Enter') submit(); });
})();
