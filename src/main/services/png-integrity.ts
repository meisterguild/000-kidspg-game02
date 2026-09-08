import * as fs from 'fs/promises';
import * as fsSync from 'fs';

/**
 * PNG が「最後まで書き終わっているか」を判定する。
 *
 * ■ なぜ先頭シグネチャだけでは足りないか
 * カードの合成は ImageMagick が**出力先へ直接書く**ため、書き込み途中で
 * プロセスが落ちると**最終ファイル名のまま先頭だけ揃った壊れたPNG**が残る。
 * 実際に 2026-09-02 の検証で
 * `memorial_card_20260902_184254.png` が 950,272 バイト（正常は 2.36〜2.87MB、
 * かつブロック境界ぴったり）で残り、ギャラリーで**上半分しか表示されない**状態になった。
 * 先頭8バイトのシグネチャとサイズ>0 だけを見る判定では、これを「正常」と誤認する。
 *
 * ■ ここで見るもの
 *   1. 先頭8バイトの PNG シグネチャ
 *   2. 末尾12バイトの IEND チャンク（長さ0 + "IEND" + CRC 固定値）
 * IEND は PNG の最終チャンクなので、これが揃っていれば
 * 「少なくとも書き込みは完了した」と言える。全チャンクの CRC 検証まではしない
 * （1枚2.8MB を当日3000枚ぶん読み直すのは高すぎる。切断の検出には末尾で足りる）。
 *
 * ■ 🔴 「壊れている」と「検査できなかった」を混ぜないこと
 * results/ は OneDrive 同期ツリーの中にあり、同期中のロック・クラウドのプレースホルダ化・
 * ウイルス対策のスキャンで `open` / `read` が EBUSY / EACCES / EIO を返すことがある。
 * これを「壊れている」と断定すると、**完成しているカードを消したり退避したり**してしまう。
 * その子の記念カードは取り返しがつかないので、判定は3つに分ける。
 *
 *   corrupt … PNG として明確に不正（署名不一致・IEND 不一致・小さすぎる）→ 破壊的操作をしてよい
 *   unknown … 検査できなかった（I/Oエラー・短い読み取り）→ **何も壊さず次回に持ち越す**
 *   missing … ファイルが無い
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 長さ0 + "IEND" + CRC(0xAE426082)。PNG 仕様で内容が一意に決まる12バイト */
const PNG_IEND = Buffer.from([
  0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

/** シグネチャ(8) + IHDR(25) + IEND(12)。これ未満は PNG として成立しない */
const PNG_MIN_SIZE = PNG_SIGNATURE.length + 25 + PNG_IEND.length;

export type PngStatus = 'valid' | 'corrupt' | 'unknown' | 'missing';

export interface PngIntegrityResult {
  /** status === 'valid' と同義。既存の呼び出しを壊さないために残している */
  valid: boolean;
  status: PngStatus;
  /** 判定に使ったファイルサイズ。ログ・調査用 */
  size?: number;
  /** valid=false のときだけ入る。日本語で原因を書く（当日スタッフが読む） */
  error?: string;
}

/**
 * 破壊的な操作（削除・退避）をしてよいかの判定。
 * **`!valid` で判断してはいけない。** 検査できなかっただけの完成品を壊すことになる。
 */
export const isDefinitelyCorrupt = (result: PngIntegrityResult): boolean => result.status === 'corrupt';

const ok = (size: number): PngIntegrityResult => ({ valid: true, status: 'valid', size });

const corrupt = (error: string, size?: number): PngIntegrityResult =>
  ({ valid: false, status: 'corrupt', size, error });

const unknown = (error: string, size?: number): PngIntegrityResult =>
  ({ valid: false, status: 'unknown', size, error });

/** 例外を投げずに結果へ変換する。ENOENT 以外は「検査できなかった」に寄せる */
const toFailure = (error: unknown): PngIntegrityResult => {
  const code = (error as { code?: string })?.code;
  if (code === 'ENOENT') return { valid: false, status: 'missing', error: 'ファイルがありません' };
  return unknown(`検査に失敗しました(${code ?? 'unknown'}): ${error instanceof Error ? error.message : String(error)}`);
};

/** サイズだけで判定できる分（同期版と非同期版で判定をずらさないため共有する） */
const checkSize = (size: number, isFile: boolean): PngIntegrityResult | null => {
  // ディレクトリを指しているのは呼び出し側の間違い。ファイルの中身の話ではないので
  // 「壊れている」とは言わない（消す・退避する対象にしない）
  if (!isFile) return unknown('PNG ではなくディレクトリを指しています');
  if (size < PNG_MIN_SIZE) return corrupt(`PNG として小さすぎます (${size} バイト)`, size);
  return null;
};

/**
 * 読み出した先頭・末尾から判定する（同期版と非同期版で共有する）。
 * `bytesRead` を必ず見ること。クラウド越しの短い読み取りでバッファがゼロのまま残ると
 * 「署名不一致」に化け、完成品を壊す判定になる。
 */
const checkHeadAndTail = (
  head: Buffer,
  headBytes: number,
  tail: Buffer,
  tailBytes: number,
  size: number
): PngIntegrityResult => {
  if (headBytes !== head.length || tailBytes !== tail.length) {
    return unknown(`読み取りが途中で終わりました (head=${headBytes}/${head.length}, tail=${tailBytes}/${tail.length})`, size);
  }
  if (!head.equals(PNG_SIGNATURE)) {
    return corrupt('PNG シグネチャが一致しません', size);
  }
  if (!tail.equals(PNG_IEND)) {
    return corrupt(`IEND チャンクがありません。書き込み途中で切れた可能性があります (${size} バイト)`, size);
  }
  return ok(size);
};

/**
 * PNG ファイルが完全かを検査する。例外は投げず、status で結果を返す。
 */
export async function verifyPngFile(filePath: string): Promise<PngIntegrityResult> {
  let handle: fs.FileHandle | undefined;
  try {
    const stat = await fs.stat(filePath);
    const sizeFailure = checkSize(stat.size, stat.isFile());
    if (sizeFailure) return sizeFailure;

    handle = await fs.open(filePath, 'r');
    const head = Buffer.alloc(PNG_SIGNATURE.length);
    const headRead = await handle.read(head, 0, head.length, 0);
    const tail = Buffer.alloc(PNG_IEND.length);
    const tailRead = await handle.read(tail, 0, tail.length, stat.size - PNG_IEND.length);

    return checkHeadAndTail(head, headRead.bytesRead, tail, tailRead.bytesRead, stat.size);
  } catch (error) {
    return toFailure(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * verifyPngFile の同期版。
 * 救済ツール（tools/retry-failed.cjs）が dist からこれを読む。
 * **判定を2か所に書かないため**、非同期版と同じ検査関数を共有している。
 */
export function verifyPngFileSync(filePath: string): PngIntegrityResult {
  let fd: number | undefined;
  try {
    const stat = fsSync.statSync(filePath);
    const sizeFailure = checkSize(stat.size, stat.isFile());
    if (sizeFailure) return sizeFailure;

    fd = fsSync.openSync(filePath, 'r');
    const head = Buffer.alloc(PNG_SIGNATURE.length);
    const headBytes = fsSync.readSync(fd, head, 0, head.length, 0);
    const tail = Buffer.alloc(PNG_IEND.length);
    const tailBytes = fsSync.readSync(fd, tail, 0, tail.length, stat.size - PNG_IEND.length);

    return checkHeadAndTail(head, headBytes, tail, tailBytes, stat.size);
  } catch (error) {
    return toFailure(error);
  } finally {
    if (fd !== undefined) {
      try { fsSync.closeSync(fd); } catch { /* 閉じられなくても判定に影響しない */ }
    }
  }
}
