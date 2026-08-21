const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INDEX_JS = path.join(ROOT, 'index.js');
const PROJECT_ID = process.env.GCP_PROJECT || 't8studio-infra-jp';
const RUNTIME_SA = process.env.RUNTIME_SA || '970630623430-compute@developer.gserviceaccount.com';

const KIND_CONFIG = {
  claude: {
    label: 'Claude',
    secretPrefix: 'claude-api-key-',
    needsProxyMap: true,
    proxyUrl: 'https://claude-proxy-3fwuq2jhrq-an.a.run.app',
    storageOnly: false,
  },
  openai: {
    label: 'ChatGPT',
    secretPrefix: 'openai-api-key-',
    needsProxyMap: false,
    proxyUrl: null,
    storageOnly: true,
  },
  gemini: {
    label: 'Gemini',
    secretPrefix: 'gemini-api-key-',
    needsProxyMap: false,
    proxyUrl: null,
    storageOnly: true,
  },
  dropbox: {
    label: 'Dropbox',
    secretPrefix: 'dropbox-token-',
    needsProxyMap: false,
    proxyUrl: null,
    storageOnly: true,
  },
};

const SECRET_PREFIX_KIND = [
  ['claude-api-key-', 'claude'],
  ['openai-api-key-', 'openai'],
  ['gemini-api-key-', 'gemini'],
  ['dropbox-token-', 'dropbox'],
];

let gcloudBinCache = null;

function resolveGcloudBin() {
  if (process.env.GCLOUD_BIN) return process.env.GCLOUD_BIN;

  const candidates = [
    path.join(os.homedir(), 'google-cloud-sdk', 'bin', 'gcloud'),
    '/usr/bin/gcloud',
    '/usr/local/bin/gcloud',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const found = run('which', ['gcloud'], { shell: true });
  if (found.ok && found.stdout) return found.stdout.split('\n')[0];

  return null;
}

function getGcloudBin() {
  if (!gcloudBinCache) gcloudBinCache = resolveGcloudBin();
  if (!gcloudBinCache) {
    throw new Error(
      'gcloud が見つかりません。Google Cloud SDK をインストールするか、PATH に ~/google-cloud-sdk/bin を追加してください。'
    );
  }
  return gcloudBinCache;
}

function run(cmd, args, opts = {}) {
  const { shell: shellOpt, ...rest } = opts;
  const shell =
    shellOpt !== undefined
      ? shellOpt
      : process.platform === 'win32' && cmd !== 'git';
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell,
    ...rest,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    error: result.error ? result.error.message : '',
  };
}

function formatCommandError(label, result) {
  const detail = [result.stderr, result.stdout, result.error].filter(Boolean).join('\n').trim();
  if (!detail) {
    return `${label}（詳細なし。gcloud auth login が必要かもしれません）`;
  }
  if (/Reauthentication failed|Please run:\s*\n\s*\$ gcloud auth login/i.test(detail)) {
    return `${label}: GCP の認証が切れています。WSL で次を実行してください:\n  ~/google-cloud-sdk/bin/gcloud auth login\n  ~/google-cloud-sdk/bin/gcloud config set project ${PROJECT_ID}`;
  }
  return `${label}: ${detail}`;
}

function runGcloud(args) {
  return run(getGcloudBin(), args);
}

function assertToolId(toolId) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(toolId)) {
    throw new Error('toolId は小文字英数字とハイフンのみ（先頭は英数字）');
  }
}

function assertSingleKey(kind, value) {
  const key = String(value || '').trim();
  if (!key) {
    throw new Error('キーを入力してください');
  }
  if (kind === 'claude' && !key.startsWith('sk-ant-')) {
    throw new Error('Claude APIキーは sk-ant- で始まる必要があります');
  }
  if (kind === 'openai' && !/^sk-/.test(key)) {
    throw new Error('OpenAI APIキーは sk- で始まる必要があります');
  }
  if (kind === 'gemini' && key.length < 20) {
    throw new Error('Gemini APIキーが短すぎます');
  }
  return key;
}

function assertDropboxCredentials(credentials) {
  const access_token = String(credentials.access_token || '').trim();
  const app_key = String(credentials.app_key || '').trim();
  const app_secret = String(credentials.app_secret || '').trim();
  const refresh_token = String(credentials.refresh_token || '').trim();

  if (!access_token) throw new Error('Dropbox Access Token を入力してください');
  if (!app_key) throw new Error('Dropbox App Key を入力してください');
  if (!app_secret) throw new Error('Dropbox App Secret を入力してください');
  if (!refresh_token) throw new Error('Dropbox Refresh Token を入力してください');

  if (access_token.length < 10) throw new Error('Dropbox Access Token が短すぎます');
  if (app_key.length < 5) throw new Error('Dropbox App Key が短すぎます');
  if (app_secret.length < 5) throw new Error('Dropbox App Secret が短すぎます');
  if (refresh_token.length < 10) throw new Error('Dropbox Refresh Token が短すぎます');

  return { access_token, app_key, app_secret, refresh_token };
}

