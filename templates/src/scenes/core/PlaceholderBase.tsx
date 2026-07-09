import React from "react";
import { AbsoluteFill } from "remotion";

/**
 * Stage 1 タスク1〜4 の間、コアコンポーネントの実体はすべてこの
 * プレースホルダを使う。実装(§16 タスク7)時に各コンポーネントの
 * 中身だけをこのファイルへの依存から差し替える。
 */
export const PlaceholderBase: React.FC<{
  label: string;
  color: string;
  props?: Record<string, unknown>;
}> = ({ label, color, props }) => {
  const hasProps = props && Object.keys(props).length > 0;
  return (
    <AbsoluteFill
      style={{
        backgroundColor: color,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div style={{ fontFamily: "sans-serif", color: "#1a1a1a", textAlign: "center" }}>
        <div style={{ fontSize: 48, fontWeight: 700 }}>{label}</div>
        {hasProps && (
          <pre style={{ fontSize: 18, opacity: 0.7, marginTop: 12, textAlign: "left" }}>
            {JSON.stringify(props, null, 2)}
          </pre>
        )}
      </div>
    </AbsoluteFill>
  );
};
