import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { RecentEntry, RankingTopEntry } from '@shared/types/ranking';
import { AppConfig } from '@shared/types';

// CardItem and CardWrapper logic is now merged into this component

interface PaginatedScrollListProps {
  entries: (RecentEntry | RankingTopEntry)[];
  config: AppConfig['ranking'] | undefined;
  /** 見出しの横にページ番号を出すために、現在ページと総ページ数を親へ知らせる */
  onPageInfo?: (current: number, total: number) => void;
}

/** ページの位置。out=左へ出ていく / in=右端で待機（アニメ無し）/ center=定位置 */
type SlidePhase = 'center' | 'out' | 'in';

/**
 * まだ出来ていないカード画像を取り直す間隔。
 * ダミーカードは結果保存の直後、AIカードは変換完了後（このPCで約3分）に現れる。
 * 短すぎると終日 IPC を叩き続けるので、体感を損なわない範囲で長めに取る。
 */
const CARD_IMAGE_RETRY_MS = 5000;

const PaginatedScrollList: React.FC<PaginatedScrollListProps> = ({
  entries,
  config,
  onPageInfo,
}) => {
  const cardsPerPage = config?.pagination?.cardsPerPage ?? 5;
  const intervalSeconds = config?.pagination?.intervalSeconds ?? 8;
  // 切り替え全体にかける時間。前半で左へ送り出し、後半で右から滑り込ませる
  const transitionDuration = config?.pagination?.transitionDurationMs ?? 600;
  const half = Math.max(120, Math.round(transitionDuration / 2));

  // 数字を全角に変換する関数
  const toFullWidth = (num: number): string => {
    const fullWidthNumbers = ['０', '１', '２', '３', '４', '５', '６', '７', '８', '９'];
    return num.toString().split('').map(digit => fullWidthNumbers[parseInt(digit)]).join('');
  };

  const [currentPage, setCurrentPage] = useState(0);
  const [slide, setSlide] = useState<SlidePhase>('center');
  /**
   * 自動送りを止めているか。
   * 親御さんがカードを撮るとき、スライドショーが動いたままだと
   * カメラを構えて待つことになるため、運営が止められるようにした
   * （2026-09-08 の指摘）。**自動では再開しない**（撮り終わるまで確実に止める）。
   */
  const [paused, setPaused] = useState(false);
  const [imageUrls, setImageUrls] = useState<Record<string, string | null>>({});
  // 終日つけっぱなしの画面なので、待機中のタイマーは必ず片付ける
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // step() から最新のページ数を読む箱。依存に入れると送るたびに関数が作り直され、
  // 自動送りの setInterval が張り直されて間隔がずれる
  const pagesLenRef = useRef(0);

  const pages = useMemo(() => {
    if (entries.length === 0) return [];
    const result: (RecentEntry | RankingTopEntry)[][] = [];
    for (let i = 0; i < entries.length; i += cardsPerPage) {
      result.push(entries.slice(i, i + cardsPerPage));
    }
    return result;
  }, [entries, cardsPerPage]);

  // step() が最新のページ数を読めるようにする（レンダーごとに詰め替える）
  pagesLenRef.current = pages.length;

  // ページ数が減ったとき（記録が入れ替わった等）に、無いページを指したままにしない
  useEffect(() => {
    if (pages.length && currentPage >= pages.length) setCurrentPage(0);
  }, [pages.length, currentPage]);

  // 見出し横のページ番号（「０１／２０」）用に、親へ現在地を渡す
  useEffect(() => {
    onPageInfo?.(pages.length ? currentPage + 1 : 0, pages.length);
  }, [currentPage, pages.length, onPageInfo]);

  /**
   * 取得済み／取得中のカード画像。
   *
   * 🔴 **`imageUrls`（state）を依存配列に入れてはいけない。**
   * カードがまだ出来ていない回は main から null が返るが、それを state へ書くと
   * 新しいオブジェクトになって effect が再実行され、また同じ回を取りに行く——
   * という**無限ループ**になる。ランキング画面は終日つけっぱなしなので、
   * 「じゅんび中」のカードが1枚でもあると、IPC と results/ の読み取りを
   * 際限なく叩き続けることになる（1枚2.5MB を base64 で往復する処理）。
   *
   * そこで「取れたか」の判断は ref で行い、state は描画のためだけに持つ。
   * まだ出来ていない回は一定間隔で取り直す（後からダミー／AIカードが出来るため）。
   *
   * 🔴 **いま表示していない回は必ず捨てる。**
   * 保持しているのはカード画像の data URL で、1枚 2.5MB の PNG が base64 で
   * 約3.4MB、JS の文字列（UTF-16）としては約7MB になる。
   * 「みんなのきろく」は新しい30件だけを見せる一方、当日は3000人が遊ぶので、
   * 一度でも表示した回をすべて抱えると数十GBに達して**ランキング画面が落ちる**
   * （記録は残るが、会場の大画面が消える）。
   */
  const loadedUrlsRef = useRef<Record<string, string>>({});
  const inFlightRef = useRef<Set<string>>(new Set());

  /**
   * まだ描画しているか（アンマウントしていないか）。
   *
   * 🔴 **effect ごとの `alive` で state 書き込みを止めてはいけない。**
   * `entries` は results.json が書かれるたびに作り直されるため、この effect は
   * 1回の保存で何度も入れ替わる（ranking-service の fs.watch はディレクトリを
   * 監視しており、tmp への書き込みと rename を複数イベントとして流す）。
   * 取得中に入れ替わると、返ってきた実体を `loadedUrlsRef` にだけ書いて
   * state へ載せないまま捨てることになり、以後の再取得は「取得済み」と見て
   * 素通りするので、**実体があるのに永久に「じゅんび中」のまま**になる。
   * 止めたいのはアンマウント後だけなので、判定はここで持つ。
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    // StrictMode の二重実行で「破棄 → 生成」が走るため、マウント側で必ず戻す。
    // 戻さないと二度目以降 state を更新できず、同じ症状（じゅんび中のまま）になる。
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    // いま一覧にある回だけを残す（表から外れた回の data URL を解放する）
    const livePaths = new Set(
      entries.map((entry) => entry.memorialCardPath).filter((p): p is string => !!p)
    );
    for (const path of Object.keys(loadedUrlsRef.current)) {
      if (!livePaths.has(path)) delete loadedUrlsRef.current[path];
    }
    setImageUrls((prev) => {
      const keys = Object.keys(prev);
      if (keys.every((k) => livePaths.has(k))) return prev;
      const next: Record<string, string | null> = {};
      for (const k of keys) if (livePaths.has(k)) next[k] = prev[k];
      return next;
    });

    const fetchMissing = () => {
      // 取得済みなのに state へ載っていない回を先に載せる。
      // effect の入れ替わりで取りこぼした実体はここでしか拾えない
      // （下の for は loadedUrlsRef を見て素通りするため）。
      setImageUrls((prev) => {
        let next = prev;
        for (const path of livePaths) {
          const loaded = loadedUrlsRef.current[path];
          if (loaded && prev[path] !== loaded) {
            if (next === prev) next = { ...prev };
            next[path] = loaded;
          }
        }
        return next;
      });

      for (const path of livePaths) {
        // すでに実体を取れている回・いま取りに行っている回は触らない
        if (loadedUrlsRef.current[path] || inFlightRef.current.has(path)) continue;
        inFlightRef.current.add(path);
        window.electronAPI?.getImageDataUrl?.(path)
          .then(url => {
            // 取れた実体は effect の入れ替わり（entries の更新）を越えて使い回す。
            // ここで捨てると、記録が1件増えるたびに全件を取り直すことになる。
            // 一覧から外れた回はこの effect の先頭で掃除される。
            if (url) loadedUrlsRef.current[path] = url;
            if (!mountedRef.current) return;
            setImageUrls(prev => (prev[path] === url ? prev : { ...prev, [path]: url }));
          })
          .catch(err => {
            console.error('Failed to load image url', err);
            if (!mountedRef.current) return;
            setImageUrls(prev => (prev[path] === null ? prev : { ...prev, [path]: null }));
          })
          .finally(() => {
            inFlightRef.current.delete(path);
          });
      }
    };

    fetchMissing();
    const retry = setInterval(fetchMissing, CARD_IMAGE_RETRY_MS);
    return () => {
      clearInterval(retry);
    };
  }, [entries]);

  /**
   * ページを送る。自動送りと運営のキー操作で同じ経路を通す
   * （動きが2通りに分かれると、手で送ったときだけ挙動が違うことになる）。
   */
  const step = useCallback((delta: number) => {
    const count = pagesLenRef.current;
    if (count <= 1) return;
    // 1) 今のページを左へ送り出す
    setSlide('out');
    const t1 = setTimeout(() => {
      // 2) 次のページに差し替え、アニメーション無しで右端へ置く
      setCurrentPage(prev => (prev + delta + count) % count);
      setSlide('in');
      // 3) 1フレーム置いてから定位置へ滑り込ませる
      //    （同じフレームで戻すとブラウザが「移動」と見なさず、瞬間移動になる）
      const t2 = setTimeout(() => setSlide('center'), 30);
      timersRef.current.push(t2);
    }, half);
    timersRef.current.push(t1);
  }, [half]);

  useEffect(() => {
    if (pages.length <= 1 || paused) return;

    const interval = setInterval(() => step(1), intervalSeconds * 1000);

    return () => {
      clearInterval(interval);
      for (const t of timersRef.current) clearTimeout(t);
      timersRef.current = [];
      setSlide('center');
    };
  }, [pages.length, intervalSeconds, paused, step]);

  /**
   * 運営の操作を受ける（main 側の globalShortcut から届く）。
   * F7 = 停止／再開・F8 = 次・F6 = 前。
   * ゲーム側にフォーカスがあっても効くよう、main を経由している。
   * 手で送ったときは自動送りも止める（見たいカードが流れていくため）。
   */
  useEffect(() => {
    const cleanup = window.electronAPI?.onSlideshowCommand?.((action) => {
      if (action === 'toggle') { setPaused((p) => !p); return; }
      setPaused(true);
      step(action === 'next' ? 1 : -1);
    });
    return cleanup;
  }, [step]);

  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="gold-heading text-lg">まだ ありません</p>
      </div>
    );
  }

  const currentPageData = pages[currentPage] || [];

  return (
    <div className="w-full h-full relative overflow-hidden">
      {/* 停止中の目印。運営が分かればよいので小さく、
          カードに重ならない左上の隅に置く（撮った写真に写り込ませない）。
          2026-09-08 の指摘で「一時停止中」の大きな表示から差し替えた。 */}
      {paused && (
        <div
          className="absolute top-1 left-1 z-10 rounded-full bg-red-600 shadow"
          style={{ width: 10, height: 10 }}
          title="スライドショー停止中（F7 で再開）"
        />
      )}
      <div
        className="grid w-full h-full p-2 gap-2"
        style={{
          gridTemplateColumns: `repeat(${cardsPerPage}, 1fr)`,
          transform:
            slide === 'out' ? 'translateX(-100%)' : slide === 'in' ? 'translateX(100%)' : 'translateX(0)',
          // 右端へ置く瞬間だけはアニメーションさせない（そこは「移動」ではないため）
          transition: slide === 'in' ? 'none' : `transform ${half}ms ease-in-out`,
        }}
      >
        {currentPageData.map((entry, index) => {
          const isRankingEntry = 'rank' in entry;
          const rank = isRankingEntry ? (entry as RankingTopEntry).rank : undefined;

          let rankStyle = "";
          let rankBgStyle = "";
          if (rank) {
            if (rank === 1) {
              rankStyle = "text-2xl font-bold text-black";
              rankBgStyle = "bg-gradient-to-b from-yellow-300 to-amber-500 border-2 border-white";
            } else if (rank === 2) {
              rankStyle = "text-2xl font-bold text-black";
              rankBgStyle = "bg-gradient-to-b from-slate-200 to-gray-400 border-2 border-white";
            } else if (rank === 3) {
              rankStyle = "text-2xl font-bold text-black";
              rankBgStyle = "bg-gradient-to-b from-orange-300 to-amber-600 border-2 border-white";
            } else {
              // 4位以下。金色の背景の上なので、黒帯ではなく白地＋濃い文字にする
              rankStyle = "text-xl font-semibold text-amber-950";
              rankBgStyle = "bg-white/85 border border-white";
            }
          }

          const imageUrl = entry.memorialCardPath ? imageUrls[entry.memorialCardPath] : null;

          return (
            <div key={`${entry.score}-${currentPage}-${index}`} className="w-full h-full flex flex-col items-center justify-center">
              {/* Rank Display */}
              <div className="flex-shrink-0 h-6 flex items-center justify-center">
                {rank && (
                  <div className={`px-3 py-1 rounded-full shadow ${rankBgStyle}`}>
                    <span className={rankStyle}>{toFullWidth(rank)}位</span>
                  </div>
                )}
              </div>

              {/* Card Item
                  カードの下敷き（暗い枠）は置かない。背景の波打つ模様を隠さないため、
                  カード画像そのものだけを見せる。 */}
              <div className="flex-1 w-full min-h-0">
                <div className="w-full h-full relative">
                  {imageUrl ? (
                    <img
                      src={imageUrl}
                      alt={`Score ${entry.score}`}
                      className="absolute inset-0 w-full h-full object-contain z-10 drop-shadow-lg"
                    />
                  ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center z-10">
                      {/* 画像がまだ無い回だけ、白い薄板を敷いて「準備中」と分かるようにする */}
                      <div className="flex flex-col items-center justify-center rounded-xl bg-white/70 px-4 py-3 text-amber-900">
                        <svg className="w-8 h-8 mb-1" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z" clipRule="evenodd" />
                        </svg>
                        <span className="text-xs font-bold">じゅんび中</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default PaginatedScrollList;
