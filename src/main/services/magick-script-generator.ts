import * as path from 'path';
import * as fs from 'fs/promises';
import type { CompositionConfig, TextElement } from './image-composition-config';
import { buildPartialOutputPath, getProcessToken } from './card-output';

/**
 * 前景（AI画像）をカードの枠に合わせて拡大するときのフィルタ。
 *
 * 🔴 **明示すること。** `-geometry 650x650+180+190 -composite` のように
 * geometry にサイズを書くと ImageMagick が暗黙にリサイズするが、
 * **拡大時の既定フィルタは Mitchell** で、線画とまつげが目に見えて甘くなる。
 * AI画像は 320px で生成してカードは 650px なので2倍以上に拡大しており、
 * ここの差がそのままカードの印象になる。
 *
 * 実際に5通り出して見比べた結果（2026-09-07）:
 *   Mitchell（暗黙の既定） … 線とまつげがぼやける
 *   Lanczos                … はっきり改善
 *   Lanczos + 弱シャープ   … いちばん自然に見えた（これを採用）
 *   Lanczos + 中シャープ   … 線の周りに白い縁が出て硬すぎる
 *   Catrom + 弱シャープ    … Lanczos + 弱シャープとほぼ同等
 */
const FOREGROUND_RESIZE_FILTER = 'Lanczos';

/**
 * 拡大後にかける弱いシャープ。`半径x強さ+量+しきい値`。
 * 強くすると線の周りに白い縁（ハロー）が出るので上げないこと。
 */
const FOREGROUND_UNSHARP = '0x0.75+0.60+0.008';

export class MagickScriptGenerator {
  /**
   * ImageMagickスクリプトファイルを生成
   */
  async generateScript(
    config: CompositionConfig,
    foregroundImagePath: string,
    resultDir: string
  ): Promise<string> {
    const datetime = path.basename(resultDir);
    // 🔴 スクリプト名にもプロセス固有の印を入れる。
    // アプリ稼働中に救済ツール（retry-failed / recovery）を走らせる運用があるため、
    // 固定名だと**実行中のスクリプトを相手が上書き**する。
    // `magick -script` はトークンを逐次読むので、上書きされた瞬間に合成が失敗する
    // ＝その子のカードが1枚も出ない。
    const scriptPath = path.join(resultDir, `magick_script_${datetime}.${getProcessToken()}.txt`);

    try {
      const scriptContent = this.buildScriptContent(
        config,
        foregroundImagePath,
        resultDir
      );
      
      await fs.writeFile(scriptPath, scriptContent, 'utf-8');
      
      return scriptPath;
      
    } catch (error) {
      console.error('MagickScriptGenerator - Script generation failed:', error);
      throw new Error(`Script generation failed: ${error}`);
    }
  }

