/**
 * ComfyUI ワークフローテンプレートの変数置換。
 *
 * これまで main.ts の save-photo ハンドラ内にインラインで書かれていたが、
 * Electron に依存しない純粋な処理であり、E2E テスト（tools/e2e-local-play.cjs）から
 * 「アプリと同一のロジック」で image_generate.json を作れるようにするため関数へ切り出した。
 * main.ts と E2E がそれぞれ別実装を持つと、テストが通っても本番が壊れる状態になり得る。
 *
 * assets/ComfyUI_KidsPG_2026_01.README.md の「アプリ側との約束」と対になっている。
 */

import type { GenerationParams } from '../../shared/config/generation-params';

export interface WorkflowNode {
  class_type: string;
  inputs?: Record<string, unknown>;
}

export type WorkflowTemplate = Record<string, WorkflowNode>;

export interface ApplyOptions {
  /** SaveImage の filename_prefix。通常は `${outputPrefix}_${dateTime}` */
  outputPrefix: string;
  /** LoadImage に渡す、ComfyUI へアップロード済みの写真ファイル名 */
  photoFileName: string;
  /** seed 生成器。テストから固定値を注入できるようにしている */
  randomSeed?: () => number;
  /**
   * config.json 由来の生成パラメータ。指定した項目だけテンプレートの値を上書きする。
   * テンプレート JSON を書き換えずに当日調整できるようにするための入口。
   */
  generation?: GenerationParams;
}

const isNode = (value: unknown): value is WorkflowNode =>
  !!value && typeof value === 'object' && 'class_type' in (value as Record<string, unknown>);


/** ["10", 0] のような入力リンクなら参照先ノードIDを返す */
const linkTarget = (value: unknown): string | null =>
  Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;

/**
 * KSampler の positive / negative から CLIPTextEncode を辿る。
 *
 * ノードIDを決め打ちしないのは、テンプレートが local / server で別ファイルであり、
 * ControlNet を1段挟む・挟まないの違いも起こり得るため。
 * ControlNetApplyAdvanced は同名（positive / negative）の入力を持つので、
 * 同じ役割の入力名を辿るだけで正負を取り違えずに末端まで到達できる。
 */
const findPromptNodeId = (
  workflow: WorkflowTemplate,
  start: unknown,
  role: 'positive' | 'negative'
): string | null => {
  let link = start;
  // 循環参照のあるテンプレートで無限ループしないよう深さで打ち切る
  for (let depth = 0; depth < 16; depth += 1) {
    const id = linkTarget(link);
    if (!id) return null;
    const node = workflow[id];
    if (!isNode(node)) return null;
    if (node.class_type === 'CLIPTextEncode') return id;
    link = node.inputs?.[role];
  }
  return null;
};

/** ノードから入力リンクを辿り、指定 class_type のノードへ到達できるか */
const reachesClassType = (
  workflow: WorkflowTemplate,
  start: unknown,
  classType: string
): boolean => {
  const queue: string[] = [];
  const startId = linkTarget(start);
  if (startId) queue.push(startId);
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = workflow[id];
    if (!isNode(node)) continue;
    if (node.class_type === classType) return true;
    for (const value of Object.values(node.inputs ?? {})) {
      const next = linkTarget(value);
      if (next && !visited.has(next)) queue.push(next);
    }
  }
  return false;
};

/**
 * 数値入力を上書きする。配線された入力（["14", 0]）は絶対に触らない。
 * 触ると配線が数値で潰れ、ワークフローが黙って別物になる。
 */
const overwriteNumber = (
  inputs: Record<string, unknown>,
  key: string,
  value: number | undefined
): void => {
  if (value === undefined) return;
  if (typeof inputs[key] !== 'number') return;
  inputs[key] = value;
};

/**
 * config.json の generation をワークフローへ焼き込む。
 * 対象ノードは class_type で探すため、ノードIDの振り方には依存しない。
 */
