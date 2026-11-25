/**
 * 晝夜光影模組 DayNight Lighting  ── for Three.js r155+（以 r160 撰寫）
 * 從「燕尾脊宗祠／長頸龍遊戲場」原生 WebGL2 版本移植的光影系統。
 *
 * 包含：
 *   ‧ 太陽／月亮平行光 + PCF 柔和陰影（陰影範圍自動貼合場景）
 *   ‧ 天空／地面半球環境光（降飽和，避免整片偏藍）
 *   ‧ 程式化天空：漸層、太陽光暈、雲、星星、月亮
 *   ‧ 白天 → 黃昏 → 夜晚 三組關鍵影格平滑內插（光色、角度、環境色、霧、曝光、Bloom）
 *   ‧ 夜間點光源（路燈、燈籠）與自發光材質（窗戶、燈泡）隨夜晚係數亮起
 *   ‧ 後處理：MSAA 4× HDR → GTAO → Bloom → 移軸景深 → ACES → 調色（飽和、暗角、抖色）
 *   ‧ 選用：夜晚螢火蟲
 *
 * 用法：
 *   import { createDayNightLighting } from './daynight-lighting.js';
 *   const lighting = createDayNightLighting(renderer, scene, camera, {
 *     bounds: { center: [0, 0, 0], radius: 20 },        // 場景中心與半徑（決定陰影、霧、AO 尺度）
 *     lamps: [{ position: [3, 4, 2], color: 0xffb877, intensity: 24, distance: 10 }],
 *     nightEmissive: [windowMaterial, bulbMaterial],   // 夜晚才發光的材質（先設好 emissive 顏色與 emissiveIntensity）
 *     fireflies: true,
 *   });
 *   lighting.enableShadows(scene);                     // 一鍵讓所有 Mesh 投影、受影
 *   lighting.setTime('night');                          // 'day' | 'dusk' | 'night' | 0~1
 *   // 每幀：
 *   lighting.update(deltaSeconds);
 *   lighting.render();                                 // 取代 renderer.render(scene, camera)
 *   // 視窗大小改變：
 *   lighting.resize(width, height);
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ------------------------------------------------------------------ *
 * 關鍵影格（顏色皆為線性 RGB，可直接修改 lighting.keyframes 即時生效）
 *   sun   主光顏色          si   主光強度
 *   el    太陽仰角（弧度）   azOffsetDeg  相對 sunAzimuthDeg 的方位偏移
 *   zen   天頂色            hor  地平線色（也是霧色）
 *   gnd   地面反光色        amb  環境光倍率
 *   exp   曝光              fog  霧濃度（乘以 1/半徑）
 *   bloom Bloom 強度
 * ------------------------------------------------------------------ */
export const DEFAULT_KEYFRAMES = {
  day:   { sun: [1.0, 0.94, 0.84], si: 3.6, el: 0.92,  azOffsetDeg: 0,   zen: [0.035, 0.17, 0.62], hor: [0.30, 0.50, 0.82],  gnd: [0.32, 0.27, 0.18],    amb: 1.05, exp: 0.95, fog: 0.22, bloom: 0.12 },
  dusk:  { sun: [1.0, 0.50, 0.24], si: 2.0, el: 0.075, azOffsetDeg: -28, zen: [0.10, 0.13, 0.32],  hor: [0.90, 0.42, 0.20],  gnd: [0.20, 0.13, 0.10],    amb: 0.60, exp: 1.15, fog: 0.30, bloom: 0.28 },
  night: { sun: [0.48, 0.60, 0.95], si: 0.15, el: 0.68, azOffsetDeg: 0,  zen: [0.004, 0.008, 0.026], hor: [0.025, 0.035, 0.065], gnd: [0.015, 0.015, 0.022], amb: 0.55, exp: 1.55, fog: 0.34, bloom: 0.75 },
};

const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const desat = (c, k) => { const l = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722; return lerp3([l, l, l], c, k); };
const dirFrom = (el, az) => new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
const toV3 = (p) => (p && p.isVector3) ? p.clone() : new THREE.Vector3(p[0], p[1], p[2]);

/* ---------------- shaders ---------------- */
const NOISE = /* glsl */`
float h12(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(h12(i),h12(i+vec2(1,0)),f.x),mix(h12(i+vec2(0,1)),h12(i+vec2(1,1)),f.x),f.y);}`;

