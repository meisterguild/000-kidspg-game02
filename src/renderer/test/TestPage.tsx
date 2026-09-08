import React, { useEffect, useCallback, useState, useMemo } from 'react';
import { useConfig } from '../contexts/ConfigContext';
import { playSound } from '../utils/assets';
import type { ComfyUIStatus, ComfyUIActiveJob } from '@shared/types/comfyui';
import type { GenerationParams } from '@shared/config/generation-params';
import { GENERATION_NUMBER_RANGES } from '@shared/config/generation-params';
import {
  CAMERA_RANGES,
  DIFFICULTIES,
  GAME_NUMBER_RANGES,
  RANK_THRESHOLD_COUNT,
  STAGE_RANGES,
  type ConfigPatch,
} from '@main/services/config-writer';

/**
 * 入力欄はすべて文字列で持つ。
 *
 * number 型の state にすると、入力途中の "0." や "" を数値へ丸める過程で
 * カーソルが飛んだり、消したはずの値が 0 に戻ったりする。
 * 保存時にまとめて数値へ変換し、範囲の検査は main 側（config-writer.ts）に任せる。
 */
interface StageDraft {
  size: string;
  difficulty: string;
  multiplier: string;
}

interface Draft {
  timeLimitSeconds: string;
  levelUpScoreInterval: string;
  partialScoreRate: string;
  maxStages: string;
  repeatLastStage: boolean;
  rankThresholds: string[];
  stageProgression: StageDraft[];
  cameraWidth: string;
  cameraHeight: string;
  generation: Record<string, string>;
}

const numberToInput = (value: number | undefined): string =>
  value === undefined || value === null ? '' : String(value);

/** 入力文字列 → 数値。空欄は undefined（＝この項目は保存しない） */
/**
 * 入力欄を数値にする。空欄なら undefined（＝パッチに載せない）。
 *
 * 🔴 **`current` を必ず渡すこと。**
 * 空欄を黙って undefined にすると、その項目だけパッチから落ちる。
 * config 側に値がある項目でそれをやると、**旧値が残ったまま
 * 「保存しました」と出る**——スタッフは変えたつもりでいるのに変わっていない。
 * そこで「いま config に値がある項目が空欄なら」明示的にエラーにする。
 * ランク閾値とステージ進行は先に同じ穴を塞いでいるので、それに揃えた。
 *
 * @param current いま config.json に入っている値。undefined なら
 *   「もともと無い項目」なので、空欄のままでよい（省略として扱う）
 */
const parseOptionalNumber = (
  raw: string,
  label: string,
  errors: string[],
  current?: number
): number | undefined => {
  const trimmed = raw.trim();
  if (trimmed === '') {
    if (current !== undefined) {
      errors.push(`${label}: 空欄です（消したい場合は config.json を直接編集してください）`);
    }
    return undefined;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    errors.push(`${label}: 数値を入力してください（入力値「${raw}」）`);
    return undefined;
  }
  return value;
};

const GENERATION_FIELDS: Array<{
  key: keyof typeof GENERATION_NUMBER_RANGES;
  label: string;
  hint?: string;
}> = [
  {
    key: 'denoise',
    label: 'denoise',
    hint: '1 だと写真は輪郭しか使われない。0.5〜0.65 で顔の面影が残る',
  },
  {
    key: 'steps',
    label: 'steps',
    hint: 'denoise を下げてもサンプリング回数はこの値のまま。増やすとその分だけ時間が伸びる',
  },
  { key: 'cfg', label: 'cfg', hint: '1 にするとネガティブプロンプトが効かなくなる' },
  { key: 'controlnetStrength', label: 'ControlNet strength', hint: '輪郭の拘束の強さ' },
  { key: 'controlnetStartPercent', label: 'ControlNet start_percent' },
  {
    key: 'controlnetEndPercent',
    label: 'ControlNet end_percent',
    hint: '小さいほど早く輪郭の拘束が外れ、写真から離れる',
  },
  { key: 'cannyLowThreshold', label: 'Canny low_threshold' },
  { key: 'cannyHighThreshold', label: 'Canny high_threshold' },
  { key: 'inputSize', label: '入力解像度（正方形）', hint: '上げると生成時間が伸びる' },
];

