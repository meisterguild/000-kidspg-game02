import React, { useEffect, useState } from 'react';
import { playSound } from '../utils/assets';
import { useScreen } from '../contexts/ScreenContext';
import { TIMING_CONFIG } from '@shared/utils/constants';

const CountdownPage: React.FC = () => {
  const { setCurrentScreen } = useScreen();
  const [count, setCount] = useState(3);

  useEffect(() => {
    if (count > 0) {
      // カウントダウンの音を再生
      playSound('bell');
      const timer = setTimeout(() => {
        setCount(count - 1);
      }, 1000);
      
      return () => clearTimeout(timer);
    } else {
      // ゲーム開始音を再生
      //playSound('newtype');
      // カウントダウン終了後、ゲーム画面に遷移
      const timer = setTimeout(() => {
        setCurrentScreen('GAME');
      }, TIMING_CONFIG.countdownInterval);
      
      return () => clearTimeout(timer);
    }
  }, [count, setCurrentScreen]);

  return (
    <div className="screen-container">
      {/* 明るい黄色の地では薄いグレーが飛んで読めない。濃色＋白フチにする */}
      <h2 className="countdown-lead text-3xl md:text-4xl font-bold mb-12">
        まもなくゲーム開始！
      </h2>
      
      <div className="countdown-text">
        {count > 0 ? count : 'スタート‼'}
      </div>
      
      <div className="mt-12">
        <p className="text-lg text-game-text/70">
          光っているグミをタップして進もう
        </p>
        <p className="text-lg text-game-text/70">
          つながったグミをぜんぶ食べて、ゴールをめざそう！
        </p>
      </div>
    </div>
  );
};

export default CountdownPage;