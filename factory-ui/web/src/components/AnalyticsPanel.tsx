import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { AnalyticsData, EpisodeSummary, ThumbTestData } from '../../../shared/types';
import {
  fetchYoutubeAnalytics,
  getAnalytics,
  getThumbTest,
  putAnalyticsManual,
  putThumbTest,
} from '../api';
import { retentionSummaryLines } from '../retention';

const THUMB_OPTIONS = ['thumb-1', 'thumb-2', 'thumb-3'] as const;

const inputStyle: CSSProperties = {
  padding: '6px 10px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-s)',
  background: 'var(--surface)',
  color: 'var(--text-primary)',
  fontSize: '14px',
  fontFamily: 'var(--font-body)',
  width: '110px',
};

/** 秒 → mm:ss */
function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '96px' }}>
      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{label}</span>
      <span className="mono" style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>
        {value}
      </span>
    </div>
  );
}

/**
 * アナリティクス還流+サムネABテスト記録パネル(エピソード詳細内、YoutubePanel直下)。
 * - 初期表示: 保存済みの analytics.json / thumb-test.json をGET(いずれも無ければ空状態)
 * - 「分析取得」: YouTube Analytics APIから実測を取得しanalytics.jsonへ保存(チャートは描かない。
 *   主要数値+維持率カーブの要約テキストのみ)。401(needs_reauth含む)は再認証導線を出す
 * - CTR・インプレッションは非公開APIのため手動入力(analytics.jsonのmanualへPUT)
 * - サムネABテストは人間がYouTube Studio「テストと比較」を見て結果を記録するフォーム
 */