export const TestPage: React.FC = () => {
  const { config, reloadConfig, saveConfig, loading, error } = useConfig();
  const [comfyUIStatus, setComfyUIStatus] = useState<ComfyUIStatus | null>(null);
  const [comfyUIHealth, setComfyUIHealth] = useState<boolean | null>(null);
  const [comfyUIJobs, setComfyUIJobs] = useState<ComfyUIActiveJob[]>([]);
  const [comfyUILoading, setComfyUILoading] = useState(false);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // config.json は activeProfile + profiles 形式。旧フラット形式も一応読む。
  // ここを config.comfyui.baseUrl だけで見ると、プロファイル形式では**空欄になる**。
  const comfy = config?.comfyui;
  const activeProfileName = comfy?.activeProfile;
  const activeProfile = activeProfileName ? comfy?.profiles?.[activeProfileName] : undefined;
  const comfyUIUrl = activeProfile?.baseUrl ?? comfy?.baseUrl ?? '';
  const comfyUITemplate = activeProfile?.templatePath ?? comfy?.workflow?.templatePath ?? '';

  /**
   * いま効いている生成パラメータ（共通 → プロファイルの重ね合わせ、後勝ち）。
   * resolveComfyUIConfig と同じ順序にしてある。どちらか片方だけを見ると、
   * 共通側に書いた値が空欄に見えて実際には効く、という一番たちの悪いずれ方をする。
   * 入力欄への展開と、保存時の「空欄になっていないか」の判定で共有する。
   */
  const effectiveGeneration = useMemo(
    () => ({
      ...((comfy?.generation ?? {}) as Record<string, unknown>),
      ...((activeProfile?.generation ?? {}) as Record<string, unknown>),
    }),
    [comfy, activeProfile]
  );

  /** config.json の内容を入力欄へ展開する（画面を開いた時と、保存・再読み込みの後） */
  const resetDraft = useCallback(() => {
    if (!config) return;
    const generation: Record<string, string> = {};
    const source = effectiveGeneration;
    for (const field of GENERATION_FIELDS) {
      const value = source[field.key];
      generation[field.key] = typeof value === 'number' ? String(value) : '';
    }
    generation.positivePrompt = typeof source.positivePrompt === 'string' ? source.positivePrompt : '';
    generation.negativePrompt = typeof source.negativePrompt === 'string' ? source.negativePrompt : '';

    const thresholds = config.game.rankThresholds ?? [];
    setDraft({
      timeLimitSeconds: numberToInput(config.game.timeLimitSeconds),
      levelUpScoreInterval: numberToInput(config.game.levelUpScoreInterval),
      partialScoreRate: numberToInput(config.game.partialScoreRate),
      maxStages: numberToInput(config.game.maxStages),
      repeatLastStage: config.game.repeatLastStage ?? false,
      rankThresholds: Array.from({ length: RANK_THRESHOLD_COUNT }, (_, i) =>
        numberToInput(thresholds[i])
      ),
      // config.json を手編集して stageProgression を落とした場合でも、
      // この画面（＝それを直すための画面）が例外で真っ白にならないようにする
      stageProgression: (config.game.stageProgression ?? []).map((st) => ({
        size: String(st.size),
        difficulty: st.difficulty,
        multiplier: String(st.multiplier),
      })),
      cameraWidth: numberToInput(config.camera?.width),
      cameraHeight: numberToInput(config.camera?.height),
      generation,
    });
    setSaveError(null);
  }, [config, effectiveGeneration]);

  useEffect(() => {
    resetDraft();
  }, [resetDraft]);

  const updateDraft = useCallback((patch: Partial<Draft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setSaveMessage(null);
  }, []);

  const updateGeneration = useCallback((key: string, value: string) => {
    setDraft((prev) =>
      prev ? { ...prev, generation: { ...prev.generation, [key]: value } } : prev
    );
    setSaveMessage(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    await playSound('buttonClick');
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const errors: string[] = [];
      const game: NonNullable<ConfigPatch['game']> = { repeatLastStage: draft.repeatLastStage };

      const timeLimit = parseOptionalNumber(
        draft.timeLimitSeconds,
        '制限時間',
        errors,
        config?.game.timeLimitSeconds
      );
      if (timeLimit !== undefined) game.timeLimitSeconds = timeLimit;
      const levelUp = parseOptionalNumber(
        draft.levelUpScoreInterval,
        'レベルアップ間隔',
        errors,
        config?.game.levelUpScoreInterval
      );
      if (levelUp !== undefined) game.levelUpScoreInterval = levelUp;
      const partial = parseOptionalNumber(
        draft.partialScoreRate,
        '部分点率',
        errors,
        config?.game.partialScoreRate
      );
      if (partial !== undefined) game.partialScoreRate = partial;
      const maxStages = parseOptionalNumber(
        draft.maxStages,
        '最大ステージ数',
        errors,
        config?.game.maxStages
      );
      if (maxStages !== undefined) game.maxStages = maxStages;

      // ランク閾値は7個そろって初めて意味を持つ。
      // 欠けたまま黙って「送らない」で済ませると、保存成功と出るのに
      // 編集がまるごと捨てられて理由も分からない
      const thresholds = draft.rankThresholds.map((raw, i) =>
        parseOptionalNumber(raw, `ランク閾値${i + 1}`, errors)
      );
      if (thresholds.every((v) => v !== undefined)) {
        game.rankThresholds = thresholds as number[];
      } else if (thresholds.some((v) => v !== undefined) || config?.game.rankThresholds) {
        errors.push(`ランク閾値: ${RANK_THRESHOLD_COUNT} 個すべて入力してください（空欄があります）`);
      }

      const stages = draft.stageProgression.map((st, i) => ({
        size: parseOptionalNumber(st.size, `ステージ${i + 1} の盤サイズ`, errors),
        difficulty: st.difficulty,
        multiplier: parseOptionalNumber(st.multiplier, `ステージ${i + 1} の倍率`, errors),
      }));
      if (draft.stageProgression.length === 0) {
        errors.push('ステージ進行: 1 件以上にしてください');
      } else if (stages.every((st) => st.size !== undefined && st.multiplier !== undefined)) {
        game.stageProgression = stages as NonNullable<ConfigPatch['game']>['stageProgression'];
      } else {
        // 空欄のままだと parseOptionalNumber はエラーを積まないので、ここで明示する。
        // 黙って捨てると「追加した面が消えたのに保存成功と出る」ことになる
        errors.push('ステージ進行: 盤サイズと倍率に空欄があります');
      }

      const camera: NonNullable<ConfigPatch['camera']> = {};
      const cameraWidth = parseOptionalNumber(
        draft.cameraWidth,
        '撮影解像度（幅）',
        errors,
        config?.camera?.width
      );
      if (cameraWidth !== undefined) camera.width = cameraWidth;
      const cameraHeight = parseOptionalNumber(
        draft.cameraHeight,
        '撮影解像度（高さ）',
        errors,
        config?.camera?.height
      );
      if (cameraHeight !== undefined) camera.height = cameraHeight;

      const generation: GenerationParams = {};
      for (const field of GENERATION_FIELDS) {
        // 現在値は「いま効いている値」＝画面を開いたときに入っていた値。
        // 空欄にされたら旧値が残るので、それをエラーにする
        const value = parseOptionalNumber(
          draft.generation[field.key] ?? '',
          field.label,
          errors,
          effectiveGeneration[field.key] as number | undefined
        );
        if (value !== undefined) generation[field.key] = value;
      }
      if (draft.generation.positivePrompt.trim() !== '') {
        generation.positivePrompt = draft.generation.positivePrompt;
      }
      if (draft.generation.negativePrompt.trim() !== '') {
        generation.negativePrompt = draft.generation.negativePrompt;
      }

      if (errors.length > 0) {
        setSaveError(errors.map((e) => '・' + e).join('\n'));
        return;
      }

      const patch: ConfigPatch = { game, camera };
      // 生成パラメータは「いま選ばれているプロファイル」にだけ書く。
      // 使っていない側のプロファイルまで書き換えると、当日プロファイルを
      // 切り替えたときに知らない値が効いてしまう
      if (activeProfileName) {
        patch.comfyuiGeneration = { [activeProfileName]: generation };
      }

      const result = await saveConfig(patch);
      if (!result.success) {
        setSaveError(result.error ?? '設定の保存に失敗しました');
        return;
      }
      // 🔴 **点検結果（warnings）を必ず出す。** main は保存直後にワークフローを
      // 組み立てて配線を点検している。`denoise: 1` のように「範囲内なので保存はできるが、
      // 絵が写真とほぼ無関係になる」設定はここでしか伝えられない
      // （起動時の警告ダイアログはもう過ぎている）。
      const warnings = result.warnings?.length
        ? '\n\n【要確認】\n' + result.warnings.map((w) => '・' + w).join('\n')
        : '';
      setSaveMessage(
        (result.restartRequired && result.restartRequired.length > 0
          ? `保存しました。ただし ${result.restartRequired.join(' / ')} の変更はアプリを再起動しないと反映されません。`
          : '保存しました。ゲーム設定は次のプレイから、生成パラメータは次の撮影から反映されます。') + warnings
      );
    } finally {
      setSaving(false);
    }
  }, [draft, saveConfig, activeProfileName, config, effectiveGeneration]);

  const handleOpenComfyUI = useCallback(async () => {
    try {
      await playSound('buttonClick');
      if (!window.electronAPI) {
        alert('ブラウザ検証中は ComfyUI を開けません（Electron アプリから操作してください）');
        return;
      }
      const result = await window.electronAPI.comfyui.openUI();
      if (!result.success) alert('ComfyUI の画面を開けませんでした: ' + (result.error ?? '原因不明'));
    } catch (err) {
      console.warn('ComfyUI 画面のオープンに失敗:', err);
    }
  }, []);

  const handleExportWorkflow = useCallback(async () => {
    try {
      await playSound('buttonClick');
      if (!window.electronAPI) {
        alert('ブラウザ検証中はワークフローを書き出せません（Electron アプリから操作してください）');
        return;
      }
      const result = await window.electronAPI.comfyui.exportWorkflow();
      if (!result.success) {
        alert('ワークフローを書き出せませんでした: ' + (result.error ?? '原因不明'));
        return;
      }
      const warnings = result.warnings?.length
        ? '\n\n【警告】\n' + result.warnings.map((w) => '・' + w).join('\n')
        : '';
      alert(
        [
          'ゲームと同じ内容のワークフローを書き出しました。',
          result.filePath ?? '',
          '',
          '手順:',
          '1. 「ComfyUI をブラウザで開く」でブラウザを開く',
          '2. このJSONファイルをブラウザ画面へドラッグ＆ドロップ',
          '3. LoadImage ノードへ写真をドラッグ＆ドロップ',
          '4. Queue で生成',
        ].join('\n') + warnings
      );
    } catch (err) {
      console.warn('ワークフローの書き出しに失敗:', err);
    }
  }, []);

  const handleConfigReload = useCallback(async () => {
    try {
      await playSound('buttonClick');
      const result = await reloadConfig();
      // 再起動が要る項目を伝えないと、半分だけ適用された状態に気づけない
      const restart = result.restartRequired?.length
        ? '\n\nただし ' + result.restartRequired.join(' / ') + ' の変更はアプリを再起動しないと反映されません。'
        : '';
      // 手で config.json を編集した場合、その内容の点検結果はここが唯一の伝え所になる
      const warnings = result.warnings?.length
        ? '\n\n【要確認】\n' + result.warnings.map((w) => '・' + w).join('\n')
        : '';
      alert(
        '設定ファイル（config.json）を再読み込みしました。\n入力欄もファイルの内容へ戻します。'
        + restart + warnings
      );
    } catch (err) {
      console.warn('設定再読み込みエラー:', err);
      alert('設定ファイルの再読み込みに失敗しました。\nconfig.jsonファイルの内容を確認してください。');
    }
  }, [reloadConfig]);

  const refreshComfyUIStatus = useCallback(async () => {
    // ブラウザ検証では main が居ないため、状況は取れない（ヘルスは NG 表示のまま）
    if (!config?.comfyui || !window.electronAPI) return;

    setComfyUILoading(true);
    try {
      const [statusResult, healthResult, jobsResult] = await Promise.all([
        window.electronAPI.comfyui.getStatus(),
        window.electronAPI.comfyui.healthCheck(),
        window.electronAPI.comfyui.getActiveJobs()
      ]);

      setComfyUIStatus(statusResult.success ? (statusResult.status ?? null) : null);
      setComfyUIHealth(healthResult.success ? healthResult.isHealthy : false);
      setComfyUIJobs(jobsResult.success ? jobsResult.jobs : []);
    } catch (error) {
      console.error('ComfyUI status check failed:', error);
      setComfyUIStatus(null);
      setComfyUIHealth(false);
      setComfyUIJobs([]);
    } finally {
      setComfyUILoading(false);
    }
  }, [config]);

  const handleComfyUIRefresh = useCallback(async () => {
    try {
      await playSound('buttonClick');
      await refreshComfyUIStatus();
    } catch (err) {
      console.warn('ComfyUI status refresh error:', err);
    }
  }, [refreshComfyUIStatus]);

  useEffect(() => {
    if (config?.comfyui) {
      refreshComfyUIStatus();
    }
  }, [config, refreshComfyUIStatus]);

  const inputClass =
    'w-full px-2 py-1 rounded bg-red-950 border border-red-500 text-yellow-200 font-mono text-sm ' +
    'focus:outline-none focus:border-yellow-400';
  const blueInputClass =
    'w-full px-2 py-1 rounded bg-blue-950 border border-blue-500 text-yellow-200 font-mono text-sm ' +
    'focus:outline-none focus:border-yellow-400';

  return (
    <div
      className="bg-red-950"
      style={{
        minHeight: '100vh',
        height: '100vh',
        overflowY: 'scroll',
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0
      }}
    >
      <div className="container mx-auto py-8">
        {/* ページタイトル */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">テスト・設定ページ</h1>
          <p className="text-red-200">ゲームの設定確認・調整およびスプライト表示テスト</p>
          <p className="text-sm text-red-300 mt-1">Escキーでトップページに戻ります</p>
        </div>

        {/* 設定セクション */}
        <div className="mb-12">
          <div className="bg-red-900 border border-red-700 rounded-lg shadow-md p-6">
            <h2 className="text-xl font-semibold text-white mb-4 flex items-center">
              <span className="mr-2">⚙️</span>
              ゲーム設定 (config.json)
            </h2>

            {loading && (
              <div className="text-yellow-300 mb-4">設定を読み込み中...</div>
            )}

            {error && (
              <div className="bg-red-800 border border-red-600 rounded-md p-3 mb-4">
                <p className="text-red-200 font-medium">設定読み込みエラー</p>
                <p className="text-red-300 text-sm">{error}</p>
              </div>
            )}

            {config && draft && (
              <div className="grid md:grid-cols-2 gap-6 mb-6">
                <div className="space-y-4">
                  <div className="border border-red-600 rounded-lg p-4 bg-red-800">
                    <h3 className="font-medium text-red-200 mb-3">基本設定</h3>
                    <div className="space-y-3 text-sm">
                      <label className="block">
                        <span className="text-red-300">
                          制限時間（秒）{' '}
                          <span className="text-red-400 text-xs">
                            {GAME_NUMBER_RANGES.timeLimitSeconds.min}〜
                            {GAME_NUMBER_RANGES.timeLimitSeconds.max}
                          </span>
                        </span>
                        <input
                          type="number"
                          className={inputClass}
                          value={draft.timeLimitSeconds}
                          onChange={(e) => updateDraft({ timeLimitSeconds: e.target.value })}
                        />
                      </label>
                      <label className="block">
                        <span className="text-red-300">レベルアップ間隔（pts）</span>
                        <input
                          type="number"
                          className={inputClass}
                          value={draft.levelUpScoreInterval}
                          onChange={(e) => updateDraft({ levelUpScoreInterval: e.target.value })}
                        />
                      </label>
                      <label className="block">
                        <span className="text-red-300">
                          部分点率 <span className="text-red-400 text-xs">0〜1（0でクリアした面だけ加点）</span>
                        </span>
                        <input
                          type="number"
                          step="0.05"
                          className={inputClass}
                          value={draft.partialScoreRate}
                          onChange={(e) => updateDraft({ partialScoreRate: e.target.value })}
                        />
                      </label>
                      <label className="block">
                        <span className="text-red-300">
                          最大ステージ数 <span className="text-red-400 text-xs">0 で上限なし</span>
                        </span>
                        <input
                          type="number"
                          className={inputClass}
                          value={draft.maxStages}
                          onChange={(e) => updateDraft({ maxStages: e.target.value })}
                        />
                      </label>
                      <label className="flex items-center gap-2 text-red-300">
                        <input
                          type="checkbox"
                          checked={draft.repeatLastStage}
                          onChange={(e) => updateDraft({ repeatLastStage: e.target.checked })}
                        />
                        最終ステージをクリア後も同設定で出題し続ける
                      </label>
                    </div>
                  </div>

                  <div className="border border-red-600 rounded-lg p-4 bg-red-800">
                    <h3 className="font-medium text-red-200 mb-3">カメラ設定</h3>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <label className="block">
                        <span className="text-red-300">
                          撮影幅 <span className="text-red-400 text-xs">{CAMERA_RANGES.width.min}〜{CAMERA_RANGES.width.max}</span>
                        </span>
                        <input
                          type="number"
                          className={inputClass}
                          value={draft.cameraWidth}
                          onChange={(e) => updateDraft({ cameraWidth: e.target.value })}
                        />
                      </label>
                      <label className="block">
                        <span className="text-red-300">撮影高さ</span>
                        <input
                          type="number"
                          className={inputClass}
                          value={draft.cameraHeight}
                          onChange={(e) => updateDraft({ cameraHeight: e.target.value })}
                        />
                      </label>
                    </div>
                    <p className="text-xs text-red-400 mt-2">
                      画像フォーマット: {config.camera?.format || 'image/png'}（変更は config.json を直接編集）
                    </p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="border border-red-600 rounded-lg p-4 bg-red-800">
                    <h3 className="font-medium text-red-200 mb-3">
                      ステージ進行 <span className="text-xs text-red-400">（難易度・盤サイズ・グミ1個あたりの得点）</span>
                    </h3>
                    <div className="space-y-2 text-sm">
                      {draft.stageProgression.map((st, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="text-red-300 w-16 shrink-0">面 {i + 1}</span>
                          <input
                            type="number"
                            aria-label={`ステージ${i + 1} の盤サイズ`}
                            className={inputClass + ' w-16'}
                            min={STAGE_RANGES.size.min}
                            max={STAGE_RANGES.size.max}
                            value={st.size}
                            onChange={(e) => {
                              const next = [...draft.stageProgression];
                              next[i] = { ...next[i], size: e.target.value };
                              updateDraft({ stageProgression: next });
                            }}
                          />
                          <select
                            aria-label={`ステージ${i + 1} の難易度`}
                            className={inputClass}
                            value={st.difficulty}
                            onChange={(e) => {
                              const next = [...draft.stageProgression];
                              next[i] = { ...next[i], difficulty: e.target.value };
                              updateDraft({ stageProgression: next });
                            }}
                          >
                            {DIFFICULTIES.map((d) => (
                              <option key={d} value={d}>{d}</option>
                            ))}
                          </select>
                          <input
                            type="number"
                            aria-label={`ステージ${i + 1} の倍率`}
                            className={inputClass + ' w-20'}
                            value={st.multiplier}
                            onChange={(e) => {
                              const next = [...draft.stageProgression];
                              next[i] = { ...next[i], multiplier: e.target.value };
                              updateDraft({ stageProgression: next });
                            }}
                          />
                          <button
                            type="button"
                            onClick={() =>
                              updateDraft({
                                stageProgression: draft.stageProgression.filter((_, j) => j !== i),
                              })
                            }
                            disabled={draft.stageProgression.length <= 1}
                            className="px-2 py-1 bg-red-700 border border-red-500 rounded text-white disabled:opacity-40"
                            title="この面を削除"
                          >
                            −
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          updateDraft({
                            stageProgression: [
                              ...draft.stageProgression,
                              draft.stageProgression[draft.stageProgression.length - 1] ?? {
                                size: '4',
                                difficulty: 'normal',
                                multiplier: '8',
                              },
                            ],
                          })
                        }
                        className="px-3 py-1 bg-red-700 border border-red-500 rounded text-white text-sm"
                      >
                        ＋ 面を追加
                      </button>
                    </div>
                  </div>

                  <div className="border border-red-600 rounded-lg p-4 bg-red-800">
                    <h3 className="font-medium text-red-200 mb-3">
                      ランク閾値 <span className="text-xs text-red-400">（高い順に{RANK_THRESHOLD_COUNT}個。カード背景8種に対応）</span>
                    </h3>
                    <div className="grid grid-cols-4 gap-2 text-sm">
                      {draft.rankThresholds.map((value, i) => (
                        <input
                          key={i}
                          type="number"
                          aria-label={`ランク閾値${i + 1}`}
                          className={inputClass}
                          value={value}
                          onChange={(e) => {
                            const next = [...draft.rankThresholds];
                            next[i] = e.target.value;
                            updateDraft({ rankThresholds: next });
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {saveError && (
              <div className="bg-red-800 border border-red-500 rounded-md p-3 mb-4 whitespace-pre-wrap">
                <p className="text-red-100 font-medium">保存できませんでした</p>
                <p className="text-red-200 text-sm">{saveError}</p>
              </div>
            )}
            {/* 点検結果（warnings）を改行込みで出すので、保存エラー側と同じく
                whitespace-pre-wrap を付ける。付けないと1行に潰れて読めない */}
            {saveMessage && (
              <div className="bg-green-800 border border-green-500 rounded-md p-3 mb-4 whitespace-pre-wrap">
                <p className="text-green-100 text-sm">{saveMessage}</p>
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                onClick={handleSave}
                disabled={loading || saving || !draft}
                className="px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 border border-yellow-400 font-bold"
              >
                <span>💾</span>
                {saving ? '保存中...' : 'この内容で保存（config.json へ書き込み）'}
              </button>

              <button
                onClick={resetDraft}
                disabled={loading || saving}
                className="px-4 py-2 bg-red-700 text-white rounded-lg hover:bg-red-600 disabled:opacity-50 flex items-center gap-2 border border-red-500"
              >
                <span>↩️</span>
                入力を取り消す
              </button>

              <button
                onClick={handleConfigReload}
                disabled={loading || saving}
                className="px-4 py-2 bg-green-700 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 border border-green-500"
              >
                <span>🔄</span>
                {loading ? '読み込み中...' : 'ファイルから再読み込み'}
              </button>

              <div className="text-sm text-red-300 flex items-center">
                <span>💡</span>
                <span className="ml-1">保存すると config.json が更新されます（注釈コメントは残ります）</span>
              </div>
            </div>
          </div>
        </div>

        {/* ComfyUI監視セクション */}
        {config?.comfyui && (
          <div className="mb-12">
            <div className="bg-blue-900 border border-blue-700 rounded-lg shadow-md p-6">
              <h2 className="text-xl font-semibold text-white mb-4 flex items-center">
                <span className="mr-2">🎨</span>
                ComfyUI画像変換システム
              </h2>

              <div className="grid md:grid-cols-2 gap-6 mb-6">
                <div className="space-y-4">
                  <div className="border border-blue-600 rounded-lg p-4 bg-blue-800">
                    <h3 className="font-medium text-blue-200 mb-3">サーバー情報</h3>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between gap-2">
                        <span className="text-blue-300 whitespace-nowrap">アクセスURL:</span>
                        <span className="font-mono text-yellow-300 break-all select-all text-right">
                          {comfyUIUrl || '(未設定)'}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-blue-300 whitespace-nowrap">プロファイル:</span>
                        <span className="font-mono text-yellow-300 text-right">
                          {activeProfileName ?? '(旧形式)'}{activeProfile?.label ? ' / ' + activeProfile.label : ''}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-blue-300 whitespace-nowrap">ワークフロー:</span>
                        <span className="font-mono text-yellow-300 break-all text-right">{comfyUITemplate || '(未設定)'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-blue-300">ヘルスチェック:</span>
                        <span className={`font-mono ${comfyUIHealth ? 'text-green-300' : 'text-red-300'}`}>
                          {comfyUIHealth === null ? '確認中...' : comfyUIHealth ? 'OK' : 'NG'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-blue-300">最大同時ジョブ数:</span>
                        <span className="font-mono text-yellow-300">{config.comfyui.maxConcurrentJobs}</span>
                      </div>
                    </div>
                    <p className="text-xs text-blue-400 mt-3">
                      接続先URL・プロファイル・ワークフローの変更は config.json を直接編集し、
                      アプリを再起動してください（起動時に ComfyUI へ接続するため）。
                    </p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="border border-blue-600 rounded-lg p-4 bg-blue-800">
                    <h3 className="font-medium text-blue-200 mb-3">システム状況</h3>
                    <div className="space-y-2 text-sm">
                      {comfyUIStatus ? (
                        <>
                          <div className="flex justify-between">
                            <span className="text-blue-300">アプリ内アクティブ:</span>
                            <span className="font-mono text-yellow-300">{comfyUIStatus.activeJobs?.length || 0}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-blue-300">サーバー実行中:</span>
                            <span className="font-mono text-yellow-300">{comfyUIStatus.serverQueueRunning || 0}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-blue-300">サーバー待機中:</span>
                            <span className="font-mono text-yellow-300">{comfyUIStatus.serverQueuePending || 0}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-blue-300">内部キュー:</span>
                            <span className="font-mono text-yellow-300">{comfyUIStatus.internalQueueLength || 0}</span>
                          </div>
                          {comfyUIStatus.error && (
                            <div className="text-red-300 text-xs">{comfyUIStatus.error}</div>
                          )}
                        </>
                      ) : (
                        <div className="text-blue-300">ステータス取得中...</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* 生成パラメータ（config.json の comfyui.profiles.*.generation） */}
              {draft && (
                <div className="mb-6 border border-blue-600 rounded-lg p-4 bg-blue-800">
                  <h3 className="font-medium text-blue-200 mb-1">
                    生成パラメータ
                    {activeProfileName ? `（プロファイル ${activeProfileName}）` : ''}
                  </h3>
                  <p className="text-xs text-blue-300 mb-3">
                    ここで保存した値が、ワークフロー JSON の同名の値を上書きします。
                    上の「保存」ボタンで config.json へ書き込まれ、次の撮影から反映されます。
                  </p>

                  <div className="grid md:grid-cols-3 gap-3 text-sm mb-4">
                    {GENERATION_FIELDS.map((field) => (
                      <label key={field.key} className="block">
                        <span className="text-blue-300">
                          {field.label}{' '}
                          <span className="text-blue-400 text-xs">
                            {GENERATION_NUMBER_RANGES[field.key].min}〜{GENERATION_NUMBER_RANGES[field.key].max}
                          </span>
                        </span>
                        <input
                          type="number"
                          step={GENERATION_NUMBER_RANGES[field.key].integer ? 1 : 0.05}
                          className={blueInputClass}
                          value={draft.generation[field.key] ?? ''}
                          onChange={(e) => updateGeneration(field.key, e.target.value)}
                        />
                        {field.hint && <span className="text-blue-400 text-xs">{field.hint}</span>}
                      </label>
                    ))}
                  </div>

                  <p className="text-xs text-blue-300 mb-4">
                    denoise は「元の写真をどれだけ残すか」を決めます（1 で写真を完全に捨て、輪郭だけが残る）。
                    ComfyUI はノイズスケジュールを内部で {'int(steps/denoise)'} 段に引き伸ばして末尾だけを使うため、
                    <span className="text-yellow-200">サンプリング回数は steps のまま</span>です。
                    steps は LoRA が前提とする 8 から動かさないでください（1枚あたりの時間に直結します）。
                  </p>

                  <label className="block mb-3 text-sm">
                    <span className="text-blue-300">ポジティブプロンプト</span>
                    <textarea
                      className={blueInputClass + ' h-28'}
                      value={draft.generation.positivePrompt}
                      onChange={(e) => updateGeneration('positivePrompt', e.target.value)}
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="text-blue-300">
                      ネガティブプロンプト{' '}
                      <span className="text-blue-400 text-xs">
                        nsfw / horror などの安全側の指定を消さないこと
                      </span>
                    </span>
                    <textarea
                      className={blueInputClass + ' h-28'}
                      value={draft.generation.negativePrompt}
                      onChange={(e) => updateGeneration('negativePrompt', e.target.value)}
                    />
                  </label>
                </div>
              )}

              {/* アクティブジョブリスト */}
              {comfyUIJobs.length > 0 && (
                <div className="mb-6">
                  <h3 className="font-medium text-blue-200 mb-3">アクティブジョブ</h3>
                  <div className="bg-blue-800 border border-blue-600 rounded-lg p-4">
                    <div className="space-y-2">
                      {comfyUIJobs.map((job, index) => (
                        <div key={index} className="flex justify-between items-center text-sm">
                          <span className="text-blue-300">{job.datetime}</span>
                          <span className={`font-mono px-2 py-1 rounded text-xs ${
                            job.status === 'completed' ? 'bg-green-700 text-green-200' :
                            job.status === 'error' ? 'bg-red-700 text-red-200' :
                            job.status === 'processing' ? 'bg-yellow-700 text-yellow-200' :
                            'bg-gray-700 text-gray-200'
                          }`}>
                            {job.status}
                          </span>
                          <span className="text-blue-300">{Math.floor(job.duration / 1000)}s</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <button
                  onClick={handleComfyUIRefresh}
                  disabled={comfyUILoading}
                  className="px-4 py-2 bg-blue-700 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 border border-blue-500"
                >
                  <span>🔄</span>
                  {comfyUILoading ? 'チェック中...' : 'ステータス更新'}
                </button>

                <button
                  onClick={handleOpenComfyUI}
                  disabled={!comfyUIUrl}
                  className="px-4 py-2 bg-indigo-700 text-white rounded-lg hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 border border-indigo-500"
                >
                  <span>🌐</span>
                  ComfyUI をブラウザで開く
                </button>

                {/* ブラウザの ComfyUI が最初に表示するのは「そのブラウザで最後に編集した
                    グラフ」で、ゲームが投げているものではない。同じ内容を手元で試せるよう、
                    現在の設定を焼き込んだワークフローを書き出す */}
                <button
                  onClick={handleExportWorkflow}
                  className="px-4 py-2 bg-indigo-700 text-white rounded-lg hover:bg-indigo-600 flex items-center gap-2 border border-indigo-500"
                >
                  <span>📤</span>
                  同じワークフローを書き出す（ブラウザへD&D用）
                </button>
              </div>

              <p className="text-xs text-blue-300 mt-3">
                ブラウザで開いた ComfyUI に最初から出ているグラフは、そのブラウザで最後に編集したものです
                （ゲームが使っているワークフローとは無関係）。ゲームと同じ状態を再現するには、
                書き出した JSON をブラウザ画面へドラッグ＆ドロップし、LoadImage ノードへ写真を
                ドラッグ＆ドロップしてください。
              </p>
            </div>
          </div>
        )}

        {/* スプライトテストセクション */}
        <div className="bg-red-900 border border-red-700 rounded-lg shadow-md p-6">
          <div className="mb-4">
            <h2 className="text-xl font-semibold text-white flex items-center">
              <span className="mr-2">🎮</span>
              スプライト表示テスト
            </h2>
            <p className="text-sm text-red-200 mt-2">
              ゲーム内で使用されるスプライトの表示確認ができます
            </p>
          </div>
          <div className="w-full overflow-auto">
            <div className="text-gray-400 text-sm">スプライトビューアは3Dパズル版では使用しません</div>
          </div>
        </div>
      </div>
    </div>
  );
};