const SkyShader = {
  uniforms: {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uZen: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uSunCol: { value: new THREE.Color() },
    uNight: { value: 0 }, uTime: { value: 0 }, uSunVis: { value: 1 },
  },
  vertexShader: /* glsl */`
    varying vec3 vWorld;
    void main(){ vec4 w = modelMatrix*vec4(position,1.); vWorld = w.xyz;
      gl_Position = projectionMatrix*viewMatrix*w; gl_Position.z = gl_Position.w; }`,
  fragmentShader: /* glsl */`
    uniform vec3 uSunDir,uMoonDir,uZen,uHor,uSunCol; uniform float uNight,uTime,uSunVis;
    varying vec3 vWorld;
    ${NOISE}
    float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*vnoise(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return s;}
    float h31(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
    void main(){
      vec3 d = normalize(vWorld - cameraPosition); float y = d.y;
      vec3 c = mix(uHor, uZen, pow(clamp(y,0.,1.),.5));
      if(y<0.) c = uHor*mix(1.,.35,clamp(-y*2.5,0.,1.));
      float sd = max(dot(d,uSunDir),0.);
      c += uSunCol*(pow(sd,900.)*60. + pow(sd,10.)*.35 + pow(sd,3.)*.12)*uSunVis;
      if(y>0.){
        vec2 cp = d.xz/(y+.12)*.9 + vec2(uTime*.006, uTime*.002);
        float cl = smoothstep(.52,.86,fbm(cp*1.4));
        vec3 cc = mix(mix(vec3(1.05,1.03,1.),vec3(1.2,.62,.4),smoothstep(.2,.55,uNight)),vec3(.05,.06,.1),smoothstep(.55,.9,uNight));
        c = mix(c, cc*mix(1.,.75,y), cl*.55*smoothstep(0.,.18,y));
        vec3 q = d*220.; vec3 iq = floor(q); float h = h31(iq);
        float st = step(.9965,h)*smoothstep(.42,0.,length(fract(q)-.5))*(.6+.4*sin(uTime*2.+h*90.));
        c += vec3(.9,.95,1.)*st*2.2*smoothstep(.6,1.,uNight)*smoothstep(.02,.25,y)*(1.-cl);
      }
      float md = dot(d,uMoonDir);
      c += vec3(1.,.96,.86)*smoothstep(.99955,.9997,md)*4.*smoothstep(.55,.9,uNight) + vec3(.25,.35,.6)*pow(max(md,0.),300.)*.8*uNight;
      gl_FragColor = vec4(c,1.);
    }`,
};

/** 移軸景深：畫面上下方逐漸模糊，中間清楚（可分兩次：水平＋垂直） */
const TiltShiftShader = {
  uniforms: { tDiffuse: { value: null }, delta: { value: new THREE.Vector2(1, 0) }, focus: { value: 0.5 }, range: { value: 0.12 }, amount: { value: 1 } },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform vec2 delta; uniform float focus,range,amount; varying vec2 vUv;
    void main(){
      float b = clamp((abs(vUv.y-focus)-range)/max(.5-range,1e-3),0.,1.); b = b*b*amount;
      if(b<.01){ gl_FragColor = texture2D(tDiffuse,vUv); return; }
      vec4 c = vec4(0.); float t = 0.;
      for(int i=-6;i<=6;i++){ float w = exp(-float(i*i)/18.); c += texture2D(tDiffuse, vUv+delta*float(i)*b)*w; t += w; }
      gl_FragColor = c/t;
    }`,
};

/** 最終調色：飽和、暗角、抖色（在 OutputPass 之後，顯示空間） */
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, saturation: { value: 1.12 }, vignette: { value: 0.55 }, uTime: { value: 0 } },
  vertexShader: TiltShiftShader.vertexShader,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float saturation,vignette,uTime; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse,vUv).rgb;
      float l = dot(c,vec3(.2126,.7152,.0722)); c = max(mix(vec3(l),c,saturation),0.);
      vec2 q = vUv-.5; c *= 1. - dot(q,q)*vignette;
      c += (fract(sin(dot(gl_FragCoord.xy+uTime,vec2(12.9898,78.233)))*43758.5453)-.5)/255.;
      gl_FragColor = vec4(c,1.);
    }`,
};