  /**
   * スクリプト内容を構築
   */
  private buildScriptContent(
    config: CompositionConfig,
    foregroundImagePath: string,
    resultDir: string
  ): string {
    const lines: string[] = [];
    
    // ヘッダーコメント
    lines.push('# ImageMagick script for memorial card generation');
    lines.push(`# Generated at: ${new Date().toISOString()}`);
    lines.push('');
    
    // Step 1: 背景画像と前景画像の合成。
    // magick -script はコマンドラインと同じ規則で空白区切りにトークン化するため、
    // パスは必ず引用符で囲む。囲まないと「C:/Users/owner/OneDrive - 株式会社…」のような
    // 空白入りパスが分断され、
    // `no decode delegate for this image format 'C:/Users/owner/OneDrive'`
    // でカードが1枚も出なくなる。出力(-write)側だけ囲われていて入力側が漏れていた。
    lines.push('# Step 1: Load background image and composite foreground');
    lines.push(this.quotePathForMagick(config.backgroundImagePath));

    // 前景は括弧で囲んでから拡大する。
    //
    // 🔴 **括弧を外してはいけない。** -filter / -resize / -unsharp は
    // 「いま読み込んでいる画像すべて」に効くため、括弧が無いと**背景まで
    // 650px に縮められてカードが壊れる**。括弧の対応は
    // tools/test-magick-script.cjs が検査している。
    const { x, y, width, height } = config.foregroundPosition;
    lines.push('(');
    lines.push(this.quotePathForMagick(foregroundImagePath));
    if (width && height) {
      lines.push(`-filter ${FOREGROUND_RESIZE_FILTER}`);
      lines.push(`-resize ${width}x${height}`);
      lines.push(`-unsharp ${FOREGROUND_UNSHARP}`);
    }
    lines.push(')');

    // 位置だけを渡す（サイズは上で確定させた）
    lines.push(`-geometry +${x}+${y}`);
    lines.push('-composite');
    lines.push('');
    
    // Step 2: フォント設定。
    // パスは config.fontPath（ImageCompositionConfig が持つ唯一の出どころ）から取る。
    // ここに直書きすると、validateConfig が存在確認するフォントと
    // 実際に描画で使うフォントが食い違う。
    lines.push('# Step 2: Configure base font');
    lines.push(`-font ${this.quotePathForMagick(config.fontPath)}`);
    lines.push('');
    
    // Step 3: テキスト描画（各要素ごとに設定）
    lines.push('# Step 3: Draw text elements with individual settings');
    const textCommands = this.generateTextCommands(config.textElements);
    lines.push(...textCommands);
    lines.push('');
    
    // Step 4: 出力画像保存
    lines.push('# Step 4: Save final image');
    const outputPath = path.join(resultDir, config.outputFileName);
    // 出力先だけは `%d` 等のシーン番号展開が効く。展開されると
    // 「カードは出るがファイル名が違う」＝ results.json が指す先に実体が無い、
    // という無言の失敗になるので、混入していたら止める。
    // 入力側のパスにこの検査を掛けると「50% off」のような正常なフォルダ名まで
    // 弾いてしまう（入力では展開されないことを magick で確認済み）。
    if (/%[-+ 0#]*[0-9]*[dioxX]/.test(this.normalizePathForMagick(outputPath))) {
      throw new Error(`出力パスに ImageMagick のシーン番号展開として解釈される指定が含まれています: ${outputPath}`);
    }
    // 🔴 **最終ファイル名へ直接書かない。**
    // magick が書いている最中にプロセスが落ちると、最終名のまま先頭だけ揃った
    // 壊れたPNGが残り、アプリは「カードが出来ている」と誤認する
    // （2026-09-02: ギャラリーでカードの上半分しか出ない事象の原因）。
    // 一時名へ書き、完全性を確認してから rename する（results.json と同じ考え方）。
    // 拡張子が `.png` でなくなるため `PNG:` で形式を明示する。
    const partialPath = buildPartialOutputPath(outputPath);
    lines.push(`-write ${this.quotePathForMagick(partialPath, 'PNG:')}`);

    return lines.join('\n');
  }

  /**
   * Windowsパスを ImageMagick用に正規化
   */
  private normalizePathForMagick(filePath: string): string {
    // 絶対パスに変換し、バックスラッシュをスラッシュに変換
    return path.resolve(filePath).replace(/\\/g, '/');
  }

  /**
   * 正規化したうえでダブルクォートで囲む。スクリプト内のパスは例外なくこれを通す。
   *
   * ただし**引用符が守るのは空白によるトークン分割だけ**で、
   * ImageMagick のファイル名メタ文字（`%` の書式指定、末尾の `[...]` フレーム指定、
   * 先頭の `@`）は引用しても解釈される。特に `-write` 先に `%d` などが混ざると
   * 「カードは出るがファイル名が違う」という無言の失敗になり、
   * results.json が指すパスと食い違ってランキングに絵が出なくなる。
   * 現行のパスは日時由来なので安全だが、混入したら気づけるようにここで弾く。
   */
  private quotePathForMagick(filePath: string, formatPrefix: string = ''): string {
    const normalized = this.normalizePathForMagick(filePath);
    if (normalized.includes('"')) {
      // Windows のファイル名に " は使えないため、ここに来るのは異常系。
      // 黙って壊れたスクリプトを書くより、原因が分かる形で落とす。
      throw new Error(`パスにダブルクォートが含まれています: ${normalized}`);
    }
    if (/\[[^\]]*\]$/.test(normalized)) {
      throw new Error(`パスの末尾がフレーム指定 [...] として解釈されます: ${normalized}`);
    }
    // 形式指定子は引用符の**内側**に置く（`"PNG:C:/…/a.png.partial"`）。
    // 外に出すと空白入りパスが分断される。
    return `"${formatPrefix}${normalized}"`;
  }