function buildSecretValue(kind, input) {
  if (kind === 'dropbox') {
    const cred = input.credentials || input;
    const validated = assertDropboxCredentials(cred);
    return JSON.stringify(validated, null, 2);
  }
  return assertSingleKey(kind, input.apiKey);
}

function updateToolMap(toolId, secretName) {
  let js = fs.readFileSync(INDEX_JS, 'utf8');
  const mapPattern = /(const DEFAULT_TOOL_SECRET_MAP = \{)([\s\S]*?)(\r?\n\};)/;
  const m = js.match(mapPattern);
  if (!m) throw new Error('DEFAULT_TOOL_SECRET_MAP が見つかりません');

  const escaped = toolId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^|\\n)\\s*'?${escaped}'?\\s*:`, 'm').test(m[2])) {
    return { changed: false, message: `マップに ${toolId} は既にあります` };
  }

  const entryKey = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(toolId) ? toolId : `'${toolId}'`;
  let body = m[2].replace(/\s+$/, '');
  if (body && !/,\s*$/.test(body)) body += ',';
  body += `\n  ${entryKey}: '${secretName}',`;

  const updated = js.slice(0, m.index) + m[1] + body + m[3] + js.slice(m.index + m[0].length);
  fs.writeFileSync(INDEX_JS, updated, 'utf8');
  return { changed: true, message: `Claudeプロキシマップに ${toolId} を追加しました` };
}

function gitPush(toolId) {
  const logs = [];
  const add = run('git', ['add', 'index.js'], { cwd: ROOT });
  logs.push(add.stdout || add.stderr || 'git add');
  if (!add.ok) throw new Error(`git add 失敗: ${add.stderr || add.stdout}`);

  const status = run('git', ['status', '--porcelain', 'index.js'], { cwd: ROOT });
  if (!status.stdout) {
    return { pushed: false, message: 'コミット対象の差分なし', logs };
  }

  const commit = run(
    'git',
    ['commit', '-m', `Register tool ${toolId} in Claude proxy secret map.`],
    { cwd: ROOT }
  );
  logs.push(commit.stdout || commit.stderr);
  if (!commit.ok) throw new Error(`git commit 失敗: ${commit.stderr || commit.stdout}`);

  const push = run('git', ['push', 'origin', 'HEAD'], { cwd: ROOT });
  logs.push(push.stdout || push.stderr);
  if (!push.ok) throw new Error(`git push 失敗: ${push.stderr || push.stdout}`);

  return { pushed: true, message: 'push 完了（GitHub Actions がデプロイします）', logs };
}

function upsertSecret(secretName, secretValue, steps) {
  const member = `serviceAccount:${RUNTIME_SA}`;
  const keyFile = path.join(os.tmpdir(), `secret-${Date.now()}.txt`);

  try {
    fs.writeFileSync(keyFile, secretValue, { encoding: 'utf8', flag: 'w' });

    const describe = runGcloud(['secrets', 'describe', secretName, `--project=${PROJECT_ID}`]);
    if (!describe.ok) {
      const create = runGcloud([
        'secrets',
        'create',
        secretName,
        '--replication-policy=automatic',
        `--project=${PROJECT_ID}`,
      ]);
      if (!create.ok) {
        throw new Error(formatCommandError('シークレット作成失敗', create));
      }
      steps.push({ step: 'secret_create', ok: true, detail: `created ${secretName}` });
    } else {
      steps.push({ step: 'secret_create', ok: true, detail: `${secretName} は既存。バージョン追加` });
    }

    const addVersion = runGcloud([
      'secrets',
      'versions',
      'add',
      secretName,
      `--data-file=${keyFile}`,
      `--project=${PROJECT_ID}`,
    ]);
    if (!addVersion.ok) {
      throw new Error(formatCommandError('シークレット登録失敗', addVersion));
    }
    steps.push({ step: 'secret_version', ok: true, detail: 'バージョン登録完了' });

    const iam = runGcloud([
      'secrets',
      'add-iam-policy-binding',
      secretName,
      `--member=${member}`,
      '--role=roles/secretmanager.secretAccessor',
      `--project=${PROJECT_ID}`,
      '--quiet',
    ]);
    if (!iam.ok) {
      throw new Error(formatCommandError('IAM 付与失敗', iam));
    }
    steps.push({ step: 'iam', ok: true, detail: 'secretAccessor 付与完了' });
  } finally {
    try {
      if (fs.existsSync(keyFile)) fs.unlinkSync(keyFile);
    } catch (_) {}
  }
}

function kindFromSecretName(secretName) {
  for (const [prefix, kind] of SECRET_PREFIX_KIND) {
    if (secretName.startsWith(prefix)) {
      return { kind, toolId: secretName.slice(prefix.length) };
    }
  }
  return null;
}

/**
 * @param {{ kind?: string, toolId: string, apiKey?: string, credentials?: object, push?: boolean }} input
 */
function registerTool(input) {
  const steps = [];
  const kind = String(input.kind || 'claude').trim().toLowerCase();
  const toolId = String(input.toolId || '').trim();
  const wantPush = Boolean(input.push);

  if (!KIND_CONFIG[kind]) {
    throw new Error('種別は claude、openai、gemini、dropbox のいずれかを指定してください');
  }

  assertToolId(toolId);

  const cfg = KIND_CONFIG[kind];
  const secretName = `${cfg.secretPrefix}${toolId}`;
  const secretValue = buildSecretValue(kind, input);

  steps.push({
    step: 'validate',
    ok: true,
    detail: `kind=${kind}, toolId=${toolId}, secret=${secretName}`,
  });

  upsertSecret(secretName, secretValue, steps);

  let pushResult = { pushed: false, message: 'push 対象なし' };

  if (cfg.needsProxyMap) {
    const mapResult = updateToolMap(toolId, secretName);
    steps.push({ step: 'map', ok: true, detail: mapResult.message });

    if (wantPush) {
      pushResult = gitPush(toolId);
      steps.push({ step: 'push', ok: true, detail: pushResult.message });
    } else {
      steps.push({ step: 'push', ok: true, detail: 'push 未実行（チェックを外しています）' });
    }
  } else {
    steps.push({
      step: 'map',
      ok: true,
      detail: `${cfg.label} は Secret Manager に保管のみ（中継プロキシは未接続）`,
    });
    steps.push({
      step: 'push',
      ok: true,
      detail: `${cfg.label} 登録では Git push / Cloud Run デプロイは不要`,
    });
  }

  let note = null;
  if (cfg.storageOnly) {
    note = `Secret Manager への保管が完了しました（${cfg.label}）。中継プロキシは別途実装が必要です。`;
    if (kind === 'dropbox') {
      note += ' 認証情報は JSON（access_token / app_key / app_secret / refresh_token）で保存しました。';
    }
  }

  return {
    ok: true,
    kind,
    kindLabel: cfg.label,
    toolId,
    secretName,
    proxyHeader: cfg.needsProxyMap ? `X-Tool-Id: ${toolId}` : null,
    proxyUrl: cfg.proxyUrl,
    note,
    steps,
    push: pushResult,
  };
}

function secretNameFromResource(name) {
  const parts = String(name).split('/');
  return parts[parts.length - 1] || String(name);
}

function listRegisteredTools() {
  const bySecret = new Map();

  // Claude: プロキシマップ
  try {
    const js = fs.readFileSync(INDEX_JS, 'utf8');
    const m = js.match(/const DEFAULT_TOOL_SECRET_MAP = \{([\s\S]*?)\n\};/);
    if (m) {
      const re = /^\s*'?([a-z0-9][a-z0-9-]*)'?\s*:\s*'([^']+)'/gm;
      let match;
      while ((match = re.exec(m[1])) !== null) {
        bySecret.set(match[2], {
          kind: 'claude',
          toolId: match[1],
          secretName: match[2],
        });
      }
    }
  } catch (_) {}

  // Secret Manager 上の実体も一覧
  const listed = runGcloud([
    'secrets',
    'list',
    `--project=${PROJECT_ID}`,
    '--format=json',
  ]);
  if (listed.ok && listed.stdout) {
    try {
      const arr = JSON.parse(listed.stdout);
      for (const item of arr) {
        const secretName = secretNameFromResource(item.name || '');
        const parsed = kindFromSecretName(secretName);
        if (!parsed) continue;
        if (parsed.kind === 'claude' && bySecret.has(secretName)) continue;
        bySecret.set(secretName, {
          kind: parsed.kind,
          toolId: parsed.toolId,
          secretName,
        });
      }
    } catch (_) {}
  }

  return Array.from(bySecret.values()).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.toolId.localeCompare(b.toolId);
  });
}

module.exports = { registerTool, listRegisteredTools, ROOT, KIND_CONFIG };
