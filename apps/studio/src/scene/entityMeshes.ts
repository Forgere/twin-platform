import type { TwinVector3 } from '@twin-platform/world-kernel';
import * as THREE from 'three';

/**
 * 实体模型工厂：把一个 TwinEntity 的"声明"翻译成有造型的三维物件。
 *
 * 之前每个实体只有一个 BoxGeometry，设备全是一模一样的方块，看不出是什么。
 * 这里按 `kind` / id 前缀组合出可辨认的造型（参考 VividFactory 范例的做法）：
 * - transport：皮带台面 + 两侧护栏 + 一排滚筒 + 四根支腿（分拣台再挂一根推杆）
 * - inspect：跨在皮带上方的检测拱门（立柱 + 顶梁 + 半透明光幕 + 状态灯）
 * - buffer：货架（四立柱 + 层板 + 货位 + 顶灯），包装架比拒收架装得满
 * - 其余（parcel）：货物方块
 *
 * 这一层只负责"长什么样"，不保存任何业务真相：尺寸取自实体声明的 `visual.size`，
 * 颜色取自 `visual.color`，全部由场景模板决定。
 */

const FRAME = '#E8E4DC';
const FRAME_DARK = '#CFC7B8';
const METAL = '#A9A296';
const PEACH = '#F4A261';
const SKY = '#9FD8F0';
const CARGO_COLORS = ['#FFB7B2', '#B5EAD7', '#C7CEEA', '#FFDAC1', '#FDFD96'];

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

function boxMesh(width: number, height: number, depth: number, color: string, options?: MaterialOptions): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material(color, options));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cylinderMesh(radius: number, height: number, color: string, segments = 12, options?: MaterialOptions): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, segments), material(color, options));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function sphereMesh(radius: number, color: string, options?: MaterialOptions): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 10), material(color, options));
  mesh.castShadow = true;
  return mesh;
}

function at<T extends THREE.Object3D>(object: T, x: number, y: number, z: number): T {
  object.position.set(x, y, z);
  return object;
}

/** 输送段：台面 + 护栏 + 滚筒 + 支腿；分拣台额外挂一根推杆。 */
function buildConveyor(sizeX: number, sizeZ: number, color: string, baseY: number, id: string): THREE.Group {
  const group = new THREE.Group();
  // 皮带沿较长的那条水平边铺设：主输送段是沿 X 的长条，外部车道是沿 Z 的长条。
  const alongZ = sizeZ > sizeX;
  const length = alongZ ? sizeZ : sizeX;
  const width = alongZ ? sizeX : sizeZ;
  if (alongZ) group.rotation.y = Math.PI / 2;

  const deckHeight = 0.1;
  const deckCenterY = 0.25; // 局部坐标：台面中心（世界 y = baseY + 0.25）
  const deckBottom = deckCenterY - deckHeight / 2;

  // 皮带台面
  group.add(at(boxMesh(length * 0.98, deckHeight, width * 0.88, color, { roughness: 0.5 }), 0, deckCenterY, 0));

  // 两侧护栏
  const railThickness = 0.055;
  const railHeight = 0.11;
  for (const side of [-1, 1]) {
    group.add(
      at(
        boxMesh(length * 0.98, railHeight, railThickness, FRAME_DARK, { roughness: 0.55 }),
        0,
        deckCenterY + deckHeight / 2 + railHeight / 2 - 0.01,
        side * (width / 2 - railThickness / 2),
      ),
    );
  }

  // 一排滚筒（小件不投影，省开销）
  const rollerRadius = 0.055;
  const rollerCount = Math.max(2, Math.round(length / 0.34));
  for (let i = 0; i <= rollerCount; i += 1) {
    const x = -length / 2 + 0.12 + (i / rollerCount) * (length - 0.24);
    const roller = cylinderMesh(rollerRadius, width * 0.9, METAL, 10, { roughness: 0.35, metalness: 0.45 });
    roller.castShadow = false;
    roller.rotation.x = Math.PI / 2; // 圆柱默认沿 Y，转成沿 Z 横跨皮带
    group.add(at(roller, x, deckBottom - rollerRadius * 0.75, 0));
  }

  // 四根支腿 + 脚垫
  const legTop = deckBottom - 0.02;
  const legBottom = -baseY; // 局部坐标下地面所在高度
  const legHeight = Math.max(0.08, legTop - legBottom);
  const legCenterY = (legTop + legBottom) / 2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const legX = sx * (length / 2 - 0.28);
      const legZ = sz * (width / 2 - 0.16);
      group.add(at(cylinderMesh(0.05, legHeight, FRAME_DARK, 8, { roughness: 0.7 }), legX, legCenterY, legZ));
      const foot = boxMesh(0.16, 0.04, 0.16, FRAME, { roughness: 0.8 });
      foot.castShadow = false;
      group.add(at(foot, legX, legBottom + 0.02, legZ));
    }
  }

  // 分拣台：侧面加一根推杆，和别的输送段区分开
  if (id.startsWith('sorter')) {
    group.add(at(boxMesh(0.16, 0.16, 0.72, PEACH, { roughness: 0.5 }), 0, deckCenterY + 0.18, width / 2 + 0.22));
  }

  return group;
}

