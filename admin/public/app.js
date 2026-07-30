const form = document.getElementById('form');
const logEl = document.getElementById('log');
const toolList = document.getElementById('toolList');
const submitBtn = document.getElementById('submitBtn');

function setLog(text, type) {
  logEl.textContent = text;
  logEl.classList.remove('ok', 'err');
  if (type) logEl.classList.add(type);
}

async function refreshTools() {
  const res = await fetch('/api/tools');
  const data = await res.json();
  toolList.innerHTML = '';
  if (!data.tools || data.tools.length === 0) {
    toolList.innerHTML = '<li>まだありません</li>';
    return;
  }
  data.tools.forEach((t) => {
    const li = document.createElement('li');
    li.innerHTML = `<code>${t.toolId}</code><span>${t.secretName}</span>`;
    toolList.appendChild(li);
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const toolId = document.getElementById('toolId').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();
  const push = document.getElementById('push').checked;

  submitBtn.disabled = true;
  setLog('実行中…（キーはログに出しません）');

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolId, apiKey, push }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || '登録に失敗しました');
    }

    const lines = [
      '成功',
      `toolId: ${data.toolId}`,
      `secret: ${data.secretName}`,
      `header: ${data.proxyHeader}`,
      `url: ${data.proxyUrl}`,
      '',
      ...data.steps.map((s) => `[${s.step}] ${s.detail}`),
    ];
    setLog(lines.join('\n'), 'ok');
    document.getElementById('apiKey').value = '';
    await refreshTools();
  } catch (err) {
    setLog(String(err.message || err), 'err');
  } finally {
    submitBtn.disabled = false;
  }
});

refreshTools().catch((err) => setLog(String(err.message || err), 'err'));
