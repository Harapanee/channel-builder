/**
 * ep015-salmon リメイクの共通語彙。
 *
 * 前作の失敗は「絵コンテの図解演出(ゲージ・荷札・階段記号・ラベル)をそのまま英訳した」こと。
 * 視聴者には意味が通らず、生成側も抽象的な指示ほど破綻した(人物・UIアイコン・でたらめな文字が湧く)。
 *
 * 今回の原則は3つだけ。
 *  1. 画面には「その行のナレーションが指している実物」しか描かない
 *  2. 画面内に文字・数字・記号・図表を一切出さない(意味は音と字幕が運ぶ)
 *  3. 1カット = 1つの場所・1つの被写体・1つの動き・1つのカメラ動作
 *
 * 前セッションで実証済みの規則も引き継ぐ:
 *  - 場所を書かないとモデルが場所を発明する。必ず場所から書き始める
 *  - 余白の多いカットは CLOSE で閉じないと人物やアイコンで埋められる
 *  - 「AがBに変形する」は事故る。移動・出現・拡大で書く
 *  - 多義語を避ける(tank は戦車になる)
 *
 * 出典: h3/_archive/v2-remake/lib.mjs から定数のみ移設(2026-08-19)。
 * 英語の文面は実際に MiniMax H3 へ渡して絵を作った実績のある文言なので一字一句変えない。
 * `P()` と `chapterCard()` は関数なので移さない(Task 3 で compose.ts へ)。
 */
import type { Vocab } from "../../src/pipeline/h3/types";

