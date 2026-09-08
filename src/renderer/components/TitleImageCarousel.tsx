import React, { useEffect, useState } from 'react';
import { getImageAssets } from '../utils/assets';

/**
 * TOP画面のタイトル画像。
 * 昨年は4枚を8秒ごとに切り替えるカルーセルだったが、それらは
 * すべて「よけまくり中」のタイトル画像なので今年は使わない。
 * いまは 2026 用（「AIグミパク！」）の1枚を表示するだけ。
 */
const TitleImageCarousel: React.FC = () => {
  const [src, setSrc] = useState<string>('');

  useEffect(() => {
    let alive = true;
    getImageAssets()
      .then((a) => { if (alive) setSrc(a.titleGummy01); })
      .catch((err) => console.warn('タイトル画像の読み込みに失敗しました:', err));
    return () => { alive = false; };
  }, []);

  return (
    <div className="relative w-full max-w-3xl mx-auto aspect-[3/2] overflow-hidden rounded-2xl mb-6">
      {src && (
        <img
          src={src}
          alt="KidsPG AIグミパク！ タイトル"
          /* object-cover だと縦横比のわずかな差で下端が切れ、
             「クリアするとAIがカードをつくってくれるよ！」の行が欠ける。
             用意された画像は端まで情報が入っているので contain で全体を見せる。 */
          className="absolute inset-0 w-full h-full object-contain"
        />
      )}
    </div>
  );
};

export default TitleImageCarousel;
