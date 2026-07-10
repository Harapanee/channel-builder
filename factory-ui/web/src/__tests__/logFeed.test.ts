import { describe, expect, it } from 'vitest';
import { applyFeedItem, parseFeedItem, type FeedItem } from '../logFeed';

// 実ジョブ(ep010 video-create)の log.jsonl の形を模したフィクスチャ
const toolUseRead = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Read',
        input: { file_path: '/Users/x/youtube/youtubebuilder/episodes/ep010-cleopatra/shots.json', offset: 3580 },
      },
    ],
  },
});

const toolUseBash = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'npm test', description: 'テストを実行' } },
    ],
  },
});

const toolUseTask = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_3',
        name: 'Task',
        input: { subagent_type: 'scene-implementer', description: 'Fix props-contract mismatches ep010', prompt: '...' },
      },
    ],
  },
});

const assistantText = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: '根本原因は確定しました。\n<stage>実装</stage>' }],
  },
});

const taskProgress = JSON.stringify({
  type: 'system',
  subtype: 'task_progress',
  task_id: 'af75109',
  tool_use_id: 'toolu_3',
  description: 'Reading episodes/ep010-cleopatra/shots.json',
  subagent_type: 'scene-implementer',
  usage: { total_tokens: 152454, tool_uses: 31, duration_ms: 461291 },
});

const toolResultError = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        tool_use_id: 'toolu_9',
        type: 'tool_result',
        is_error: true,
        content: '<tool_use_error>File has not been read yet.</tool_use_error>',
      },
    ],
  },
});

const toolResultOk = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'ok' }] },
});

const subagentToolUse = JSON.stringify({
  type: 'assistant',
  parent_tool_use_id: 'toolu_3',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_sub', name: 'Read', input: { file_path: '/a/b.json' } }],
  },
});

const rateLimit = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });

describe('parseFeedItem', () => {
  it('Read の tool_use はファイル名(末尾パス)つきで表示する', () => {
    const item = parseFeedItem(toolUseRead);
    expect(item).not.toBeNull();
    expect(item!.kind).toBe('tool');
    expect(item!.label).toContain('Read');
    expect(item!.label).toContain('ep010-cleopatra/shots.json');
    expect(item!.label).not.toContain('/Users/');
  });

  it('Bash は description を表示する', () => {
    const item = parseFeedItem(toolUseBash);
    expect(item!.label).toContain('テストを実行');
  });

  it('Task はサブエージェント名とタスク説明を表示する', () => {
    const item = parseFeedItem(toolUseTask);
    expect(item!.kind).toBe('subagent');
    expect(item!.label).toContain('scene-implementer');
    expect(item!.label).toContain('Fix props-contract mismatches ep010');
  });

  it('assistant text はマーカーを除去して表示する', () => {
    const item = parseFeedItem(assistantText);
    expect(item!.kind).toBe('text');
    expect(item!.detail).toContain('根本原因は確定しました。');
    expect(item!.detail).not.toContain('<stage>');
  });

  it('task_progress はサブエージェントの進捗として task_id をキーに表示する', () => {
    const item = parseFeedItem(taskProgress);
    expect(item!.kind).toBe('subagent');
    expect(item!.key).toBe('task:af75109');
    expect(item!.label).toContain('scene-implementer');
    expect(item!.label).toContain('Reading episodes/ep010-cleopatra/shots.json');
    expect(item!.label).toContain('31');
    expect(item!.label).toContain('7分');
  });

  it('エラーの tool_result は ⚠ 表示、正常な tool_result は非表示', () => {
    const err = parseFeedItem(toolResultError);
    expect(err!.kind).toBe('error');
    expect(err!.detail).toContain('File has not been read yet');
    expect(parseFeedItem(toolResultOk)).toBeNull();
  });

  it('サブエージェント内の行(parent_tool_use_id あり)は非表示', () => {
    expect(parseFeedItem(subagentToolUse)).toBeNull();
  });

  it('rate_limit_event・不正JSONは非表示', () => {
    expect(parseFeedItem(rateLimit)).toBeNull();
    expect(parseFeedItem('not json at all')).toBeNull();
    expect(parseFeedItem('')).toBeNull();
  });
});

describe('applyFeedItem', () => {
  it('通常項目は追記、同一 task_id の進捗は最新で上書きする', () => {
    let items: FeedItem[] = [];
    items = applyFeedItem(items, parseFeedItem(toolUseTask)!);
    items = applyFeedItem(items, parseFeedItem(taskProgress)!);
    const updated = JSON.parse(taskProgress);
    updated.description = '2nd step';
    items = applyFeedItem(items, parseFeedItem(JSON.stringify(updated))!);
    expect(items).toHaveLength(2);
    expect(items[1].label).toContain('2nd step');
  });

  it('上限を超えたら古い項目から捨てる', () => {
    let items: FeedItem[] = [];
    for (let i = 0; i < 600; i++) {
      items = applyFeedItem(items, { key: `k${i}`, icon: '💬', label: `m${i}`, kind: 'text' });
    }
    expect(items.length).toBeLessThanOrEqual(500);
    expect(items[items.length - 1].label).toBe('m599');
  });
});
