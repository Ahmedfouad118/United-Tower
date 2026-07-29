// Floating AI assistant widget (chat that can query data + post journals/invoices).
const AIWidget = (() => {
  let state = { open: false, messages: [], busy: false };

  function mount() {
    if (document.getElementById('ai-fab')) return;
    const fab = document.createElement('button');
    fab.id = 'ai-fab'; fab.title = 'المساعد الذكي'; fab.textContent = '🤖';
    fab.onclick = toggle;
    document.body.appendChild(fab);
    const panel = document.createElement('div');
    panel.id = 'ai-panel'; panel.style.display = 'none';
    panel.innerHTML = `
      <div class="ai-hd"><span>🤖 المساعد الذكي</span><button id="ai-x">&times;</button></div>
      <div class="ai-body" id="ai-body"><div class="ai-msg ai-bot">أهلاً! أقدر أجاوبك من بيانات النظام، أعملك قيد، أولّد فواتير، أو أطلّعلك تقرير. اكتب طلبك.</div></div>
      <div class="ai-in"><input id="ai-input" placeholder="مثال: اعملي قيد إيجار 250 للوحدة 401" autocomplete="off"><button id="ai-send">إرسال</button></div>`;
    document.body.appendChild(panel);
    panel.querySelector('#ai-x').onclick = toggle;
    panel.querySelector('#ai-send').onclick = send;
    panel.querySelector('#ai-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  }
  function toggle() {
    state.open = !state.open;
    document.getElementById('ai-panel').style.display = state.open ? 'flex' : 'none';
    if (state.open) document.getElementById('ai-input').focus();
  }
  function add(role, text) {
    const b = document.getElementById('ai-body');
    const el = document.createElement('div');
    el.className = 'ai-msg ' + (role === 'user' ? 'ai-user' : 'ai-bot');
    el.textContent = text;
    b.appendChild(el); b.scrollTop = b.scrollHeight;
    return el;
  }
  async function send() {
    const inp = document.getElementById('ai-input');
    const text = inp.value.trim();
    if (!text || state.busy) return;
    inp.value = ''; add('user', text);
    state.messages.push({ role: 'user', content: text });
    state.busy = true;
    const thinking = add('bot', '… جاري التفكير');
    try {
      const res = await API.post('/ai/chat', { messages: state.messages });
      thinking.remove();
      state.messages = res.messages || state.messages;
      add('bot', res.reply || '(لا يوجد رد)');
    } catch (e) {
      thinking.remove();
      add('bot', '⚠️ ' + e.message);
    }
    state.busy = false;
  }
  function unmount() {
    ['ai-fab', 'ai-panel'].forEach((id) => { const el = document.getElementById(id); if (el) el.remove(); });
    state = { open: false, messages: [], busy: false };
  }
  return { mount, unmount };
})();
