import { app } from 'electron';
import * as path from 'path';

/**
 * results ディレクトリの解決。
 * 以前は save-photo だけが process.cwd() を使っており、exe ディレクトリ以外を
 * 作業フォルダにして起動すると、写真と results.json が別の場所に書かれて
 * ランキングのカード画像が一枚も出なくなっていた。
 * results の場所を知りたい側は必ずこの関数を使うこと。
 */
export const resolveResultsDir = (): string =>
  app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), 'results')
    : path.join(app.getAppPath(), 'results');
