import { Fragment } from 'react';
import type { JobStage } from '../../../shared/types';

// 工程ラベル → 円形ノード内のミニアイコン(24x24 viewBox, stroke)。未知ラベルは番号にフォールバック
const ICON_PATHS: Record<string, string> = {
  調査: 'M10.5 3a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15Zm5.8 13.3L21 21',
  台本: 'M6 3h9l4 4v14H6V3Zm3 8h6M9 15h6',
  音声: 'M4 10v4h4l5 4V6L8 10H4Zm12-1a4 4 0 0 1 0 6',
  絵コンテ: 'M4 5h16v14H4V5Zm0 7h16M10 5v14',
  素材: 'M4 5h16v14H4V5Zm3 8 3-3 3 3 4-4 3 3M8.5 9.5h.01',
  実装: 'm9 8-4 4 4 4m6-8 4 4-4 4',
  QA: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3Zm-3 8 2.2 2.2L15 9.5',
  検査: 'M10.5 3a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15Zm5.8 13.3L21 21M7.5 10.5l2 2 3.5-3.5',
  レビュー: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Zm12-0a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  公開準備: 'M12 15V4m0 0 4 4m-4-4-4 4M4 15v4h16v-4',
  承認: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3Zm-3.5 8.5 2.5 2.5 4.5-5',
  レンダー: 'M4 4h16v16H4V4Zm4 0v16m8-16v16M4 9h4m8 0h4M4 15h4m8 0h4',
  分析: 'M5 20V10m7 10V4m7 16v-7',
  反映: 'M20 12a8 8 0 1 1-2.3-5.7M20 3v4h-4',
  検証: 'm5 12 5 5L20 7',
  探索: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4 6-2.5 6-6 2.5 2.5-6L16 8Z',
  採点: 'm12 3 2.7 5.6 6.3.9-4.5 4.3 1 6.2-5.5-3-5.5 3 1-6.2L3 9.5l6.3-.9L12 3Z',
  分類: 'M3 7h7l2 2h9v10H3V7Z',
  適用: 'M4 12h13m-5-6 6 6-6 6',
  同期検証: 'm5 12 5 5L20 7',
  回答: 'M4 5h16v11H9l-5 4V5Z',
};

function StageIcon({ label, index }: { label: string; index: number }) {
  const d = ICON_PATHS[label];
  if (!d) return <span className="stepper-num">{index + 1}</span>;
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

/**
 * 横型コネクテッド・ステッパー(signatureのステージレール拡大版)。
 * 円形アイコンノードを水平コネクターで連結し、完了=accent塗り / 現在=accentリング / 未達=border。
 * 状態は色に加えてラベル下のテキスト((進行中)/(完了))でも伝える(quality-floor)。
 */
export function Stepper({ stages }: { stages: JobStage[] }) {
  return (
    <div className="stepper" role="list" aria-label="制作ラインの進捗">
      {stages.map((s, i) => (
        <Fragment key={s.key}>
          {i > 0 && (
            <span className={`stepper-connector${stages[i - 1]!.state === 'done' ? ' done' : ''}`} />
          )}
          <div
            className={`stepper-node ${s.state}`}
            role="listitem"
            aria-current={s.state === 'active' ? 'step' : undefined}
          >
            <span className="stepper-circle">
              <StageIcon label={s.label} index={i} />
            </span>
            <span className="stepper-label">
              {s.label}
              {s.state === 'active' && <span className="stepper-state">(進行中)</span>}
              {s.state === 'done' && <span className="stepper-state">(完了)</span>}
            </span>
          </div>
        </Fragment>
      ))}
    </div>
  );
}