const applyGenerationParams = (
  workflow: WorkflowTemplate,
  generation: GenerationParams
): void => {
  for (const nodeData of Object.values(workflow)) {
    if (!isNode(nodeData) || !nodeData.inputs) continue;
    const inputs = nodeData.inputs;

    switch (nodeData.class_type) {
      case 'KSampler':
        overwriteNumber(inputs, 'steps', generation.steps);
        overwriteNumber(inputs, 'cfg', generation.cfg);
        overwriteNumber(inputs, 'denoise', generation.denoise);
        break;
      case 'ControlNetApplyAdvanced':
        overwriteNumber(inputs, 'strength', generation.controlnetStrength);
        overwriteNumber(inputs, 'start_percent', generation.controlnetStartPercent);
        overwriteNumber(inputs, 'end_percent', generation.controlnetEndPercent);
        break;
      case 'Canny':
        overwriteNumber(inputs, 'low_threshold', generation.cannyLowThreshold);
        overwriteNumber(inputs, 'high_threshold', generation.cannyHighThreshold);
        break;
      case 'ImageScale':
        overwriteNumber(inputs, 'width', generation.inputSize);
        overwriteNumber(inputs, 'height', generation.inputSize);
        break;
      default:
        break;
    }
  }

  if (generation.positivePrompt === undefined && generation.negativePrompt === undefined) return;

  const ksampler = Object.values(workflow).find((n) => isNode(n) && n.class_type === 'KSampler');
  if (!ksampler) return;
  const positiveId = findPromptNodeId(workflow, ksampler.inputs?.positive, 'positive');
  const negativeId = findPromptNodeId(workflow, ksampler.inputs?.negative, 'negative');

  // 同じノードに行き着いた（＝正負を判別できない）場合は書き換えない。
  // 取り違えるとネガティブが正方向に入り、子ども向けに出せない絵が出る危険がある。
  if (positiveId && positiveId === negativeId) return;

  if (positiveId && generation.positivePrompt !== undefined) {
    const node = workflow[positiveId];
    if (node.inputs && typeof node.inputs.text === 'string') node.inputs.text = generation.positivePrompt;
  }
  if (negativeId && generation.negativePrompt !== undefined) {
    const node = workflow[negativeId];
    if (node.inputs && typeof node.inputs.text === 'string') node.inputs.text = generation.negativePrompt;
  }
};

/**
 * テンプレートを破壊的に書き換えず、置換済みの新しいワークフローを返す。
 * 呼び出し側が同じテンプレートオブジェクトを使い回しても汚染されない。
 */
export const applyWorkflowVariables = (
  template: WorkflowTemplate,
  options: ApplyOptions
): WorkflowTemplate => {
  const randomSeed = options.randomSeed ?? (() => Math.floor(Math.random() * 1000000000000000));
  const workflow = JSON.parse(JSON.stringify(template)) as WorkflowTemplate;

  for (const nodeData of Object.values(workflow)) {
    if (!isNode(nodeData) || !nodeData.inputs) continue;
    const inputs = nodeData.inputs;

    // SaveImage: ${filename_prefix} を置換する。
    // プレースホルダが無いテンプレートでも出力先が散らからないよう、値ごと差し替える。
    if (nodeData.class_type === 'SaveImage' && inputs.filename_prefix !== undefined) {
      inputs.filename_prefix =
        typeof inputs.filename_prefix === 'string' && inputs.filename_prefix.includes('${filename_prefix}')
          ? inputs.filename_prefix.replace('${filename_prefix}', options.outputPrefix)
          : options.outputPrefix;
    }

    // LoadImage: ${photo_png} を置換する
    if (nodeData.class_type === 'LoadImage' && typeof inputs.image === 'string') {
      if (inputs.image.includes('${photo_png}')) {
        inputs.image = inputs.image.replace('${photo_png}', options.photoFileName);
      }
    }

    // KSampler: seed を固定のままにすると全員が同じ乱数から生成される。
    // 顔以外の要素（構図・色）まで揃ってしまうため、プレイごとに振り直す。
    // `'seed' in inputs` だと、seed を別ノードから配線したときの ["25", 0] という
    // リンク配列まで数値で潰し、配線を黙って無効化してしまう。数値のときだけ触る。
    if (nodeData.class_type === 'KSampler' && typeof inputs.seed === 'number') {
      inputs.seed = randomSeed();
    }
  }

  // 生成パラメータの上書きは、置換ループとは別に行う。
  // プロンプトの正負判定に配線を辿る必要があり、ノード単位のループでは決められない。
  if (options.generation) {
    applyGenerationParams(workflow, options.generation);
  }

  return workflow;
};

