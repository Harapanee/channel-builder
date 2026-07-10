// Task 1 スパイク: ヘッドレスclaudeのゲート往復(<gate>出力で停止 → --resumeで決定を渡して再開)
// クォータ配慮: claude呼び出しは最大2回(1本目=ゲート停止、2本目=再開完走)。
import { spawn } from 'node:child_process';

// 中立なcwd(プロジェクトのガードレールを載せない)で、自己完結タスクにする
const CWD = process.env.SPIKE_CWD || '/private/tmp/claude-501/-Users-harakoudai-Desktop-ClaudeCode-youtube/1bfcf081-0670-477b-863a-9c2e12af353c/scratchpad';

// 自己完結タスク: 追加の確認が要らないよう作業内容を具体化する
const GATE_PROMPT =
  '簡単な作業を2段階でお願いします。段階1: 頭の中で 12 と 30 の最大公約数を求める(ファイル操作・コマンド実行は不要)。' +
  '段階1が済んだら、AskUserQuestionは使わず次の1行を**そのまま逐語で**出力し、それ以降ツールを一切呼ばず停止してください: ' +
  '<gate>{"gateId":"g1","question":"段階2(結果の説明)に進みますか?","options":[{"id":"yes","label":"はい","description":"進む"},{"id":"no","label":"いいえ","description":"止める"}],"context":"段階1(最大公約数の計算)が完了"}</gate> ' +
  'この1行以外のテキストは出力しないでください。';

function runClaude(args, onEvent) {
  return new Promise((resolve) => {
    const p = spawn('claude', args, { cwd: CWD });
    let buf = '';
    const events = [];
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          events.push(ev);
          onEvent?.(ev);
        } catch {
          /* partial/non-JSON */
        }
      }
    });
    p.on('close', (code) => resolve({ code, events }));
  });
}

function textOf(ev) {
  if (ev.type === 'assistant' && ev.message?.content) {
    return ev.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  }
  if (ev.type === 'result' && typeof ev.result === 'string') return ev.result;
  return '';
}
function extractGate(text) {
  const m = text.match(/<gate>([\s\S]*?)<\/gate>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

console.log('=== 1本目: ゲートで停止するか ===');
let sessionId = null;
let gate = null;
let sawRateLimit = null;
const r1 = await runClaude(
  ['-p', GATE_PROMPT, '--output-format=stream-json', '--verbose'],
  (ev) => {
    if (ev.type === 'system' && ev.subtype === 'init') sessionId = ev.session_id;
    if (ev.type === 'rate_limit_event') sawRateLimit = ev.rate_limit_info;
    const t = textOf(ev);
    if (t) console.log(`  [${ev.type}] ${JSON.stringify(t).slice(0, 200)}`);
    const g = extractGate(t);
    if (g) gate = g;
    if (ev.type === 'result') sessionId = ev.session_id || sessionId;
  },
);
console.log('exit:', r1.code, '/ sessionId:', sessionId, '/ gate:', JSON.stringify(gate));
console.log('event types:', [...new Set(r1.events.map((e) => e.type + (e.subtype ? ':' + e.subtype : '')))].join(', '));
if (sawRateLimit) console.log('rate_limit:', JSON.stringify(sawRateLimit));

if (!gate || !sessionId) {
  console.log('\nRESULT: FAIL — ゲート停止またはsessionId取得に失敗。方式の再検討が必要。');
  process.exit(1);
}

console.log('\n=== 2本目: --resume で決定を渡して再開・完走するか ===');
let resumed = false;
const r2 = await runClaude(
  ['-p', '--resume', sessionId, `ゲート ${gate.gateId} の決定: はい。作業を続けて「完了しました」とだけ述べて終わってください。`, '--output-format=stream-json', '--verbose'],
  (ev) => {
    if (ev.type === 'result') resumed = ev.subtype === 'success';
  },
);
console.log('exit:', r2.code, '/ resumed-success:', resumed);
const finalText = r2.events.filter((e) => e.type === 'assistant').map(textOf).join('');
console.log('final text:', finalText.slice(0, 120));

console.log(resumed ? '\nRESULT: PASS — ゲート往復が実機で成立(プロンプト指示方式を採用)' : '\nRESULT: FAIL — 再開に失敗');
process.exit(resumed ? 0 : 1);
