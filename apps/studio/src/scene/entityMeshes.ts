import type { TwinVector3 } from '@twin-platform/world-kernel';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { getActiveTheme, cargoColorFor, type DeviceTheme } from './theme';

/**
 * 实体模型工厂：把一个 TwinEntity 的"声明"翻译成有造型的三维物件。
 *
 * 参考 VividFactory / r3f-tools 的做法，并按本项目的仿真契约补了三件事：
 * - 每个模型挂 `userData.codePath`：点中就能回答"它由 entityMeshes.ts 的哪个函数渲染"；
 * - 可动子部件（皮带箭头 shader、滚筒、状态灯、缓存货位）挂 `userData.anim`，
 *   供 `TwinSceneController` 按内核发来的 status / attrs 驱动；
 * - 颜色 / 圆角全读 `DeviceTheme`，切主题=换对象，组件不写字面量。
 *
 * 这一层只负责"长什么样"，不保存任何业务真相：尺寸取自实体声明的 `visual.size`，
 * 颜色取自 `visual.color`，全部由场景模板决定。
 */

/** 渲染层每帧从内核 status / attrs 消费的动画句柄。 */
export interface EntityAnim {
  kind: string;
  /** 输送带箭头流动 shader（仅 transport）。 */
  belt?: THREE.ShaderMaterial;
  /** 滚筒网格数组（transport / transfer / 弯道），按速度自转。 */
  rollers?: THREE.Mesh[];
  /**
   * 滚筒自转方向符号：控制器执行 `rotation.y += spin * rollerSign`（spin > 0）。
   *
   * **改符号前先读这段推导**，凭直觉改必反：
   * 滚筒由 `rotation.x = π/2` 立起来，轴向用方位角 θ 表示（直段 θ=π/2 → 轴沿
   * local +Z；弯道 θ 为径向、轴指向圆心外）。Euler 默认 XYZ，即 R = Rx·Ry·Rz，
   * 所以 `rotation.y` 是在**本体坐标系**里转，转轴就是滚筒自身轴线 ✓。
   * 角速度 ω = ṡ·(cosθ, 0, sinθ)，台面顶点 r=(0, r, 0) 的速度
   * v = ω × r = ṡ·r·(−sinθ, 0, cosθ)。
   * - 直段 θ=π/2 → v = ṡ·r·(−1, 0, 0)：**rotation.y 增大，台面往 −X 走**。
   *   所以"台面顺 local +X 走"必须 rollerSign = −direction（之前写成 +direction，反了）。
   * - 弯道：行进切向 = σ·(−sinθ, 0, cosθ)，故 rollerSign = σ（扫掠方向）。
   */
  rollerSign?: number;
  /** 状态灯材质（inspect / buffer / transfer / stacker），idle↔active 变色。 */
  statusLight?: THREE.MeshStandardMaterial;
  /** 缓存货架预置货位（仅 buffer），按 attrs.fill 显隐。 */
  bufferSlots?: THREE.Mesh[];
  /**
   * 台钓钓组的线（主线 / 子线）：每帧按两端实体的**挂线点**拉伸。
   * 挂线点 = 实体位置 + 该实体模型 `userData.lineAnchor`（本地偏移，缺省为原点），
   * 例如线穿漂脚而不是漂身中心、子线系在钩柄眼上而不是钩门中间。
   */
  fishingLines?: {
    readonly mesh: THREE.Mesh;
    readonly fromId: string;
    readonly toId: string;
    /** 子线弯曲：设置则该段属子线，控制器按 rigVisualPose 的 bend（调钓状态 + 这一口）松弛成折线。 */
    readonly bendAttr?: 'bendUpper' | 'bendLower';
    /** 子线沿曲线分段：本 mesh 是第 index 截（共 count 截）。 */
    readonly segment?: { readonly index: number; readonly count: number };
    /** 弯曲量来源的 rig 实体（钓场固定为 rig-01）。 */
    readonly rigId?: string;
  }[];
  /** 咬钩的鱼（仅钓组）：只在一口鱼期间显示，嘴在模型本地 +X 端。 */
  biter?: THREE.Group;
  /** 顶升链带的链轮（仅 cassette）：顶起后按出货方向自转。 */
  sprockets?: THREE.Mesh[];
  /** 水面涟漪（仅 water）：按渲染时钟从中心向外扩散、淡出，循环播放。 */
  ripples?: { readonly mesh: THREE.Mesh; readonly phase: number; readonly maxRadius: number; readonly period: number }[];
  /** 摆动件（水草叶片 / 鱼尾）：绕 axis 在 base 附近做正弦摆动，纯表现，不写世界状态。 */
  sway?: { readonly mesh: THREE.Object3D; readonly axis: 'y' | 'z'; readonly base: number; readonly amp: number; readonly speed: number; readonly phase: number }[];
  /** 顶升链带上的链齿（仅 cassette）：沿 local Z 循环平移，链条才像在跑。 */
  chainTeeth?: { mesh: THREE.Mesh; halfSpan: number }[];
  /** 出货方向：+1 沿 local +Z，-1 沿 local -Z。决定链轮转向与链齿走向。 */
  divertSign?: number;
}

export interface EntityMeshInput {
  id: string;
  kind: string;
  visual?: { kind?: string; color?: string; size?: TwinVector3 };
  transform: { position: TwinVector3; rotation?: TwinVector3 };
  capabilities?: readonly string[];
  config?: Record<string, unknown>;
}

interface MaterialOptions {
  roughness?: number;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
}

function material(color: string, options: MaterialOptions = {}): THREE.MeshStandardMaterial {
  const opacity = options.opacity ?? 1;
  return new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.62,
    metalness: options.metalness ?? 0.12,
    emissive: new THREE.Color(options.emissive ?? '#000000'),
    emissiveIntensity: options.emissiveIntensity ?? 1,
    transparent: opacity < 1,
    opacity,
  });
}

/** 圆角盒子：玩具工厂质感靠它；industrial 主题 radius≈0 退回方角。 */
function rbox(width: number, height: number, depth: number, color: string, options?: MaterialOptions): THREE.Mesh {
  const theme = getActiveTheme();
  const radius = Math.min(theme.cornerRadius, Math.min(width, height, depth) / 2 - 1e-3);
  const geometry = radius > 1e-4 ? new RoundedBoxGeometry(width, height, depth, 4, radius) : new THREE.BoxGeometry(width, height, depth);
  const mesh = new THREE.Mesh(geometry, material(color, options));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cyl(radius: number, height: number, color: string, segments = 12, options?: MaterialOptions): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, segments), material(color, options));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function sphere(radius: number, color: string, options?: MaterialOptions): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 10), material(color, options));
  mesh.castShadow = true;
  return mesh;
}

function at<T extends THREE.Object3D>(object: T, x: number, y: number, z: number): T {
  object.position.set(x, y, z);
  return object;
}

/** 状态灯：放在设备顶端，材质引用存进 anim 供控制器 idle↔active 切换。 */
function statusLamp(y: number, theme: DeviceTheme): THREE.Mesh {
  const lamp = sphere(0.07, theme.lightIdle, { emissive: theme.lightIdle, emissiveIntensity: 0.9 });
  lamp.position.y = y;
  return lamp;
}

/**
 * 皮带箭头流动 shader：按 UV 滚动箭头，比贴图省事、可逐线调色。
 *
 * 两个关键约定（改之前踩过的坑）：
 * - **滚动必须走 `vUv.x`**：皮带面是 `PlaneGeometry(长度, 宽度)`，`u` 沿长度方向、
 *   也就是物料行进方向；拿 `vUv.y` 去滚会让箭头横穿带宽，跟 path 完全无关。
 * - **要真透明**：`depthWrite: false` + 低背景 alpha，滚筒才透得出来；
 *   只写个 0.85 常量等于没透明，还会把滚筒盖住。
 *
 * `direction` 用 local +X 定义：+1 顺着 local +X 流，-1 逆着流。
 * 沿 Z 铺的皮带在 buildConveyor 里被转了 90°，local +X 指向世界 -Z，
 * 所以"顺着 path 流"要按实际行进方向选 ±1（模板里用 `beltDirection` 声明）。
 */
