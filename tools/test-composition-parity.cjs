'use strict';

/**
 * カード合成の設定が「本体」と「ツール用の並行実装」で食い違っていないかのテスト。
 *
 * 🔴 **同じ値が2箇所に書かれている。**
 *   本体   : src/main/services/image-composition-config.ts（アプリが当日使う）
 *   ツール : src/test/node-image-composition-config.ts（救済ツールが後日使う）
 * 本体は Electron の `app` に依存していてツールから読めないため、
 * ランクごとの背景・前景の配置・フォント・文字の配置が複製されている。
 * ソース側にも「本体と同じ扱いにすること」と書いてあるが、
 * **守られているかを確かめる仕組みが無かった。**
 *
 * ずれると「当日のカードと、後日 retry-failed で作り直したカードの見た目が違う」
 * という壊れ方をする。しかも作り直したほうが公開物になるので、気づくのは公開後。
 *
 * ここでは electron を偽物に差し替えて本体を Node から読み込み、
 * 両者の出力を突き合わせる。
 *
 *   npm run build && node --test tools/test-composition-parity.cjs
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'main');
const MAIN_PATH = path.join(DIST, 'main', 'services', 'image-composition-config.js');
// ツール側は dist へ出力されず tsx で直接実行される（package.json の recovery 系）。
// そのため実行時に型を落として読む。**救済ツールが実際に読むのと同じソース**を
// 見ないと、この検査の意味が無い。
require('tsx/cjs');
const NODE_SRC = path.join(ROOT, 'src', 'test', 'node-image-composition-config.ts');

if (!fs.existsSync(MAIN_PATH)) {
  throw new Error(`dist が見つかりません。先に \`npm run build\` を実行してください: ${MAIN_PATH}`);
}
if (!fs.existsSync(NODE_SRC)) {
  throw new Error(`ツール側の実装がありません: ${NODE_SRC}`);
}

/**
 * 本体は `import { app } from 'electron'` を持つので、そのままでは読めない。
 * require の解決を1箇所だけ差し替えて、偽の electron を返す。
 * **アプリの実装には手を入れない**（テストのためにコードを曲げると、
 * テストが通っても本番で動くとは言えなくなる）。
 */
const withFakeElectron = (fn) => {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => ROOT,
          getPath: () => path.join(ROOT, 'dummy-exe', 'app.exe'),
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return fn();
  } finally {
    Module._load = originalLoad;
  }
};

const { ImageCompositionConfig } = withFakeElectron(() => require(MAIN_PATH));
const { NodeImageCompositionConfig } = require(NODE_SRC);
const { RANK_NAMES } = require(path.join(DIST, 'shared', 'utils', 'helpers.js'));

const mainConfig = withFakeElectron(() => new ImageCompositionConfig());
const toolConfig = new NodeImageCompositionConfig(path.join(ROOT, 'card_base_images'));

const sampleResult = {
  nickname: 'すやすや博士',
  rank: RANK_NAMES.LEGEND,
  level: 'MAX',
  score: 928,
  timestampJST: '2026-09-12 10:11:12',
  imagePath: 'photo_20260912_101112.png',
};

/**
 * 両者の generateCompositionConfig を突き合わせられる形に揃える。
 * ディレクトリの根が違う（本体は Electron のアプリパス、ツールは引数）ので、
 * パスはファイル名だけを比べる。**比べたいのは値の決め方**であって、
 * どのフォルダに置くかではない。
 */
const normalise = (config) => ({
  background: path.basename(config.backgroundImagePath),
  foregroundPosition: config.foregroundPosition,
  textElements: config.textElements,
  outputFileName: config.outputFileName,
  font: config.fontPath,
});

const DATETIME = '20260912_101112';
const ANIME = 'photo_anime_20260912_101112_00001_.png';

test('本番カードの合成設定が本体とツールで一致する（8ランクすべて）', () => {
  for (const rank of Object.values(RANK_NAMES)) {
    const result = { ...sampleResult, rank };
    const a = normalise(
      withFakeElectron(() => mainConfig.generateCompositionConfig(result, DATETIME))
    );
    const b = normalise(toolConfig.generateCompositionConfig(result, DATETIME, ANIME));
    assert.deepStrictEqual(
      b,
      a,
      `ランク「${rank}」で食い違っています。\n本体 : ${JSON.stringify(a)}\nツール: ${JSON.stringify(b)}`
    );
  }
});

test('ダミーカードの合成設定も一致する', () => {
  const a = normalise(
    withFakeElectron(() => mainConfig.generateDummyCompositionConfig(sampleResult, DATETIME))
  );
  const b = normalise(toolConfig.generateDummyCompositionConfig(sampleResult, DATETIME));
  assert.deepStrictEqual(
    b,
    a,
    `ダミーカードで食い違っています。\n本体 : ${JSON.stringify(a)}\nツール: ${JSON.stringify(b)}`
  );
});

test('知らないランクは同じ既定へ倒れる', () => {
  const result = { ...sampleResult, rank: '存在しない称号' };
  const a = normalise(
    withFakeElectron(() => mainConfig.generateCompositionConfig(result, DATETIME))
  );
  const b = normalise(toolConfig.generateCompositionConfig(result, DATETIME, ANIME));
  assert.strictEqual(b.background, a.background, '既定の倒し先が食い違っています');
});

test('参照する背景ファイルが8種すべて実在する', () => {
  for (const rank of Object.values(RANK_NAMES)) {
    const p = withFakeElectron(() => mainConfig.getBackgroundImagePath(rank));
    assert.ok(fs.existsSync(p), `背景画像がありません: ${p}`);
  }
});

test('フォントが一致し、実在する', () => {
  const a = withFakeElectron(() =>
    mainConfig.generateCompositionConfig(sampleResult, DATETIME)
  ).fontPath;
  const b = toolConfig.getFontPath();
  assert.strictEqual(b, a, `フォントが食い違っています（本体 ${a} / ツール ${b}）`);
  assert.ok(fs.existsSync(a), `フォントがありません: ${a}`);
});

test('ニックネームの長さが変わっても両者の扱いが揃う', () => {
  // カードへ焼く文字は長さで折り返し・縮小の判断が入りうる。
  // 片方だけ調整すると、長い名前の子だけ見た目が変わる。
  for (const nickname of ['あ', 'すやすや博士', 'わたあめだいじんクッキー名人ぱくぱく大王']) {
    const result = { ...sampleResult, nickname };
    const a = normalise(
      withFakeElectron(() => mainConfig.generateCompositionConfig(result, DATETIME))
    );
    const b = normalise(toolConfig.generateCompositionConfig(result, DATETIME, ANIME));
    assert.deepStrictEqual(b, a, `ニックネーム「${nickname}」で食い違っています`);
  }
});

test('スコアと時刻の焼き方が揃う（秒を落とす整形を両者が持っている）', () => {
  const result = { ...sampleResult, score: 1504, timestampJST: '2026-09-12 09:05:07' };
  const a = normalise(
    withFakeElectron(() => mainConfig.generateCompositionConfig(result, DATETIME))
  );
  const b = normalise(toolConfig.generateCompositionConfig(result, DATETIME, ANIME));
  assert.deepStrictEqual(b, a, '時刻・スコアの焼き方が食い違っています');
  const texts = a.textElements.map((t) => t.text).join(' / ');
  assert.ok(!texts.includes(':07'), `秒が残っています: ${texts}`);
});