const vocab: Vocab = {
  /** 画風。ユーザーが選定した st1(紙地・影なし・極太線)。一字一句変えない。 */
  STYLE:
    '2D-animated, hand-drawn doodle cartoon animation on plain warm off-white cream paper that fills the entire frame edge to edge, ' +
    'with thick rough black marker outlines drawn in slightly uneven strokes, flat solid opaque fills, no shading and no gradients.',
  /** 画面を閉じる一文。これが無いカットでは余白が人物・アイコン・数字で埋まる(前作で実証)。 */
  CLOSE:
    'Nothing else appears in the frame at any point, and no writing, numbers, symbols, diagrams or people of any kind appear.',
  /** 人の手が意図的に写るカット用(ふ化場の作業など)。 */
  CLOSE_H:
    'Nothing else appears in the frame at any point, and no writing, numbers, symbols or diagrams of any kind appear.',
  /**
   * 章カードと地図だけは画面内に文字を出す(ユーザー判断 2026-08-19)。
   * 前作の実測では、横書きの明示 + 文字数の明示 + ダブルクォートで高精度に出る。
   * 崩れるのは20箇所に1〜2箇所なので、出したあと必ず目視して崩れた分だけ作り直す。
   */
  CLOSE_TEXT:
    'No other writing, number, label or mark appears anywhere in the frame at any point, and no people appear.',
  /**
   * 寄りのカット用。被写体を大きく描かせると、モデルは描き込みを増やして画風から外れる
   * (第2章 cL41/cL42/cL45 で魚が青紫の写実寄りになり、卵黄嚢が別物になった)。
   * **合成器が寄りのカットへ自動で足す**(書き手は body に書かない)。
   */
  CLOSEUP_GUARD:
    'Even at this size the subject stays a simple flat doodle drawing with the same thick rough black outline, flat solid opaque ' +
    'fills and no extra detail, no texture, no highlights and no added colours.',

  places: {
    /** 外洋。水が全面を占める(帯として書くと紙に貼った水彩のパッチになる・実証済み) */
    SEA: 'a flat deep blue-green field of open ocean water filling the whole frame, with a few small pale specks drifting slowly in it',
    /** 沖の水面。上に空気の紙地を残す。 */
    SEA_SURFACE:
      'open ocean water filling the lower four fifths of the frame as a flat deep blue-green field, with one wavy black waterline across ' +
      'the top of it and plain cream paper above the line as open air',
    /** 川の中。海より明るく浅い。 */
    RIVER:
      'a flat blue-green field of shallow river water filling the whole frame, lighter than the sea, with a few small pale bubbles rising slowly',
    /** 川底。砂利が下三分の一を占める。 */
    RIVERBED:
      'the bed of a shallow river filling the whole frame, with a flat blue-green field of water above and a layer of rounded grey pebbles ' +
      'drawn as flat doodle shapes across the lower third',
    /** 砂利の中(卵の視点)。 */
    IN_GRAVEL:
      'the inside of a river gravel bed filling the whole frame, with rounded grey pebbles drawn as flat doodle shapes packed on all sides ' +
      'and narrow dark gaps of water between them',
    /**
     * ふ化場。**建物として引きで描かせない**。序章 cL13/cL19 で建物の全景を求めたところ、
     * 窓・外の風景・小さな人物が湧いた(否定形の no windows は効かない)。床と水だけに絞る。
     */
    HATCHERY:
      'a flat pale grey concrete floor with shallow clear water running across it, framed close so that no wall, window, ceiling, ' +
      'doorway or horizon is visible at any point',
  },

  subjects: {
    /** 成体(銀)。第8章の遡上以降は使わない。 */
    ADULT:
      'one cartoon salmon in side view facing left, with a silver-grey body, a white belly, a dark back, one small solid black dot for its ' +
      'eye and small simple fins',
    /** 遡上期。銀を失い、暗い帯・曲がった鼻。cL210 以降の主人公。 */
    SPAWNER:
      'one cartoon salmon in side view facing left, its body dull olive-brown with broad dark red-brown bands across its flank, a hooked ' +
      'upper jaw, one small solid black dot for its eye and worn ragged fins, with no silver anywhere on it',
    /** 稚魚(5cm)。 */
    FRY: 'one tiny cartoon salmon fry in side view facing left, a small slender silver-grey body with a white belly and one small solid black dot for its eye',
    /** 卵黄嚢つきの仔魚。 */
    ALEVIN:
      'one tiny cartoon salmon hatchling in side view facing left, its thin body a plain pale silver-grey with no other colours on it, ' +
      'one small solid black dot for its eye, and a large round plain orange yolk sac hanging under its belly',
    /** いくら一粒。目が入っている。 */
    EGG: 'one salmon roe pearl, a translucent orange sphere with a brighter orange centre and one small solid black dot inside it for the eye',
    /** 母。実体のある大きなサケとして描く(前作の破線の幽霊は意味が伝わらなかった)。 */
    MOTHER:
      'one large cartoon salmon in side view facing left, clearly bigger than the others, with a silver-grey body, a dark back and one small ' +
      'solid black dot for its eye',
  },

  props: {
    TRAY: 'a square shallow hatchery tray of flat pale grey, holding a single layer of small orange roe pearls',
    BEAR:
      'one cartoon brown bear standing in the shallow water in side view, a heavy rounded dark brown body with small round ears and one ' +
      'small solid black dot for its eye',
    SEABIRD: 'one cartoon seabird in side view with white body, grey wings and one small solid black dot for its eye',
    BIG_FISH: 'one large dark predatory cartoon fish in side view with a blunt head, a wide mouth and one small solid black dot for its eye',
    /**
     * 【紙は文字を呼ぶ】2026-08-19 に2度実証。
     *  - 第6章 cL143「罫線のある白い紙」→ "Paytorw!" が大書され、鎖で4カット引きずった
     *  - 第7章 cL176「集計の帳面に罫線を引く」→ "tyre 7.16" が大書され、鎖で6カット引きずった
     * 紙・帳面・書類・罫線は、指定していない文字を強く呼び込む。文字を出さないカットでは
     * 紙を「紙」と呼ばず、`BLANK_PLATE` のように無地の矩形として書く。
     */
    BLANK_PLATE:
      'a plain pale rectangle with a thin black outline and a completely blank inside, with no text, no letters, no ruled lines and no ' +
      'marks of any kind on it at any moment',
    /** 北太平洋の地図。回遊を見せる章で使う。 */
    NPAC_MAP:
      'a simple hand-drawn map of the North Pacific Ocean seen from directly above, filling the whole frame: a flat pale blue-green ocean ' +
      'with every coastline drawn as a thick black doodle line, the curved chain of the Japanese islands at the lower left, the long ' +
      'Kamchatka peninsula rising at the upper left, the arc of the Aleutian islands running across the top, and the bulk of Alaska at ' +
      'the upper right, with all land filled flat cream',
    /** 日本列島だけの地図。終章の地域差で使う。 */
    JAPAN_MAP:
      'a simple hand-drawn map of the Japanese islands seen from directly above, filling the whole frame: a flat pale blue-green sea with ' +
      'the coastline drawn as a thick black doodle line, the large northern island of Hokkaido at the top and the long main island ' +
      'stretching down to the lower left, with all land filled flat cream',
    /** 地図の上を進む主人公。 */
    MAP_DOT: 'one small silver-grey dot standing for the salmon',
  },
};

export default vocab;
