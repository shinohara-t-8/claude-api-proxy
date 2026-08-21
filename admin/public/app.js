const form = document.getElementById('form');
const logEl = document.getElementById('log');
const toolList = document.getElementById('toolList');
const submitBtn = document.getElementById('submitBtn');
const kindEl = document.getElementById('kind');
const pushRow = document.getElementById('pushRow');
const secretLabel = document.getElementById('secretLabel');
const kindHint = document.getElementById('kindHint');
const apiKeyEl = document.getElementById('apiKey');
const singleKeyFields = document.getElementById('singleKeyFields');
const dropboxFields = document.getElementById('dropboxFields');
const accessTokenEl = document.getElementById('accessToken');
const appKeyEl = document.getElementById('appKey');
const appSecretEl = document.getElementById('appSecret');
const refreshTokenEl = document.getElementById('refreshToken');

const KIND_UI = {
  claude: {
    label: 'Anthropic API Key',
    placeholder: 'sk-ant-...',
    hint: 'Claude: Secret作成 → プロキシマップ更新 →（任意）自動デプロイ',
    showPush: true,
    multiField: false,
  },
  openai: {
    label: 'OpenAI API Key',
    placeholder: 'sk-...',
    hint: 'ChatGPT: Secret Manager に保管のみ（中継プロキシは未接続）',
    showPush: false,
    multiField: false,
  },
  gemini: {
    label: 'Gemini API Key',
    placeholder: 'AIza...',
    hint: 'Gemini: Secret Manager に保管のみ（中継プロキシは未接続）',
    showPush: false,
    multiField: false,
  },
  dropbox: {
    hint: 'Dropbox: 4項目を JSON で Secret Manager に保管（中継プロキシは未接続）',
    showPush: false,
    multiField: true,
  },
};

function setLog(text, type) {
  logEl.textContent = text;
  logEl.classList.remove('ok', 'err');
  if (type) logEl.classList.add(type);
}

function clearSecretFields() {
  apiKeyEl.value = '';
  accessTokenEl.value = '';
  appKeyEl.value = '';
  appSecretEl.value = '';
  refreshTokenEl.value = '';
}

function syncKindUI() {
  const kind = kindEl.value;
  const ui = KIND_UI[kind] || KIND_UI.claude;

  if (ui.multiField) {
    singleKeyFields.hidden = true;
    dropboxFields.hidden = false;
    apiKeyEl.required = false;
    accessTokenEl.required = true;
    appKeyEl.required = true;
    appSecretEl.required = true;
    refreshTokenEl.required = true;
  } else {
    singleKeyFields.hidden = false;
    dropboxFields.hidden = true;
    apiKeyEl.required = true;
    accessTokenEl.required = false;
    appKeyEl.required = false;
    appSecretEl.required = false;
    refreshTokenEl.required = false;
    secretLabel.textContent = ui.label;
    apiKeyEl.placeholder = ui.placeholder;
  }

  pushRow.style.display = ui.showPush ? '' : 'none';
  kindHint.textContent = ui.hint;
}

function buildPayload() {
  const kind = kindEl.value;
  const toolId = document.getElementById('toolId').value.trim();
  const push = kind === 'claude' && document.getElementById('push').checked;

  if (kind === 'dropbox') {
    return {
      kind,
      toolId,
      push,
      credentials: {
        access_token: accessTokenEl.value.trim(),
        app_key: appKeyEl.value.trim(),
        app_secret: appSecretEl.value.trim(),
        refresh_token: refreshTokenEl.value.trim(),
      },
    };
  }

  return {
    kind,
    toolId,
    push,
    apiKey: apiKeyEl.value.trim(),
  };
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

  submitBtn.disabled = true;
  setLog('実行中…（キーはログに出しません）');

  try {
    const payload = buildPayload();
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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
    clearSecretFields();
    await refreshTools();
  } catch (err) {
    setLog(String(err.message || err), 'err');
  } finally {
    submitBtn.disabled = false;
  }
});

refreshTools().catch((err) => setLog(String(err.message || err), 'err'));
