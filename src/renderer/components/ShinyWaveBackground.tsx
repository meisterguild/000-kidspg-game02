import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

/* ============================================================
   きらきら波打つ背景（三角ポリゴンの面）

   三角形をつないだ面を波打たせ、面ごとの法線で光らせる。
   明るい黄色〜オレンジのグラデーションに、鏡面反射の粒でキラキラを足す。
   マウスを近づけると、その周りが盛り上がって波紋が広がる。

   終日つけっぱなしになる画面（ランキング）でも使うので、次を守っている。
   - 頂点の移動は**シェーダ側**で行う（CPU を使わない。本番PCは CPU で画像生成もする）
   - 描画は既定 30fps に制限し、ウィンドウが隠れている間は止める
   - アンマウント時に WebGL のリソースを明示的に解放する
   ============================================================ */

interface ShinyWaveBackgroundProps {
  /** マウスに反応させるか。既定は true（ランキング画面でも害はない） */
  interactive?: boolean;
  /** 描画の上限フレームレート。既定 30 */
  fps?: number;
  /** 追加のクラス（z-index の調整などに使う） */
  className?: string;
  /**
   * 画面全体に敷くなら fixed（既定）。
   * 親要素の中だけに敷きたいときは absolute（ゲーム画面のように枠内で使う場合）。
   */
  position?: 'fixed' | 'absolute';
}