export function AnalyticsPanel({
  dir,
  episode,
  onOpenSettings,
}: {
  dir: string;
  episode: EpisodeSummary;
  onOpenSettings?: () => void;
}) {
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [fetching, setFetching] = useState(false);

  const [thumbTest, setThumbTest] = useState<ThumbTestData | null>(null);
  const [winner, setWinner] = useState<(typeof THUMB_OPTIONS)[number]>('thumb-1');
  const [note, setNote] = useState('');
  const [thumbSaving, setThumbSaving] = useState(false);
  const [thumbError, setThumbError] = useState<string | null>(null);
  const [thumbSaved, setThumbSaved] = useState(false);

  const [impressions, setImpressions] = useState('');
  const [impressionsCtr, setImpressionsCtr] = useState('');
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualSaved, setManualSaved] = useState(false);

  const reload = useCallback(async () => {
    try {
      setAnalytics(await getAnalytics(dir, episode.episodeId));
    } catch {
      setAnalytics(null); // 404含む: まだ分析データがありません
    }
    try {
      const t = await getThumbTest(dir, episode.episodeId);
      setThumbTest(t);
      setWinner(t.winner);
      setNote(t.note ?? '');
    } catch {
      setThumbTest(null);
    }
  }, [dir, episode.episodeId]);

  useEffect(() => {
    // エピソード切替時に前エピソードの表示・入力状態を持ち越さない
    setAnalytics(null);
    setAnalyticsError(null);
    setNeedsReauth(false);
    setThumbTest(null);
    setWinner('thumb-1');
    setNote('');
    setImpressions('');
    setImpressionsCtr('');
    setManualSaved(false);
    setThumbSaved(false);
    reload();
  }, [reload]);

  useEffect(() => {
    // 取得済みanalyticsのmanualを入力欄の初期値にする(再取得後の反映も含む)
    setImpressions(analytics?.manual?.impressions !== undefined ? String(analytics.manual.impressions) : '');
    setImpressionsCtr(
      analytics?.manual?.impressionsCtr !== undefined ? String(analytics.manual.impressionsCtr) : '',
    );
  }, [analytics]);

  async function doFetch() {
    if (fetching) return;
    setFetching(true);
    setAnalyticsError(null);
    setNeedsReauth(false);
    try {
      setAnalytics(await fetchYoutubeAnalytics(dir, episode.episodeId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes(' -> 401')) {
        setNeedsReauth(true);
      } else {
        setAnalyticsError(msg);
      }
    } finally {
      setFetching(false);
    }
  }

  async function saveManual() {
    if (manualSaving) return;
    const patch: { impressions?: number; impressionsCtr?: number } = {};
    if (impressions.trim() !== '') {
      const n = Number(impressions);
      if (Number.isNaN(n)) {
        setManualError('インプレッションは数値で入力してください');
        return;
      }
      patch.impressions = n;
    }
    if (impressionsCtr.trim() !== '') {
      const n = Number(impressionsCtr);
      if (Number.isNaN(n)) {
        setManualError('CTRは数値で入力してください');
        return;
      }
      patch.impressionsCtr = n;
    }
    setManualSaving(true);
    setManualError(null);
    setManualSaved(false);
    try {
      await putAnalyticsManual(dir, episode.episodeId, patch);
      setManualSaved(true);
      await reload();
    } catch (e) {
      setManualError(e instanceof Error ? e.message : String(e));
    } finally {
      setManualSaving(false);
    }
  }

  async function saveThumbTest() {
    if (thumbSaving) return;
    setThumbSaving(true);
    setThumbError(null);
    setThumbSaved(false);
    try {
      await putThumbTest(dir, episode.episodeId, {
        winner,
        note: note.trim() === '' ? undefined : note,
      });
      setThumbSaved(true);
      await reload();
    } catch (e) {
      setThumbError(e instanceof Error ? e.message : String(e));
    } finally {
      setThumbSaving(false);
    }
  }

  const retentionLines = useMemo(
    () =>
      retentionSummaryLines({
        retentionCurve: analytics?.retentionCurve,
        averageViewDuration: analytics?.averageViewDuration,
        averageViewPercentage: analytics?.averageViewPercentage,
      }),
    [analytics],
  );

  return (
    <section className="panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <h3>アナリティクス・サムネAB</h3>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" type="button" onClick={doFetch} disabled={fetching}>
          {fetching ? '取得中…' : analytics ? '分析を再取得' : '分析を取得'}
        </button>
        {analytics && (
          <span className="mono" style={{ color: 'var(--text-secondary)' }}>
            最終取得: {new Date(analytics.fetchedAt).toLocaleString('ja-JP')}
          </span>
        )}
      </div>

      {needsReauth && (
        <div className="gate-card" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--status-warn)' }}>YouTube連携の再認証が必要です</span>
          {onOpenSettings && (
            <button className="btn btn-ghost" type="button" onClick={onOpenSettings}>
              設定タブへ
            </button>
          )}
        </div>
      )}
      {analyticsError && <span style={{ color: 'var(--status-err)' }}>{analyticsError}</span>}

      {analytics === null && !needsReauth && !analyticsError && (
        <div className="empty">まだ分析データがありません</div>
      )}

      {analytics && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px' }}>
            <Stat label="views" value={String(analytics.views ?? 0)} />
            <Stat label="平均視聴率" value={`${(analytics.averageViewPercentage ?? 0).toFixed(1)}%`} />
            <Stat label="平均視聴時間" value={fmtDuration(analytics.averageViewDuration ?? 0)} />
            <Stat label="登録者増" value={String(analytics.subscribersGained ?? 0)} />
            <Stat label="likes" value={String(analytics.likes ?? 0)} />
            <Stat label="comments" value={String(analytics.comments ?? 0)} />
          </div>

          {retentionLines.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {retentionLines.map((l) => (
                <span className="mono" key={l}>
                  {l}
                </span>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span className="mono">CTR・インプレッション(YouTube Studioから手動転記。APIでは取得できません)</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span>インプレッション</span>
                <input
                  type="number"
                  value={impressions}
                  onChange={(e) => setImpressions(e.target.value)}
                  style={inputStyle}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span>CTR%</span>
                <input
                  type="number"
                  value={impressionsCtr}
                  onChange={(e) => setImpressionsCtr(e.target.value)}
                  style={inputStyle}
                />
              </label>
              <button className="btn btn-ghost" type="button" onClick={saveManual} disabled={manualSaving}>
                {manualSaving ? '保存中…' : '保存'}
              </button>
              {manualSaved && <span style={{ color: 'var(--status-ok)' }}>保存しました</span>}
            </div>
            {manualError && <span style={{ color: 'var(--status-err)' }}>{manualError}</span>}
          </div>
        </>
      )}

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          borderTop: '1px solid var(--border)',
          paddingTop: '12px',
        }}
      >
        <h4>サムネABテスト結果</h4>
        {thumbTest && (
          <span className="mono">
            現在の記録: 勝者 {thumbTest.winner}({thumbTest.recordedAt}){thumbTest.note ? ` — ${thumbTest.note}` : ''}
          </span>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
          <span className="mono">勝者</span>
          {THUMB_OPTIONS.map((t) => (
            <label key={t} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <input
                type="radio"
                name={`thumb-winner-${episode.episodeId}`}
                value={t}
                checked={winner === t}
                onChange={() => setWinner(t)}
              />
              {t}
            </label>
          ))}
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span className="mono">所感(なぜ勝ったかの仮説)</span>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例: サムネ2はテキストが大きく視認性が高かった"
            style={{ ...inputStyle, width: '100%', resize: 'vertical' }}
          />
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button className="btn btn-primary" type="button" onClick={saveThumbTest} disabled={thumbSaving}>
            {thumbSaving ? '保存中…' : thumbTest ? '更新' : '記録'}
          </button>
          {thumbSaved && <span style={{ color: 'var(--status-ok)' }}>保存しました</span>}
        </div>
        {thumbError && <span style={{ color: 'var(--status-err)' }}>{thumbError}</span>}
      </div>
    </section>
  );
}