/**
 * 生成パラメータとワークフローの配線が噛み合っているかの点検。
 *
 * 返すのは**警告**（生成は続行する）。当日の運用では、多少ずれた絵でも
 * カードが1枚できる方が、生成を止めるより望ましいため。
 * ただし黙って旧挙動に戻るのが一番まずいので、必ずログとスタッフ向け警告に出す。
 *
 * 渡すのは applyWorkflowVariables 適用**後**のワークフロー（実際に投げる形）。
 */
export const checkGenerationWiring = (workflow: WorkflowTemplate): string[] => {
  const warnings: string[] = [];

  for (const [id, node] of Object.entries(workflow)) {
    if (!isNode(node) || node.class_type !== 'KSampler') continue;
    const denoise = node.inputs?.denoise;
    if (typeof denoise !== 'number') continue;

    if (denoise >= 1) {
      warnings.push(
        `KSampler(${id}).denoise = ${denoise} です。潜在表現が完全にノイズへ置き換わるため、` +
          '撮影した写真は ControlNet の輪郭以外いっさい反映されません（色・髪色・服も引き継がれない）。' +
          'img2img として効かせるには 1 未満にしてください'
      );
    } else if (!reachesClassType(workflow, node.inputs?.latent_image, 'VAEEncode')) {
      warnings.push(
        `KSampler(${id}).denoise = ${denoise} ですが、latent_image が VAEEncode へ繋がっていません。` +
          'ノイズだけを部分的に消す形になり、写真の情報は入りません（EmptyLatentImage になっていないか確認）'
      );
    }

  }

  return warnings;
};

/**
 * config.json の generation が、実際に投げるワークフローへ反映されたかの照合。
 *
 * `applyGenerationParams` は配線された入力・非数値の入力・辿れなかった
 * CLIPTextEncode を**黙って飛ばす**。テンプレートを差し替えたり途中にノードを
 * 挟んだりすると、「保存しました。次の撮影から反映されます」と表示されるのに
 * ComfyUI へはテンプレート側の古い値が投げ続けられる、という一番まずい形になる。
 * ここで突き合わせて、反映できなかった項目を名前で挙げる。
 *
 * 渡すのは applyWorkflowVariables 適用**後**のワークフロー。
 */
