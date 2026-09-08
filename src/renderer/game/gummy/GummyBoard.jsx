import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/* ============================================================
   3D表現ヘルパー
   ============================================================ */

/** 超楕円体（丸みのある立方体）＝グミの基本形 */
export function squircleGeometry(radius, e = 4, detail = 3) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const d = Math.pow(
      Math.pow(Math.abs(v.x), e) + Math.pow(Math.abs(v.y), e) + Math.pow(Math.abs(v.z), e),
      1 / e
    );
    v.multiplyScalar(radius / d);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * 頭の表面に張り付く「口のパッチ」を作る。
 *
 * 口を球にして拡大する作りでは、横に広げるほど中央が頭の中へ埋まり、
 * 頭の丸みで表面が後退する外周だけが飛び出す＝「唇の輪だけが拡大した」ように見えた
 * （2026-09-08 の指摘）。**頭と同じ超楕円体の式で表面を切り出す**ことで、
 * どれだけ広げても常に表面へ乗る。
 *
 * @param radius     頭の半径にわずかな余裕を足した値（z-fighting を避ける）
 * @param e          超楕円体の指数。頭（body）と同じ値にすること
 * @param halfAngle  +Z を中心とした開き（ラジアン）。これが口の大きさになる
 * @param squashY    縦の潰し。1 で丸い開口、小さくすると横長になる。
 *                   潰れて半径が縮んだ部分は頭に隠れるので、閉じた口は細い線に見える
 */
export function mouthPatchGeometry(radius, e, halfAngle, squashY, seg = 20) {
  const g = new THREE.SphereGeometry(1, seg, seg, 0, Math.PI * 2, 0, halfAngle);
  // SphereGeometry の帽子は +Y が中心なので、+Z を向くように倒す
  g.rotateX(Math.PI / 2);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const d = Math.pow(
      Math.pow(Math.abs(v.x), e) + Math.pow(Math.abs(v.y), e) + Math.pow(Math.abs(v.z), e),
      1 / e
    );
    v.multiplyScalar(radius / d);
    p.setXYZ(i, v.x, v.y * squashY, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** 口の開き具合の段目数。閉じた細い線から、大きく開いた口まで */
export const MOUTH_STEPS = 10;

/**
 * 「GOAL」の札。板（Sprite）なので盤面がどう回っても常に正面を向く。
 *
 * ゴールを形と色だけで示していたため、初見では「オレンジの玉」に見えて
 * どこを目指すのか分からなかった（2026-09-08 の動作確認）。
 * 文字は読ませるためではなく**目印**として置く。金色の背景に沈まないよう、
 * 影 → 白フチ → 本体の順に重ねて塊として見えるようにする。
 */
export function goalLabelSprite() {
  const W = 256, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');

  g.font = 'bold 76px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';

  g.shadowColor = 'rgba(90,40,0,0.55)';
  g.shadowBlur = 10;
  g.shadowOffsetY = 4;
  g.strokeStyle = '#ffffff';
  g.lineWidth = 16;
  g.strokeText('GOAL', W / 2, H / 2);

  g.shadowColor = 'transparent';
  g.fillStyle = '#e8410f';
  g.fillText('GOAL', W / 2, H / 2);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    // depthTest を切って常に最前面へ出す。グミの球体と交差すると
    // 札が半分めり込んで見えるため（2026-09-08 の動作確認）。
    // 裏の面にゴールがあるときも位置が分かるという利点もある。
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false })
  );
  sprite.scale.set(1.7, 0.85, 1);
  // 🔴 depthTest を切るだけでは足りない。グミもキューブ本体も transparent なので、
  // three は透明オブジェクトをカメラからの距離順に描く。ゴールが裏の面にあると
  // 札のほうが遠いため先に描かれ、あとから描かれる本体に塗り潰される
  // （初手でゴールが隠れる。2026-09-08 の動作確認）。
  // renderOrder を上げて必ず最後に描く。
  sprite.renderOrder = 1000;
  return sprite;
}

/** 面をまたぐ辺は角の外側へ膨らむベジェにする */
export function edgeCurve(pa, pb, na, nb) {
  if (na.equals(nb)) return new THREE.LineCurve3(pa.clone(), pb.clone());
  const mid = pa.clone().add(pb).multiplyScalar(0.5);
  mid.add(na.clone().add(nb).normalize().multiplyScalar(0.34));
  return new THREE.QuadraticBezierCurve3(pa.clone(), mid, pb.clone());
}

const COL = {
  // 今は進めないグミ。暗いと「触ってはいけない」感が強すぎるので明るい緑にし、
  // 向こう側が透けるよう不透明度も下げてある（下の 'default' 分岐）
  idle:     0x7fe86a,
  movable:  0xff92bd,
  visited:  0x5d4a80,
  goal:     0xffc23d,
  goalOpen: 0xffe07a,
  start:    0x3fe0b0,
  syrup:    0xffa62b,
  link:     0xa84a86,
};

/**
 * ステージ1面ぶんの three リソースを破棄する。
 * 「次ステージ構築時」と「アンマウント時」の両方から呼ぶため関数にまとめてある。
 * scene から外して Map もクリアするので、二重に呼んでも安全。
 */
