const form = document.getElementById('form');
const logEl = document.getElementById('log');
const toolList = document.getElementById('toolList');
const submitBtn = document.getElementById('submitBtn');
const kindEl = document.getElementById('kind');
const pushRow = document.getElementById('pushRow');
const secretLabel = document.getElementById('secretLabel');
const kindHint = document.getElementById('kindHint');
const apiKeyEl = document.getElementById('apiKey');

function setLog(text, type) {
  logEl.textContent = text;
  logEl.classList.remove('ok', 'err');
  if (type) logEl.classList.add(type);
}

function syncKindUI() {
  const kind = kindEl.value;
  if (kind === 'claude') {
    secretLabel.textContent = 'Anthropic API Key';
    apiKeyEl.placeholder = 'sk-ant-...';
    pushRow.style.display = '';
    kindHint.textContent = 'Claude: Secret作成 → プロキシマップ更新 →（任意）自動デプロイ';
  } else {
    secretLabel.textContent = 'Dropbox Access Token';
    apiKeyEl.placeholder = 'Dropbox token...';
    pushRow.style.display = 'none';
    kindHint.textContent = 'Dropbox: Secret Manager に保管のみ（中継プロキシは未接続）';
  }
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
    const kind = t.kind || 'claude';
    li.innerHTML = `<code>${kind}:${t.toolId}</code><span>${t.secretName}</span>`;
    toolList.appendChild(li);
  });
}

kindEl.addEventListener('change', syncKindUI);
syncKindUI();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const kind = kindEl.value;
  const toolId = document.getElementById('toolId').value.trim();
  const apiKey = apiKeyEl.value.trim();
  const push = kind === 'claude' && document.getElementById('push').checked;

  submitBtn.disabled = true;
  setLog('実行中…（キーはログに出しません）');

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, toolId, apiKey, push }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || '登録に失敗しました');
    }

    const lines = [
      '成功',
      `kind: ${data.kindLabel || data.kind}`,
      `toolId: ${data.toolId}`,
      `secret: ${data.secretName}`,
    ];
    if (data.proxyHeader) lines.push(`header: ${data.proxyHeader}`);
    if (data.proxyUrl) lines.push(`url: ${data.proxyUrl}`);
    if (data.note) lines.push(`note: ${data.note}`);
    lines.push('');
    lines.push(...data.steps.map((s) => `[${s.step}] ${s.detail}`));

    setLog(lines.join('\n'), 'ok');
    apiKeyEl.value = '';
    await refreshTools();
  } catch (err) {
    setLog(String(err.message || err), 'err');
  } finally {
    submitBtn.disabled = false;
  }
});

refreshTools().catch((err) => setLog(String(err.message || err), 'err'));