export const checkGenerationApplied = (
  workflow: WorkflowTemplate,
  generation: GenerationParams
): string[] => {
  const missing: string[] = [];

  /**
   * 該当 class_type の**すべての**ノードで期待値になっているかを見る。
   *
   * 「どれか1つが一致」で判定すると、同じ class_type のノードが2つあるとき
   * 片方が一致しているだけで、上書きが落ちた側を見逃す。
   * 該当ノードが1つも無い場合も「反映できていない」として扱う。
   */
  const applied = (classType: string, key: string, expected: unknown): boolean => {
    const nodes = Object.values(workflow).filter((n) => isNode(n) && n.class_type === classType);
    if (nodes.length === 0) return false;
    return nodes.every((n) => n.inputs?.[key] === expected);
  };

  // 1つの設定項目が複数の入力へ当たる場合（inputSize → width と height）は並べる
  const numberTargets: Array<[keyof GenerationParams, string, string[]]> = [
    ['denoise', 'KSampler', ['denoise']],
    ['steps', 'KSampler', ['steps']],
    ['cfg', 'KSampler', ['cfg']],
    ['controlnetStrength', 'ControlNetApplyAdvanced', ['strength']],
    ['controlnetStartPercent', 'ControlNetApplyAdvanced', ['start_percent']],
    ['controlnetEndPercent', 'ControlNetApplyAdvanced', ['end_percent']],
    ['cannyLowThreshold', 'Canny', ['low_threshold']],
    ['cannyHighThreshold', 'Canny', ['high_threshold']],
    ['inputSize', 'ImageScale', ['width', 'height']],
  ];

  for (const [paramKey, classType, inputKeys] of numberTargets) {
    const value = generation[paramKey];
    if (value === undefined) continue;
    for (const inputKey of inputKeys) {
      if (!applied(classType, inputKey, value)) {
        missing.push(`${paramKey}（${classType}.${inputKey}）`);
      }
    }
  }

  // プロンプトは「全ノードが同じ値」にはならない（正と負で別のテキストが入る）。
  // 書き換え対象は配線から特定した1ノードだけなので、どこかに入っていれば反映済み。
  for (const paramKey of ['positivePrompt', 'negativePrompt'] as const) {
    const value = generation[paramKey];
    if (value === undefined) continue;
    const found = Object.values(workflow).some(
      (n) => isNode(n) && n.class_type === 'CLIPTextEncode' && n.inputs?.text === value
    );
    if (!found) missing.push(`${paramKey}（CLIPTextEncode.text）`);
  }

  if (missing.length === 0) return [];
  return [
    'config.json の生成パラメータのうち、ワークフローへ反映できなかった項目があります: ' +
      missing.join(' / ') +
      '。ワークフロー側の配線（該当ノードの有無・入力が配線されていないか）を確認してください',
  ];
};

/**
 * テンプレートが「アプリ側との約束」を満たしているかの静的チェック。
 * 起動時や E2E の先頭で呼び、置換に失敗したまま生成へ進むのを防ぐ。
 */
export const validateWorkflowTemplate = (template: WorkflowTemplate): string[] => {
  const errors: string[] = [];
  const nodes = Object.entries(template).filter(([, n]) => isNode(n));

  const loadImage = nodes.filter(([, n]) => n.class_type === 'LoadImage');
  if (loadImage.length === 0) {
    errors.push('LoadImage ノードがありません');
  } else if (!loadImage.some(([, n]) => typeof n.inputs?.image === 'string' && (n.inputs.image as string).includes('${photo_png}'))) {
    errors.push('LoadImage.inputs.image に ${photo_png} が含まれていません');
  }

  const saveImage = nodes.filter(([, n]) => n.class_type === 'SaveImage');
  if (saveImage.length === 0) {
    errors.push('SaveImage ノードがありません');
  } else if (!saveImage.some(([id]) => id === '9' || id === '8')) {
    // comfyui-worker.ts が 9 → 8 の順で出力ノードを探すため、どちらかである必要がある
    errors.push('SaveImage のノードIDが 9 でも 8 でもありません（comfyui-worker.ts が出力を見つけられません）');
  } else if (saveImage.some(([, n]) => n.inputs?.filename_prefix === undefined)) {
    // applyWorkflowVariables は filename_prefix が未定義のノードには何も書かない。
    // その結果 ComfyUI 既定の名前で出力され、memorial-card 側が photo_anime_* を
    // 見つけられなくなる（カードがプレースホルダのままになる）。
    errors.push('SaveImage に filename_prefix がありません（出力名を差し替えられません）');
  }

  // applyWorkflowVariables が振り直せるのは数値の seed だけ。
  // 配線された seed しか無いテンプレートは「全員同じ絵」になるので弾く。
  if (!nodes.some(([, n]) => n.class_type === 'KSampler' && typeof n.inputs?.seed === 'number')) {
    errors.push('数値の seed を持つ KSampler ノードがありません（プレイごとの振り直しができません）');
  }

  // SaveImage が複数あると全ノードが同じ filename_prefix に潰され、
  // カードに載る画像がどれになるか不定になる（README「アプリ側との約束」3）
  if (saveImage.length > 1) {
    errors.push(`SaveImage ノードが ${saveImage.length} 個あります。1個にしてください`);
  }

  return errors;
};
