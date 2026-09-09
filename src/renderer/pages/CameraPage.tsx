import React, { useRef, useEffect, useState, useCallback } from 'react';
import { NICKNAME_OPTIONS, TIMING_CONFIG } from '@shared/utils/constants';
import { useImageResize } from '../hooks/useImageResize';
import { playSound } from '../utils/assets';
import { useScreen } from '../contexts/ScreenContext';
import { useGameSession } from '../contexts/GameSessionContext';
import { useCamera } from '../contexts/CameraContext';
import { cameraService } from '../services/camera-service';
import { useSavePhoto } from '../hooks/useSavePhoto';

const CameraPage: React.FC = () => {
  const { setCurrentScreen } = useScreen();
  const {
    capturedImage,
    setCapturedImage,
    selectedNickname,
    setSelectedNickname,
    setResultDir,
  } = useGameSession();
  const { isReady: isCameraReady, isUsingDummy, error: cameraError } = useCamera();

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isPhotoTaken, setIsPhotoTaken] = useState(!!capturedImage);
  const { savePhoto, isSaving: isSavingHook, error: saveError } = useSavePhoto();
  const { resizeToSquare } = useImageResize();
  const [dummyPhotoPath, setDummyPhotoPath] = useState('');

  // 撮影設定（camera.width / height）は CameraProvider が初期化の前に
  // cameraService へ渡す。ここで渡し直すと「初期化には間に合っていない設定」を
  // 後から上書きすることになり、どちらが効いているのか分からなくなるので行わない。

  // ダミーモード時にアセットの絶対パスを取得
  useEffect(() => {
    if (isUsingDummy) {
      window.electronAPI?.getAssetAbsolutePath('assets/images/dummy_photo.png')
        .then(path => {
          // Windowsのパス区切り文字をスラッシュに変換し、file://プロトコルを付与
          const url = path.replace(/\\/g, '/');
          setDummyPhotoPath(`file://${url}`);
        })
        .catch(err => {
          console.error('Failed to get dummy photo path:', err);
          // フォールバックパスを設定
          setDummyPhotoPath('./assets/dummy_photo.png'); 
        });
    }
  }, [isUsingDummy]);

  // 準備済みカメラストリームを使用
  const setupVideoStream = useCallback(() => {
    if (isUsingDummy || !videoRef.current) {
      return;
    }

    const stream = cameraService.getStream();
    if (stream) {
      videoRef.current.srcObject = stream;
      videoRef.current.onloadeddata = () => {
      };
    }
  }, [isUsingDummy]);

  useEffect(() => {
    if (!isPhotoTaken && isCameraReady) {
      const timer = setTimeout(() => {
        setupVideoStream();
      }, TIMING_CONFIG.cameraStartDelay);
      return () => clearTimeout(timer);
    }
  }, [isPhotoTaken, isCameraReady, setupVideoStream]);

  const capturePhoto = useCallback(() => {
    playSound('buttonClick');

    try {
      if (isUsingDummy) {
        if (!dummyPhotoPath) {
          throw new Error('ダミー画像のパスが設定されていません');
        }
        // ダミーモード: 取得したアセットパスを使用
        const dummyImageSrc = dummyPhotoPath;
        
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          if (ctx) {
            canvas.width = 320;
            canvas.height = 320;
            ctx.drawImage(img, 0, 0, 320, 320);
            const imageData = canvas.toDataURL('image/png');
            setCapturedImage(imageData);
            setIsPhotoTaken(true);
          }
        };
        img.onerror = () => {
          // フォールバック: CameraServiceのダミー画像を使用
          const dummyImageData = cameraService.getDummyImageData();
          if (dummyImageData) {
            setCapturedImage(dummyImageData);
            setIsPhotoTaken(true);
          } else {
            // 🔴 ここで throw しても、この関数は画像読み込みのコールバックとして
            // 後から呼ばれるため、上の try/catch では捕まらない（未処理エラーになる）。
            // 撮影に進めないことをその場で伝える。
            console.error('ダミー画像が利用できません');
            alert('画像の処理中にエラーが発生しました。もう一度お試しください。');
          }
        };
        img.src = dummyImageSrc;
      } else {
        // 実カメラモード: カメラから撮影
        if (!videoRef.current || !canvasRef.current) {
          throw new Error('カメラまたはキャンバスが利用できません');
        }

        const canvas = canvasRef.current;
        const video = videoRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('Canvas 2D context を取得できませんでした');
        }

        // 🔴 **映像が来ていないうちに撮ってはいけない。**
        // srcObject を差してから最初のフレームが届くまで videoWidth は 0 のままで、
        // その状態で撮ると 0x0 のキャンバスから**真っ黒な写真**が出来る。
        // 本人には気づけないまま保存され、そのまま AI 変換にも回る。
        if (!video.videoWidth || !video.videoHeight) {
          alert('カメラの準備がまだできていません。少し待ってからもう一度おしてください。');
          return;
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);

        const imageData = resizeToSquare(canvas); // デフォルトサイズを使用
        setCapturedImage(imageData);
        setIsPhotoTaken(true);
      }
    } catch (error) {
      console.error('写真撮影エラー:', error);
      alert('画像の処理中にエラーが発生しました。もう一度お試しください。');
    }
  }, [isUsingDummy, resizeToSquare, setCapturedImage, dummyPhotoPath]);

  const retakePhoto = useCallback(() => {
    setIsPhotoTaken(false);
    setCapturedImage('');
    if (!isUsingDummy) {
      setupVideoStream();
    }
  }, [setCapturedImage, isUsingDummy, setupVideoStream]);

  const handleConfirm = useCallback(async () => {
    if (!capturedImage || isSavingHook) return;

    playSound('buttonClick');

    const result = await savePhoto(capturedImage, isUsingDummy);

    if (result.success && result.dirPath) {
      setResultDir(result.dirPath);
      setCurrentScreen('COUNTDOWN');
    } else {
      console.error('写真の保存に失敗しました:', saveError || result.error);
      alert(`写真の保存に失敗しました: ${saveError || result.error}`);
    }
  }, [capturedImage, setResultDir, setCurrentScreen, savePhoto, isSavingHook, saveError, isUsingDummy]);

  useEffect(() => {
    const handleKeyPress = (event: KeyboardEvent) => {
      if (event.key !== ' ') return;
      event.preventDefault();
      // 🔴 **キーリピートを無視する。** Space を押しっぱなしにすると、
      // 1発目で撮影、2発目（Windows の既定で約0.5秒後）で確定が走り、
      // **「やりなおし」を見る前に本番の1枚が確定して次の画面へ進む**。
      // 確定した写真はそのまま AI 変換と記念カードに焼かれ、
      // 画面が変わったあとでは撮り直せない（敵対的レビュー 2026-09-09 の指摘）。
      if (event.repeat) return;
      // 撮影の直後に同じ押下で確定へ進まないよう、状態ごとに分ける
      if (!isPhotoTaken) {
        capturePhoto();
      } else if (capturedImage) {
        handleConfirm();
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [isPhotoTaken, capturedImage, capturePhoto, handleConfirm]);

  const getRandomNickname = useCallback(() => {
    const nonRandomOptions = NICKNAME_OPTIONS.filter(opt => opt.id !== 'random');
    const randomOption = nonRandomOptions[Math.floor(Math.random() * nonRandomOptions.length)];
    return randomOption.text;
  }, []);

  useEffect(() => {
    // 「ランダム」という文字列がそのまま入っているのは、選択前か
    // ランダムボタンの表示名がそのまま渡ってしまった場合。実名へ確定させる。
    // 比較対象は候補一覧のランダム項目の表示名から取る（直書きしない）
    const randomLabel = NICKNAME_OPTIONS.find(opt => opt.id === 'random')?.text;
    if (!selectedNickname || selectedNickname === randomLabel) {
      const initialNickname = getRandomNickname();
      setSelectedNickname(initialNickname);
    }
  }, [selectedNickname, setSelectedNickname, getRandomNickname]);

  // 判定は id で行う。表示名（text）で見ると、「ランダム」を含む名前を
  // 候補に足した瞬間に、その名前を選べなくなる
  const handleNicknameClick = useCallback((option: { id: string; text: string }) => {
    playSound('buttonClick');
    const finalNickname = option.id === 'random' ? getRandomNickname() : option.text;
    setSelectedNickname(finalNickname);
  }, [setSelectedNickname, getRandomNickname]);

  return (
    <div className="camera-layout">
      <div className="camera-nicknames">
        <h2 className="text-2xl font-bold mb-4">ニックネームを選択してください</h2>
        <div className="flex flex-wrap">
          {NICKNAME_OPTIONS.map((option) => (
            <button
              key={option.id}
              className={`nickname-button ${
                selectedNickname === option.text
                  ? 'nickname-button--selected' 
                  : 'nickname-button--unselected'
              } ${
                option.id === 'random' ? 'is-random' : ''
              }`}
              onClick={() => handleNicknameClick(option)}
            >
              {option.text}
            </button>
          ))}
        </div>
        <div className="mt-6 p-4 bg-white/85 border-4 border-white rounded-2xl shadow-lg">
          <p className="text-lg text-game-text">
            選択中: <span className="font-bold text-mg-brand-600">{selectedNickname}</span>
          </p>
        </div>
      </div>

      <div className="camera-preview">
        <h2 className="text-xl font-bold mb-4">カメラをみて<br/>スペースバーをおす！</h2>
        
        <div className="video-container mb-4 relative" style={{ width: '320px', height: '320px' }}>
          {!isPhotoTaken ? (
            <>
              {isUsingDummy ? (
                <div className="w-full h-full flex items-center justify-center bg-gray-200 relative">
                  {dummyPhotoPath ? (
                    <img 
                      src={dummyPhotoPath} 
                      alt="ダミーカメラ画像"
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        console.error('Failed to load dummy_photo.png from path:', dummyPhotoPath);
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <p>ダミー画像読込中...</p>
                    </div>
                  )}
                  <div className="absolute top-2 left-2 bg-yellow-500 text-black px-2 py-1 text-xs rounded">
                    ダミーモード
                  </div>
                </div>
              ) : (
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
              )}
              <div className="face-guide-overlay">
                <div className="face-guide-ellipse"></div>
              </div>
              {!isCameraReady && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-75 text-white text-xl font-bold">
                  {cameraError ? 'カメラエラー' : '準備中...'}
                </div>
              )}
            </>
          ) : (
            <img 
              src={capturedImage} 
              alt="撮影した写真"
              className="w-full h-full object-cover"
            />
          )}
          <canvas ref={canvasRef} className="hidden" />
        </div>

        <div className="space-y-3">
          {!isPhotoTaken ? (
            <button 
              className="game-button w-full"
              onClick={capturePhoto}
            >
              さつえい (Space)
            </button>
          ) : (
            <>
              <button 
                className="game-button w-full bg-green-600 hover:bg-green-700"
                onClick={handleConfirm}
                disabled={!capturedImage || isSavingHook}
              >
                {isSavingHook ? '保存中...' : 'スタート (Space)'}
              </button>
              <button 
                className="game-button w-full bg-gray-600 hover:bg-gray-700"
                onClick={retakePhoto}
                disabled={isSavingHook}
              >
                やりなおし
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default CameraPage;