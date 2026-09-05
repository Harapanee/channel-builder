/** 差し替え可能な語彙帳。エピソードごとに1つ持つ。 */
export interface Vocab {
  /** 画風。一字一句変えない */
  STYLE: string;
  /** 閉じの一文(既定) */
  CLOSE: string;
  /** 人が意図的に写るカット用 */
  CLOSE_H: string;
  /** 画面内に文字を出すカット用 */
  CLOSE_TEXT: string;
  /** 寄りのカットへ自動付与する画風保持文 */
  CLOSEUP_GUARD: string;
  /** 場所。カットは必ず場所から書き始める */
  places: Record<string, string>;
  /** 被写体 */
  subjects: Record<string, string>;
  /** 脇役・小物 */
  props: Record<string, string>;
}

/** カット1本の宣言。エージェントが書くのはこれだけ。 */
export interface ShotDecl {
  /** 「場所 → 被写体 → 動き → カメラ」の順で書く本文 */
  body?: string;
  /** overall_soundscape に入る英文1段落(1〜4文)。**定型文で埋めない**(公式 §4.6) */
  sound?: string;
  /** 人が意図的に写る(閉じの一文を CLOSE_H にする) */
  open?: boolean;
  /** 画面内に文字を出す(閉じの一文を CLOSE_TEXT にする) */
  text?: boolean;
  /** 高解像度(1344x768)。既定は 1152x640 */
  hi?: boolean;
  /** 直前のカットの最終フレームを起点にする */
  chain?: boolean;
  /** 章をまたいで特定のカットの最終フレームを起点にする */
  chainFrom?: string;
  /** 章カード([番号, 章名]) */
  card?: [string, string];
  /** non_diegetic_music。既定は "N/A"(BGM は master.mp3 で別に載せる) */
  music?: string;
  /**
   * 生成のノイズ種。**既定は 0 固定**(同じ宣言からは同じ絵が出る = 再現性)。
   * 同じ body で別の絵が欲しいときだけ振る(不合格クリップの作り直しなど)。
   * ここに書けば台帳と一緒に残るので、採用した take を後から再現できる。
   * 台帳(cuts.json)側に対応するキーは無い(checkLedger の突合対象ではない)。
   */
  seed?: number;
}

/** カット割り台帳の1カット。h3-cut-planner が書く。 */
export interface Cut {
  /** 対応する台本行。複数なら束ねたカット。**先頭行のIDがカットIDの元になる** */
  lineIds: string[];
  /** 生成する尺(秒)。目標区間以上・17k+5 グリッドに乗る値 */
  seconds: number;
  /** vocab.places のキー */
  place: string;
  /** vocab.subjects のキー */
  subject: string;
  /** 役割(導入・展開・視覚ピークなど) */
  role: string;
  chain?: boolean;
  chainFrom?: string;
  hi?: boolean;
  text?: boolean;
  card?: [string, string];
  /**
   * 早回しが 1.4 倍を超えるが、意味の上で隣と束ねられないカット。
   * **h3-cut-planner が「束ねを検討したうえで束ねられなかった」ことを明示する欄。**
   * 立てると assemble が早回しをやめ、頭から等速で必要フレームだけ使う(絵の後半は切れる)。
   */
  holdSlow?: boolean;
  /**
   * このカットの字幕を敷かない。**画面内に文字を出すカット(`text: true`)用**。
   * 画面の文字と字幕が同時に出ると視聴者は同じ意味を二度読むことになる。
   * 章カード(`card`)は画面の文言と字幕の文言が別物なので、既定では立てない。
   */
  noSub?: boolean;
}

export interface Chapter {
  id: string;
  title: string;
  name: string;
  cuts: string[];
}

export interface CutsFile {
  episodeId: string;
  chapters: Chapter[];
  cuts: Record<string, Cut>;
  /**
   * 「最初の最悪」(宣告のあと、時系列で最初に起きる具体的な被害・脅威)を言い切る行。
   * bible §4(2026-09-03): 宣告から45秒以内に1つ言い切り、同じカットで画面上に大きい動きとして起こす。
   * check:h3 が「その行が45秒以内に始まるか・章カードのカットでないか」を機械検査する(B14)。
   */
  firstWorstLineId?: string;
  /** 語彙帳に無い場所・被写体が要るときの申請。空でなければ人間の承認待ち */
  needsVocab?: { name: string; kind: "place" | "subject" | "prop"; use: string; line: string }[];
}

export type Level = "BLOCK" | "ADVISE";

export interface Finding {
  level: Level;
  /** カットID */
  id: string;
  /** 規則の識別子(B1・A3 など) */
  rule: string;
  message: string;
}
