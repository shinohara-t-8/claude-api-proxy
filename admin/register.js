const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INDEX_JS = path.join(ROOT, 'index.js');
const PROJECT_ID = process.env.GCP_PROJECT || 't8studio-infra-jp';
const RUNTIME_SA = process.env.RUNTIME_SA || '970630623430-compute@developer.gserviceaccount.com';

function run(cmd, args, opts = {}) {
  // Windows では gcloud.cmd のために shell が必要。
  // git commit -m を shell 経由にするとメッセージが単語分割されるため git は shell なし。
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
  };
}

function runGcloud(args) {
  return run('gcloud', args);
}

function assertToolId(toolId) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(toolId)) {
    throw new Error('toolId は小文字英数字とハイフンのみ（先頭は英数字）');
  }
}

function assertApiKey(apiKey) {
  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    throw new Error('APIキーは sk-ant- で始まる必要があります');
  }
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
  return { changed: true, message: `マップに ${toolId} を追加しました` };
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

/**
 * @param {{ toolId: string, apiKey: string, push?: boolean }} input
 */
function registerTool(input) {
  const steps = [];
  const toolId = String(input.toolId || '').trim();
  const apiKey = String(input.apiKey || '').trim();
  const wantPush = Boolean(input.push);

  assertToolId(toolId);
  assertApiKey(apiKey);

  const secretName = `claude-api-key-${toolId}`;
  const member = `serviceAccount:${RUNTIME_SA}`;
  const keyFile = path.join(os.tmpdir(), `claude-key-${Date.now()}.txt`);

  steps.push({ step: 'validate', ok: true, detail: `toolId=${toolId}, secret=${secretName}` });

  try {
    fs.writeFileSync(keyFile, apiKey, { encoding: 'utf8', flag: 'w' });

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
        throw new Error(`シークレット作成失敗: ${create.stderr || create.stdout}`);
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
      throw new Error(`シークレット登録失敗: ${addVersion.stderr || addVersion.stdout}`);
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
      throw new Error(`IAM 付与失敗: ${iam.stderr || iam.stdout}`);
    }
    steps.push({ step: 'iam', ok: true, detail: 'secretAccessor 付与完了' });
  } finally {
    try {
      if (fs.existsSync(keyFile)) fs.unlinkSync(keyFile);
    } catch (_) {}
  }

  const mapResult = updateToolMap(toolId, secretName);
  steps.push({ step: 'map', ok: true, detail: mapResult.message });

  let pushResult = { pushed: false, message: 'push はスキップ' };
  if (wantPush) {
    pushResult = gitPush(toolId);
    steps.push({ step: 'push', ok: true, detail: pushResult.message });
  } else {
    steps.push({ step: 'push', ok: true, detail: 'push 未実行（チェックを外しています）' });
  }

  return {
    ok: true,
    toolId,
    secretName,
    proxyHeader: `X-Tool-Id: ${toolId}`,
    proxyUrl: 'https://claude-proxy-3fwuq2jhrq-an.a.run.app',
    steps,
    push: pushResult,
  };
}

function listRegisteredTools() {
  const js = fs.readFileSync(INDEX_JS, 'utf8');
  const m = js.match(/const DEFAULT_TOOL_SECRET_MAP = \{([\s\S]*?)\n\};/);
  if (!m) return [];
  const tools = [];
  const re = /^\s*'?([a-z0-9][a-z0-9-]*)'?\s*:\s*'([^']+)'/gm;
  let match;
  while ((match = re.exec(m[1])) !== null) {
    tools.push({ toolId: match[1], secretName: match[2] });
  }
  return tools;
}

module.exports = { registerTool, listRegisteredTools, ROOT };