  /**
   * テキスト描画コマンドを生成（各要素ごとに個別設定）
   */
  private generateTextCommands(textElements: TextElement[]): string[] {
    const commands: string[] = [];
    
    for (const element of textElements) {
      // テキストのエスケープ処理
      const escapedText = this.escapeTextForMagick(element.text);
      
      // 各テキスト要素ごとに設定を適用
      commands.push(`-pointsize ${element.fontSize}`);
      commands.push(`-fill "${element.color}"`);
      
      // Bold効果のためのstroke設定。
      // 🔴 **付けない側でも明示的に消すこと。** ImageMagick の -stroke は
      // 以後のすべての -draw に効き続ける「状態」なので、太字の要素のあとに
      // 太字でない要素が来ると、前の要素の縁取りをそのまま引き継いで描かれる。
      // 現行の4項目はすべて bold なので露見していないが、項目を1つ足した
      // 瞬間に「なぜか一部だけ太い」カードが全員ぶん出る。
      if (element.bold && element.strokeWidth) {
        commands.push(`-stroke "${element.color}"`);
        commands.push(`-strokewidth ${element.strokeWidth}`);
      } else {
        commands.push('-stroke none');
      }
      
      if (element.gravity) {
        commands.push(`-gravity ${element.gravity}`);
      }
      
      // -draw コマンドの構築
      const drawCommand = `-draw "text ${element.x},${element.y} '${escapedText}'"`;
      commands.push(drawCommand);
      
      // 次のテキスト要素との区切り
      commands.push('');
    }
    
    return commands;
  }

  /**
   * ImageMagick の -draw に載せられる形へテキストを整える。
   *
   * `-draw "text x,y '...'"` は2段のパーサを通る。
   *   (a) `magick -script` のトークナイザ … `"..."` 内のバックスラッシュを消費する
   *   (b) MVG の text プリミティブ      … `'...'` 内では**エスケープを受け付けない**
   * このため `'` はバックスラッシュを何段重ねても表現できず、
   * `non-conforming drawing primitive definition` でスクリプト全体が exit 1 になる。
   * つまり「その子のカードが1枚も出ない」。
   *
   * 現行のニックネーム（NICKNAME_OPTIONS）とランク名（RANK_NAMES）は日本語の固定文言で
   * これらの文字を含まないため今は踏まないが、自由入力になった瞬間に踏む。
   * さらに MVG の文字列は percent-escape の展開を受ける。`%f` が入力画像の
   * ファイル名に化けることを magick で確認したので、`%` も対象に含める。
   *
   * 描画そのものを守るため、危険な4文字だけ**見た目の近い全角/約物へ置き換える**。
   * 現行の固定文言（NICKNAME_OPTIONS / RANK_NAMES / スコア / 日時）には一切影響しない。
   */
  private escapeTextForMagick(text: string): string {
    return text
      .replace(/\\/g, '＼')
      .replace(/'/g, '’')
      .replace(/"/g, '”')
      .replace(/%/g, '％');
  }

  /**
   * スクリプトファイルの存在確認
   */
  async validateScriptFile(scriptPath: string): Promise<{ valid: boolean; error?: string }> {
    try {
      await fs.access(scriptPath);
      const stats = await fs.stat(scriptPath);
      
      if (!stats.isFile()) {
        return { valid: false, error: 'Script path is not a file' };
      }
      
      if (stats.size === 0) {
        return { valid: false, error: 'Script file is empty' };
      }
      
      return { valid: true };
      
    } catch (error) {
      return { 
        valid: false, 
        error: `Script file validation failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * スクリプトファイルの内容をログ出力
   */
  async logScriptContent(scriptPath: string): Promise<void> {
    try {
      // ログ出力が削除されたため、このメソッドは現在何も行わない
      // ファイル存在確認のみ
      await fs.access(scriptPath);
    } catch (error) {
      console.error('MagickScriptGenerator - Failed to read script for logging:', error);
    }
  }

  /**
   * 一時スクリプトファイルの削除
   */
  async cleanupScript(scriptPath: string): Promise<void> {
    try {
      await fs.unlink(scriptPath);
    } catch (error) {
      console.warn(`MagickScriptGenerator - Failed to cleanup script file: ${error}`);
    }
  }
}