/** 检测站：跨在皮带上方的拱门 + 半透明光幕 + 状态灯。 */
function buildInspection(size: TwinVector3, color: string, baseY: number): THREE.Group {
  const group = new THREE.Group();
  const [width, height, depth] = size;
  const groundY = -baseY;
  const postHeight = height * 0.95;

  for (const side of [-1, 1]) {
    const z = side * (depth / 2 - 0.08);
    group.add(at(boxMesh(0.13, postHeight, 0.13, color, { roughness: 0.5 }), 0, groundY + postHeight / 2, z));
    const foot = boxMesh(0.26, 0.05, 0.26, FRAME_DARK, { roughness: 0.75 });
    foot.castShadow = false;
    group.add(at(foot, 0, groundY + 0.025, z));
  }

  const topY = groundY + postHeight;
  group.add(at(boxMesh(0.16, 0.16, depth, color, { roughness: 0.5 }), 0, topY + 0.08, 0));

  const curtain = boxMesh(width * 0.34, height * 0.6, depth * 0.86, SKY, {
    opacity: 0.26,
    roughness: 0.2,
    emissive: SKY,
    emissiveIntensity: 0.35,
  });
  curtain.castShadow = false;
  group.add(at(curtain, 0, groundY + height * 0.42, 0));

  group.add(at(sphereMesh(0.075, color, { emissive: color, emissiveIntensity: 0.9 }), 0, topY + 0.25, 0));

  return group;
}

/** 货架：立柱 + 层板 + 货位；包装架装满，拒收架空一些。 */
function buildRack(size: TwinVector3, color: string, baseY: number, id: string): THREE.Group {
  const group = new THREE.Group();
  const [width, height, depth] = size;
  const groundY = -baseY;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(
        at(
          boxMesh(0.1, height, 0.1, FRAME_DARK, { roughness: 0.7 }),
          sx * (width / 2 - 0.06),
          groundY + height / 2,
          sz * (depth / 2 - 0.06),
        ),
      );
    }
  }

  const shelves = 4;
  for (let i = 0; i < shelves; i += 1) {
    group.add(at(boxMesh(width * 0.96, 0.06, depth * 0.92, color, { roughness: 0.6 }), 0, groundY + height * (0.18 + i * 0.22), 0));
  }

  const filled = id.startsWith('pack');
  const spots = filled ? 6 : 3;
  for (let i = 0; i < spots; i += 1) {
    const shelf = i % 3;
    const y = groundY + height * (0.18 + shelf * 0.22) + 0.17;
    const x = -width / 2 + 0.42 + (i % 2) * 0.62;
    const z = -depth / 2 + 0.36 + ((i + (filled ? 1 : 0)) % 2) * 0.5;
    const cargo = boxMesh(0.34, 0.28, 0.34, CARGO_COLORS[i % CARGO_COLORS.length], { roughness: 0.5, metalness: 0.05 });
    group.add(at(cargo, x, y, z));
  }

  group.add(at(sphereMesh(0.07, color, { emissive: color, emissiveIntensity: 0.9 }), 0, groundY + height + 0.12, 0));

  return group;
}

/** 在制物料：一个带顶面封条的货箱。 */
function buildCargo(size: TwinVector3, color: string): THREE.Group {
  const group = new THREE.Group();
  group.add(boxMesh(size[0], size[1], size[2], color, { roughness: 0.45, metalness: 0.05 }));
  const tape = boxMesh(size[0] * 0.34, size[1] * 0.08, size[2] * 1.02, FRAME, { roughness: 0.7 });
  tape.castShadow = false;
  group.add(at(tape, 0, size[1] / 2, 0));
  return group;
}

/** 按实体类型生成模型；未知类型退回货箱，保证外部数据源补出来的实体不会消失。 */
export function buildEntityMesh(entity: EntityMeshInput): THREE.Group {
  const size = entity.visual?.size ?? [0.7, 0.7, 0.7];
  const color = entity.visual?.color ?? '#94a3b8';
  const baseY = entity.transform.position[1] ?? 0;

  switch (entity.kind) {
    case 'transport':
      return buildConveyor(size[0], size[2], color, baseY, entity.id);
    case 'inspect':
      return buildInspection(size, color, baseY);
    case 'buffer':
      return buildRack(size, color, baseY, entity.id);
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