function disposeStage(c) {
  if (!c) return;
  for (const g of c.gummies.values()) {
    c.cube.remove(g.mesh, g.hit);
    g.mesh.geometry.dispose(); g.mesh.material.dispose();
    g.hit.geometry.dispose(); g.hit.material.dispose();
  }
  c.gummies.clear();

  for (const l of c.links.values()) {
    c.cube.remove(l);
    l.geometry.dispose(); l.material.dispose();
  }
  c.links.clear();
  c.curves.clear();

  while (c.syrup.children.length) {
    const m = c.syrup.children.pop();
    m.geometry.dispose(); m.material.dispose();
  }

  if (c.core) {
    c.cube.remove(c.core);
    c.core.geometry.dispose(); c.core.material.dispose();
    c.core = null;
  }

  if (c.goalLabel) {
    c.scene.remove(c.goalLabel);
    // geometry は three が全 Sprite で共有しているので触らない。
    // ステージごとに作り直しているテクスチャとマテリアルだけ捨てる。
    c.goalLabel.material.map?.dispose();
    c.goalLabel.material.dispose();
    c.goalLabel = null;
    c.goalCell = null;
  }

  // 覚えていた進行方向は面ごとの座標に依存するので持ち越さない。
  // 次のステージのスタート地点では、また顔を見せる状態から始める。
  c.faceQ = null;
}

/* ============================================================
   3Dビュー
   ============================================================ */

/**
 * @param stage      generateStage() の結果
 * @param path       通過したセルの配列
 * @param movable    次に進めるセルの Set
 * @param cleared    クリア済みか
 * @param onPick     進めるグミがタップされた
 * @param onReject   進めないグミがタップされた
 * @param onLanded   キャラクターが移動先へ着地した（食べる音のトリガー）
 * @param shakeRef   { current: (cell)=>void } を受け取り、外から揺らせるようにする
 * @param hudOverlay HUD が盤面の上に重なっているか。true なら上下に UI ぶんの帯を空ける。
 *                   false（HUD を左右へ逃がしたPCレイアウト）なら縦をめいっぱい使う。
 */