const FireflyShader = {
  uniforms: { uTime: { value: 0 }, uNight: { value: 0 }, uScale: { value: 300 }, uSize: { value: 0.16 }, uDrift: { value: 1 } },
  vertexShader: /* glsl */`
    attribute float aPhase; uniform float uTime,uNight,uScale,uSize,uDrift; varying float vA;
    void main(){
      float t = uTime, ph = aPhase;
      vec3 p = position + vec3(sin(t*.4+ph*3.)*.8, sin(t*.7+ph*5.)*.35, cos(t*.33+ph*2.)*.8)*uDrift;
      vA = pow(.5+.5*sin(t*1.7+ph*11.),3.)*uNight;
      vec4 mv = modelViewMatrix*vec4(p,1.);
      gl_Position = projectionMatrix*mv;
      gl_PointSize = clamp(uScale*uSize/-mv.z, 2., 26.);
    }`,
  fragmentShader: /* glsl */`
    varying float vA;
    void main(){ vec2 d = gl_PointCoord-.5; float a = exp(-dot(d,d)*20.)*vA; gl_FragColor = vec4(vec3(.8,1.,.35)*a*7.,1.); }`,
};

/* ------------------------------------------------------------------ */
export function createDayNightLighting(renderer, scene, camera, options = {}) {
  const opt = {
    bounds: { center: [0, 0, 0], radius: 20 },
    sunAzimuthDeg: -37,       // 太陽從哪個方位照過來（0 = +Z 方向，往 +X 為正）
    moonAzimuthDeg: -137,
    lamps: [],
    nightEmissive: [],
    fireflies: false,
    shadowMapSize: 2048,
    msaa: 4,                  // 多重取樣數；手機建議 0
    post: true,               // false：不建立後製（手機省記憶體），render() 直接畫
    ao: true, bloom: true, tiltShift: true,
    tiltFocus: 0.5,           // 清晰帶在畫面高度的位置（0 = 底、1 = 頂）
    tiltRange: 0.12,          // 清晰帶半寬
    tiltAmount: 1,            // 模糊強度
    transitionSeconds: 3,     // 白天↔夜晚 過渡時間
    cycle: false,             // 自動晝夜循環
    cycleHoldSeconds: 9,
    startTime: 0,             // 0 白天、0.5 黃昏、1 夜晚
    ...options,
  };
  const center = toV3(opt.bounds.center);
  const R = opt.bounds.radius;
  const keyframes = JSON.parse(JSON.stringify(DEFAULT_KEYFRAMES));
  if (opt.keyframes) for (const k of Object.keys(opt.keyframes)) Object.assign(keyframes[k], opt.keyframes[k]);

  /* renderer */
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  /* lights */
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(opt.shadowMapSize, opt.shadowMapSize);
  const sc = sun.shadow.camera;
  sc.left = -R * 1.1; sc.right = R * 1.1; sc.top = R * 1.1; sc.bottom = -R * 1.1; sc.near = 0.1; sc.far = R * 5;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = R * 0.0015;
  sun.target.position.copy(center);
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, Math.PI);
  scene.add(hemi);

  scene.fog = new THREE.FogExp2(0x000000, 0.01);
  scene.background = null;

  /* sky */
  const skyMat = new THREE.ShaderMaterial({ ...SkyShader, uniforms: THREE.UniformsUtils.clone(SkyShader.uniforms), side: THREE.BackSide, depthWrite: false, fog: false });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), skyMat);
  sky.frustumCulled = false; sky.renderOrder = -1000; sky.name = 'DayNightSky';
  scene.add(sky);

  /* night lamps */
  const lamps = [];
  function addLamp(l) {
    const pl = new THREE.PointLight(l.color ?? 0xffb877, 0, l.distance ?? R * 0.5, 2);
    pl.position.copy(toV3(l.position));
    if (l.castShadow) { pl.castShadow = true; pl.shadow.mapSize.set(512, 512); pl.shadow.bias = -0.002; }
    scene.add(pl);
    const entry = { light: pl, base: l.intensity ?? 24, flicker: !!l.flicker, seed: Math.random() * 100 };
    lamps.push(entry);
    return pl;
  }
  opt.lamps.forEach(addLamp);

  /* night emissive */
  const emissives = [];
  function addNightEmissive(target) {
    const push = (m) => { if (m && 'emissiveIntensity' in m && !emissives.some(e => e.m === m)) emissives.push({ m, base: m.emissiveIntensity || 1 }); };
    if (target.isMaterial) push(target);
    else if (target.isObject3D) target.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(push); });
  }
  opt.nightEmissive.forEach(addNightEmissive);

  /* fireflies */
  let fireflies = null;
  if (opt.fireflies) {
    const cfg = opt.fireflies === true ? {} : opt.fireflies;
    const n = cfg.count ?? 60;
    const pos = new Float32Array(n * 3), ph = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * R * 0.85;
      pos[i * 3] = center.x + Math.cos(a) * r;
      pos[i * 3 + 1] = center.y + (0.4 + Math.random() * 2.4) * (R / 20);
      pos[i * 3 + 2] = center.z + Math.sin(a) * r;
      ph[i] = Math.random() * 6.28;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    const m = new THREE.ShaderMaterial({ ...FireflyShader, uniforms: THREE.UniformsUtils.clone(FireflyShader.uniforms), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    m.uniforms.uDrift.value = R / 20;
    fireflies = new THREE.Points(g, m);
    fireflies.frustumCulled = false;
    scene.add(fireflies);
  }

  /* post-processing（post: false 時完全不建立：省下大量繪圖記憶體，手機上建議關閉） */
  let composer = null, rt = null, gtao = null, tiltH = null, tiltV = null, grade = null;
  let bloom = { strength: 0, enabled: false };
  const size = renderer.getSize(new THREE.Vector2());
  function applyTiltUniforms(w, h) {
    if (!tiltH) return;
    for (const p of [tiltH, tiltV]) { p.uniforms.focus.value = opt.tiltFocus; p.uniforms.range.value = opt.tiltRange; p.uniforms.amount.value = opt.tiltAmount; }
    tiltH.uniforms.delta.value.set(3 / w, 0);
    tiltV.uniforms.delta.value.set(0, 3 / h);
  }
  function applyToggles() { if (!composer) return; gtao.enabled = !!opt.ao; bloom.enabled = !!opt.bloom; tiltH.enabled = tiltV.enabled = !!opt.tiltShift; }
  if (opt.post !== false) {
    rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: opt.msaa });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    if (opt.ao) {   // GTAO 只在需要時建立（它會配置好幾張全螢幕緩衝）
      gtao = new GTAOPass(scene, camera, size.x, size.y);
      gtao.updateGtaoMaterial({ radius: R * 0.035, distanceExponent: 1.5, thickness: R * 0.05, scale: 1.0 });
      gtao.blendIntensity = 0.9;
      composer.addPass(gtao);
    } else gtao = { enabled: false };
    bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.2, 0.55, 0.9);
    composer.addPass(bloom);
    tiltH = new ShaderPass(TiltShiftShader); tiltV = new ShaderPass(TiltShiftShader);
    composer.addPass(tiltH); composer.addPass(tiltV);
    composer.addPass(new OutputPass());
    grade = new ShaderPass(GradeShader);
    composer.addPass(grade);
    applyTiltUniforms(size.x, size.y);
    applyToggles();
  }

  /* state */
  let tod = clamp(opt.startTime, 0, 1), todTarget = tod, hold = 0, elapsed = 0;
  const named = { day: 0, dusk: 0.5, night: 1 };

  /** 依時間 t（0~1）計算整組光影參數 */
  function sample(t) {
    const A = keyframes.day, B = keyframes.dusk, C = keyframes.night;
    let a, b, k; if (t <= 0.5) { a = A; b = B; k = t / 0.5; } else { a = B; b = C; k = (t - 0.5) / 0.5; }
    const L = {};
    for (const key of ['zen', 'hor', 'gnd']) L[key] = lerp3(a[key], b[key], k);
    for (const key of ['amb', 'exp', 'fog', 'bloom']) L[key] = lerp(a[key], b[key], k);
    const sunAz = THREE.MathUtils.degToRad(opt.sunAzimuthDeg + lerp(A.azOffsetDeg, B.azOffsetDeg, clamp(t / 0.5, 0, 1)));
    const sunEl = t <= 0.5 ? lerp(A.el, B.el, t / 0.5) : lerp(B.el, -0.12, clamp((t - 0.5) / 0.15, 0, 1));
    L.sunDir = dirFrom(sunEl, sunAz);
    L.moonDir = dirFrom(C.el, THREE.MathUtils.degToRad(opt.moonAzimuthDeg));
    L.sunCol = lerp3(A.sun, B.sun, clamp(t / 0.5, 0, 1));
    if (t < 0.6) { L.dir = L.sunDir; L.col = L.sunCol.map(v => v * lerp(A.si, B.si, clamp(t / 0.5, 0, 1)) * (1 - smooth(0.5, 0.6, t))); }
    else { L.dir = L.moonDir; L.col = C.sun.map(v => v * C.si * smooth(0.6, 0.85, t)); }
    L.sunVis = 1 - smooth(0.5, 0.62, t);
    L.night = smooth(0.45, 0.85, t);
    return L;
  }

  function apply(L) {
    sun.color.setRGB(L.col[0], L.col[1], L.col[2]); sun.intensity = 1;
    sun.position.copy(center).addScaledVector(L.dir, R * 2.5);
    const skyC = desat(L.zen, 0.42).map(v => v * 1.35 * L.amb), gndC = L.gnd.map(v => v * 0.45 * L.amb);
    hemi.color.setRGB(skyC[0], skyC[1], skyC[2]); hemi.groundColor.setRGB(gndC[0], gndC[1], gndC[2]);
    scene.fog.color.setRGB(L.hor[0] * 0.9, L.hor[1] * 0.9, L.hor[2] * 0.9);
    scene.fog.density = L.fog / R;
    renderer.toneMappingExposure = L.exp * 0.6;   // Three.js 的 ACES 內含 1/0.6 的預曝光
    bloom.strength = L.bloom;
    const u = skyMat.uniforms;
    u.uSunDir.value.copy(L.sunDir); u.uMoonDir.value.copy(L.moonDir);
    u.uZen.value.setRGB(...L.zen); u.uHor.value.setRGB(...L.hor); u.uSunCol.value.setRGB(...L.sunCol);
    u.uNight.value = tod; u.uTime.value = elapsed; u.uSunVis.value = L.sunVis;
    for (const l of lamps) {
      const f = l.flicker ? 0.92 + 0.08 * Math.sin(elapsed * 13 + l.seed) * Math.sin(elapsed * 3.1 + l.seed) : 1;
      l.light.intensity = l.base * L.night * f; l.light.visible = L.night > 0.01;
    }
    for (const e of emissives) e.m.emissiveIntensity = e.base * L.night;
    if (fireflies) { const fu = fireflies.material.uniforms; fu.uTime.value = elapsed; fu.uNight.value = L.night; fu.uScale.value = renderer.domElement.height * 0.5 * camera.projectionMatrix.elements[5]; fireflies.visible = L.night > 0.01; }
    if (grade) grade.uniforms.uTime.value = elapsed;
    current = L;
  }
  let current = null;

  const api = {
    keyframes,
    options: opt,
    composer, passes: { gtao, bloom, tiltH, tiltV, grade },
    lights: { sun, hemi, lamps: lamps.map(l => l.light) },
    sky,

    /** 'day' | 'dusk' | 'night' | 0~1；instant = true 時直接跳過去 */
    setTime(t, instant = false) {
      todTarget = clamp(typeof t === 'string' ? named[t] ?? 0 : t, 0, 1); hold = 0;
      if (instant) tod = todTarget;
    },
    getTime() { return tod; },
    /** 目前時刻的時鐘字串，例如 15:20 / 18:05 / 20:40 */
    getClock() {
      const m = Math.round(tod <= 0.5 ? lerp(920, 1085, tod / 0.5) : lerp(1085, 1240, (tod - 0.5) / 0.5));
      return String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    },
    getPeriod() { return tod < 0.25 ? 'day' : tod < 0.72 ? 'dusk' : 'night'; },
    /** 開關：'ao' | 'bloom' | 'tiltShift' | 'cycle'，或調整 tiltFocus / tiltRange / tiltAmount */
    setOption(key, value) { opt[key] = value; applyToggles(); if (rt) applyTiltUniforms(rt.width, rt.height); },
    addLamp, addNightEmissive,
    /** 讓 root 底下所有 Mesh 都投射與接收陰影 */
    enableShadows(root, cast = true, receive = true) { root.traverse(o => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; } }); },

    update(dt) {
      dt = Math.min(dt, 0.1); elapsed += dt;
      const sp = dt / Math.max(opt.transitionSeconds, 0.01);
      if (Math.abs(todTarget - tod) <= sp) tod = todTarget; else tod += Math.sign(todTarget - tod) * sp;
      if (opt.cycle && tod === todTarget) { hold += dt; if (hold > opt.cycleHoldSeconds) { hold = 0; todTarget = todTarget < 0.5 ? 1 : 0; } }
      sky.position.copy(camera.position); sky.scale.setScalar((camera.near + camera.far) * 0.5);
      apply(sample(tod));
    },
    render() { if (!current) api.update(0); if (composer) composer.render(); else renderer.render(scene, camera); },
    resize(w, h) { if (!composer) return; composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); applyTiltUniforms(w * renderer.getPixelRatio(), h * renderer.getPixelRatio()); },
    dispose() {
      scene.remove(sun, sun.target, hemi, sky); lamps.forEach(l => scene.remove(l.light));
      if (fireflies) { scene.remove(fireflies); fireflies.geometry.dispose(); fireflies.material.dispose(); }
      sky.geometry.dispose(); skyMat.dispose(); composer?.dispose?.(); rt?.dispose(); scene.fog = null;
    },
  };
  return api;
}
