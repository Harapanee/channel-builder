/**
 * claude CLI の stream-json(JSONL)1行を、人間向けの活動フィード項目に変換する純関数群。
 * 表示不要な行(rate_limit、正常なtool_result、サブエージェント内部の行など)は null。
 * 生ログは別タブで常に見られるため、解釈できない行は黙って捨ててよい。
 */

export type FeedItem = {
  /** 一意キー。task_progress は 'task:{task_id}' で同一タスクを上書き更新する */
  key: string;
  icon: string;
  label: string;
  /** 長文(発話・エラー本文)。label と分けて折りたたみ表示できるようにする */
  detail?: string;
  kind: 'tool' | 'text' | 'subagent' | 'error';
};

export const MAX_FEED_ITEMS = 500;

const TOOL_ICONS: Record<string, string> = {
  Read: '📖',
  Write: '📝',
  Edit: '✏️',
  Bash: '💻',
  Grep: '🔎',
  Glob: '🔎',
  WebFetch: '🌐',
  WebSearch: '🌐',
};

/** パスの末尾2要素だけに短縮する(例: episodes/ep010/shots.json → ep010/shots.json) */
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

/** <stage>…</stage> 等の制御マーカーを取り除く */
function stripMarkers(text: string): string {
  return text.replace(/<\/?(stage|gate|done|option)[^>]*>[^<]*<\/(stage|gate|done|option)>|<\/?(stage|gate|done|option)[^>]*>/g, '').trim();
}

function toolLabel(name: string, input: Record<string, unknown>): string {
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
  if (filePath) return `${name} ${shortPath(filePath)}`;
  if (name === 'Bash' && typeof input.description === 'string') return `${name}: ${input.description}`;
  if (typeof input.pattern === 'string') return `${name} ${input.pattern}`;
  if (typeof input.command === 'string') return `${name}: ${String(input.command).slice(0, 80)}`;
  return name;
}

let seq = 0;

export function parseFeedItem(line: string): FeedItem | null {
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;

  // サブエージェント内部の行は task_progress で代表させる
  if (d.parent_tool_use_id) return null;

  if (d.type === 'system' && d.subtype === 'task_progress') {
    const agent = d.subagent_type ?? 'subagent';
    const tools = d.usage?.tool_uses;
    const mins = d.usage?.duration_ms !== undefined ? Math.floor(d.usage.duration_ms / 60000) : undefined;
    const meta = [tools !== undefined ? `ツール${tools}回` : null, mins !== undefined ? `${mins}分` : null]
      .filter(Boolean)
      .join('・');
    return {
      key: `task:${d.task_id ?? d.tool_use_id ?? seq++}`,
      icon: '🤖',
      label: `${agent}: ${d.description ?? '作業中'}${meta ? `(${meta})` : ''}`,
      kind: 'subagent',
    };
  }

  if (d.type === 'assistant') {
    const content = d.message?.content;
    if (!Array.isArray(content)) return null;
    for (const c of content) {
      if (c?.type === 'tool_use') {
        const input = (c.input ?? {}) as Record<string, unknown>;
        if (c.name === 'Task') {
          const agent = typeof input.subagent_type === 'string' ? input.subagent_type : 'subagent';
          const desc = typeof input.description === 'string' ? input.description : '';
          return { key: c.id ?? `f${seq++}`, icon: '🤖', label: `${agent} 起動: ${desc}`, kind: 'subagent' };
        }
        return {
          key: c.id ?? `f${seq++}`,
          icon: TOOL_ICONS[c.name] ?? '🔧',
          label: toolLabel(c.name, input),
          kind: 'tool',
        };
      }
      if (c?.type === 'text') {
        const text = stripMarkers(String(c.text ?? ''));
        if (!text) continue;
        return { key: `f${seq++}`, icon: '💬', label: '', detail: text, kind: 'text' };
      }
    }
    return null;
  }

  if (d.type === 'user') {
    const content = d.message?.content;
    if (!Array.isArray(content)) return null;
    for (const c of content) {
      if (c?.type === 'tool_result' && c.is_error) {
        const body = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
        return { key: `f${seq++}`, icon: '⚠️', label: 'エラー', detail: body.slice(0, 200), kind: 'error' };
      }
    }
    return null;
  }

  return null;
}

/** 追記。同一keyのsubagent進捗はその場で上書きし、上限を超えたら古い順に捨てる */
export function applyFeedItem(items: FeedItem[], item: FeedItem): FeedItem[] {
  if (item.kind === 'subagent') {
    const i = items.findIndex((x) => x.key === item.key);
    if (i >= 0) {
      const next = items.slice();
      next[i] = item;
      return next;
    }
  }
  return [...items, item].slice(-MAX_FEED_ITEMS);
}
