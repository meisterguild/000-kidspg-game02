import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import GummyBoard from './GummyBoard';
import { DIFFICULTY, PLANE_FACES, generateStage, movableFrom } from './core';
import { playSound } from '../../utils/assets';
import { useWideLayout } from '../../hooks/useWideLayout';
import ShinyWaveBackground from '../../components/ShinyWaveBackground';

/* ============================================================
   ゲーム進行（制限時間・ステージ進行・スコア）

   スコア = Σ（各ステージで食べたグミの最大数 × 難易度係数）
   クリアしたステージは「全グミ × 係数」で確定する。
   進行中のステージは「そのステージで到達した最大の食数 × 係数 × 部分点率」。

   食数は "そのステージ内での最大到達数" を使う（high-water mark）。
   Undo・やりなおしでスコアが減らないようにするため。
   ============================================================ */

/**
 * config.json に stageProgression が無いときの既定。
 * **出荷する config.json と揃えておくこと**（食い違うと、設定を落とした
 * ときだけ静かに別の難易度で動く）。全面 4×4 で、3面目から経路を長くする。
 */
export const DEFAULT_STAGE_PROGRESSION = [
  { size: 4, difficulty: 'veasy',  multiplier: 8 },
  { size: 4, difficulty: 'easy',   multiplier: 8 },
  { size: 4, difficulty: 'normal', multiplier: 8 },
  { size: 4, difficulty: 'hard',   multiplier: 8 },
  { size: 4, difficulty: 'vhard',  multiplier: 8 },
];

export const DEFAULT_TIME_LIMIT_SECONDS = 120;
/** 0 以下で上限なし。ゲームは制限時間で終わるので、既定は上限を設けない */
export const DEFAULT_MAX_STAGES = 0;
/** 進行中ステージの部分点率。0 なら「クリアした面だけが点になる」 */
export const DEFAULT_PARTIAL_SCORE_RATE = 0;

/** クリア演出を見せてから次ステージへ進むまでの待ち時間 */
const CLEAR_DELAY_MS = 1500;
/** 同じグミを続けて叩いたとき、無効フィードバックを出さない猶予 */
const REPEAT_TAP_GRACE_MS = 400;
/** グミを食べる音の音程（半音）。長音階のペンタトニックを巡回させる */
const EAT_PITCH_STEPS = [0, 2, 4, 7, 9];