function beltMaterial(theme: DeviceTheme, direction: number, repeat: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    // 透明面别写深度，否则会把下面的滚筒挡掉、还容易和台面 z-fighting。
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      time: { value: 0 },
      color: { value: new THREE.Color(theme.accent) },
      /** 一条皮带上排几个箭头（按长度算，保证箭头间距不随段长拉伸）。 */
      repeat: { value: repeat },
      /** 每秒流动几个箭头周期。 */
      speed: { value: 0.55 },
      direction: { value: direction },
      /** 人字形箭头的后掠量（周期占比）：0 是直条，越大越尖。 */
      chevron: { value: 0.42 },
      alpha: { value: 0.85 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float time;
      uniform vec3 color;
      uniform float repeat;
      uniform float speed;
      uniform float direction;
      uniform float chevron;
      uniform float alpha;
      varying vec2 vUv;
      void main() {
        // fwd：沿行进方向的长度坐标（0 → 1），direction 负责掉头
        float fwd = direction >= 0.0 ? vUv.x : 1.0 - vUv.x;
        // across：0 在带宽中心、1 在两侧边缘，用来把直条拗成人字形
        float across = abs(vUv.y - 0.5) * 2.0;
        float u = fwd * repeat + across * chevron - time * speed;
        float k = fract(u);
        // 箭头：头锐（k→1 处截断）尾渐隐，指向行进方向
        float arrow = smoothstep(0.35, 1.0, k);
        vec3 c = mix(color * 0.4, color, arrow);
        // 底噪几乎全透明（露出滚筒），箭头处才提亮提实
        gl_FragColor = vec4(c, mix(0.10, 0.85, arrow) * alpha);
      }
    `,
  });
}

/** 输送段：皮带箭头面 + 滚筒（旋转）+ 两侧低边框 + 支腿 + 来料端电机 + 状态灯。 */
function buildConveyor(
  sizeX: number,
  sizeZ: number,
  color: string,
  baseY: number,
  id: string,
  /** 箭头流动方向：+1 顺 local +X，-1 逆行。沿 Z 铺设时 local +X 指向世界 -Z。 */
  direction = 1,
  /**
   * 长边落在哪个轴上——**必须由场景模板声明**，不能靠 `sizeZ > sizeX` 猜。
   * 猜会在短段上翻车：0.9m 长 × 1.4m 宽的接驳段会被当成"沿 Z 铺"，
   * 整段转 90°、长宽互换，滚筒轴和箭头方向跟着全错。
   */
  axis: 'x' | 'z' = 'x',
): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildConveyor';
  const alongZ = axis === 'z';
  const length = alongZ ? sizeZ : sizeX;
  const width = alongZ ? sizeX : sizeZ;
  if (alongZ) group.rotation.y = Math.PI / 2;

  const deckHeight = 0.1;
  const deckCenterY = 0.25;
  const deckTop = deckCenterY + deckHeight / 2;
  const deckBottom = deckCenterY - deckHeight / 2;
  const rollerRadius = 0.05;
  const rollerCenterY = deckTop - rollerRadius;

  // 皮带箭头面：盖在滚筒上方，UV.x 沿皮带长度方向滚动箭头。
  // 箭头间距按 1.1m 一个折算成 repeat，长皮带不会把箭头拉长。
  const belt = new THREE.Mesh(
    new THREE.PlaneGeometry(length * 0.96, width * BELT_SURFACE_RATIO),
    beltMaterial(theme, direction, Math.max(1, Math.round(length / BELT_ARROW_SPACING))),
  );
  belt.rotation.x = -Math.PI / 2;
  belt.position.y = deckTop + 0.005;
  belt.renderOrder = 2;
  belt.castShadow = false;
  belt.receiveShadow = false;
  group.add(belt);

  group.add(at(rbox(length * 0.98, 0.04, width * BELT_DECK_RATIO, theme.frameDark, { roughness: 0.7 }), 0, deckBottom - 0.02, 0));

  for (const side of [-1, 1]) {
    group.add(at(rbox(length * 0.98, 0.07, 0.06, theme.frame, { roughness: 0.6 }), 0, deckBottom - 0.05 / 2 + 0.02, side * (width / 2 - 0.05)));
  }

  const rollers: THREE.Mesh[] = [];
  const rollerCount = Math.max(3, Math.round(length / 0.32));
  for (let i = 0; i <= rollerCount; i += 1) {
    const x = -length / 2 + 0.16 + (i / rollerCount) * (length - 0.32);
    const roller = cyl(rollerRadius, width * BELT_ROLLER_RATIO, theme.roller, 10, { roughness: 0.35, metalness: 0.45 });
    roller.castShadow = false;
    roller.rotation.x = Math.PI / 2;
    roller.position.set(x, rollerCenterY, 0);
    rollers.push(roller);
    group.add(roller);
  }

  const groundY = -baseY;
  const legSpacing = 1.35;
  const nLegs = Math.max(1, Math.round(length / legSpacing));
  const legTopY = deckBottom - 0.02;
  const legHeight = Math.max(0.08, legTopY - groundY);
  const legCenterY = (legTopY + groundY) / 2;
  for (let i = 0; i <= nLegs; i += 1) {
    const lx = -length / 2 + (i / nLegs) * length;
    for (const sz of [-1, 1]) {
      group.add(at(cyl(0.045, legHeight, theme.frameDark, 8, { roughness: 0.7 }), lx, legCenterY, sz * (width / 2 - 0.12)));
    }
  }

  const motorX = -length / 2 + 0.3;
  group.add(at(cyl(0.06, 0.14, theme.metal, 12, { roughness: 0.4, metalness: 0.5 }), motorX, rollerCenterY, width / 2 + 0.04));
  group.add(at(cyl(0.04, 0.05, theme.frameDark, 12), motorX, rollerCenterY, width / 2 + 0.12));

  if (id.startsWith('sorter')) {
    group.add(at(rbox(0.16, 0.16, 0.72, theme.accent, { roughness: 0.5 }), 0, deckCenterY + 0.18, width / 2 + 0.22));
  }

  const lamp = statusLamp(deckCenterY + 0.5, theme);
  group.add(lamp);

  // rollerSign = −direction：rotation.y 增大时台面往 −X 走（见 EntityAnim 推导）。
  group.userData.anim = { kind: 'transport', belt: belt.material as THREE.ShaderMaterial, rollers, rollerSign: -direction, statusLight: lamp.material as THREE.MeshStandardMaterial } as EntityAnim;
  return group;
}

/** 检测站：跨在皮带上方的拱门 + 半透明光幕 + 状态灯。 */
function buildInspection(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildInspection';
  const [width, height, depth] = size;
  const groundY = -baseY;
  const postHeight = height * 0.95;

  for (const side of [-1, 1]) {
    const z = side * (depth / 2 + 0.04);
    group.add(at(rbox(0.13, postHeight, 0.13, color, { roughness: 0.5 }), 0, groundY + postHeight / 2, z));
    const foot = rbox(0.26, 0.05, 0.26, theme.frameDark, { roughness: 0.75 });
    foot.castShadow = false;
    group.add(at(foot, 0, groundY + 0.025, z));
  }

  const topY = groundY + postHeight;
  group.add(at(rbox(0.16, 0.16, depth + 0.2, color, { roughness: 0.5 }), 0, topY + 0.08, 0));

  const curtain = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.34, height * 0.6),
    material(theme.roller, { opacity: 0.26, roughness: 0.2, emissive: theme.roller, emissiveIntensity: 0.35 }),
  );
  curtain.castShadow = false;
  curtain.position.set(0, groundY + height * 0.42, 0);
  group.add(curtain);

  const lamp = statusLamp(topY + 0.25, theme);
  group.add(lamp);

  group.userData.anim = { kind: 'inspect', statusLight: lamp.material as THREE.MeshStandardMaterial } as EntityAnim;
  return group;
}

/**
 * 缓存货架：立柱 + 层板 + 货位。货位按 `attrs.fill` 实时显隐
 *（由 buffer-fill 行为算出来），不再写死"包装架满 / 拒收架空"。
 */
function buildRack(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildRack';
  const [width, height, depth] = size;
  const groundY = -baseY;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(at(rbox(0.1, height, 0.1, theme.frameDark, { roughness: 0.7 }), sx * (width / 2 - 0.06), groundY + height / 2, sz * (depth / 2 - 0.06)));
    }
  }

  const shelves = 4;
  for (let i = 0; i < shelves; i += 1) {
    group.add(at(rbox(width * 0.96, 0.06, depth * 0.92, color, { roughness: 0.6 }), 0, groundY + height * (0.18 + i * 0.22), 0));
  }

  // 预置货位：初始隐藏，applyState 按 fill 比例点亮前 N 个。
  const slots: THREE.Mesh[] = [];
  const slotCount = 8;
  for (let i = 0; i < slotCount; i += 1) {
    const shelf = i % shelves;
    const x = -width / 2 + 0.42 + (i % 2) * 0.62;
    const z = -depth / 2 + 0.36 + (i % 4 >= 2 ? 0.5 : 0);
    const cargo = rbox(0.34, 0.28, 0.34, theme.cargoColors[i % theme.cargoColors.length]!, { roughness: 0.5, metalness: 0.05 });
    cargo.position.set(x, groundY + height * (0.18 + shelf * 0.22) + 0.17, z);
    cargo.visible = false;
    slots.push(cargo);
    group.add(cargo);
  }

  const lamp = statusLamp(groundY + height + 0.12, theme);
  group.add(lamp);

  group.userData.anim = { kind: 'buffer', statusLight: lamp.material as THREE.MeshStandardMaterial, bufferSlots: slots } as EntityAnim;
  return group;
}

/** 在制物料：带顶面封条的货箱（非实例化路径的兜底，实例化走 CargoPool）。 */
function buildCargo(size: TwinVector3, color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildCargo';
  group.add(rbox(size[0], size[1], size[2], color, { roughness: 0.45, metalness: 0.05 }));
  const tape = rbox(size[0] * 0.34, size[1] * 0.08, size[2] * 1.02, getActiveTheme().frame, { roughness: 0.7 });
  tape.castShadow = false;
  group.add(at(tape, 0, size[1] / 2, 0));
  return group;
}

/**
 * 高层货架（AS/RS）：立柱 + 每层横梁 + 顶部天轨，**不画托盘**。
 *
 * 以前这里按"确定性哈希"在货位上摆了几块装饰托盘，结果是：看得见、点不中、
 * 数量也永远不变。现在托盘是真正的实体（`kind: 'pallet'`，由 `asrs-cycle`
 * 行为搬进搬出），货架只负责画"有哪些货位"，货位有没有货由世界状态决定。
 *
 * 横梁高度直接读 `config.levelHeights`（与堆垛机取货高度同一份数组），
 * 所以托盘落位一定压在横梁上，不会浮空也不会穿梁。
 */
function buildAsrsRack(size: TwinVector3, color: string, baseY: number, config?: Record<string, unknown>): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildAsrsRack';
  const [width, height, depth] = size;
  const groundY = -baseY;
  const declaredLevels = config?.levelHeights;
  const levelHeights =
    Array.isArray(declaredLevels) && declaredLevels.length > 0 && declaredLevels.every((value) => typeof value === 'number')
      ? (declaredLevels as number[])
      : Array.from({ length: typeof config?.levels === 'number' ? (config.levels as number) : 5 }, (_, level) => (height / 5) * (level + 0.5));
  const bays = typeof config?.bays === 'number' && config.bays > 0 ? Math.round(config.bays) : Math.max(3, Math.round(depth / 2.2));
  const bayDepth = depth / bays;
  const postX = width / 2 - 0.06;

  for (let i = 0; i <= bays; i += 1) {
    const z = -depth / 2 + i * bayDepth;
    for (const sx of [-1, 1]) {
      group.add(at(rbox(0.1, height, 0.1, theme.frameDark, { roughness: 0.7 }), sx * postX, groundY + height / 2, z));
    }
  }

  // 每层两根横梁（托盘就坐在上面）+ 一层浅浅的层板，货位才看得出"格子"。
  for (const levelY of levelHeights) {
    const y = groundY + levelY;
    for (const sx of [-1, 1]) {
      const beam = rbox(0.07, 0.08, depth * 0.98, color, { roughness: 0.6 });
      beam.castShadow = false;
      group.add(at(beam, sx * (postX + 0.02), y, 0));
    }
    const deck = rbox(width * 0.94, 0.04, depth * 0.96, theme.frame, { roughness: 0.8 });
    deck.castShadow = false;
    deck.receiveShadow = true;
    group.add(at(deck, 0, y - 0.03, 0));
  }

  group.add(at(rbox(width * 0.5, 0.08, depth * 0.98, theme.frameDark, { roughness: 0.6 }), 0, groundY + height + 0.1, 0));
  return group;
}

/** 小货物发生器：底座 + 料斗 + 出料口 + 状态灯。 */
function buildSource(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildSource';
  const [width, height, depth] = size;
  const groundY = -baseY;

  group.add(at(rbox(width, 0.3, depth, theme.frameDark, { roughness: 0.7 }), 0, groundY + 0.15, 0));
  // 料斗用"上宽下窄"的两段盒子近似（圆角盒不做锥形，够看了）
  group.add(at(rbox(width, height * 0.45, depth, color, { roughness: 0.5 }), 0, groundY + 0.3 + height * 0.22, 0));
  group.add(at(rbox(width * 0.55, height * 0.4, depth * 0.7, color, { roughness: 0.5 }), 0, groundY + 0.3 + height * 0.62, 0));
  group.add(at(rbox(width * 0.42, 0.16, depth * 0.42, theme.metal, { roughness: 0.4, metalness: 0.5 }), 0, groundY + 0.3, 0));

  const lamp = statusLamp(groundY + height + 0.1, theme);
  group.add(lamp);
  group.userData.anim = { kind: 'source', statusLight: lamp.material as THREE.MeshStandardMaterial } as EntityAnim;
  return group;
}

/** 打包站：机架 + 台面滚筒 + 上模压盖 + 状态灯。 */
function buildPackingStation(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildPackingStation';
  const [width, height, depth] = size;
  const groundY = -baseY;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(
        at(rbox(0.1, height * 0.7, 0.1, theme.frameDark, { roughness: 0.7 }), sx * (width / 2 - 0.08), groundY + height * 0.35, sz * (depth / 2 - 0.08)),
      );
    }
  }
  group.add(at(rbox(width, 0.12, depth, color, { roughness: 0.55 }), 0, groundY + height * 0.7, 0));
  // 台面滚筒（轴沿 Z）
  for (let i = 0; i < 5; i += 1) {
    const roller = cyl(0.07, depth * 0.88, theme.metal, 10, { roughness: 0.4, metalness: 0.5 });
    roller.rotation.x = Math.PI / 2;
    group.add(at(roller, -width / 2 + 0.3 + i * ((width - 0.6) / 4), groundY + height * 0.78, 0));
  }
  // 上模：压下去就是"2 合 1"
  group.add(at(rbox(width * 0.72, 0.2, depth * 0.72, theme.frameDark, { roughness: 0.5 }), 0, groundY + height * 1.02, 0));

  const lamp = statusLamp(groundY + height * 1.28, theme);
  group.add(lamp);
  group.userData.anim = { kind: 'pack', statusLight: lamp.material as THREE.MeshStandardMaterial } as EntityAnim;
  return group;
}

/** 卡车：驾驶室 + 平板货厢 + 四轮。 */
function buildTruck(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildTruck';
  const [width, height, depth] = size;
  const groundY = -baseY;

  // 货厢在后半段（托盘就装在这里）
  group.add(at(rbox(width, height * 0.5, depth * 0.62, color, { roughness: 0.55 }), 0, groundY + height * 0.45, depth * 0.16));
  // 驾驶室在前半段
  group.add(at(rbox(width * 0.94, height * 0.42, depth * 0.3, theme.frameDark, { roughness: 0.5 }), 0, groundY + height * 0.4, -depth * 0.32));
  group.add(
    at(rbox(width * 0.8, height * 0.16, 0.06, theme.roller, { roughness: 0.2, opacity: 0.7 }), 0, groundY + height * 0.5, -depth * 0.46),
  );
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = cyl(height * 0.16, 0.16, theme.frameDark, 12, { roughness: 0.6 });
      wheel.rotation.z = Math.PI / 2;
      group.add(at(wheel, sx * (width / 2 - 0.02), groundY + height * 0.16, sz * depth * 0.3));
    }
  }
  return group;
}

/** 堆垛机门架：底盘 + 车轮 + 双立柱 + 顶部天梁 + 状态灯。 */
function buildStacker(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildStacker';
  const [width, height, length] = size;
  const groundY = -baseY;

  group.add(at(rbox(width * 0.95, 0.26, length * 0.94, color, { roughness: 0.5, metalness: 0.2 }), 0, groundY + 0.22, 0));
  group.add(at(rbox(width * 0.45, 0.42, length * 0.3, theme.frameDark, { roughness: 0.6 }), -width * 0.22, groundY + 0.55, -length * 0.28));

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = cyl(0.13, 0.08, theme.metal, 12, { roughness: 0.4, metalness: 0.5 });
      wheel.rotation.z = Math.PI / 2;
      group.add(at(wheel, sx * (width / 2 - 0.02), groundY + 0.13, sz * (length / 2 - 0.22)));
    }
  }

  const mastHeight = height - 0.2;
  for (const sx of [-1, 1]) {
    group.add(at(rbox(0.12, mastHeight, 0.12, theme.frameDark, { roughness: 0.55, metalness: 0.3 }), sx * (width / 2 - 0.14), groundY + 0.3 + mastHeight / 2, 0));
  }
  group.add(at(rbox(width * 0.9, 0.1, 0.14, theme.frameDark, { roughness: 0.55 }), 0, groundY + 0.3 + mastHeight, 0));
  const lamp = statusLamp(groundY + 0.3 + mastHeight + 0.14, theme);
  group.add(lamp);

  group.userData.anim = { kind: 'stacker', statusLight: lamp.material as THREE.MeshStandardMaterial } as EntityAnim;
  return group;
}

/** 载货台：平台 + 两侧导向。 */
function buildCarriage(size: TwinVector3, color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildCarriage';
  const [width, height, length] = size;
  group.add(rbox(width * 0.92, height * 0.36, length * 0.96, color, { roughness: 0.5, metalness: 0.2 }));
  for (const sx of [-1, 1]) {
    const guide = rbox(0.06, height * 0.9, length * 0.96, getActiveTheme().frameDark, { roughness: 0.6 });
    guide.castShadow = false;
    group.add(at(guide, sx * (width / 2 - 0.04), height * 0.28, 0));
  }
  return group;
}

/** 货叉：背板 + 两根对称叉齿。 */
function buildFork(size: TwinVector3, color: string): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildFork';
  const [width, height, depth] = size;
  const back = rbox(0.07, height * 1.5, depth * 0.96, theme.frameDark, { roughness: 0.6 });
  group.add(at(back, -width / 2 + 0.04, height * 0.2, 0));
  for (const sz of [-1, 1]) {
    const prong = rbox(width * 0.92, height * 0.5, 0.09, color, { roughness: 0.45, metalness: 0.3 });
    prong.castShadow = false;
    group.add(at(prong, width * 0.04, 0, sz * (depth / 2 - 0.12)));
  }
  return group;
}

/** 托盘：底托 + 纸箱 + 封条。 */
function buildPallet(size: TwinVector3, color: string): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildPallet';
  const [width, height, depth] = size;
  const baseH = height * 0.2;
  const cartonH = height * 0.72;
  const bottom = -height / 2;

  group.add(at(rbox(width, baseH, depth, theme.frameDark, { roughness: 0.75 }), 0, bottom + baseH / 2, 0));
  group.add(at(rbox(width * 0.86, cartonH, depth * 0.88, color, { roughness: 0.5, metalness: 0.04 }), 0, bottom + baseH + cartonH / 2, 0));
  const tape = rbox(width * 0.3, height * 0.06, depth * 0.9, theme.frame, { roughness: 0.7 });
  tape.castShadow = false;
  group.add(at(tape, 0, bottom + baseH + cartonH, 0));
  return group;
}

/** 顶升移栽机：滚筒银行 + 侧板（出口侧留开口）+ 四角顶升气缸 + 状态灯。 */
/**
 * 顶升移栽机的滚筒根数。滚筒与链带共用一套节距——链带必须正好落在
 * 两根滚筒之间的缝里，所以两个 build 函数都用下面这几个常量算 X。
 */
const TRANSFER_ROLLERS = 8;

const transferPitch = (width: number): number => (width - 0.32) / (TRANSFER_ROLLERS - 1);

/** 第 i 根滚筒中心的 X。 */
const transferRollerX = (width: number, i: number): number => -width / 2 + 0.16 + i * transferPitch(width);

/** 第 i 条链带中心的 X —— 正好在两根滚筒的缝正中。 */
const transferStrandX = (width: number, i: number): number => -width / 2 + 0.16 + (i + 0.5) * transferPitch(width);

/**
 * 顶升移栽机机身：平常就是一段**顺流向**的滚筒输送线，货直着滚过去；
 * 只有 declare 了 divertIds 的货来了，滚筒缝里的链带才顶起来，把它**垂直**
 * 送出去。所以这里不再铺皮带面——主线到机身处就是断开的。
 *
 * @param direction 主线流向：+1 沿 local +X。
 * @param divertSign 顶升后的出货方向：+1 沿 local +Z，-1 沿 local -Z。
 */
function buildTransfer(
  size: TwinVector3,
  color: string,
  baseY: number,
  direction = 1,
  divertSign = -1,
): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildTransfer';
  const [width, , depth] = size;
  const groundY = -baseY;
  const deckHeight = 0.1;
  const deckCenterY = 0.25;
  const deckTop = deckCenterY + deckHeight / 2;
  const deckBottom = deckCenterY - deckHeight / 2;
  const rollerRadius = 0.05;
  const rollerCenterY = deckTop - rollerRadius;

  group.add(at(rbox(width * 0.98, 0.06, depth * 0.94, theme.frameDark, { roughness: 0.7 }), 0, groundY + 0.04, 0));

  const legTopY = deckBottom - 0.02;
  const legHeight = Math.max(0.08, legTopY - groundY);
  const legCenterY = (legTopY + groundY) / 2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(at(cyl(0.05, legHeight, theme.frameDark, 8, { roughness: 0.7 }), sx * (width / 2 - 0.2), legCenterY, sz * (depth / 2 - 0.15)));
    }
  }

  // 滚筒：沿流向（local X）排布，轴垂直于流向（local Z）。货物平常就压在这排
  // 滚筒上顺着滚过去；滚筒之间留出的缝，就是顶升链带的藏身处。
  const rollers: THREE.Mesh[] = [];
  for (let i = 0; i < TRANSFER_ROLLERS; i += 1) {
    const roller = cyl(rollerRadius, depth * 0.82, theme.roller, 10, { roughness: 0.35, metalness: 0.45 });
    roller.castShadow = false;
    roller.rotation.x = Math.PI / 2;
    roller.position.set(transferRollerX(width, i), rollerCenterY, 0);
    rollers.push(roller);
    group.add(roller);
  }

  // 侧板：出货侧开长口（货才出得去），对侧整块挡料。
  // 开口必须盖住整组链带的 X 跨度（约 1.1m），两端只留立柱。
  const openZ = -divertSign * (depth / 2 - 0.025);
  const solidZ = divertSign * (depth / 2 - 0.025);
  group.add(at(rbox(width * 0.96, 0.26, 0.05, theme.metal, { roughness: 0.5, metalness: 0.4 }), 0, deckCenterY, solidZ));
  for (const sx of [-1, 1]) {
    group.add(
      at(rbox(0.18, 0.26, 0.05, theme.metal, { roughness: 0.5, metalness: 0.4 }), sx * (width / 2 - 0.09), deckCenterY, openZ),
    );
  }

  // 四角导向柱必须落在滚筒包络之外：滚筒最外侧到 x=±(width/2-0.16)+r，
  // 所以柱子贴到 x=±(width/2-0.05)、z=±(depth/2-0.10)，才不会从滚筒里穿出来。
  const postX = width / 2 - 0.05;
  const postZ = depth / 2 - 0.10;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(at(cyl(0.045, 0.22, theme.frameDark, 10, { roughness: 0.5, metalness: 0.4 }), sx * postX, deckCenterY + 0.08, sz * postZ));
      group.add(at(cyl(0.025, 0.3, theme.metal, 8, { roughness: 0.4, metalness: 0.5 }), sx * postX, deckCenterY + 0.2, sz * postZ));
    }
  }

  // 端部驱动罩：整体挪到滚筒包络之外（滚筒最右到 width/2-0.16+r）。
  group.add(at(rbox(0.22, 0.18, 0.2, theme.metal, { roughness: 0.45, metalness: 0.4 }), width / 2 + 0.05, rollerCenterY, 0));

  // 光电对射：抬到滚筒线以上，原来埋在滚筒里。
  for (const sz of [-1, 1]) {
    group.add(at(rbox(0.08, 0.08, 0.08, '#FF5252', { emissive: '#FF5252', emissiveIntensity: 0.6 }), -width / 2 + 0.12, deckTop + 0.06, sz * (depth / 2 - 0.12)));
  }

  // 流向指示：挡料侧台面上两个小箭头，指的就是主线滚动方向 ——
  // 平常（不顶升）这台机器就等同于一段顺流向的滚筒输送线。
  const flowGeo = new THREE.ConeGeometry(0.06, 0.18, 4);
  const flowMat = new THREE.MeshStandardMaterial({ color: theme.accent, roughness: 0.45 });
  for (const sx of [-1, 1]) {
    const arrow = new THREE.Mesh(flowGeo, flowMat);
    arrow.rotation.z = direction > 0 ? -Math.PI / 2 : Math.PI / 2;
    arrow.position.set(sx * (width / 2 - 0.32), deckTop + 0.05, divertSign * (depth / 2 - 0.12));
    group.add(arrow);
  }

  const lamp = statusLamp(deckCenterY + 0.5, theme);
  group.add(lamp);

  group.userData.anim = {
    kind: 'transfer',
    rollers,
    rollerSign: -direction, // 同直段皮带：rotation.y 增大台面往 −X 走
    statusLight: lamp.material as THREE.MeshStandardMaterial,
  } as EntityAnim;
  return group;
}

/**
 * 托举座（cassette）：**坐在滚筒缝里**的那组顶升链带。
 *
 * 它和机身共用同一套节距，所以每条链带都正好卡在两根滚筒之间：
 * - idle —— 链带顶低于滚筒顶，整组缩在缝里，货压在滚筒上顺流向滚过去；
 * - 顶起 —— 整组链带抬 `liftHeight`，链带顶高过滚筒顶把货托离滚筒，
 *   链轮转起来把他沿 local ±Z **垂直**送出去，然后落回缝里。
 *
 * @param divertSign 出货方向：+1 沿 local +Z，-1 沿 local -Z。
 */
function buildCassette(size: TwinVector3, color: string, divertSign = -1): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildCassette';
  const [width, , depth] = size;

  // 链带顶：比滚筒顶（0.30）低 3.5cm，是"缩在缝里"的那个状态。
  const chainTop = 0.265;
  const strandLen = depth * 0.86;
  const halfSpan = strandLen / 2;
  // 链带宽度受滚筒缝宽限制：缝 = 节距 - 2×滚筒半径，两侧各留 1cm 余量。
  const strandW = Math.min(0.06, transferPitch(width) - 0.12);
  const rollerHalfZ = (depth * 0.82) / 2;

  // 两端横梁：把几条链带串成一套机构，同时充当链轮轴。
  // 必须落在滚筒 Z 包络之外——做成整块底板会横穿所有滚筒。
  const beamZ = rollerHalfZ + 0.04;
  for (const sz of [-1, 1]) {
    group.add(at(rbox(width * 0.84, 0.05, 0.04, color, { roughness: 0.5 }), 0, chainTop - 0.075, sz * beamZ));
  }

  const sprockets: THREE.Mesh[] = [];
  const chainTeeth: { mesh: THREE.Mesh; halfSpan: number }[] = [];
  const toothGeo = new THREE.BoxGeometry(strandW * 0.9, 0.014, 0.035);
  const toothMat = new THREE.MeshStandardMaterial({ color: theme.frameDark, roughness: 0.5, metalness: 0.35 });

  // 链带只占中间几条缝（最外侧两条留空，免得蹭到侧板立柱）。
  for (let i = 1; i < TRANSFER_ROLLERS - 2; i += 1) {
    const x = transferStrandX(width, i);

    // 链带本体：沿 local Z 铺满台面，货从进到出全程有链托着。
    group.add(at(rbox(strandW, 0.055, strandLen, theme.frameDark, { roughness: 0.55, metalness: 0.3 }), x, chainTop - 0.0275, 0));

    // 两端链轮：轴沿 local X（rotation.z = 90°），转起来链带才跑。
    // 厚度同样不能超缝宽，否则两侧会啃到滚筒（和链带同宽就够）。
    for (const sz of [-1, 1]) {
      const sprocket = cyl(0.045, strandW, theme.metal, 12, { roughness: 0.4, metalness: 0.5 });
      // 链轮盘的轴必须沿 local X（链带沿 Z 跑），并且自转要绕**自身轴线**：
      // - 默认 Euler 序 XYZ 下 R = Rx·Ry·Rz，改 rotation.y 会在父级坐标系里转，
      //   链轮不是自转而是整体翻跟头。改成 'ZYX'（R = Rz·Ry·Rx）后，
      //   "立起来"的 Rz 在最外层、自转的 Ry 在内层，才是绕自身轴转。
      // - Rz(−π/2) 把本体 +Y 摆到 +X；此后 rotation.y 增大 → 盘面顶点往 +Z 走，
      //   所以控制器里链轮与链齿同取 `+divertSign`。
      sprocket.rotation.order = 'ZYX';
      sprocket.rotation.set(0, 0, -Math.PI / 2);
      sprocket.position.set(x, chainTop - 0.045, sz * halfSpan);
      sprockets.push(sprocket);
      group.add(sprocket);
    }

    // 链齿：沿 local Z 均布，动画里循环平移，一眼看出链条往哪跑。
    const toothCount = 5;
    for (let t = 0; t < toothCount; t += 1) {
      const tooth = new THREE.Mesh(toothGeo, toothMat);
      tooth.position.set(x, chainTop + 0.007, -halfSpan + ((t + 0.5) / toothCount) * strandLen);
      chainTeeth.push({ mesh: tooth, halfSpan });
      group.add(tooth);
    }
  }

  group.userData.anim = { kind: 'cassette', sprockets, chainTeeth, divertSign } as EntityAnim;
  return group;
}

/** `'x+'` / `'z-'` 这类行进方向声明 → `[dx, dz]` 单位向量；解析不出来返回 null。 */
function travelDir(raw: unknown): [number, number] | null {
  if (typeof raw !== 'string' || raw.length !== 2) return null;
  const sign = raw[1] === '-' ? -1 : raw[1] === '+' ? 1 : 0;
  if (sign === 0) return null;
  if (raw[0] === 'x') return [sign, 0];
  if (raw[0] === 'z') return [0, sign];
  return null;
}

/**
 * 90° 弯曲输送线：货物沿一段**真正的圆弧**从入口转到出口。
 *
 * 以前那个"方形台面 + 一排平行滚筒"根本不是弯道——滚筒全平行、货是硬拐的。
 * 几何关系如下（手推过一次，改代码前先看这段）：设入口行进方向 din、出口 dout
 * （都是 ±X/±Z 单位向量且互相垂直），模块边长 S（= 带宽 w），半宽 h = S/2，则
 *   转弯半径 R = h                      （S = R + w/2 且 w = S）
 *   圆心     C = R·(dout − din)         落在转弯内侧那个角上
 *   切点方位 n1 = −dout（入）、n2 = din（出），方位角 θ = atan2(z, x)
 *   扫掠     θ1 → θ2，正好 90°，σ = sign(归一化(θ2 − θ1))
 * 滚筒轴沿径向 (cosθ, 0, sinθ)，`rotation.y` 增大时台面沿 (−sinθ, 0, cosθ) 走，
 * 与 σ·行进切向同向，所以 `rollerSign = σ`（推导见 EntityAnim.rollerSign）。
 *
 * 环形几何（RingGeometry / TorusGeometry）都在 XY 平面，绕 X 转 −90° 躺平后
 * XZ 方位角 = −φ，所以起笔角取 −θB，扇面才正好盖住 [θA, θB]。
 *
 * @param din  入口处货物的行进方向
 * @param dout 出口处货物的行进方向
 */
function buildCurvedConveyor(
  size: TwinVector3,
  color: string,
  baseY: number,
  din: [number, number],
  dout: [number, number],
): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildCurvedConveyor';
  const [width, , depth] = size;
  const groundY = -baseY;
  const span = Math.min(width, depth); // 模块边长 = 带宽
  const half = span / 2;
  const R = half; // 中心线转弯半径
  const rOut = span; // 外缘半径 = R + 带宽/2
  const rIn = 0.06;

  const deckTop = 0.31; // 比直行皮带台面(0.30)高 1cm，避免同高 z-fighting
  const deckBottom = deckTop - 0.12;
  const rollerCenterY = deckTop - 0.05;

  const cx = R * (dout[0] - din[0]);
  const cz = R * (dout[1] - din[1]);
  const th1 = Math.atan2(-dout[1], -dout[0]);
  const th2 = Math.atan2(din[1], din[0]);
  const sweep = Math.atan2(Math.sin(th2 - th1), Math.cos(th2 - th1)); // 归一化到 (−π, π]
  const sigma = sweep >= 0 ? 1 : -1;
  const thA = Math.min(th1, th2);
  const thB = Math.max(th1, th2);
  const thM = th1 + sweep / 2;

  // 弧形台面：90° 环形扇面
  const deck = new THREE.Mesh(
    new THREE.RingGeometry(rIn, rOut, 30, 1, -thB, thB - thA),
    material(color, { roughness: 0.65 }),
  );
  deck.rotation.x = -Math.PI / 2;
  deck.position.set(cx, deckBottom, cz);
  deck.receiveShadow = true;
  group.add(deck);

  // 外侧护栏：一段圆环管
  const rail = new THREE.Mesh(
    new THREE.TorusGeometry(rOut - 0.02, 0.035, 8, 24, Math.PI / 2),
    material(theme.frameDark, { roughness: 0.6 }),
  );
  rail.rotation.set(-Math.PI / 2, 0, -thB);
  rail.position.set(cx, deckTop + 0.06, cz);
  rail.castShadow = true;
  group.add(rail);

  // 弯道滚筒：轴一律沿径向；做成锥形（内侧细）才不会在靠圆心那端互相啃到
  const rollers: THREE.Mesh[] = [];
  const rollerCount = 5;
  const rollerGeo = new THREE.CylinderGeometry(0.055, 0.022, 1.2, 10);
  const rollerMat = material(theme.roller, { roughness: 0.35, metalness: 0.45 });
  for (let i = 0; i < rollerCount; i += 1) {
    const th = th1 + (i / (rollerCount - 1)) * sweep;
    const roller = new THREE.Mesh(rollerGeo, rollerMat);
    roller.castShadow = false;
    // 摆位必须放在外层 rig 上：Euler XYZ 序下 R = Rx·Ry·Rz，rotation.y 在 Rz 外层，
    // 直接写 rotation.set(π/2, 0, β) 再累加 rotation.y 会把摆好的轴一起转走（滚筒翻跟头）。
    // rig 只负责摆位（Rx(π/2)·Rz(θ−π/2) 把本体 +Y 摆到径向），自转留给 roller.rotation.y。
    const rig = new THREE.Object3D();
    rig.rotation.set(Math.PI / 2, 0, th - Math.PI / 2);
    rig.position.set(cx + (R + 0.05) * Math.cos(th), rollerCenterY, cz + (R + 0.05) * Math.sin(th));
    rig.add(roller);
    rollers.push(roller);
    group.add(rig);
  }

  // 支腿：沿外缘三处
  const legTopY = deckBottom - 0.02;
  const legHeight = Math.max(0.08, legTopY - groundY);
  const legCenterY = (legTopY + groundY) / 2;
  for (const th of [th1, thM, th2]) {
    group.add(
      at(
        cyl(0.045, legHeight, theme.frameDark, 8, { roughness: 0.7 }),
        cx + (rOut - 0.18) * Math.cos(th),
        legCenterY,
        cz + (rOut - 0.18) * Math.sin(th),
      ),
    );
  }

  // 内侧角柱：兼支腿与内导向，顶端挂状态灯（灯不挡货）
  const postTop = deckTop + 0.5;
  group.add(at(cyl(0.05, Math.max(0.08, postTop - groundY), theme.frame, { roughness: 0.6 }), cx, (postTop + groundY) / 2, cz));
  const lamp = statusLamp(postTop + 0.06, theme);
  lamp.position.x = cx;
  lamp.position.z = cz;
  group.add(lamp);

  // 流向箭头：贴外缘，避开货物包络（货半宽 0.3，只占到半径 1.0）
  const arrowGeo = new THREE.ConeGeometry(0.06, 0.2, 4);
  const arrowMat = material(theme.accent, { roughness: 0.45 });
  for (let i = 0; i < 3; i += 1) {
    const th = th1 + ((i + 0.5) / 3) * sweep;
    // 行进切向 = σ·(−sinθ, 0, cosθ)；Rx(−π/2)·Rz(β) 把本体 +Y 摆到切向，β = atan2(−tx, −tz)
    const tx = sigma * -Math.sin(th);
    const tz = sigma * Math.cos(th);
    const arrow = new THREE.Mesh(arrowGeo, arrowMat);
    arrow.rotation.set(-Math.PI / 2, 0, Math.atan2(-tx, -tz));
    arrow.position.set(cx + (rOut - 0.2) * Math.cos(th), deckTop + 0.03, cz + (rOut - 0.2) * Math.sin(th));
    group.add(arrow);
  }

  group.userData.anim = { kind: 'transport', rollers, rollerSign: sigma, statusLight: lamp.material as THREE.MeshStandardMaterial } as EntityAnim;
  return group;
}

/** 一条皮带上每隔多少米排一个人字形箭头。 */
const BELT_ARROW_SPACING = 1.1;

/**
 * 皮带横断面的比例（相对带宽 W）——直段 buildConveyor 和折线 buildBeltPath **必须共用**，
 * 否则同一条线上"直段宽、拐弯窄"，接缝处会像两条不同规格的带子。
 *
 * 撑满 1.0 会让皮带边缘啃进挡板、弯道内侧还会自交（内缘半径 = R − W/2·ratio ≤ 0），
 * 所以留 9%~18% 余量。自检：R=0.7、W=1.4 时皮带内缘 +0.126、台面 +0.070、挡板 +0.030。
 */
const BELT_SURFACE_RATIO = 0.82; // 皮带面（箭头的载体）
const BELT_DECK_RATIO = 0.9; // 台面底板
const BELT_ROLLER_RATIO = 0.84; // 滚筒长度

/** 折线中心线的采样点：位置 + 单位切向 + 带符号曲率 + 累积弧长。 */
interface BeltSample {
  x: number;
  z: number;
  /** 单位切向（XZ 平面），指向点列顺序方向。 */
  tx: number;
  tz: number;
  /** 带符号曲率：dt/ds 在"右法向"(tz, −tx) 上的投影。直段为 0。 */
  k: number;
  /** 从起点起的累积弧长（米）。 */
  s: number;
}

/**
 * 折线倒圆：把每个拐角替换成半径 `radius` 的圆弧，返回密化后的中心线点列。
 * 同时给出主转弯方向 `sigma`（+1 外法向取右法向，−1 取左法向）——整条线
 * 所有滚筒必须共用它，否则自转方向会前后打架。
 */
function beltCenterline(
  path: readonly unknown[],
  radius: number,
  arcSegments = 14,
): { points: { x: number; z: number }[]; sigma: number } {
  const pts: [number, number][] = [];
  for (const raw of path) {
    if (Array.isArray(raw) && typeof raw[0] === 'number' && typeof raw[1] === 'number') {
      pts.push([raw[0], raw[1]]);
    }
  }
  const asPoints = pts.map(([px, pz]) => ({ x: px, z: pz }));
  if (pts.length < 3) return { points: asPoints, sigma: 1 };

  const out: { x: number; z: number }[] = [];
  const push = (x: number, z: number): void => {
    const last = out[out.length - 1];
    if (last && Math.hypot(x - last.x, z - last.z) < 1e-6) return;
    out.push({ x, z });
  };
  push(pts[0]![0], pts[0]![1]);

  let sweepSign = 0;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1]!;
    const corner = pts[i]!;
    const next = pts[i + 1]!;
    const lu = Math.hypot(corner[0] - prev[0], corner[1] - prev[1]);
    const lv = Math.hypot(next[0] - corner[0], next[1] - corner[1]);
    if (lu < 1e-6 || lv < 1e-6) continue;
    const ux = (corner[0] - prev[0]) / lu;
    const uz = (corner[1] - prev[1]) / lu;
    const vx = (next[0] - corner[0]) / lv;
    const vz = (next[1] - corner[1]) / lv;
    const half = Math.acos(Math.max(-1, Math.min(1, ux * vx + uz * vz))) / 2;
    if (Math.sin(half) < 1e-6) {
      push(corner[0], corner[1]); // 共线，不用倒圆
      continue;
    }
    // 切点到拐点的距离。调用方保证每个拐两侧段长都 ≥ radius（场景模板按
    // "模块让位半个带宽"铺线，天然满足），所以这里只夹到段长本身，
    // 不再额外打折——否则末段恰好等于 radius 时圆角会被悄悄缩小，跟下一条线对不上缝。
    const t = Math.min(radius / Math.tan(half), lu, lv);
    const r = t * Math.tan(half);
    const bx = vx - ux;
    const bz = vz - uz;
    const lb = Math.hypot(bx, bz);
    if (lb < 1e-6) {
      push(corner[0], corner[1]);
      continue;
    }
    const cx = corner[0] + (r / Math.sin(half)) * (bx / lb);
    const cz = corner[1] + (r / Math.sin(half)) * (bz / lb);
    const t1x = corner[0] - ux * t;
    const t1z = corner[1] - uz * t;
    const t2x = corner[0] + vx * t;
    const t2z = corner[1] + vz * t;
    push(t1x, t1z);
    const a1 = Math.atan2(t1z - cz, t1x - cx);
    const a2 = Math.atan2(t2z - cz, t2x - cx);
    let sweep = a2 - a1;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    if (sweepSign === 0 && Math.abs(sweep) > 1e-6) sweepSign = sweep > 0 ? 1 : -1;
    for (let k = 1; k < arcSegments; k += 1) {
      const a = a1 + (k / arcSegments) * sweep;
      push(cx + r * Math.cos(a), cz + r * Math.sin(a));
    }
    push(t2x, t2z);
  }
  const tail = pts[pts.length - 1]!;
  push(tail[0], tail[1]);
  return { points: out, sigma: sweepSign === 0 ? 1 : sweepSign };
}

/** 给中心线补切向、曲率与累积弧长。 */
function beltSamples(points: readonly { x: number; z: number }[]): BeltSample[] {
  const n = points.length;
  const out: BeltSample[] = [];
  let s = 0;
  for (let i = 0; i < n; i += 1) {
    const p = points[i]!;
    if (i > 0) s += Math.hypot(p.x - points[i - 1]!.x, p.z - points[i - 1]!.z);
    const a = points[Math.max(0, i - 1)]!;
    const b = points[Math.min(n - 1, i + 1)]!;
    let tx = b.x - a.x;
    let tz = b.z - a.z;
    const len = Math.hypot(tx, tz);
    if (len < 1e-6) {
      tx = 1;
      tz = 0;
    } else {
      tx /= len;
      tz /= len;
    }
    // 曲率在下面的第二遍扫描里填（要用到已算好的切向与弧长）
    out.push({ x: p.x, z: p.z, tx, tz, k: 0, s });
  }
  // 曲率单独扫一遍（要用到已算好的切向与弧长）
  for (let i = 0; i < n; i += 1) {
    const prev = out[Math.max(0, i - 1)]!;
    const next = out[Math.min(n - 1, i + 1)]!;
    const ds = next.s - prev.s;
    if (ds < 1e-6) continue;
    const dtx = (next.tx - prev.tx) / ds;
    const dtz = (next.tz - prev.tz) / ds;
    const me = out[i]!;
    me.k = dtx * me.tz + dtz * -me.tx;
  }
  return out;
}

/** 沿中心线按固定间距走一遍，返回插值出的采样点（用来摆滚筒/支腿）。 */
function beltWalk(samples: readonly BeltSample[], pitch: number, start: number): BeltSample[] {
  const out: BeltSample[] = [];
  let target = start;
  for (let i = 0; i < samples.length - 1; i += 1) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    const segLen = b.s - a.s;
    if (segLen <= 1e-9) continue;
    while (target <= b.s + 1e-9) {
      const f = (target - a.s) / segLen;
      out.push({
        x: a.x + (b.x - a.x) * f,
        z: a.z + (b.z - a.z) * f,
        tx: a.tx,
        tz: a.tz,
        k: a.k,
        s: target,
      });
      target += pitch;
    }
  }
  return out;
}

/**
 * 沿中心线扫掠出一条水平带（皮带面 / 台面底板）。
 * UV.x = 弧长 × uvScale，所以箭头间距恒定、且一定顺着 path 指。
 */
function beltRibbonGeometry(
  samples: readonly BeltSample[],
  halfWidth: number,
  y: number,
  uvScale: number,
): THREE.BufferGeometry {
  const n = samples.length;
  const pos = new Float32Array(n * 6);
  const uv = new Float32Array(n * 4);
  const idx: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const p = samples[i]!;
    const nx = -p.tz * halfWidth;
    const nz = p.tx * halfWidth;
    const a = i * 2;
    const b = i * 2 + 1;
    pos[a * 3] = p.x + nx;
    pos[a * 3 + 1] = y;
    pos[a * 3 + 2] = p.z + nz;
    pos[b * 3] = p.x - nx;
    pos[b * 3 + 1] = y;
    pos[b * 3 + 2] = p.z - nz;
    uv[a * 2] = p.s * uvScale;
    uv[a * 2 + 1] = 1;
    uv[b * 2] = p.s * uvScale;
    uv[b * 2 + 1] = 0;
    if (i < n - 1) idx.push(a, a + 2, b, b, a + 2, b + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** 沿中心线扫掠出一条竖直带（两侧挡板）。 */
function beltWallGeometry(
  samples: readonly BeltSample[],
  offset: number,
  y0: number,
  y1: number,
): THREE.BufferGeometry {
  const n = samples.length;
  const pos = new Float32Array(n * 6);
  const idx: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const p = samples[i]!;
    const x = p.x + -p.tz * offset;
    const z = p.z + p.tx * offset;
    const a = i * 2;
    const b = i * 2 + 1;
    pos[a * 3] = x;
    pos[a * 3 + 1] = y0;
    pos[a * 3 + 2] = z;
    pos[b * 3] = x;
    pos[b * 3 + 1] = y1;
    pos[b * 3 + 2] = z;
    if (i < n - 1) idx.push(a, a + 2, b, b, a + 2, b + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * 折线输送线：一段线自带 90° 拐。
 *
 * 与"直段 + 独立弯道模块"的区别是皮带面一整条扫掠出来的（连续、无缝、无同高叠面），
 * 箭头 UV 按弧长走，所以它必然顺着 path 指；滚筒在拐弯处自动换成锥形（内侧细），
 * 且所有滚筒共用同一套朝向约定，自转方向不会前后打架。
 */
function buildBeltPath(
  path: readonly unknown[],
  width: number,
  color: string,
  baseY: number,
  direction: number,
  radius: number,
): THREE.Group {
  const theme = getActiveTheme();
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildBeltPath';
  const { points, sigma } = beltCenterline(path, radius);
  if (points.length < 2) return buildConveyor(width, width, color, baseY, 'belt', direction);
  const center = beltSamples(points);
  const halfW = width / 2;
  const groundY = -baseY;
  const deckTop = 0.3;
  const deckBottom = 0.2;
  const rollerCenterY = deckTop - 0.05;

  // 台面底板
  const deck = new THREE.Mesh(
    beltRibbonGeometry(center, halfW * BELT_DECK_RATIO, deckBottom - 0.02, 0),
    material(theme.frameDark, { roughness: 0.7 }),
  );
  deck.receiveShadow = true;
  group.add(deck);

  // 皮带面：UV.x 以"米 / 箭头间距"为单位，repeat 传 1
  const belt = new THREE.Mesh(
    beltRibbonGeometry(center, halfW * BELT_SURFACE_RATIO, deckTop + 0.005, 1 / BELT_ARROW_SPACING),
    beltMaterial(theme, direction, 1),
  );
  belt.renderOrder = 2;
  belt.castShadow = false;
  belt.receiveShadow = false;
  group.add(belt);

  // 两侧挡板（双面可见，内外都挡）
  const wallMat = material(theme.frame, { roughness: 0.6 });
  wallMat.side = THREE.DoubleSide;
  for (const side of [1, -1]) {
    const wall = new THREE.Mesh(
      beltWallGeometry(center, side * (halfW - 0.03), deckBottom - 0.03, deckBottom + 0.04),
      wallMat,
    );
    wall.castShadow = true;
    group.add(wall);
  }

  // 滚筒：直段直筒、拐弯段锥形（内侧细，否则靠圆心那端互相啃）
  const rollers: THREE.Mesh[] = [];
  const straightGeo = new THREE.CylinderGeometry(0.05, 0.05, width * BELT_ROLLER_RATIO, 10);
  const taperGeo = new THREE.CylinderGeometry(0.055, 0.022, width * BELT_ROLLER_RATIO, 10);
  const rollerMat = material(theme.roller, { roughness: 0.35, metalness: 0.45 });
  for (const sm of beltWalk(center, 0.28, 0.2)) {
    const mesh = new THREE.Mesh(Math.abs(sm.k) > 0.05 ? taperGeo : straightGeo, rollerMat);
    mesh.castShadow = false;
    // 外法向 Ô = σ·右法向 = σ·(tz, −tx)；Rz(β) 后 Rx(π/2) 把本体 +Y 摆到 (−sinβ, 0, cosβ)
    const ox = sigma * sm.tz;
    const oz = sigma * -sm.tx;
    const rig = new THREE.Object3D();
    rig.rotation.set(Math.PI / 2, 0, Math.atan2(-ox, oz));
    rig.position.set(sm.x, rollerCenterY, sm.z);
    rig.add(mesh);
    rollers.push(mesh);
    group.add(rig);
  }

  // 支腿：沿路径每 1.35m 一组，落在带子两侧
  const legTopY = deckBottom - 0.04;
  const legHeight = Math.max(0.08, legTopY - groundY);
  const legCenterY = (legTopY + groundY) / 2;
  for (const sm of beltWalk(center, 1.35, 0.6)) {
    for (const side of [1, -1]) {
      group.add(
        at(
          cyl(0.045, legHeight, theme.frameDark, 8, { roughness: 0.7 }),
          sm.x + -sm.tz * side * (halfW - 0.12),
          legCenterY,
          sm.z + sm.tx * side * (halfW - 0.12),
        ),
      );
    }
  }

  // 状态灯：立在线中点外侧，不挡货
  const mid = center[Math.floor(center.length / 2)]!;
  const postTop = deckTop + 0.5;
  const side = sigma;
  group.add(
    at(
      cyl(0.05, Math.max(0.08, postTop - groundY), theme.frame, { roughness: 0.6 }),
      mid.x + -mid.tz * side * (halfW + 0.3),
      (postTop + groundY) / 2,
      mid.z + mid.tx * side * (halfW + 0.3),
    ),
  );
  const lamp = statusLamp(postTop + 0.06, theme);
  lamp.position.set(
    mid.x + -mid.tz * side * (halfW + 0.3),
    postTop + 0.06,
    mid.z + mid.tx * side * (halfW + 0.3),
  );
  group.add(lamp);

  // rollerSign：+Y 取外法向时，σ 决定自转正负，再乘行进方向
  group.userData.anim = {
    kind: 'transport',
    belt: belt.material as THREE.ShaderMaterial,
    rollers,
    rollerSign: sigma * direction,
    statusLight: lamp.material as THREE.MeshStandardMaterial,
  } as EntityAnim;
  return group;
}

// ─────────────────────────────────────────────────────────────────────────
// 台钓钓组（漂语插件）
// ─────────────────────────────────────────────────────────────────────────
// 真实台钓的漂 / 钩 / 饵是厘米级，放进 2m 深的水里根本看不清。这里是**示意比例**
// （漂总长 ~0.9m），位置仍严格来自 fishingLayout（米）——尺寸只影响"看不看得清"，
// 不影响仿真，几何与行为共用同一套坐标。

/** 漂尾目数：红 / 黑相间的短节，数得出来才叫"看得清目"。 */
const FLOAT_MARKS = 5;
const FLOAT_MARK_H = 0.08;
const FLOAT_TAIL_R = 0.028;
const FLOAT_BODY_R = 0.075;
const FLOAT_BODY_H = 0.3;
const FLOAT_STEM_H = 0.2;
const SINKER_R = 0.045;
const SINKER_H = 0.11;
const HOOK_R = 0.06;
const HOOK_TUBE = 0.018;
const HOOK_SHANK_H = HOOK_R * 2.2;
const BAIT_R = 0.07;
/**
 * 仿真里钩和饵是同一个点（饵挂在钩上），实体位置 = 钩门底部。
 * 钩柄在 +X 侧、钩尖在 −X 侧；饵穿在钩尖上并往外偏半个饵径，
 * 这样既"挂在钩上"，又不会把钩柄和钩门整个盖住。
 */
const HOOK_SHANK_X = HOOK_R;
const HOOK_POINT_X = -HOOK_R;
const BAIT_DX = HOOK_POINT_X - BAIT_R * 0.55;
/** 线的半径：按真实粗细缩下去就没了，这里给到缩放后仍看得出是一条线。 */
const FISHING_LINE_R = 0.022;

/** 浮漂：漂尾（红 / 黑目节）+ 漂身（纺锤）+ 漂脚。 */
function buildFloat(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildFloat';
  // 零件都挂在内层枢轴上：漂相动作只动枢轴，实体位置仍是内核给的静止位。
  const pivot = new THREE.Group();
  group.add(pivot);

  const body = new THREE.Mesh(new THREE.SphereGeometry(FLOAT_BODY_R, 14, 12), material(color, { roughness: 0.32 }));
  body.scale.set(1, FLOAT_BODY_H / (FLOAT_BODY_R * 2), 1);
  body.castShadow = true;
  pivot.add(body);

  const tailBottom = FLOAT_BODY_H / 2;
  for (let index = 0; index < FLOAT_MARKS; index += 1) {
    const bandColor = index % 2 === 0 ? '#e63946' : '#1f2933';
    pivot.add(at(cyl(FLOAT_TAIL_R, FLOAT_MARK_H, bandColor, 10, { roughness: 0.35 }), 0, tailBottom + FLOAT_MARK_H * (index + 0.5), 0));
  }

  pivot.add(at(cyl(FLOAT_TAIL_R, FLOAT_STEM_H, '#5b6472', 8, { roughness: 0.4 }), 0, -FLOAT_BODY_H / 2 - FLOAT_STEM_H / 2, 0));
  // 漂座在漂脚末端：主线从这里穿过，上接竿梢、下接铅皮座，不穿漂身。
  group.userData.lineAnchor = [0, -FLOAT_BODY_H / 2 - FLOAT_STEM_H, 0];
  group.userData.lineAnchorPivot = pivot;
  group.userData.anim = { kind: 'float' } as EntityAnim;
  return group;
}

/** 铅坠：铅皮座缠一圈铅皮，做成一节深色圆柱。 */
function buildSinker(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildSinker';
  // 内层枢轴：随主线上下 / 走铅时平躺，只动枢轴，实体位置仍是内核给的值。
  const pivot = new THREE.Group();
  group.add(pivot);
  pivot.add(cyl(SINKER_R, SINKER_H, color, 12, { roughness: 0.45, metalness: 0.55 }));
  group.userData.lineAnchorPivot = pivot;
  return group;
}

/**
 * 鱼钩：钩柄 + 半圆钩门（Torus 下半圈）+ 钩尖短刺。
 * 钩柄立在钩门的 +X 端（不是钩门中间），柄顶是钩眼——子线系在这里。
 */
function buildHook(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildHook';
  // 零件挂在内层枢轴上：朝向 / 被鱼拖拽只动枢轴，实体位置仍是内核给的值。
  const pivot = new THREE.Group();
  group.add(pivot);
  const metal = { roughness: 0.3, metalness: 0.65 };
  // 钩门圆心抬高 HOOK_R，让实体位置落在钩门最低点（饵 / 钩触底时贴着底）。
  const bendY = HOOK_R;
  const bend = new THREE.Mesh(new THREE.TorusGeometry(HOOK_R, HOOK_TUBE, 10, 20, Math.PI), material(color, metal));
  bend.rotation.z = Math.PI;
  bend.castShadow = true;
  pivot.add(at(bend, 0, bendY, 0));
  pivot.add(at(cyl(HOOK_TUBE, HOOK_SHANK_H, color, 10, metal), HOOK_SHANK_X, bendY + HOOK_SHANK_H / 2, 0));
  const point = new THREE.Mesh(new THREE.ConeGeometry(HOOK_TUBE * 1.3, HOOK_R * 0.7, 8), material(color, metal));
  pivot.add(at(point, HOOK_POINT_X, bendY + HOOK_R * 0.35, 0));
  group.userData.lineAnchor = [HOOK_SHANK_X, bendY + HOOK_SHANK_H, 0];
  group.userData.lineAnchorPivot = pivot;
  return group;
}

/** 饵：一小团，穿在钩尖上（搓饵 / 拉饵都这样示意）。 */
function buildBait(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildBait';
  // 与钩同构的枢轴：控制器给钩和饵写同一个姿态，饵始终穿在钩尖上。
  const pivot = new THREE.Group();
  group.add(pivot);
  pivot.add(at(sphere(BAIT_R, color, { roughness: 0.75 }), BAIT_DX, HOOK_R * 0.9, 0));
  group.userData.lineAnchorPivot = pivot;
  return group;
}

/**
 * 水面 / 水体：半透明体块，上表面就是水面（实体 position 是水体中心）。
 * 顶部叠一层更亮的薄板当"水面高光"，让水面读得出一个平面而不是盒子的侧面。
 * 透明件不投影也不收影，否则水下钓组会被自己的水面阴影糊掉。
 */
function buildWater(size: TwinVector3, color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildWater';
  const body = rbox(size[0], size[1], size[2], color, { roughness: 0.12, metalness: 0.05, opacity: 0.26 });
  body.castShadow = false;
  body.receiveShadow = false;
  group.add(body);
  const surface = rbox(size[0] * 0.995, 0.04, size[2] * 0.995, '#9fd3e8', { roughness: 0.18, opacity: 0.5 });
  surface.position.y = size[1] / 2 - 0.02;
  surface.castShadow = false;
  surface.receiveShadow = false;
  group.add(surface);
  // 水体下半层压一块更深的色：浅处透、深处暗，读得出"有深度"而不是一块均匀玻璃。
  const deep = rbox(size[0] * 0.99, size[1] * 0.5, size[2] * 0.99, '#123f5c', { roughness: 0.3, opacity: 0.22 });
  deep.position.y = -size[1] / 4;
  deep.castShadow = false;
  deep.receiveShadow = false;
  group.add(deep);
  // 漂落点的涟漪：三圈白环错相扩散、淡出（每圈独占材质，才能各自改透明度）。
  const ripples: NonNullable<EntityAnim['ripples']> = [];
  for (let index = 0; index < 3; index += 1) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 8, 48), material('#ffffff', { roughness: 0.25, opacity: 0.5 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = size[1] / 2 + 0.008;
    ring.castShadow = false;
    ring.receiveShadow = false;
    group.add(ring);
    ripples.push({ mesh: ring, phase: index / 3, maxRadius: 0.9, period: 3.6 });
  }
  group.userData.anim = { kind: 'water', ripples } as EntityAnim;
  return group;
}

/** 鱼竿长度（示意比例，够长才像"竿指水面"）。 */
const ROD_LENGTH = 2.6;

/**
 * 鱼竿：锥形竿身 + 握把。竿身以实体位置为中心、沿 +Y 摆放，再整体转向竿梢。
 *
 * 模板声明 tipOffset（竿梢相对竿中心的偏移）时，竿长 = 2·|tipOffset|、朝向 = tipOffset，
 * 竿尖恰好落在竿梢导线环上——主线从竿梢出发才连得上。未声明时退回固定长度与斜角。
 */
function buildRod(color: string, config?: Record<string, unknown>): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildRod';
  const offset = config?.tipOffset;
  const dir =
    Array.isArray(offset) && offset.length === 3
      ? new THREE.Vector3(offset[0] as number, offset[1] as number, offset[2] as number)
      : undefined;
  const declared = dir !== undefined && dir.lengthSq() > 1e-9;
  const length = declared ? dir.length() * 2 : ROD_LENGTH;

  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.035, length, 10), material(color, { roughness: 0.55 }));
  rod.castShadow = true;
  group.add(rod);
  // 握把套在竿根上（在竿身长度之内），不再伸出竿根之外。
  const gripH = 0.45;
  const grip = cyl(0.042, gripH, '#3b2f2a', 10, { roughness: 0.85 });
  grip.position.y = -length / 2 + gripH / 2;
  grip.castShadow = true;
  group.add(grip);

  if (declared) {
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return group;
  }
  group.rotation.z = 0.62;
  group.rotation.y = -0.55;
  return group;
}

/** 水底泥沙：贴地薄板 + 几颗鹅卵石，透过半透明水体看得见才有"底"。 */
function buildPondBottom(size: TwinVector3, color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildPondBottom';
  const slab = rbox(size[0], size[1], size[2], color, { roughness: 0.95 });
  slab.castShadow = false;
  slab.receiveShadow = false;
  group.add(slab);
  const pebbles: [number, number, number, number][] = [
    [-1.2, 0.6, 0.09],
    [0.7, -0.9, 0.07],
    [1.5, 1.1, 0.11],
  ];
  for (const [x, z, r] of pebbles) {
    const pebble = sphere(r, '#c2ab84', { roughness: 0.9 });
    pebble.position.set(x, size[1] / 2 + r * 0.5, z);
    pebble.castShadow = false;
    group.add(pebble);
  }
  return group;
}

/** 水草：一丛高低错落的细锥，带轻微倾角，贴在水底。 */
function buildWeed(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildWeed';
  const sway: NonNullable<EntityAnim['sway']> = [];
  for (let index = 0; index < 6; index += 1) {
    const height = 0.22 + ((index * 37) % 23) / 100;
    const blade = new THREE.Mesh(new THREE.ConeGeometry(0.03, height, 6), material(color, { roughness: 0.7 }));
    blade.position.set((index - 2.5) * 0.09, height / 2, ((index % 3) - 1) * 0.05);
    blade.rotation.z = index % 2 === 0 ? 0.12 : -0.09;
    blade.castShadow = false;
    // 锥体绕自身中心转会"飘"，把几何下移让转轴落在根部，叶片才是从底上摆。
    blade.geometry.translate(0, height / 2, 0);
    blade.position.y = 0;
    group.add(blade);
    sway.push({ mesh: blade, axis: 'z', base: blade.rotation.z, amp: 0.1, speed: 1.1 + index * 0.13, phase: index * 0.9 });
  }
  group.userData.anim = { kind: 'weed', sway } as EntityAnim;
  return group;
}

/**
 * 鱼影：压扁的纺锤身 + 尾鳍 + 背鳍，深灰蓝剪影色。
 * 位置固定（不做游动行为——装饰一动，确定性回放就得给鱼也上快照）；
 * 摆尾只是渲染层按渲染时钟做的表现，不写世界状态。
 */
function buildFish(color: string, size: TwinVector3): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildFish';
  const radius = Math.max(0.08, size[1]);
  const body = sphere(radius, color, { roughness: 0.45 });
  body.scale.set(1.35, 0.55, 0.42);
  body.castShadow = false;
  group.add(body);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.55, radius * 1.1, 8), material(color, { roughness: 0.5 }));
  tail.rotation.z = Math.PI / 2;
  tail.position.x = -radius * 0.55;
  tail.castShadow = false;
  // 尾鳍挂在尾柄枢轴上：摆的是枢轴，尾鳍绕尾柄甩，而不是绕自身中心转。
  const tailPivot = new THREE.Group();
  tailPivot.position.x = -radius * 1.0;
  tailPivot.add(tail);
  group.add(tailPivot);
  const fin = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.3, radius * 0.6, 6), material(color, { roughness: 0.5 }));
  fin.position.set(radius * 0.1, radius * 0.62, 0);
  fin.rotation.x = Math.PI / 4;
  fin.castShadow = false;
  group.add(fin);
  // 只摆尾、身体轻晃：鱼停在固定位置（装饰没有行为），但看起来是活的。
  const phase = size[0] * 17;
  group.userData.anim = {
    kind: 'fish',
    sway: [
      { mesh: tailPivot, axis: 'y', base: 0, amp: 0.45, speed: 5.5, phase },
      { mesh: body, axis: 'y', base: 0, amp: 0.05, speed: 5.5, phase: phase + Math.PI },
    ],
  } as EntityAnim;
  return group;
}

/** 岸坡：一圈比水体大的沙土垫片，把"水体悬在地面网格上"变成"池子嵌在岸里"。 */
function buildShore(size: TwinVector3, color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildShore';
  const pad = rbox(size[0], size[1], size[2], color, { roughness: 0.95 });
  pad.castShadow = false;
  pad.receiveShadow = true;
  group.add(pad);
  return group;
}

/** 钓台：钓箱 + 支脚，摆在岸边的标志性道具，钓竿从它后面伸出去。 */
function buildPlatform(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildPlatform';
  const box = rbox(0.62, 0.34, 0.45, color, { roughness: 0.5 });
  box.position.y = 0.32;
  box.castShadow = true;
  group.add(box);
  for (const [x, z] of [
    [-0.24, -0.15],
    [0.24, -0.15],
    [-0.24, 0.15],
    [0.24, 0.15],
  ] as const) {
    const leg = cyl(0.028, 0.3, '#4a4a4a', 8, { roughness: 0.6, metalness: 0.4 });
    leg.position.set(x, 0.15, z);
    group.add(leg);
  }
  return group;
}

/** 芦苇：几根细秆 + 穗头，插在岸边，给空旷的背景一点层次。 */
function buildReed(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildReed';
  for (let index = 0; index < 5; index += 1) {
    const height = 0.7 + ((index * 29) % 40) / 100;
    const stalk = cyl(0.012, height, '#6f8f4f', 6, { roughness: 0.8 });
    stalk.position.set((index - 2) * 0.07, height / 2, ((index % 2) - 0.5) * 0.06);
    stalk.rotation.z = ((index % 3) - 1) * 0.06;
    group.add(stalk);
    const head = cyl(0.024, 0.14, color, 6, { roughness: 0.85 });
    head.position.set((index - 2) * 0.07 + ((index % 3) - 1) * 0.06 * height * 0.5, height + 0.06, ((index % 2) - 0.5) * 0.06);
    group.add(head);
  }
  return group;
}

/**
 * 逻辑钓组：参数与观察的载体，本身不画实体——但**线**由它提供。
 *
 * 主线 / 子线是动态的（两端实体每帧都在动），所以这里只准备单位长的圆柱段，
 * 由控制器每帧按两端位置拉伸与转向。端点 id 与 fishingTemplate 的实体 id 对齐
 * （钓场是固定模板）。
 */
/** 每根子线的分段数：够多才读得出"弧"而不是折线，又不至于每帧摆太多段。 */
const SUBLINE_SEGMENTS = 6;

function buildRigMarker(): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildRig';

  // 拓扑与 rigPosture.RIG_LINKS 一致（钓场是固定模板，实体 id 直接写死）：
  //   主线：竿梢 → 浮漂 → 铅坠 → 8 字环（直线段）
  //   子线：8 字环 → 上钩 / 下钩（两根**并联**，钝了子线松开 → 各拆成 2 段折线）
  const mainLines: [string, string][] = [
    ['rod-tip-01', 'float-01'],
    ['float-01', 'sinker-01'],
    ['sinker-01', 'swivel-01'],
  ];
  // 子线各分 SUBLINE_SEGMENTS 截，共用同一对端点；控制器按弯曲量沿曲线摆每一截。
  const branchLines: { fromId: string; toId: string; bendAttr: 'bendUpper' | 'bendLower' }[] = [
    { fromId: 'swivel-01', toId: 'hook-upper-01', bendAttr: 'bendUpper' },
    { fromId: 'swivel-01', toId: 'hook-lower-01', bendAttr: 'bendLower' },
  ];
  const rigId = 'rig-01';

  const fishingLines: {
    mesh: THREE.Mesh;
    fromId: string;
    toId: string;
    bendAttr?: 'bendUpper' | 'bendLower';
    segment?: { index: number; count: number };
    rigId?: string;
  }[] = [];

  for (const [fromId, toId] of mainLines) {
    const mesh = cyl(FISHING_LINE_R, 1, '#f8f9fa', 8, { roughness: 0.5 });
    mesh.castShadow = false;
    group.add(mesh);
    fishingLines.push({ mesh, fromId, toId });
  }
  for (const { fromId, toId, bendAttr } of branchLines) {
    for (let index = 0; index < SUBLINE_SEGMENTS; index += 1) {
      const mesh = cyl(FISHING_LINE_R * 0.78, 1, '#cfd6dd', 8, { roughness: 0.5 });
      mesh.castShadow = false;
      group.add(mesh);
      fishingLines.push({ mesh, fromId, toId, bendAttr, segment: { index, count: SUBLINE_SEGMENTS }, rigId });
    }
  }
  // 咬钩的鱼：平时隐藏，有口时由控制器摆到下钩饵旁（嘴含饵、身子朝外），随拖拽一起走。
  const biter = buildFish('#4f5d66', [0.3, 0.12, 0.08]);
  biter.userData.codePath = 'entityMeshes.ts:buildRig:biter';
  biter.visible = false;
  group.add(biter);
  group.userData.anim = { kind: 'fishing-rig', fishingLines, biter } as EntityAnim;
  return group;
}

/** 8 字环：主线与两根子线的分叉点，一个小金属环。 */
function buildSwivel(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildSwivel';
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.007, 8, 16), material(color, { roughness: 0.35, metalness: 0.7 }));
  ring.castShadow = false;
  // 内层枢轴：随主线上下；两根子线与主线都挂在它上面。
  const pivot = new THREE.Group();
  group.add(pivot);
  pivot.add(ring);
  group.userData.lineAnchorPivot = pivot;
  return group;
}

/** 竿梢导线环：主线（RIG_LINKS 第一段）起点，套在竿尖上的小环。 */
function buildRodTip(color: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.codePath = 'entityMeshes.ts:buildRodTip';
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.006, 8, 14), material(color, { roughness: 0.4, metalness: 0.6 }));
  ring.castShadow = false;
  group.add(ring);
  return group;
}

/** 按实体类型生成模型；未知类型退回货箱，保证外部数据源补出来的实体不会消失。 */
export function buildEntityMesh(entity: EntityMeshInput): THREE.Group {
  const size = entity.visual?.size ?? [0.7, 0.7, 0.7];
  const color = entity.visual?.color ?? '#94a3b8';
  const baseY = entity.transform.position[1] ?? 0;

  switch (entity.kind) {
    case 'transport': {
      // 箭头方向由场景模板用 `config.beltDirection` 声明（沿行进方向为 +1）。
      const raw = entity.config?.beltDirection;
      const direction = typeof raw === 'number' && raw < 0 ? -1 : 1;
      // 带 `config.beltPath` 的是"一条线自带拐弯"的折线输送线（连续的 90° 弯道）。
      const path = entity.config?.beltPath;
      if (Array.isArray(path) && path.length >= 2) {
        const beltWidth = typeof entity.config?.beltWidth === 'number' ? (entity.config.beltWidth as number) : size[0];
        const beltRadius = typeof entity.config?.beltRadius === 'number' ? (entity.config.beltRadius as number) : beltWidth / 2;
        return buildBeltPath(path, beltWidth, color, baseY, direction, beltRadius);
      }
      // 走向按 `config.beltAxis` 的声明来；老场景没声明时退回尺寸比较（不推荐）。
      const declared = entity.config?.beltAxis;
      const axis = declared === 'z' || declared === 'x' ? declared : size[2] > size[0] ? 'z' : 'x';
      return buildConveyor(size[0], size[2], color, baseY, entity.id, direction, axis);
    }
    case 'inspect':
      return buildInspection(size, color, baseY);
    case 'buffer':
      return buildRack(size, color, baseY);
    case 'asrs':
      return buildAsrsRack(size, color, baseY, entity.config);
    case 'source':
      return buildSource(size, color, baseY);
    case 'pack':
      return buildPackingStation(size, color, baseY);
    case 'truck':
      return buildTruck(size, color, baseY);
    case 'stacker':
      return buildStacker(size, color, baseY);
    case 'carriage':
      return buildCarriage(size, color);
    case 'fork':
      return buildFork(size, color);
    case 'pallet':
      return buildPallet(size, color);
    case 'transfer': {
      // 流向与出货方向都由场景模板声明：主线东行为 +1，往 +Z 出货为 +1。
      const rawDir = entity.config?.beltDirection;
      const rawSign = entity.config?.divertSign;
      return buildTransfer(
        size,
        color,
        baseY,
        typeof rawDir === 'number' && rawDir < 0 ? -1 : 1,
        typeof rawSign === 'number' && rawSign > 0 ? 1 : -1,
      );
    }
    case 'cassette': {
      const rawSign = entity.config?.divertSign;
      return buildCassette(size, color, typeof rawSign === 'number' && rawSign > 0 ? 1 : -1);
    }
    case 'corner': {
      const din = travelDir(entity.config?.cornerIn) ?? ([1, 0] as [number, number]);
      const dout = travelDir(entity.config?.cornerOut) ?? ([0, -1] as [number, number]);
      return buildCurvedConveyor(size[0], size[2], color, baseY, din, dout);
    }
    case 'water':
      return buildWater(size, color);
    case 'pondBottom':
      return buildPondBottom(size, color);
    case 'shore':
      return buildShore(size, color);
    case 'rod':
      return buildRod(color, entity.config);
    case 'rodTip':
      return buildRodTip(color);
    case 'swivel':
      return buildSwivel(color);
    case 'platform':
      return buildPlatform(color);
    case 'reed':
      return buildReed(color);
    case 'weed':
      return buildWeed(color);
    case 'fish':
      return buildFish(color, size);
    case 'float':
      return buildFloat(color);
    case 'sinker':
      return buildSinker(color);
    case 'hook':
      return buildHook(color);
    case 'bait':
      return buildBait(color);
    case 'rig':
      return buildRigMarker();
    default:
      return buildCargo(size, color);
  }
}

/** 收集一个模型上所有标准材质，供选中高亮统一改 emissive。 */
export function collectMaterials(root: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const result: THREE.MeshStandardMaterial[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.material instanceof THREE.MeshStandardMaterial) result.push(mesh.material);
  });
  return result;
}

/** 递归释放一个模型的几何体与材质。 */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material.dispose();
  });
}

/** 给非实例化兜底用的货物色（实例化走 CargoPool 的颜色轮转）。 */
export function fallbackCargoColor(id: string): string {
  return cargoColorFor(getActiveTheme(), id);
}