const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec2  uMouse;
  uniform float uMouseStrength;
  varying vec3 vPos;

  // 1本ぶんの波。向きと周期をそろえないのは、格子のような模様に見せないため
  float wave(vec2 p, vec2 dir, float freq, float speed, float amp) {
    return sin(dot(p, dir) * freq + uTime * speed) * amp;
  }

  float waveHeight(vec2 p) {
    // 三角形1枚あたりが大きくなったので、波の細かさもそれに合わせて落とす。
    // 三角形より細かい波を混ぜても、面ごとの陰影ではノイズにしかならない。
    float h = 0.0;
    h += wave(p, normalize(vec2( 0.92,  0.39)), 0.030, 0.85, 13.0);
    h += wave(p, normalize(vec2(-0.44,  0.90)), 0.047, 0.62,  9.0);
    h += wave(p, normalize(vec2( 0.31, -0.95)), 0.071, 1.15,  5.5);
    h += wave(p, normalize(vec2(-0.86, -0.51)), 0.104, 1.60,  2.6);

    // マウスの周りを持ち上げて、外へ広がる波紋を足す（三角形が大きくなったぶん広めに）
    float d = distance(p, uMouse);
    h += uMouseStrength * 16.0 * exp(-d * d * 0.00012) * cos(d * 0.055 - uTime * 3.0);
    return h;
  }

  void main() {
    vec3 p = position;
    p.z = waveHeight(p.xy);
    vPos = p;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec3 vPos;
  uniform float uTime;

  void main() {
    // 面ごとの法線を画面微分から作る＝三角形が1枚ずつ違う明るさになる（フラットシェーディング）
    vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
    if (n.z < 0.0) n = -n;

    vec3 lightDir = normalize(vec3(0.36, 0.58, 0.73));
    vec3 viewDir  = vec3(0.0, 0.0, 1.0);
    vec3 halfDir  = normalize(lightDir + viewDir);

    float diff = clamp(dot(n, lightDir), 0.0, 1.0);
    float ndh  = clamp(dot(n, halfDir), 0.0, 1.0);
    float spec    = pow(ndh, 42.0);
    float sparkle = pow(ndh, 260.0);

    // 明るい黄 〜 オレンジ。
    // 画面いっぱいに広がる背景なので、白飛びしない程度に輝度を落としてある
    // （2026-09-03: まぶしいという指摘を受けて全体を約2割暗くした）。
    vec3 deep   = vec3(0.62, 0.19, 0.02);
    vec3 mid    = vec3(0.84, 0.52, 0.08);
    vec3 bright = vec3(0.94, 0.80, 0.42);

    float t = clamp(diff * 1.25 + vPos.z * 0.010 - 0.12, 0.0, 1.0);
    vec3 col = mix(deep, mid, smoothstep(0.00, 0.55, t));
    col = mix(col, bright, smoothstep(0.50, 1.00, t));

    // きらめきは残しつつ、目に刺さらない量にする
    col += spec * vec3(1.00, 0.95, 0.78) * 0.22;
    col += sparkle * vec3(1.0) * 0.45;

    gl_FragColor = vec4(col, 1.0);
  }
`;

/** 画面を覆うのに必要な平面の大きさ（カメラからの距離と画角から求める） */
const planeSizeFor = (camera: THREE.PerspectiveCamera, distance: number) => {
  const height = 2 * Math.tan((camera.fov * Math.PI) / 180 / 2) * distance;
  const width = height * camera.aspect;
  // 傾け・波・マウスの盛り上がりで端が見えないよう、余裕を持たせる
  return { width: width * 1.7, height: height * 1.7 };
};

const ShinyWaveBackground: React.FC<ShinyWaveBackgroundProps> = ({
  interactive = true,
  fps = 30,
  className = '',
  position = 'fixed',
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  // 最新値をレンダーループから読むための箱（ループはマウント時に1度だけ作る）
  const optionsRef = useRef({ interactive, fps });
  optionsRef.current = { interactive, fps };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 1, 4000);
    const CAMERA_DISTANCE = 620;
    camera.position.set(0, 0, CAMERA_DISTANCE);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'low-power' });
    } catch (error) {
      // WebGL が使えない環境でも画面を壊さない（背景が無地になるだけ）
      console.warn('ShinyWaveBackground: WebGL を初期化できませんでした', error);
      return;
    }
    // 塗る面積を抑える。背景なので等倍で十分（高DPIでも粗さは目立たない）。
    // ここを 1.5 にしていた頃は、ランキングのページ送りでカクつく原因になっていた。
    renderer.setPixelRatio(1);
    renderer.setClearColor(0xc47a1a, 1);
    Object.assign(renderer.domElement.style, {
      position: 'absolute', top: '0', left: '0',
      width: '100%', height: '100%', display: 'block',
    });
    mount.appendChild(renderer.domElement);

    const uniforms = {
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2(0, 0) },
      uMouseStrength: { value: 0 },
    };

    // dFdx/dFdy（面ごとの法線に使う）は WebGL2 では標準機能。
    // three r150 以降は WebGL2 が既定で、extensions.derivatives の指定は廃止されている。
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), material);
    // 少しだけ傾けて、平らな板ではなく「奥行きのある面」に見せる
    mesh.rotation.x = -0.22;
    scene.add(mesh);

    /* --- 大きさに合わせて平面と分割数を作り直す --- */
    const rebuildGeometry = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();

      const { width, height } = planeSizeFor(camera, CAMERA_DISTANCE);
      // 三角形の大きさが画面サイズによらず一定に見えるよう、分割数を幅から決める。
      // 1マス ≒ 55px。以前は 26px で三角形が細かすぎ、枚数（＝描画の重さ）も4倍あった。
      // 大きめの面にすると模様としても見やすく、ページ送りのカクつきも減る。
      const segX = Math.max(12, Math.min(40, Math.round(w / 55)));
      const segY = Math.max(8, Math.min(28, Math.round(h / 55)));

      mesh.geometry.dispose();
      mesh.geometry = new THREE.PlaneGeometry(width, height, segX, segY);
    };
    rebuildGeometry();

    const ro = new ResizeObserver(rebuildGeometry);
    ro.observe(mount);

    /* --- マウス（ホバー）への反応 --- */
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const targetMouse = new THREE.Vector2(0, 0);
    let targetStrength = 0;
    let decayTimer: ReturnType<typeof setTimeout> | null = null;

    const onPointerMove = (ev: PointerEvent) => {
      if (!optionsRef.current.interactive) return;
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      // まだ1度も描画していない・裏で止まっている間は行列が古いままなので、ここで更新する
      camera.updateMatrixWorld();
      mesh.updateMatrixWorld();
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObject(mesh, false)[0];
      if (hit) {
        const local = mesh.worldToLocal(hit.point.clone());
        targetMouse.set(local.x, local.y);
      }
      targetStrength = 1;
      // 動かさなくなったら、じわっと静かな波へ戻す
      if (decayTimer) clearTimeout(decayTimer);
      decayTimer = setTimeout(() => { targetStrength = 0; }, 1800);
    };
    // 背景自身はクリックを拾わない（pointer-events: none）ので window で受ける
    window.addEventListener('pointermove', onPointerMove);

    /* --- 描画ループ（fps 制限つき・非表示なら止める） --- */
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let painted = false;   // 一度も描いていないうちは、隠れていても1枚は描く
    const clock = new THREE.Clock();

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = now - last;
      last = now;

      // 隠れている間は止める（終日運転で無駄に回さない）。
      // ただし初回だけは必ず描く。描かないままだと canvas が透明のままで、
      // 復帰した瞬間に背景が抜けて見える。
      if (document.hidden && painted) return;

      acc += dt;
      const interval = 1000 / Math.max(1, optionsRef.current.fps);
      if (acc < interval) return;
      acc = 0;

      uniforms.uTime.value = clock.getElapsedTime();
      // マウス位置と強さをなめらかに追従させる
      uniforms.uMouse.value.lerp(targetMouse, 0.12);
      uniforms.uMouseStrength.value += (targetStrength - uniforms.uMouseStrength.value) * 0.08;

      renderer.render(scene, camera);
      painted = true;
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      if (decayTimer) clearTimeout(decayTimer);
      window.removeEventListener('pointermove', onPointerMove);
      ro.disconnect();
      mesh.geometry.dispose();
      material.dispose();
      scene.remove(mesh);
      renderer.forceContextLoss();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      className={`${position} inset-0 pointer-events-none ${className}`}
      style={{ zIndex: 0, background: 'radial-gradient(circle at 50% 42%, #FFE87A 0%, #FFD429 62%, #F7C310 100%)' }}
    />
  );
};

export default ShinyWaveBackground;
