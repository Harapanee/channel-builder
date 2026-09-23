import { describe, it, expect } from 'vitest';
import {
  OPERATIONS,
  buildJobPrompt,
  buildResumePrompt,
  videoCreatePhaseForStatus,
} from '../operations';

describe('video-create フェーズ定義', () => {
  const op = OPERATIONS['video-create'];

  it('video-create は6フェーズを持つ(2026-08-02: 素材/実装を分割)', () => {
    expect(op.phases).toHaveLength(6);
  });

  it('phaseStages は phases と同数(範囲外の stage 誤発行を弾くため)', () => {
    expect(op.phaseStages).toHaveLength(op.phases!.length);
  });

  it('フェーズ3は素材だけを担当し、工程8(実装)へは進まない', () => {
    expect(op.phases![2]).toContain('担当範囲: 工程7(素材取得)のみ');
    expect(op.phases![2]).toContain('工程8(シーン実装)には一切進まず');
  });

  it('フェーズ4は実装(8.4の音声ミックスまで)を担当する', () => {
    expect(op.phases![3]).toContain('担当範囲: 工程8');
    expect(op.phases![3]).toContain('implemented');
  });

  it('フェーズ指示文は特定チャンネル限定の機能(npm run statusコマンド・assets_ready値)を名指ししない', () => {
    // video-create は全チャンネル共通で配信され、チャンネル別分岐は jobs.ts に無い。
    // 「npm run status」コマンドと「assets_ready」status値は配布済みの2ch(2026-08-02時点)
    // にしかなく、共通層で名指しすると未配布chのジョブが失敗する(最終レビューCritical再発防止)。
    const joined = op.phases!.join('\n');
    expect(joined).not.toContain('npm run status');
    expect(joined).not.toContain('assets_ready');
  });

  it('phaseStages が stages の名前だけを使っている', () => {
    for (const group of op.phaseStages!) {
      for (const s of group) expect(op.stages).toContain(s);
    }
  });

  it('全フェーズの担当stageが重複なく並ぶ', () => {
    const flat = op.phaseStages!.flat();
    expect(new Set(flat).size).toBe(flat.length);
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

  it('P3のプロンプトは素材工程のみを範囲とし、シーン実装(工程8)には進まない', () => {
    const p = buildJobPrompt(op, '', { mode: 'semi', phaseIndex: 2, episodeId: 'ep001-x' });
    expect(p).toContain('工程7(素材取得)のみ');
    expect(p).toContain('工程8(シーン実装)には一切進まず');
  });

  it('P4のプロンプトは実装工程のみを範囲とし、素材の作り直しはしない', () => {
    const p = buildJobPrompt(op, '', { mode: 'semi', phaseIndex: 3, episodeId: 'ep001-x' });
    expect(p).toContain('工程8〜8.4');
    expect(p).toContain('素材の作り直し・追加調達は行わない');
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
    expect(videoCreatePhaseForStatus('assets_ready')).toBe(3);
    expect(videoCreatePhaseForStatus('implemented')).toBe(4);
    expect(videoCreatePhaseForStatus('prechecked')).toBe(4);
    expect(videoCreatePhaseForStatus('qa_passed')).toBe(4);
    expect(videoCreatePhaseForStatus('reviewed')).toBe(5);
    expect(videoCreatePhaseForStatus('packaged')).toBe(5);
    expect(videoCreatePhaseForStatus('render_ready')).toBe(5);
    expect(videoCreatePhaseForStatus('final')).toBe(5);
  });

  it('返す番号が phases の範囲を出ない', () => {
    const all = [
      'researched', 'scripted', 'voiced', 'storyboarded', 'assets_ready',
      'implemented', 'prechecked', 'qa_passed', 'reviewed', 'packaged', 'render_ready', 'final',
    ];
    for (const s of all) {
      expect(videoCreatePhaseForStatus(s)).toBeLessThan(op.phases!.length);
    }
  });

  it('video-create 以外のオペは phases を持たない', () => {
    for (const key of Object.keys(OPERATIONS)) {
      if (key !== 'video-create') expect(OPERATIONS[key].phases).toBeUndefined();
    }
  });
});