export default function GummyBoard({
  stage, path, movable, cleared, onPick, onReject, onLanded, shakeRef, hudOverlay = true,
}) {
  const mountRef = useRef(null);
  const ctx = useRef(null);
  const live = useRef({});
  const pickRef = useRef(onPick);
  const rejectRef = useRef(onReject);
  const landedRef = useRef(onLanded);
  // fit() はマウント時に1回だけ作る関数なので、最新の値は ref 経由で読む
  const overlayRef = useRef(hudOverlay);

  pickRef.current = onPick;
  rejectRef.current = onReject;
  landedRef.current = onLanded;
  overlayRef.current = hudOverlay;
  live.current = { stage, path, movable, cleared, pathSet: new Set(path) };

  /* --- 初期化（マウント時1回） --- */
  useEffect(() => {
    const mount = mountRef.current;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // three r152+ は outputEncoding が廃止され outputColorSpace に置き換わっている
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    Object.assign(renderer.domElement.style, {
      position: 'absolute', top: '0', left: '0',
      width: '100%', height: '100%', display: 'block',
      touchAction: 'manipulation',
    });

    // 背景が明るい金色になったので、下からの反射光も暗い紫ではなく淡い黄にする
    scene.add(new THREE.HemisphereLight(0xfff6df, 0xffce6a, 0.95));
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(6, 9, 8);
    scene.add(key);
    const rimA = new THREE.PointLight(0x7de0ff, 0.9, 40);
    rimA.position.set(-8, 3, 4);
    scene.add(rimA);
    const rimB = new THREE.PointLight(0xff6ba8, 0.7, 40);
    rimB.position.set(3, -6, 6);
    scene.add(rimB);

    const cube = new THREE.Group();
    scene.add(cube);

    // キャラクター（グミを食べる子）
    const chara = new THREE.Group();
    const body = new THREE.Mesh(
      squircleGeometry(0.3, 2.6, 3),
      new THREE.MeshPhysicalMaterial({
        color: 0xfff4e2, roughness: 0.25, metalness: 0,
        clearcoat: 1, clearcoatRoughness: 0.15,
        emissive: 0xffd9b0, emissiveIntensity: 0.25,
      })
    );
    chara.add(body);
    const eyeGeo = new THREE.SphereGeometry(0.055, 12, 12);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x2a1330 });
    // 食いつくときに口を大きく開けるので、目は上へ逃がして細める。
    // 動かすために参照を持っておく。
    const eyes = [];
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(sx * 0.11, 0.05, 0.26);
      eye.userData.home = eye.position.clone();
      chara.add(eye);
      eyes.push(eye);
    }
    const cheekGeo = new THREE.SphereGeometry(0.05, 10, 10);
    const cheekMat = new THREE.MeshBasicMaterial({ color: 0xff9dbb, transparent: true, opacity: 0.75 });
    // グミを食べた直後は頬を膨らませる（ほおばった顔）。動かすので参照を持つ。
    const cheeks = [];
    for (const sx of [-1, 1]) {
      const ch = new THREE.Mesh(cheekGeo, cheekMat);
      ch.position.set(sx * 0.21, -0.05, 0.2);
      ch.userData.home = ch.position.clone();
      chara.add(ch);
      cheeks.push(ch);
    }
    /* 口。頭と同心の「表面パッチ」で作る。
       開き具合ごとにジオメトリを用意しておき、描画ループで差し替える。
       角度を毎フレーム作り直すのは無駄なので段階で持つ（MOUTH_STEPS 段）。
       body と同心なので、体が膨らんだら同じ倍率を掛けるだけで表面に乗り続ける。 */
    const mouthGeos = [];
    for (let i = 0; i < MOUTH_STEPS; i++) {
      const k = i / (MOUTH_STEPS - 1);          // 0=閉じている 1=大きく開く
      const halfAngle = THREE.MathUtils.degToRad(24 + 30 * k);
      const squashY = 0.16 + 0.78 * k;
      mouthGeos.push(mouthPatchGeometry(0.3 * 1.02, 2.6, halfAngle, squashY));
    }
    const mouth = new THREE.Mesh(
      mouthGeos[0],
      new THREE.MeshBasicMaterial({ color: 0x8a2338 })
    );
    // パッチは頭と同心。中心を口の位置（やや下）へ向けて倒す
    mouth.rotation.x = 0.38;
    // 頭の表面に沿っているので、体より後に描いて z-fighting を避ける
    mouth.renderOrder = 2;
    chara.add(mouth);

    // 舌。口の中に見えるものが無いと、開いても「暗い楕円が広がった」だけで
    // 口の中に見えなかった（2026-09-08 の指摘）。口の下寄りに小さく置き、
    // 口より少し手前に出すことで、開いた口の奥行きを見せる。
    const tongue = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xff6f8b })
    );
    tongue.position.set(0, -0.145, 0.30);
    tongue.scale.set(1.2, 0.5, 0.4);
    tongue.userData.home = tongue.position.clone();
    tongue.visible = false;
    chara.add(tongue);

    // 短い手足。付け根（肩・腰）を軸に振れるよう、Group を回してその中で下へずらす
    const limbGeo = new THREE.CapsuleGeometry(0.045, 0.10, 3, 8);
    const limbMat = new THREE.MeshPhysicalMaterial({
      color: 0xfff0da, roughness: 0.28, metalness: 0, clearcoat: 0.8,
    });
    const makeLimb = (x, y, z, tilt) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, z);
      pivot.rotation.z = tilt;
      const limb = new THREE.Mesh(limbGeo, limbMat);
      limb.position.y = -0.085;
      pivot.add(limb);
      chara.add(pivot);
      return pivot;
    };
    const armL = makeLimb(-0.31, -0.02, 0.08, 0.95);
    const armR = makeLimb(0.31, -0.02, 0.08, -0.95);
    const legL = makeLimb(-0.13, -0.26, 0.06, 0.12);
    const legR = makeLimb(0.13, -0.26, 0.06, -0.12);

    cube.add(chara);

    ctx.current = {
      scene, camera, renderer, cube, chara, body,
      // 口・手足。歩く動きと「パクパク」で毎フレーム触る
      parts: { mouth, tongue, armL, armR, legL, legR, eyes, cheeks },
      mouthGeos,
      gummies: new Map(), links: new Map(), curves: new Map(),
      syrup: new THREE.Group(), core: null, goalLabel: null, goalCell: null,
      // faceQ = 最後に進んだ向き（停止中もこれを向く）。chomp = 口を開ける残り
      faceQ: null, chomp: 0, suck: 0, hopSq: 1,
      // points/pad がある間は「実際のグミの位置」で詰めて合わせる（外接球より大きく写る）
      frame: { center: new THREE.Vector3(0.4, 0.4, 0.4), radius: 3.2, points: null },
      targetQ: new THREE.Quaternion(), move: null, clock: new THREE.Clock(),
    };
    cube.add(ctx.current.syrup);

    /* --- 盤面がUIに隠れず、縦横どちらでも収まるようにカメラを合わせる --- */
    const VIEW_DIR = new THREE.Vector3(7.6, 6.4, 8.6).normalize();
    // fit() の中で使い回す作業用ベクトル（毎フレームは呼ばれないが確保は1度でよい）
    const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
    const fit = () => {
      const c = ctx.current;
      if (!c) return;
      const w = mount.clientWidth, h = mount.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);

      // 上下のUIを避けた「実際に盤面を置ける帯」
      // HUD を左右へ逃がしたレイアウト（hudOverlay=false）では、上に状態メッセージぶんだけ
      // 空けて、あとは縦をめいっぱい盤面に使う。
      let top, bottom;
      if (overlayRef.current) {
        const chrome = Math.min(h * 0.42, 210);
        top = chrome * 0.28;
        bottom = chrome * 0.72;
      } else {
        // 左右にHUDを逃がしたPCレイアウト。全画面だと余白が目立つので、
        // 状態メッセージのぶんだけ空けて、残りはすべて盤面に使う
        top = Math.min(h * 0.06, 52);   // 状態メッセージの帯
        bottom = Math.min(h * 0.02, 18); // 下端に触れないための余白
      }
      const bandH = Math.max(h * 0.45, h - top - bottom);
      const shift = (top + bandH / 2) - h / 2;

      const { center, radius, points } = c.frame;
      const vFov = (c.camera.fov * Math.PI) / 180;
      const tanV0 = Math.tan(vFov / 2);
      const halfV = Math.atan(tanV0 * (bandH / h));   // 帯の高さぶんだけ使える
      const halfH = Math.atan(tanV0 * (w / h));       // 横は画面幅ぶん使える

      // 外接球でカメラを引くと、立方体の見かけの大きさに対して常に3割ほど余る。
      // グミを大きく見せたいので、実際のグミの位置をカメラ平面へ落として、
      // 縦横それぞれで必要な距離を求める（＝ぴったり収まる最短距離）。
      let dist;
      if (points && points.length) {
        const tanH = Math.tan(halfH), tanVv = Math.tan(halfV);
        // カメラ基準の3軸。zAxis は中心 → カメラの向き
        const zAxis = VIEW_DIR;
        const xAxis = tmpA.set(0, 1, 0).cross(zAxis).normalize();
        const yAxis = tmpB.copy(zAxis).cross(xAxis);   // 単位ベクトル
        dist = 0;
        for (const { v, pad: p0 } of points) {
          const d = tmpC.copy(v).sub(center);
          const depth = d.dot(zAxis);                  // 手前にあるものほど大きく写る
          dist = Math.max(
            dist,
            depth + (Math.abs(d.dot(xAxis)) + p0) / tanH,
            depth + (Math.abs(d.dot(yAxis)) + p0) / tanVv
          );
        }
      } else {
        // ステージ構築前（初回 fit）は外接球で当てておく
        dist = (radius * 1.06) / Math.sin(Math.min(halfV, halfH));
      }

      c.camera.aspect = w / h;
      c.camera.setViewOffset(w, h, 0, -shift, w, h);
      c.camera.position.copy(center).addScaledVector(VIEW_DIR, dist);
      c.camera.lookAt(center);
      c.camera.updateProjectionMatrix();
    };
    ctx.current.fit = fit;
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(mount);
    window.addEventListener('orientationchange', fit);

    /* --- タップ判定 --- */
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const onDown = (ev) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      ray.setFromCamera(ndc, camera);
      const targets = [...ctx.current.gummies.values()].map((g) => g.hit);
      const hits = ray.intersectObjects(targets, false);
      if (!hits.length) return;
      const cellKey = hits[0].object.userData.cell;
      if (live.current.movable.has(cellKey)) pickRef.current?.(cellKey);
      else rejectRef.current?.(cellKey);
    };
    renderer.domElement.addEventListener('pointerdown', onDown);

    /* --- マウスを乗せたグミの見分け ---
       進めるグミの上ではカーソルを指の形にする。マウス操作の当日構成では、
       「押せる場所」を色と光だけで判断させずに済む（2026-09-08 の動作確認）。
       タップ判定と同じレイキャストを使い、判定が2通りに分かれないようにする。 */
    const hoverCell = (ev) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      ray.setFromCamera(ndc, camera);
      const targets = [...ctx.current.gummies.values()].map((g) => g.hit);
      const hits = ray.intersectObjects(targets, false);
      return hits.length ? hits[0].object.userData.cell : null;
    };
    let lastCursor = '';
    const onMove = (ev) => {
      // タッチでは hover が無く、指を離した位置に指カーソルが残るだけなので触らない
      if (ev.pointerType && ev.pointerType !== 'mouse') return;
      const cell = hoverCell(ev);
      const want = cell && live.current.movable.has(cell) ? 'pointer' : 'default';
      if (want !== lastCursor) {
        lastCursor = want;
        renderer.domElement.style.cursor = want;
      }
    };
    const onLeave = () => {
      lastCursor = 'default';
      renderer.domElement.style.cursor = 'default';
    };
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerleave', onLeave);

    /* --- 描画ループ --- */
    let raf;
    const tmpV = new THREE.Vector3();
    const tmpN = new THREE.Vector3();
    // キャラの向きと GOAL 札の位置決め用。毎フレーム使うので確保は1度だけ
    const dirF = new THREE.Vector3();
    const dirU = new THREE.Vector3();
    const dirM = new THREE.Matrix4();
    const dirQ = new THREE.Quaternion();
    const leanQ = new THREE.Quaternion();
    const ORIGIN = new THREE.Vector3();
    const AXIS_X = new THREE.Vector3(1, 0, 0);
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const c = ctx.current;
      const dt = Math.min(c.clock.getDelta(), 0.05);
      const t = c.clock.elapsedTime;

      // アクティブ面へゆっくり傾ける
      c.cube.quaternion.slerp(c.targetQ, 1 - Math.pow(0.001, dt));

      // グミの状態を補間
      for (const g of c.gummies.values()) {
        const u = g.mesh.userData;
        u.cur.lerp(u.want, 1 - Math.pow(0.0005, dt));
        g.mesh.material.color.copy(u.cur);
        g.mesh.material.emissive.copy(u.wantEmissive);
        // 進めるグミは明るさも脈打たせる。大きさだけ 5% 揺らしていた頃は
        // 「光っている」と読み取れず、進める先が初見で分からなかった
        // （2026-09-08 の動作確認）。光量を動かすほうが目に付く。
        const glow = (u.state === 'movable' || u.state === 'goalOpen')
          ? u.wantEmissiveI * (1 + 0.45 * Math.sin(t * 4.2 + u.phase))
          : u.wantEmissiveI;
        g.mesh.material.emissiveIntensity += (glow - g.mesh.material.emissiveIntensity) * Math.min(1, dt * 9);
        g.mesh.material.opacity += (u.wantOpacity - g.mesh.material.opacity) * Math.min(1, dt * 9);

        let s = u.wantScale;
        if (u.state === 'movable' || u.state === 'goalOpen') s *= 1 + 0.11 * Math.sin(t * 4.2 + u.phase);
        if (u.pop > 0) { u.pop = Math.max(0, u.pop - dt * 3.2); s *= 1 + Math.sin(u.pop * Math.PI) * 0.42; }
        u.scale += (s - u.scale) * Math.min(1, dt * 14);
        g.mesh.scale.setScalar(u.scale);

        if (u.shake > 0) {
          u.shake = Math.max(0, u.shake - dt * 3.4);
          const a = u.shake * 0.09;
          g.mesh.position.copy(u.home).add(
            tmpV.set(Math.sin(t * 44) * a, Math.cos(t * 39) * a, Math.sin(t * 50) * a)
          );
        } else {
          g.mesh.position.copy(u.home);
        }
      }

      // GOAL の札。画面上でゴールのグミの真上に来るよう置き直す。
      // カメラのワールド行列の Y 列が「画面の上」なので、それだけ持ち上げる。
      // 盤面がどの面を向いていても、札は常にゴールの真上に立つ。
      const gLabel = c.goalLabel;
      const gGummy = c.goalCell ? c.gummies.get(c.goalCell) : null;
      if (gLabel && gGummy) {
        // renderer が行列を更新するのは描画時なので、ここで先に更新しておく。
        // でないとキューブの傾きが1フレーム遅れて札がずれる。
        c.camera.updateMatrixWorld();
        c.cube.updateMatrixWorld(true);
        gGummy.mesh.getWorldPosition(dirF);
        dirU.setFromMatrixColumn(c.camera.matrixWorld, 1).normalize();
        // ゆっくり上下させて目を引く
        gLabel.position.copy(dirF).addScaledVector(dirU, 0.95 + Math.sin(t * 1.9) * 0.07);
        // ゴールに手が届いた（＝残り1つ）ときは、札を大きく脈打たせて知らせる。
        // 以前は画面中央に「あと1つ！ GOAL へ」の帯を出していたが、
        // それが GOAL 札そのものに被っていた（2026-09-08 の指摘）。
        // 文字を増やすのではなく、GOAL 側を膨らませて気づかせる。
        const k = live.current.movable.has(c.goalCell)
          ? 1.32 + 0.13 * Math.sin(t * 6.2)
          : 1;
        gLabel.scale.set(gLabel.userData.base.x * k, gLabel.userData.base.y * k, 1);
      }

      // キャラクター移動
      const st = live.current;
      if (c.move) {
        c.move.t += dt / c.move.dur;
        const p = Math.min(1, c.move.t);
        const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        c.move.curve.getPoint(c.move.rev ? 1 - ease : ease, tmpV);
        tmpN.copy(c.move.n0).lerp(c.move.n1, ease).normalize();
        const hop = Math.sin(Math.PI * ease) * 0.4;
        c.chara.position.copy(tmpV).addScaledVector(tmpN, 0.42 + hop);
        // 跳ねているあいだの伸び。体のスケールは下の表情処理でまとめて設定するので、
        // ここでは値だけ渡す（直接書くと上書きされる）。
        c.hopSq = 1 + Math.sin(Math.PI * ease) * 0.16;
        // 口を開けるのは移動の**後半**。着いた瞬間に膨らませたいので、
        // 吸い込みは予備動作として着く前に済ませる
        // （以前は着いてから開け始めたため、膨らみが移動の後にずれていた。
        //  2026-09-08 の指摘）。
        c.suck = Math.max(0, Math.min(1, (p - 0.4) / 0.6));
        if (p >= 1) {
          const g = c.gummies.get(c.move.to);
          if (g) g.mesh.userData.pop = 1;
          const crossed = c.move.cross;
          c.move = null;
          // 着いた瞬間に飲み込んで膨らむ。口は閉じる
          c.chomp = 1;
          c.suck = 0;
          landedRef.current?.(crossed);
        }
      } else if (st.stage) {
        const cur = st.path[st.path.length - 1];
        const pos = st.stage.pos.get(cur);
        const n = st.stage.nrm.get(cur);
        if (pos) {
          const bob = Math.sin(t * 2.6) * 0.035;
          // 食いついた瞬間はグミへ少し沈み込み、離れぎわに跳ね上がる
          // 食べた瞬間にグミへ沈み込んで戻る（膨らみと同じ波を使う）
          const dive = -0.16 * (c.chomp > 0 ? Math.sin(c.chomp * Math.PI / 2) : 0);
          c.chara.position.copy(pos).addScaledVector(n, 0.44 + bob + dive);
        }
        c.hopSq += (1 - c.hopSq) * Math.min(1, dt * 8);
      }

      /* --- 食いつく動き ---
         着いた瞬間に「口を大きく開ける・体を潰す・手を上げる・沈んで跳ねる」を
         まとめて出す。移動中の伸縮だけだと淡々と移るように見えたため
         （2026-09-08 の動作確認）。chomp は 1 → 0 へ減っていく残り時間。 */
      const P = c.parts;
      if (c.chomp > 0) {
        c.chomp = Math.max(0, c.chomp - dt * 2.2);
      }
      /* 2つの波。
           open : 移動の後半。口を開けてグミへ向かう（予備動作）
           puff : 着いた瞬間から。体と頬が膨らんで、しぼむ
         着地で suck を 0・chomp を 1 にするので、
         **口が閉じるのと膨らみ始めるのが同じ瞬間**になる。 */
      const open = c.move ? (c.suck || 0) : 0;
      const puff = c.chomp > 0 ? Math.sin(c.chomp * Math.PI / 2) : 0;
      const bite = Math.max(open, puff);

      /* 体の膨らみ。
         ほおばりで丸く膨らみ、吸い込みで縦に潰れる。
         🔴 **顔の部品は body の子ではなく chara の兄弟**なので、
         body だけ大きくすると目・口・頬が体に飲み込まれる。
         下で部品の位置を同じ倍率で押し出して、表面に乗せ続ける。 */
      const grow = 1 + 0.45 * puff;                 // ほおばりの膨らみ
      const sqz = (1 - 0.20 * open) * (c.hopSq ?? 1); // 吸い込みの潰れ × 跳ねの伸び
      const bodyY = grow * sqz;
      const bodyXZ = grow / Math.sqrt(sqz);
      c.body.scale.set(bodyXZ, bodyY, bodyXZ);

      /** 顔の部品を、膨らんだ体の表面へ押し出す */
      const rideOn = (obj, dy = 0, dz = 0) => {
        const home = obj.userData.home;
        obj.position.set(
          home.x * bodyXZ,
          home.y * bodyY + dy,
          home.z * bodyXZ + dz
        );
      };

      /* 口。頭と同心のパッチなので、body と同じ倍率を掛けるだけで表面に乗る。
         開き具合は段階のジオメトリを差し替えて表す（角度を毎フレーム作り直さない）。
         平常時もゆっくり開閉させて、生きている感じを出す。 */
      const mouthOpen = bite > 0
        ? open
        : 0.08 * (0.5 + 0.5 * Math.sin(t * 2.2));
      const gi = Math.min(
        MOUTH_STEPS - 1,
        Math.max(0, Math.round(mouthOpen * (MOUTH_STEPS - 1)))
      );
      if (c.mouthGeos[gi] !== P.mouth.geometry) P.mouth.geometry = c.mouthGeos[gi];
      P.mouth.scale.set(bodyXZ, bodyY, bodyXZ);

      // 舌。開いているあいだだけ、口の中に見せる
      P.tongue.visible = open > 0.25;
      if (P.tongue.visible) {
        P.tongue.scale.set(1.2 * open, 0.5 * open, 0.4);
        rideOn(P.tongue, 0.02 * open, 0.02 * open);
      }

      // 頬。ほおばっているあいだ大きく張り出す（カービィのイメージ）
      for (const ch of P.cheeks) {
        ch.scale.setScalar(1 + 2.0 * puff);
        rideOn(ch);
      }

      // 目。口を開けるあいだは上へ逃がし、ほおばるあいだは細めて笑顔にする
      for (const eye of P.eyes) {
        rideOn(eye, 0.05 * open);
        eye.scale.set(1, 1 - 0.45 * open - 0.35 * puff, 1);
      }

      // 移動中だけ手足を振る。止まったらゆっくり元の位置へ戻す。
      // 食いつく瞬間だけは、両手を勢いよく前へ出す。
      const swing = c.move ? Math.sin(t * 16) * 0.85 : 0;
      const k = Math.min(1, dt * 16);
      // 吸い込むときに手を前へ出す（ほおばっている間は下ろす）
      const armBite = -1.5 * open;
      P.legL.rotation.x += (swing - P.legL.rotation.x) * k;
      P.legR.rotation.x += (-swing - P.legR.rotation.x) * k;
      P.armL.rotation.x += ((armBite || -swing * 0.8) - P.armL.rotation.x) * k;
      P.armR.rotation.x += ((armBite || swing * 0.8) - P.armR.rotation.x) * k;

      // キャラの向き。
      //   移動中     : 進む方向を向く
      //   移動したあと: **その方向を向いたまま**（顔をカメラへ戻さない）
      //   スタート地点: カメラを向いて顔を見せる
      // 以前は常にカメラを向いていたため、どこへ向かっているのか分からず
      // 「ずっと外側を向いている」ように見えた（2026-09-08 の動作確認）。
      // 吸い込む瞬間だけ前へ乗り出す。ほおばっている間は起き上がる。
      // 目標の向きへ掛けるだけなので角度が累積しない
      leanQ.setFromAxisAngle(AXIS_X, 0.5 * open - 0.12 * puff);
      if (c.move) {
        // 曲線の接線＝進行方向。逆走のときは向きが反転する
        c.move.curve.getTangent(c.move.rev ? 1 - c.move.t : c.move.t, dirF);
        if (c.move.rev) dirF.negate();
        dirU.copy(tmpN);                        // 立っている面の法線を上にする
        dirF.projectOnPlane(dirU);              // 面に沿った成分だけ残す
        if (dirF.lengthSq() > 1e-6) {
          dirF.normalize();
          // lookAt(eye, target, up) は +Z が target → eye を向く。
          // 顔（目・口）は +Z 側にあるので、進行方向を eye に置く。
          dirM.lookAt(dirF, ORIGIN, dirU);
          dirQ.setFromRotationMatrix(dirM);
          // 進み終わったあとも保つので、最後の向きを覚えておく（前傾は含めない）
          c.faceQ = (c.faceQ || new THREE.Quaternion()).copy(dirQ);
          c.chara.quaternion.slerp(dirQ.multiply(leanQ), Math.min(1, dt * 12));
        }
      } else if (c.faceQ && live.current.path.length > 1) {
        dirQ.copy(c.faceQ).multiply(leanQ);
        c.chara.quaternion.slerp(dirQ, Math.min(1, dt * 12));
      } else {
        // まだ1歩も進んでいない（スタート地点）。ここだけ顔を見せる
        c.chara.lookAt(c.cube.worldToLocal(c.camera.position.clone()));
      }

      renderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      // 終日運用でWebGLコンテキストとGPUリソースが積み上がらないよう明示的に解放する。
      // ステージ側の資源は [stage] effect の cleanup が既に片付けているので、
      // ここではライトやキャラクターなど残りを掃除する。
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) m.dispose();
        }
      });
      // 口の段階ジオメトリ。いま使っている1つは上の traverse が捨てるが、
      // 残りは scene に載っていないので個別に捨てる
      for (const g of mouthGeos) g.dispose();
      ro.disconnect();
      window.removeEventListener('orientationchange', fit);
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerleave', onLeave);
      renderer.forceContextLoss();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      ctx.current = null;
    };
  }, []);

  /* --- レイアウト（HUDの置き場所）が変わったらカメラを合わせ直す --- */
  // ResizeObserver は「同じサイズのまま帯の取り方だけ変わる」場合に発火しないため、
  // ここで明示的に fit() を呼ぶ。
  useEffect(() => { ctx.current?.fit?.(); }, [hudOverlay]);

  /* --- ステージ構築 --- */
  useEffect(() => {
    const c = ctx.current;
    if (!c || !stage) return;
    const { N } = stage;

    // 旧ステージを破棄
    disposeStage(c);

    // 内側のゼリーコア。
    // 紫にすると背景（紫のグラデーション）に溶けてキューブの形が分からなくなるため、
    // 背景から離れた青系にして輪郭が立つようにしている。
    c.core = new THREE.Mesh(
      squircleGeometry(N / 2 - 0.09, 7, 3),
      new THREE.MeshPhysicalMaterial({
        color: 0x2f6be0, roughness: 0.3, metalness: 0,
        clearcoat: 0.9, transparent: true, opacity: 0.94,
        emissive: 0x0b2a6b, emissiveIntensity: 0.35,
      })
    );
    c.cube.add(c.core);

    // グミ本体
    const gGeo = squircleGeometry(0.4, 4, 3);
    const goalGeo = squircleGeometry(0.46, 1.7, 3); // ゴールだけ尖ったシルエット
    const hitGeo = new THREE.SphereGeometry(0.48, 10, 10);

    for (const cell of stage.cells) {
      const isGoal = cell === stage.goal;
      const mat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(COL.idle), roughness: 0.12, metalness: 0,
        clearcoat: 1, clearcoatRoughness: 0.08,
        transparent: true, opacity: 0.9,
        emissive: new THREE.Color(0x000000), emissiveIntensity: 0,
      });
      const mesh = new THREE.Mesh(isGoal ? goalGeo : gGeo, mat);
      mesh.position.copy(stage.pos.get(cell));
      mesh.userData = {
        cell, isGoal, home: stage.pos.get(cell).clone(),
        cur: new THREE.Color(COL.idle), want: new THREE.Color(COL.idle),
        wantEmissive: new THREE.Color(0x000000), wantEmissiveI: 0,
        wantOpacity: 0.9, wantScale: 1, scale: 1,
        phase: Math.random() * 6.28, pop: 0, shake: 0, state: 'idle',
      };
      if (isGoal) mesh.rotation.set(0.4, 0.6, 0.2);
      c.cube.add(mesh);

      const hit = new THREE.Mesh(
        hitGeo,
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
      );
      hit.position.copy(mesh.position);
      hit.userData.cell = cell;
      c.cube.add(hit);

      c.gummies.set(cell, { mesh, hit });
    }

    // ゴールの「GOAL」札。
    // cube の子にして面の法線方向へ置くと、面によって真横や真下に回り込んで
    // 位置が読めなかった（2026-09-08 の動作確認）。scene 直下に付けて、
    // 毎フレーム「画面上でゴールの真上」へ置き直す（下の描画ループ）。
    // links には入れない。あちらは辺の濃さを id から一括で書き換えるループが回るうえ、
    // Sprite の geometry は three が全 Sprite で共有していて dispose すると以後が壊れる。
    const goalLabel = goalLabelSprite();
    goalLabel.userData.base = goalLabel.scale.clone();
    c.scene.add(goalLabel);
    c.goalLabel = goalLabel;
    c.goalCell = stage.goal;

    // スタート地点のリング
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.5, 0.045, 8, 28),
      new THREE.MeshBasicMaterial({ color: COL.start, transparent: true, opacity: 0.85 })
    );
    const sp = stage.pos.get(stage.start), sn = stage.nrm.get(stage.start);
    ring.position.copy(sp).addScaledVector(sn, -0.02);
    ring.lookAt(sp.clone().add(sn));
    c.cube.add(ring);
    c.links.set('__ring', ring);

    // 接続表現（面跨ぎは角を回り込む）
    const seen = new Set();
    for (const a of stage.cells) {
      for (const b of stage.adj.get(a)) {
        const id = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(id)) continue;
        seen.add(id);
        // 曲線の向きは常に id の左→右。移動時はここを基準に順逆を判定する
        const [ka, kb] = id.split('|');
        const curve = edgeCurve(stage.pos.get(ka), stage.pos.get(kb), stage.nrm.get(ka), stage.nrm.get(kb));
        c.curves.set(id, curve);
        const tube = new THREE.Mesh(
          new THREE.TubeGeometry(curve, 12, 0.075, 6, false),
          new THREE.MeshPhysicalMaterial({
            color: COL.link, roughness: 0.2, clearcoat: 1,
            transparent: true, opacity: 0.4,
          })
        );
        tube.userData.id = id;
        c.cube.add(tube);
        c.links.set(id, tube);
      }
    }

    // 実際に置かれたグミから外接球を求めてカメラを合わせる
    const box = new THREE.Box3();
    for (const cell of stage.cells) box.expandByPoint(stage.pos.get(cell));
    box.expandByScalar(0.62);              // グミ半径＋キャラの浮き
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    // キューブは原点まわりに最大0.19rad傾くので、その振れ幅を余白に足す
    let maxR = 0;
    for (const cell of stage.cells) maxR = Math.max(maxR, stage.pos.get(cell).length());
    c.frame.center.copy(sphere.center);
    c.frame.radius = sphere.radius + maxR * 0.2;
    // 実測フィット用。pad はグミ半径＋キャラの浮き＋キューブの傾きぶんの振れ幅。
    // 傾きは最大 0.19rad だが、振れるのは奥行き方向が主で画面上の見かけはもっと小さい。
    // ここを大きく取りすぎると全画面で余白が目立つため、実際に切れない範囲まで詰めてある。
    // 収めたい点と、その点ごとの余白。
    // グミ: 球の半径＋キャラクターの浮き＋傾きの振れ幅。
    // コアの角: キャラクターは乗らないので、傾きの振れ幅だけでよい（ここを共通の
    //          大きい余白にすると、全画面で見たときの余白が目立つ）。
    const swing = 0.12;   // キューブの傾き（最大0.19rad）で画面上に出る振れ幅の割合
    c.frame.points = stage.cells.map((cell) => {
      const v = stage.pos.get(cell).clone();
      return { v, pad: 0.62 + v.length() * swing };
    });
    // 🔴 グミの位置だけで合わせると、内側のゼリーコアの「角」がはみ出して切れる。
    //    コアはほぼ立方体（squircle e=7）なので、その8隅も収める対象に入れる。
    const coreHalf = N / 2 - 0.09;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const v = new THREE.Vector3(sx * coreHalf, sy * coreHalf, sz * coreHalf);
          c.frame.points.push({ v, pad: 0.06 + v.length() * swing });
        }
      }
    }
    c.fit?.();

    c.cube.quaternion.identity();
    c.move = null;

    // アンマウント時にもこのステージぶんのジオメトリ／マテリアルを解放する。
    // 「次のステージ生成時にだけ破棄」だと、プレイ終了ごとに1ステージぶんが漏れ、
    // 終日運用で GPU メモリと WebGL コンテキストが積み上がる。
    return () => disposeStage(c);
  }, [stage]);

  /* --- 状態同期（毎手） --- */
  const prevLen = useRef(0);
  const prevStage = useRef(null);
  useEffect(() => {
    const c = ctx.current;
    if (!c || !stage || !c.gummies.size) return;
    // ステージが差し替わった直後は「進んだ」と誤判定しないようにリセットする
    if (prevStage.current !== stage) {
      prevStage.current = stage;
      prevLen.current = 0;
    }
    const cur = path[path.length - 1];
    const done = new Set(path);

    for (const [cell, g] of c.gummies) {
      const u = g.mesh.userData;
      let state = 'idle';
      if (cell === cur) state = 'current';
      else if (done.has(cell)) state = 'visited';
      else if (movable.has(cell)) state = u.isGoal ? 'goalOpen' : 'movable';
      else if (u.isGoal) state = 'goal';

      const wasVisited = u.state === 'visited';
      u.state = state;

      switch (state) {
        case 'visited':
          u.want.setHex(COL.visited); u.wantEmissive.setHex(0x000000);
          u.wantEmissiveI = 0; u.wantOpacity = 0.42; u.wantScale = 0.58; break;
        case 'current':
          u.want.setHex(u.isGoal ? COL.goalOpen : COL.visited);
          u.wantEmissive.setHex(0x000000); u.wantEmissiveI = 0;
          u.wantOpacity = 0.5; u.wantScale = 0.66; break;
        case 'movable':
          u.want.setHex(COL.movable); u.wantEmissive.setHex(0xff4f8f);
          u.wantEmissiveI = 0.85; u.wantOpacity = 1; u.wantScale = 1.12; break;
        case 'goalOpen':
          u.want.setHex(COL.goalOpen); u.wantEmissive.setHex(0xffb400);
          u.wantEmissiveI = 1.05; u.wantOpacity = 1; u.wantScale = 1.2; break;
        case 'goal':
          // まだ届かないゴール。最初から探せるよう、待機中でも少し光らせておく
          u.want.setHex(COL.goal); u.wantEmissive.setHex(0xffa000);
          u.wantEmissiveI = 0.45; u.wantOpacity = 1; u.wantScale = 1.06; break;
        default:
          // 今は進めないグミ。色は明るい緑のまま残す（暗くすると
          // 「触ってはいけない」感が強すぎる）。代わりに発光を消し、
          // 透かして少し小さくして、進めるグミとの差を明るさと大きさで付ける。
          u.want.setHex(COL.idle); u.wantEmissive.setHex(0x1f7a12);
          u.wantEmissiveI = 0; u.wantOpacity = 0.48; u.wantScale = 0.94;
      }
      // Undoで戻ってきたグミは「ぽんっ」と復活
      if (wasVisited && state !== 'visited' && state !== 'current') u.pop = 1;
    }

    // 接続の強調（現在位置から進める辺だけ濃く）
    for (const [id, obj] of c.links) {
      if (id === '__ring') continue;
      const [a, b] = id.split('|');
      const hot = (a === cur && movable.has(b)) || (b === cur && movable.has(a));
      const dim = done.has(a) && done.has(b);
      obj.material.opacity = hot ? 0.75 : dim ? 0.12 : 0.4;
    }

    // シロップの軌跡を引き直す
    while (c.syrup.children.length) {
      const m = c.syrup.children.pop();
      m.geometry.dispose(); m.material.dispose();
    }
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const id = a < b ? `${a}|${b}` : `${b}|${a}`;
      const curve = c.curves.get(id);
      if (!curve) continue;
      c.syrup.add(new THREE.Mesh(
        new THREE.TubeGeometry(curve, 14, 0.135, 8, false),
        new THREE.MeshPhysicalMaterial({
          color: COL.syrup, roughness: 0.15, clearcoat: 1,
          emissive: 0x7a3a00, emissiveIntensity: 0.35,
          transparent: true, opacity: 0.95,
        })
      ));
    }

    // 面の向きに合わせてキューブを傾ける
    const face = cur[0];
    const e = face === 'F' ? new THREE.Euler(0, 0.19, 0)
      : face === 'R' ? new THREE.Euler(0, -0.19, 0)
      : new THREE.Euler(0.17, 0, 0);
    c.targetQ.setFromEuler(e);

    // Undo で戻ったときは、進行中だった移動を音を鳴らさずに破棄する
    // （放置すると取り消したはずのセルへ着地して「食べた音」が鳴る）
    if (path.length < prevLen.current) c.move = null;

    // 進んだときだけ移動アニメーション
    if (path.length > prevLen.current && path.length > 1) {
      const from = path[path.length - 2];
      const id = from < cur ? `${from}|${cur}` : `${cur}|${from}`;
      const curve = c.curves.get(id);
      if (curve) {
        // 前の移動がまだ途中なら、その分の「食べた音」を取りこぼさないよう先に鳴らす
        if (c.move) landedRef.current?.(c.move.cross);
        const cross = from[0] !== cur[0];
        c.move = {
          curve, from, to: cur, t: 0, dur: cross ? 0.42 : 0.28, cross,
          rev: !id.startsWith(`${from}|`), // 曲線の終点側から出発する場合は逆走
          n0: stage.nrm.get(from).clone(), n1: stage.nrm.get(cur).clone(),
        };
      }
    }
    prevLen.current = path.length;
  }, [stage, path, movable]);

  // 無効タップのフィードバック（外部から cell を指定して揺らす）
  useEffect(() => {
    if (!shakeRef) return;
    shakeRef.current = (cell) => {
      const g = ctx.current?.gummies.get(cell);
      if (g) g.mesh.userData.shake = 1;
    };
    return () => { shakeRef.current = null; };
  }, [shakeRef]);

  return <div ref={mountRef} className="absolute inset-0" />;
}