const formatTime = (sec) => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function GummyGame({ config, boardMode = 'cube', onScoreChange, onLevelChange, onGameOver, onEscape }) {
  // 横に余白のある画面（PCモニタ）では HUD を左右へ逃がし、盤面を縦いっぱいに使う
  const wide = useWideLayout();
  const gameConf = config?.game || {};

  /* --- 盤面の作り ---
     plane は立方体の3面ではなく正面1面だけを使う（3歳以上を対象に加えたため）。
     ステージ進行と繰り返しの設定は config.game.plane に分けて持つ。
     🔴 **立方体側の設定には触らない。** plane が無い・cube のときは
     従来どおり config.game.* をそのまま読む。 */
  const plane = boardMode === 'plane' ? (gameConf.plane || null) : null;
  const faces = plane ? PLANE_FACES : undefined;
  const conf = plane || gameConf;

  const progression = useMemo(() => {
    const p = conf.stageProgression;
    return Array.isArray(p) && p.length ? p : DEFAULT_STAGE_PROGRESSION;
  }, [conf.stageProgression]);
  // 制限時間と部分点率は平面でも共通（1プレイ120秒の枠は変えない）
  const timeLimit = gameConf.timeLimitSeconds ?? DEFAULT_TIME_LIMIT_SECONDS;
  const partialRate = gameConf.partialScoreRate ?? DEFAULT_PARTIAL_SCORE_RATE;
  const repeatLast = conf.repeatLastStage !== false;
  const maxStages = conf.maxStages ?? DEFAULT_MAX_STAGES;

  const planAt = useCallback((i) => {
    // maxStages は「保険の上限」。0 以下なら上限なし＝**時間切れだけが終了条件**になる。
    // 以前は既定 6 で打ち切っていたため、易しい面を速く抜けると
    // 「残り時間があるのにゲームが終わる」状態になっていた（2026-09-02 修正）。
    if (maxStages > 0 && i >= maxStages) return null;
    if (i < progression.length) return progression[i];
    return repeatLast ? progression[progression.length - 1] : null;
  }, [progression, repeatLast, maxStages]);

  const [stageIndex, setStageIndex] = useState(0);
  const [game, setGame] = useState(() => {
    const plan = progression[0];
    const stage = generateStage(plan.size, plan.difficulty, faces);
    return { stage, path: [stage.start] };
  });
  const [clearedCount, setClearedCount] = useState(0);
  const [baseScore, setBaseScore] = useState(0);   // 確定済み（クリア済みステージ）の合計
  const [remain, setRemain] = useState(timeLimit);
  const [finished, setFinished] = useState(false);
  const [finishReason, setFinishReason] = useState('timeup');

  const shakeRef = useRef(null);
  const advancingRef = useRef(false);
  const finishedRef = useRef(false);
  const clearTimerRef = useRef(null);
  const deadlineRef = useRef(Date.now() + timeLimit * 1000);
  const lastTapRef = useRef({ cell: null, at: 0 });
  const curRef = useRef(null);
  const finishedAtRef = useRef(0);
  const giveUpRef = useRef(null);
  // 食べる音の音程を進める位置。もどす・やりなおす・面の切り替えで最初へ戻す
  const comboRef = useRef(0);
  // 各コールバックから最新の値を読むための箱。レンダーごとに詰め替える。
  const liveRef = useRef({});

  const { stage, path } = game;
  const cur = path[path.length - 1];
  curRef.current = cur;
  const movable = useMemo(() => movableFrom(stage, path), [stage, path]);
  const cleared = cur === stage.goal && path.length === stage.cells.length;
  const deadEnd = !cleared && movable.size === 0;
  const total = stage.cells.length;
  const plan = planAt(stageIndex) || progression[progression.length - 1];

  /* --- そのステージでの最大到達数（Undo/やりなおしで減らさない） --- */
  // state にすると「ステージ差し替え直後の1フレームだけ前ステージの記録が残り、
  // スコアが一瞬跳ね上がる」ため、レンダー中に確定させる。
  const bestRef = useRef({ index: -1, best: 1 });
  if (bestRef.current.index !== stageIndex) {
    bestRef.current = { index: stageIndex, best: path.length };
  } else if (path.length > bestRef.current.best) {
    bestRef.current.best = path.length;
  }
  const bestEaten = bestRef.current.best;

  /* --- 現在スコア --- */
  // 終了後は確定値だけを見せる（進行中ステージの二重計上を避ける）。
  // クリア直後は加算待ち（演出中）なので、確定分を先に見せる。
  const pendingScore = finished
    ? 0
    : cleared
      ? total * plan.multiplier
      // 進んだ手数ぶんを点にする（スタート地点にいるだけの 0 手では点にしない）
      : Math.floor(Math.max(0, bestEaten - 1) * plan.multiplier * partialRate);
  const shownScore = baseScore + pendingScore;

  useEffect(() => { onScoreChange?.(shownScore); }, [shownScore, onScoreChange]);
  useEffect(() => { onLevelChange?.(clearedCount); }, [clearedCount, onLevelChange]);

  /* --- 終了処理 --- */
  const finish = useCallback((finalScore, extraCleared = 0, reason = 'timeup') => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    finishedAtRef.current = Date.now();
    // クリア演出の待機タイマーが残っていると、終了後に次ステージが立ち上がってしまう
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    advancingRef.current = false;
    setBaseScore(finalScore);
    if (extraCleared) setClearedCount((n) => n + extraCleared);
    setFinishReason(reason);
    setFinished(true);
    // 終了音は鳴らさない（結果画面への遷移音が続けて鳴るため）
    onGameOver?.(finalScore);
  }, [onGameOver]);

  /* --- 制限時間 --- */
  useEffect(() => {
    const id = setInterval(() => {
      if (finishedRef.current) return;
      const left = (deadlineRef.current - Date.now()) / 1000;
      setRemain(left > 0 ? left : 0);
    }, 100);
    return () => clearInterval(id);
  }, []);

  // 時間切れ判定はスコアの最新値を使いたいので remain とは別の effect に置く
  useEffect(() => {
    if (remain > 0 || finishedRef.current) return;
    // クリア演出中に時間切れになった場合、そのステージはクリア扱いで確定させる
    finish(shownScore, cleared ? 1 : 0);
  }, [remain, shownScore, cleared, finish]);

  /* --- 操作 --- */
  const pick = useCallback((cell) => {
    if (finishedRef.current || advancingRef.current) return;
    setGame((g) => {
      // ビュー側のスナップショットではなく、最新の状態で隣接を再判定する
      if (!movableFrom(g.stage, g.path).has(cell)) return g;
      return { ...g, path: [...g.path, cell] };
    });
  }, []);

  const reject = useCallback((cell) => {
    // クリア演出中は movable が空になるため、触れば必ず「ブブー」が鳴ってしまう。叱らない。
    if (finishedRef.current || advancingRef.current) return;
    // 現在位置そのものをタップした場合も無音
    if (cell === curRef.current) return;
    const now = Date.now();
    const last = lastTapRef.current;
    // 直前に触ったグミの二度押しは叱らない。
    // ここで窓を更新すると連打時に窓が滑り続け、フィードバックが恒久的に消える。
    if (last.cell === cell && now - last.at < REPEAT_TAP_GRACE_MS) return;
    lastTapRef.current = { cell, at: now };
    shakeRef.current?.(cell);
    playSound('ng', 0.4).catch(() => {});
  }, []);

  const pickWithMemo = useCallback((cell) => {
    lastTapRef.current = { cell, at: Date.now() };
    pick(cell);
  }, [pick]);

  const undo = useCallback(() => {
    if (finishedRef.current || advancingRef.current) return;
    setGame((g) => (g.path.length > 1 ? { ...g, path: g.path.slice(0, -1) } : g));
    comboRef.current = 0;
    // sound7 は音源自体が長く（150KB）、もどす操作に対して間延びしていた
    // （2026-09-08 の動作確認）。食べる音を低く鳴らして「戻した」を短く示す。
    // 別の音に替えたいときは action.mp3（未使用・6KB）が使える。
    playSound('paltu', 0.5, 0.6).catch(() => {});
  }, []);

  /**
   * やりなおす。同じ盤面をリセットするのではなく、同じ難易度で別の問題を出す。
   * 行き止まりに突き当たった子が、同じ配置で何度も詰まり続けるのを防ぐため。
   * スコアはステージ番号で持つ最大到達数を使うので、引き直しても減らない。
   */
  const restart = useCallback(() => {
    if (finishedRef.current || advancingRef.current) return;
    const p = liveRef.current.plan;
    const next = generateStage(p.size, p.difficulty, liveRef.current.faces);
    setGame({ stage: next, path: [next.start] });
    comboRef.current = 0;
    playSound('buttonClick', 0.5).catch(() => {});
  }, []);

  /** 途中でやめる。スコアはそのまま確定し、記念カードは作られる。 */
  const giveUp = useCallback(() => {
    if (finishedRef.current) return;
    finish(baseScore + pendingScore, cleared ? 1 : 0, 'giveup');
  }, [finish, baseScore, pendingScore, cleared]);

  giveUpRef.current = giveUp;

  /**
   * キャラクターが移動を終えた（または次の移動で上書きされた）タイミングで音を鳴らす。
   *
   * 音量 0.5 のままだと会場で聞こえず「効果音が無い」と感じられた
   * （2026-09-08 の動作確認）。上げたうえで、**食べるたびに音程を上げる**。
   * 連続で食べると音階が登っていくので、手が止まらない気持ちよさが出る。
   * 音階は長音階のペンタトニック（0・2・4・7・9 半音）を巡回させる。
   * 巡回させるのは、上げ続けると数手で不快な高音になるため。
   */
  const handleLanded = useCallback((crossedFace) => {
    const step = EAT_PITCH_STEPS[comboRef.current % EAT_PITCH_STEPS.length];
    comboRef.current += 1;
    const rate = Math.pow(2, step / 12);
    // 第4引数は「重ねて鳴らす」。連打すると前の音を巻き戻して消してしまい、
    // 一本道の盤面では効果音が出ていないように聞こえた（2026-09-09 の指摘）
    playSound(crossedFace ? 'jump' : 'paltu', 0.9, rate, true).catch(() => {});
  }, []);

  /* --- クリア → 次ステージ --- */
  // 依存は cleared のみに絞り、必要な値は ref から読む。
  // 依存配列が動いて cleanup が走ると advancingRef が立ったまま
  // タイマーだけ消えて進行不能になるため。
  liveRef.current = { total, plan, stageIndex, planAt, baseScore, finish, faces };

  useEffect(() => {
    if (!cleared || finishedRef.current || advancingRef.current) return;
    advancingRef.current = true;

    const { total: t, plan: p } = liveRef.current;
    const gained = t * p.multiplier;
    playSound('bell', 0.6).catch(() => {});

    clearTimerRef.current = setTimeout(() => {
      clearTimerRef.current = null;
      if (finishedRef.current) { advancingRef.current = false; return; }

      const l = liveRef.current;
      setBaseScore((s) => s + gained);
      setClearedCount((n) => n + 1);

      const nextIndex = l.stageIndex + 1;
      const nextPlan = l.planAt(nextIndex);
      if (!nextPlan) {
        advancingRef.current = false;
        l.finish(l.baseScore + gained);
        return;
      }
      const nextStage = generateStage(nextPlan.size, nextPlan.difficulty, l.faces);
      comboRef.current = 0;
      setStageIndex(nextIndex);
      setGame({ stage: nextStage, path: [nextStage.start] });
      advancingRef.current = false;
    }, CLEAR_DELAY_MS);
  }, [cleared]);

  // アンマウント時に待機中のタイマーを片付ける
  useEffect(() => () => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
  }, []);

  /* --- キーボード --- */
  useEffect(() => {
    const onKey = (e) => {
      // 終了演出中の Esc は無視する（記録が保存されないまま TOP へ戻るのを防ぐ）
      if (e.key === 'Escape') {
        // Esc は「おわる」と同じ扱いにする。
        // 以前は写真だけ残して記録が作られない孤児ディレクトリを生んでいた。
        if (!finishedRef.current) { giveUpRef.current?.(); return; }
        // 結果画面への遷移が起きなかった場合に詰まないよう、
        // 一定時間が過ぎたら TOP への脱出口として通す。
        if (Date.now() - finishedAtRef.current > 4000) onEscape?.();
        return;
      }
      if (e.key === 'z' || e.key === 'Backspace') undo();
      if (e.key === 'r') restart();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, restart, onEscape]);

  /* --- 表示 --- */
  const eaten = path.length;
  // プレイ中は長い文を読まない前提で、一目で入る短さにする
  // （2026-09-08 の動作確認）。何を押すかはボタン側の記号で示す。
  //
  // 「あと1つ！ GOAL へ」は出さない。画面中央に置くと GOAL 札に被り、
  // いちばん見せたいものを隠していた（2026-09-08 の指摘）。
  // 残り1つの合図は、盤面側で GOAL 札を膨らませて出す（GummyBoard）。
  const status = cleared
    ? { tone: 'clear', text: 'ぜんぶ食べた！ CLEAR' }
    : deadEnd
      ? { tone: 'stuck', text: 'いきどまり！ ↩ でもどろう' }
      : null;

  const urgent = remain <= 30;
  const progressPct = Math.round((eaten / total) * 100);
  const diffLabel = DIFFICULTY[plan.difficulty]?.label || plan.difficulty;

  /* --- HUD 部品（左右レイアウトと重ねレイアウトで共用） --- */
  const controlsDisabled = finished || cleared;
  // whitespace-nowrap は必須。左右のHUD列は 210〜300px しかなく、
  // 「1手もどす」が2行に折り返れていた（2026-09-08 の動作確認）。
  const btnBase = 'rounded-xl border font-bold transition-colors disabled:opacity-30 whitespace-nowrap';
  const controls = (
    <>
      {/* 3つとも同じ白いボタンだったため、いちばん使う「1手もどす」が
          他に埋もれていた（2026-09-08 の動作確認）。
          もどす＝主・やりなおす＝副・おわる＝控えの順に見た目を分け、
          記号を添えて文字を読まなくても意味が取れるようにする。 */}
      <button
        onClick={undo}
        disabled={path.length <= 1 || controlsDisabled}
        className={`${btnBase} bg-amber-300 hover:bg-amber-200 text-amber-950 border-amber-500 shadow-lg ${
          wide ? 'w-full px-5 py-5 text-2xl' : 'px-5 py-3 text-xl'
        }`}
      >
        <span aria-hidden="true" className="mr-2">↩</span>1手もどす
      </button>
      <button
        onClick={restart}
        disabled={controlsDisabled}
        className={`${btnBase} bg-white/90 hover:bg-white text-amber-950 border-white shadow-md ${
          wide ? 'w-full px-5 py-4 text-xl' : 'px-5 py-3 text-lg'
        }`}
      >
        <span aria-hidden="true" className="mr-2">⟳</span>やりなおす
      </button>
      <button
        onClick={giveUp}
        disabled={controlsDisabled}
        className={`${btnBase} bg-white/50 hover:bg-white/70 text-amber-900 border-white/70 ${
          wide ? 'w-full px-4 py-3 text-base' : 'px-4 py-2 text-sm'
        }`}
      >
        おわる
      </button>
    </>
  );

  const progressBar = (
    <div className="h-2 rounded-full bg-amber-900/20 overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-300"
        style={{ width: `${progressPct}%`, background: 'linear-gradient(90deg,#ff7ab0,#ffa62b)' }}
      />
    </div>
  );

  const statusPill = status && (
    <div
      className={`px-5 py-2 rounded-full text-center font-bold shadow-lg ${
        wide ? 'text-xl lg:text-2xl' : 'text-base sm:text-lg'
      } ${
        status.tone === 'clear'
          ? 'bg-amber-300/90 text-amber-950'
          : 'bg-slate-900/80 text-slate-100'
      }`}
    >
      {status.text}
    </div>
  );

  const board = (extra) => (
    <GummyBoard
      stage={stage}
      path={path}
      movable={movable}
      cleared={cleared}
      onPick={pickWithMemo}
      onReject={reject}
      onLanded={handleLanded}
      shakeRef={shakeRef}
      plane={!!plane}
      {...extra}
    />
  );

  return (
    <div className="absolute inset-0 overflow-hidden select-none">
      {/* 背景はスタート画面と同じ。盤面（GummyBoard）の canvas は透過なので後ろに敷ける。
          盤面の描画と競合させたくないので、こちらのフレームレートは落としてある */}
      <ShinyWaveBackground position="absolute" fps={20} />
      {wide ? (
        /* ===== PCモニタ向け：盤面は縦いっぱい、HUD は左右の余白へ ===== */
        <div className="absolute inset-0 flex items-stretch">
          {/* 左：残り時間・進行・スコア */}
          <aside
            className="shrink-0 flex flex-col justify-center gap-7 px-5 py-6 text-amber-950"
            style={{ width: 'clamp(240px, 19vw, 320px)' }}
          >
            <div>
              <div className="hud-label text-lg tracking-widest mb-1">のこり時間</div>
              <div
                className={`gold-heading tabular-nums leading-none ${urgent ? 'text-red-700' : 'text-orange-900'}`}
                style={{ fontSize: 'clamp(3.25rem, 6vw, 5.2rem)' }}
              >
                {formatTime(remain)}
              </div>
            </div>

            <div>
              <div className="flex items-baseline gap-2 tabular-nums mb-1">
                <span className="hud-label text-lg tracking-widest">たべた</span>
                <span className="ml-auto">
                  <span className="gold-heading text-3xl">{eaten}</span>
                  <span className="hud-label text-lg"> / {total}</span>
                </span>
              </div>
              {progressBar}
              {/* 1行に詰めると「ステージ 1・Very Easy・4×4」が折り返る。
                  子どもが見るのはステージ番号だけなので、難易度と盤の大きさは
                  小さく2行目へ落とす（2026-09-08 の動作確認）。 */}
              <div className="hud-label mt-2 text-base leading-tight">
                ステージ {stageIndex + 1}
              </div>
              <div className="hud-label text-xs leading-tight opacity-90">
                {diffLabel}・{plan.size}×{plan.size}
              </div>
            </div>

            <div className="border-t border-amber-900/25 pt-5 space-y-3">
              <div>
                <div className="hud-label text-lg tracking-widest">スコア</div>
                <div className="gold-heading text-4xl tabular-nums leading-tight text-orange-700">{shownScore}</div>
              </div>
              <div>
                <div className="hud-label text-lg tracking-widest">クリア</div>
                <div className="gold-heading text-3xl tabular-nums leading-tight text-green-700">
                  {clearedCount}
                  <span className="hud-label text-lg"> ステージ</span>
                </div>
              </div>
            </div>
          </aside>

          {/* 中央：盤面 */}
          <div className="relative flex-1 min-w-0">
            {board({ hudOverlay: false })}
            {statusPill && (
              <div className="absolute inset-x-0 top-3 flex justify-center pointer-events-none px-4">
                {statusPill}
              </div>
            )}
          </div>

          {/* 右：操作と説明 */}
          <aside
            className="shrink-0 flex flex-col justify-center gap-3 px-5 py-6"
            style={{ width: 'clamp(240px, 19vw, 320px)' }}
          >
            {/* 3行に伸びて読まれないので2行に詰めた（2026-09-08 の動作確認）。
                「光る＝押せる」と「GOAL が目的地」の2つだけ伝える。 */}
            <div className="gold-heading text-2xl mb-3 leading-snug">
              光るグミをクリック！<br />GOAL をめざそう
            </div>
            {controls}
            {/* 4行あった操作説明は畳んだ。プレイ中に読まれないため
                （2026-09-08 の動作確認）。意味はボタンのラベルと記号で示し、
                ここは「困ったときに何を押すか」の1行だけ残す。 */}
            <div className="hud-label mt-3 text-base leading-relaxed">
              こまったら「やりなおす」
            </div>
          </aside>
        </div>
      ) : (
        /* ===== 幅が足りない・縦長の画面：従来どおり HUD を盤面へ重ねる ===== */
        <>
          {board()}

          {/* 上部：残り時間と進行状況 */}
          <div className="absolute top-0 inset-x-0 p-3 pointer-events-none">
            <div className="mx-auto max-w-xl flex items-center gap-3 min-w-0">
              <div
                className={`gold-heading text-3xl sm:text-4xl tabular-nums leading-none shrink-0 ${urgent ? 'text-red-700' : 'text-orange-900'}`}
              >
                {formatTime(remain)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-base tabular-nums">
                  <span className="hud-label">{eaten}</span>
                  <span className="hud-label">/ {total}</span>
                  <span className="hud-label ml-auto text-sm">
                    ステージ {stageIndex + 1}・{diffLabel}・{plan.size}×{plan.size}
                  </span>
                </div>
                <div className="mt-1">{progressBar}</div>
              </div>
            </div>
          </div>

          {/* 中央：状態メッセージ */}
          {statusPill && (
            <div className="absolute inset-x-0 top-[22%] flex justify-center pointer-events-none px-4">
              {statusPill}
            </div>
          )}

          {/* 下部：操作 */}
          <div className="absolute bottom-0 inset-x-0 p-4 flex justify-center gap-3">
            {controls}
          </div>
        </>
      )}

      {/* 終了オーバーレイ */}
      {finished && (
        <div className="absolute inset-0 bg-white/75 flex flex-col items-center justify-center text-amber-950">
          <div className="gold-heading text-4xl mb-2">{finishReason === 'giveup' ? 'おつかれさま！' : 'タイムアップ！'}</div>
          <div className="text-2xl text-amber-900">{clearedCount} ステージ クリア</div>
          <div className="gold-heading text-5xl text-orange-700 mt-3 tabular-nums">{shownScore}</div>
        </div>
      )}
    </div>
  );
}
