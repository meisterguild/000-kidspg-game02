// ミニ版が実際に使う three の部品だけを束ねる（tree-shaking のための入口）。
// 実機版 kidspg-game-2026 と同じ three 0.180.0 から作る。
import {
  Scene, PerspectiveCamera, WebGLRenderer,
  HemisphereLight, DirectionalLight, PointLight,
  Group, Mesh, Sprite,
  IcosahedronGeometry, SphereGeometry, CapsuleGeometry, TorusGeometry, TubeGeometry, PlaneGeometry,
  MeshPhysicalMaterial, MeshBasicMaterial, SpriteMaterial, ShaderMaterial,
  CanvasTexture, SRGBColorSpace,
  Color, Vector2, Vector3, Quaternion, Matrix4, Euler,
  Raycaster, Box3, Sphere, Clock,
  LineCurve3, QuadraticBezierCurve3, MathUtils,
} from 'three';

window.THREE = {
  Scene, PerspectiveCamera, WebGLRenderer,
  HemisphereLight, DirectionalLight, PointLight,
  Group, Mesh, Sprite,
  IcosahedronGeometry, SphereGeometry, CapsuleGeometry, TorusGeometry, TubeGeometry, PlaneGeometry,
  MeshPhysicalMaterial, MeshBasicMaterial, SpriteMaterial, ShaderMaterial,
  CanvasTexture, SRGBColorSpace,
  Color, Vector2, Vector3, Quaternion, Matrix4, Euler,
  Raycaster, Box3, Sphere, Clock,
  LineCurve3, QuadraticBezierCurve3, MathUtils,
};
