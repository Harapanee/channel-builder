import { describe, it, expect } from 'vitest';
import {
  OPERATIONS,
  buildJobPrompt,
  buildResumePrompt,
  videoCreatePhaseForStatus,
} from '../operations';

describe('video-create フェーズ定義', () => {
  const op = OPERATIONS['video-create'];

  it('video-create は5フェーズを持つ', () => {
    expect(op.phases).toHaveLength(5);
  });

  it('buildJobPrompt はフェーズ指示を含める(P1: 工程0〜3)', () => {
    const p = buildJobPrompt(op, '織田信長', { mode: 'semi', phaseIndex: 0 });
    expect(p).toContain('工程0〜3');
    expect(p).toContain('/video-create 織田信長');
  });

  it('P2のプロンプトは工程4〜6の範囲と<done>終了規約を含む', () => {
    const p = buildJobPrompt(op, '', { mode: 'semi', phaseIndex: 1, episodeId: 'ep001-x' });
    expect(p).toContain('工程4〜6');
    expect(p).toContain('ep001-x'); // 既存の再開文(対象エピソード)と併用される
    expect(p).toContain('<done>');
  });

  it('phaseIndex未指定(旧ジョブ)ならフェーズ指示を含めない', () => {
    const p = buildJobPrompt(op, '織田信長', { mode: 'semi' });
    expect(p).not.toContain('担当範囲');
  });

  it('buildResumePrompt もフェーズ指示を引き継ぐ', () => {
    const p = buildResumePrompt(op, 'semi', 1);
    expect(p).toContain('工程4〜6');
    const legacy = buildResumePrompt(op, 'semi');
    expect(legacy).not.toContain('担当範囲');
  });

  it('題材あり+フェーズ実行中のepisodeId文は「再開」扱い(個別フィードバック文にしない)', () => {
    const p = buildJobPrompt(op, '織田信長', { mode: 'semi', phaseIndex: 1, episodeId: 'ep001-x' });
    expect(p).toContain('制作の再開');
    expect(p).not.toContain('個別フィードバック');
  });

  it('videoCreatePhaseForStatus は status から開始フェーズを引く', () => {
    expect(videoCreatePhaseForStatus(undefined)).toBe(0);
    expect(videoCreatePhaseForStatus('researched')).toBe(0);
    expect(videoCreatePhaseForStatus('scripted')).toBe(1);
    expect(videoCreatePhaseForStatus('voiced')).toBe(1);
    expect(videoCreatePhaseForStatus('storyboarded')).toBe(2);
    expect(videoCreatePhaseForStatus('implemented')).toBe(3);
    expect(videoCreatePhaseForStatus('prechecked')).toBe(3);
    expect(videoCreatePhaseForStatus('reviewed')).toBe(4);
    expect(videoCreatePhaseForStatus('packaged')).toBe(4);
    expect(videoCreatePhaseForStatus('render_ready')).toBe(4);
    expect(videoCreatePhaseForStatus('final')).toBe(4);
  });

  it('video-create 以外のオペは phases を持たない', () => {
    for (const key of Object.keys(OPERATIONS)) {
      if (key !== 'video-create') expect(OPERATIONS[key].phases).toBeUndefined();
    }
  });
});
