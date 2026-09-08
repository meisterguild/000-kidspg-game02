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
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(sx * 0.11, 0.05, 0.26);
      chara.add(eye);
    }
    const cheekGeo = new THREE.SphereGeometry(0.05, 10, 10);
    const cheekMat = new THREE.MeshBasicMaterial({ color: 0xff9dbb, transparent: true, opacity: 0.75 });
    for (const sx of [-1, 1]) {
      const ch = new THREE.Mesh(cheekGeo, cheekMat);
      ch.position.set(sx * 0.21, -0.05, 0.2);
      chara.add(ch);
    }
    // 口。いつもゆっくり開閉させる（描画ループで scale.y を動かす）
    const mouth = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0x8a2338 })
    );
    mouth.position.set(0, -0.11, 0.275);
    mouth.scale.set(1.45, 0.55, 0.5);
    chara.add(mouth);

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
      parts: { mouth, armL, armR, legL, legR },
      gummies: new Map(), links: new Map(), curves: new Map(),
      syrup: new THREE.Group(), core: null,
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

    /* --- 描画ループ --- */
    let raf;
    const tmpV = new THREE.Vector3();
    const tmpN = new THREE.Vector3();
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
        g.mesh.material.emissiveIntensity += (u.wantEmissiveI - g.mesh.material.emissiveIntensity) * Math.min(1, dt * 9);
        g.mesh.material.opacity += (u.wantOpacity - g.mesh.material.opacity) * Math.min(1, dt * 9);

        let s = u.wantScale;
        if (u.state === 'movable' || u.state === 'goalOpen') s *= 1 + 0.055 * Math.sin(t * 5.2 + u.phase);
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
        const sq = 1 + Math.sin(Math.PI * ease) * 0.16;
        c.body.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
        if (p >= 1) {
          const g = c.gummies.get(c.move.to);
          if (g) g.mesh.userData.pop = 1;
          const crossed = c.move.cross;
          c.move = null;
          landedRef.current?.(crossed);
        }
      } else if (st.stage) {
        const cur = st.path[st.path.length - 1];
        const pos = st.stage.pos.get(cur);
        const n = st.stage.nrm.get(cur);
        if (pos) {
          const bob = Math.sin(t * 2.6) * 0.035;
          c.chara.position.copy(pos).addScaledVector(n, 0.44 + bob);
        }
        c.body.scale.lerp(tmpV.set(1, 1, 1), Math.min(1, dt * 8));
      }

      // 口はいつもゆっくりパクパクさせる（止まっていても生きている感じを出す）
      const P = c.parts;
      P.mouth.scale.y = 0.26 + 0.36 * (0.5 + 0.5 * Math.sin(t * 2.2));

      // 移動中だけ手足を振る。止まったらゆっくり元の位置へ戻す
      const swing = c.move ? Math.sin(t * 16) * 0.85 : 0;
      const k = Math.min(1, dt * 16);
      P.legL.rotation.x += (swing - P.legL.rotation.x) * k;
      P.legR.rotation.x += (-swing - P.legR.rotation.x) * k;
      P.armL.rotation.x += (-swing * 0.8 - P.armL.rotation.x) * k;
      P.armR.rotation.x += (swing * 0.8 - P.armR.rotation.x) * k;

      // 常にカメラを向く
      c.chara.lookAt(c.cube.worldToLocal(c.camera.position.clone()));

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
      ro.disconnect();
      window.removeEventListener('orientationchange', fit);
      renderer.domElement.removeEventListener('pointerdown', onDown);
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
          u.wantEmissiveI = 0.55; u.wantOpacity = 0.95; u.wantScale = 1.06; break;
        case 'goalOpen':
          u.want.setHex(COL.goalOpen); u.wantEmissive.setHex(0xffb400);
          u.wantEmissiveI = 0.9; u.wantOpacity = 1; u.wantScale = 1.15; break;
        case 'goal':
          u.want.setHex(COL.goal); u.wantEmissive.setHex(0xffa000);
          u.wantEmissiveI = 0.3; u.wantOpacity = 0.95; u.wantScale = 1.02; break;
        default:
          // 今は進めないグミ。明るい緑＋少し透けさせて、
          // 「行けるグミ（光るピンク）」との差を色でも明るさでも付ける
          u.want.setHex(COL.idle); u.wantEmissive.setHex(0x1f7a12);
          u.wantEmissiveI = 0.12; u.wantOpacity = 0.62; u.wantScale = 1;
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
