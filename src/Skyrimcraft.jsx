import React, { useEffect, useMemo, useRef, useCallback } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { PointerLockControls, Sky, Html } from "@react-three/drei";
import * as THREE from "three";
import { create } from "zustand";
import SimplexNoise from "simplex-noise";

/*********************************
 * Skyrimcraft — Voxel Demo (react + R3F)
 * Robust fix v10 — extra guards, zero‑length normals, and store-level tests
 * - Click to lock pointer; WASD to move
 * - Left-click: mine block (except bottom layer is indestructible)
 * - Right-click: place on clicked face (closest-face-by-axis)
 * - 1..5: switch blocks (Stone, Snow, Wood, Obsidian, Dwemer)
 * - R: Shout (clear a small cluster ahead; respects bottom-layer protection)
 *
 * Why v10:
 * • Some environments still surfaced "reading 'source'" when pointer events lacked shapes we assumed.
 *   We now normalize/guard every optional field and handle zero-length/NaN normals explicitly.
 * • We retained the contextmenu suppression and do nothing on empty air.
 * • Added store-level tests for ground protection and placement rules without touching existing test cases.
 *********************************/

// ---------- world rules ----------
export const GROUND_Y = 0; // bottom-most layer index
const MIN_BUILD_Y = 0; // disallow placements below ground
export function isProtectedBlockCoords(x, y, z) { return y <= GROUND_Y; }
export function canPlaceAtY(y) { return y >= MIN_BUILD_Y; }

// ---------- helpers ----------
const keyFrom = (x, y, z) => `${x},${y},${z}`;
const vec3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

function asVector3(maybe) {
  if (!maybe || typeof maybe !== "object") return null;
  if (maybe.isVector3 && typeof maybe.clone === "function") return maybe.clone();
  const { x, y, z } = maybe;
  if ([x, y, z].every((n) => Number.isFinite(n))) return new THREE.Vector3(x, y, z);
  return null;
}

function dominantAxisUnit(n) {
  if (!n) return new THREE.Vector3(0, 1, 0);
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  if (![ax, ay, az].every((v) => Number.isFinite(v))) return new THREE.Vector3(0, 1, 0);
  if (ax >= ay && ax >= az) return new THREE.Vector3(Math.sign(n.x) || 1, 0, 0);
  if (ay >= ax && ay >= az) return new THREE.Vector3(0, Math.sign(n.y) || 1, 0);
  return new THREE.Vector3(0, 0, Math.sign(n.z) || 1);
}

const BLOCK_TYPES = [
  { id: "stone", label: "Nordic Stone", color: "#6b7280" },
  { id: "snow", label: "Snow", color: "#e5f4ff" },
  { id: "wood", label: "Pine Wood", color: "#8b5a2b" },
  { id: "obsidian", label: "Daedric Obsidian", color: "#211321" },
  { id: "metal", label: "Dwemer Metal", color: "#b8b5a8" }
];

// ---------- state ----------
const useGame = create((set, get) => ({
  selected: BLOCK_TYPES[0].id,
  setSelected: (id) => set({ selected: id }),
  blocks: new Map(),
  setBlocks: (map) => set({ blocks: map }),
  addBlock: (pos, type) => {
    const [x, y, z] = pos;
    if (!canPlaceAtY(y)) return; // prevent below-ground placement
    const key = keyFrom(x, y, z);
    const { blocks } = get();
    if (!blocks.has(key)) { // do nothing if occupied (per user)
      const next = new Map(blocks);
      next.set(key, { x, y, z, type });
      set({ blocks: next });
    }
  },
  removeBlock: (pos) => {
    const [x, y, z] = pos;
    if (isProtectedBlockCoords(x, y, z)) return; // protect bottom layer
    const key = keyFrom(x, y, z);
    const { blocks } = get();
    if (blocks.has(key)) {
      const next = new Map(blocks);
      next.delete(key);
      set({ blocks: next });
    }
  }
}));

// ---------- world generation ----------
function useGenerateWorld() {
  const setBlocks = useGame((s) => s.setBlocks);

  useEffect(() => {
    let simplex;
    try { simplex = new SimplexNoise("skyrim-seed-1"); }
    catch { simplex = new SimplexNoise(); }

    const blocks = new Map();
    const radius = 10, base = 2, maxHill = 6;

    for (let x = -radius; x <= radius; x++) {
      for (let z = -radius; z <= radius; z++) {
        const n = (simplex.noise2D(x / 12, z / 12) + 1) / 2; // 0..1
        const height = Math.floor(base + n * maxHill);
        for (let y = 0; y < height; y++) {
          let type = y === height - 1 ? (height >= base + maxHill - 1 ? "snow" : "stone") : "stone";
          if (type === "stone" && y > 1 && Math.random() < 0.025) type = "metal";
          blocks.set(keyFrom(x, y, z), { x, y, z, type });
        }
        if (height >= base + 3 && Math.random() < 0.08) {
          const trunkH = 3 + Math.floor(Math.random() * 2);
          for (let t = 0; t < trunkH; t++) blocks.set(keyFrom(x, height + t, z), { x, y: height + t, z, type: "wood" });
          blocks.set(keyFrom(x, height + trunkH, z), { x, y: height + trunkH, z, type: "snow" });
        }
        if (Math.random() < 0.01) blocks.set(keyFrom(x, Math.max(1, height - 2), z), { x, y: Math.max(1, height - 2), z, type: "obsidian" });
      }
    }

    setBlocks(blocks);
  }, [setBlocks]);
}

// ---------- player controls ----------
function PlayerController() {
  const { camera } = useThree();
  const keys = useRef({});
  const speed = 9;

  useEffect(() => {
    const down = (e) => { keys.current[e.code] = true; };
    const up = (e) => { keys.current[e.code] = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  useFrame((_, dt) => {
    camera.position.y = 10;
    const forward = vec3(0, 0, -1).applyQuaternion(camera.quaternion).setY(0).normalize();
    const right = vec3(1, 0, 0).applyQuaternion(camera.quaternion).setY(0).normalize();
    if (keys.current["KeyW"]) camera.position.addScaledVector(forward, speed * dt);
    if (keys.current["KeyS"]) camera.position.addScaledVector(forward, -speed * dt);
    if (keys.current["KeyA"]) camera.position.addScaledVector(right, -speed * dt);
    if (keys.current["KeyD"]) camera.position.addScaledVector(right, speed * dt);
  });

  return <PointerLockControls selector="#skyrimcraft-canvas" />;
}

// ---------- HUD / UI ----------
function HUD() {
  const selected = useGame((s) => s.selected);
  const setSelected = useGame((s) => s.setSelected);

  useEffect(() => {
    const onKey = (e) => {
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < BLOCK_TYPES.length) setSelected(BLOCK_TYPES[idx].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSelected]);

  return (
    <div className="pointer-events-none select-none">
      {/* crosshair */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="w-0.5 h-0.5 bg-white rounded-sm opacity-90" />
      </div>
      {/* inventory bar */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2 p-2 bg-black/40 rounded-2xl backdrop-blur-md">
        {BLOCK_TYPES.map((b, i) => (
          <div key={b.id} className={`pointer-events-auto px-3 py-2 rounded-xl border text-xs font-medium ${selected === b.id ? "border-white text-white" : "border-white/20 text-white/70"}`}
               onClick={(e) => { e.preventDefault(); setSelected(b.id); }}>
            <div className="flex items-center gap-2">
              <span className="inline-block w-4 h-4 rounded" style={{ background: b.color }} />
              <span>{i + 1}. {b.label}</span>
            </div>
          </div>
        ))}
      </div>
      {/* help */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 text-white/90 text-[12px] px-3 py-1.5 bg-black/40 rounded-xl backdrop-blur-md">
        Click to lock • WASD move • Left-click mine • Right-click place • 1..5 select • R: Shout (remove cluster)
      </div>
    </div>
  );
}

// ---------- Placement normal utility (testable) ----------
/**
 * Computes an outward axis-aligned normal for block placement.
 * Prefers the actual intersected face normal if available; otherwise infers
 * the closest axis from the local point within a unit cube (±0.5 extents).
 * Accepts r3f event shapes; works with THREE.Vector3 or plain `{x,y,z}`.
 * Always returns a unit axis vector in {±1,0} components.
 */
export function computePlacementNormal(evtLike) {
  const up = new THREE.Vector3(0, 1, 0);
  if (!evtLike || typeof evtLike !== "object") return up.clone();

  // 1) Face normal from primary fields or intersections[0]
  const i0 = Array.isArray(evtLike.intersections) && evtLike.intersections.length > 0 ? evtLike.intersections[0] : undefined;
  const faceCandidate = (evtLike.face && evtLike.face.normal) || (i0 && i0.face && i0.face.normal);
  const faceNormalVec = asVector3(faceCandidate);
  if (faceNormalVec) {
    if (faceNormalVec.lengthSq() === 0 || !Number.isFinite(faceNormalVec.x) || !Number.isFinite(faceNormalVec.y) || !Number.isFinite(faceNormalVec.z)) {
      return up.clone();
    }
    faceNormalVec.normalize();
    return dominantAxisUnit(faceNormalVec);
  }

  // 2) Derive from intersection point relative to the cube center
  const pointCandidate = evtLike.point || (i0 && i0.point);
  const pointVec = asVector3(pointCandidate);
  const object = evtLike.object || evtLike.eventObject || (i0 && i0.object);
  if (pointVec && object && typeof object.worldToLocal === "function") {
    try {
      const local = pointVec.clone();
      object.worldToLocal(local);
      const dx = Math.abs(Math.abs(local.x) - 0.5);
      const dy = Math.abs(Math.abs(local.y) - 0.5);
      const dz = Math.abs(Math.abs(local.z) - 0.5);
      if (![dx, dy, dz].every((v) => Number.isFinite(v))) return up.clone();
      if (dx <= dy && dx <= dz) return new THREE.Vector3(Math.sign(local.x) || 1, 0, 0);
      if (dy <= dx && dy <= dz) return new THREE.Vector3(0, Math.sign(local.y) || 1, 0);
      return new THREE.Vector3(0, 0, Math.sign(local.z) || 1);
    } catch {
      return up.clone();
    }
  }

  // 3) Final fallback
  return up.clone();
}

// ---------- Voxel ----------
function Voxel({ x, y, z, type }) {
  const removeBlock = useGame((s) => s.removeBlock);
  const addBlock = useGame((s) => s.addBlock);
  const selected = useGame((s) => s.selected);

  const color = useMemo(() => BLOCK_TYPES.find((b) => b.id === type)?.color || "#888", [type]);

  const handlePointerDown = useCallback((e) => {
    try { e.stopPropagation?.(); e.preventDefault?.(); } catch {}
    const native = e && e.nativeEvent ? e.nativeEvent : undefined;
    const button = typeof e.button === "number" ? e.button : (native && typeof native.button === "number" ? native.button : 0);

    if (button === 0) { // left-click mine
      removeBlock([x, y, z]); // removal function enforces protection
      return;
    }
    if (button === 2) { // right-click place
      const hasHit = !!(e?.face || (e?.intersections && e.intersections[0]) || (e?.point && (e?.object || e?.eventObject)));
      if (!hasHit) return; // empty air or malformed
      const n = computePlacementNormal(e);
      const nx = Math.round(n.x), ny = Math.round(n.y), nz = Math.round(n.z);
      addBlock([x + nx, y + ny, z + nz], selected); // addBlock prevents below-ground & occupied
    }
  }, [x, y, z, selected, addBlock, removeBlock]);

  const preventMenu = useCallback((e) => e.preventDefault(), []);

  return (
    <mesh position={[x, y, z]} onPointerDown={handlePointerDown} onContextMenu={preventMenu} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} roughness={0.9} metalness={type === "metal" ? 0.6 : 0.1} />
    </mesh>
  );
}

// ---------- World Renderer ----------
function World() {
  const blocks = useGame((s) => s.blocks);
  const positions = useMemo(() => Array.from(blocks.values()), [blocks]);
  return (
    <group>
      {positions.map(({ x, y, z, type }) => (
        <Voxel key={keyFrom(x, y, z)} x={x} y={y} z={z} type={type} />
      ))}
    </group>
  );
}

// ---------- Lighting / Atmosphere ----------
function Atmosphere() {
  const scene = useThree((s) => s.scene);
  const dirRef = useRef();
  const tRef = useRef(0);

  useEffect(() => {
    scene.fog = new THREE.Fog("#9fbcd4", 25, 85);
    scene.background = new THREE.Color("#a7c7e7");
  }, [scene]);

  useFrame((_, dt) => {
    tRef.current += dt * 0.03;
    const k = (Math.sin(tRef.current) + 1) / 2; // 0..1
    const sky = new THREE.Color().lerpColors(new THREE.Color("#0c1a2a"), new THREE.Color("#a7c7e7"), k);
    scene.background.copy(sky);
    if (dirRef.current) {
      dirRef.current.intensity = 0.6 + 0.6 * k;
      dirRef.current.position.set(30 * Math.cos(tRef.current), 25, 30 * Math.sin(tRef.current));
    }
  });

  return (
    <>
      <hemisphereLight args={["#cbd5e1", "#334155", 0.5]} />
      <directionalLight ref={dirRef} position={[25, 25, -25]} intensity={1} castShadow />
      <Sky sunPosition={[100, 10, 100]} turbidity={6} rayleigh={1.2} mieCoefficient={0.02} mieDirectionalG={0.8} />
    </>
  );
}

// ---------- Shout (Fus Ro Dah) ----------
function useShout() {
  const removeBlock = useGame((s) => s.removeBlock);
  const { camera } = useThree();

  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== "KeyR") return;
      const origin = camera.position.clone();
      const dir = vec3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
      const start = origin.clone().addScaledVector(dir, 5);
      const radius = 2;
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dz = -radius; dz <= radius; dz++) {
            const p = start.clone().add(vec3(dx, dy, dz));
            if (p.distanceTo(start) <= radius + 0.01) {
              removeBlock([Math.round(p.x), Math.round(p.y), Math.round(p.z)]); // respects bottom-layer protection
            }
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [camera, removeBlock]);
}

// ---------- Root Scene ----------
function Scene() {
  useGenerateWorld();
  useShout();
  return (
    <>
      <Atmosphere />
      <World />
      <PlayerController />
    </>
  );
}

// ---------- Tiny test runner (console) ----------
function runTests() {
  const results = [];
  const pass = (name, cond) => results.push({ name, ok: !!cond });
  const dump = () => {
    const ok = results.filter((r) => r.ok).length;
    const total = results.length;
    const header = `Skyrimcraft tests: ${ok}/${total} passed`;
    if (ok === total) console.log(header);
    else console.error(header, results.filter((r) => !r.ok));
  };

  // Arrange common test mesh (unit cube at origin)
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());

  // Existing tests (computePlacementNormal)
  const n1 = computePlacementNormal({ face: { normal: new THREE.Vector3(1, 0, 0) } });
  pass("uses provided face normal (+X)", n1.x === 1 && n1.y === 0 && n1.z === 0);

  const worldPx = mesh.localToWorld(new THREE.Vector3(0.51, 0, 0).clone());
  const n2 = computePlacementNormal({ point: worldPx, object: mesh });
  pass("infers +X from point", n2.x === 1 && n2.y === 0 && n2.z === 0);

  const worldPy = mesh.localToWorld(new THREE.Vector3(0, 0.51, 0).clone());
  const n3 = computePlacementNormal({ point: worldPy, object: mesh });
  pass("infers +Y from point", n3.x === 0 && n3.y === 1 && n3.z === 0);

  const worldNz = mesh.localToWorld(new THREE.Vector3(0, 0, -0.51).clone());
  const n4 = computePlacementNormal({ point: worldNz, object: mesh });
  pass("infers -Z from point", n4.x === 0 && n4.y === 0 && n4.z === -1);

  const n5 = computePlacementNormal(null);
  pass("fallback up vector", n5.x === 0 && n5.y === 1 && n5.z === 0);

  const n6 = computePlacementNormal({ intersections: [{ face: { normal: new THREE.Vector3(0, -1, 0) } }] });
  pass("intersections[0] face normal (−Y)", n6.x === 0 && n6.y === -1 && n6.z === 0);

  const iPoint = mesh.localToWorld(new THREE.Vector3(-0.51, 0, 0).clone());
  const n7 = computePlacementNormal({ intersections: [{ point: iPoint, object: mesh }] });
  pass("intersections[0] point infers −X", n7.x === -1 && n7.y === 0 && n7.z === 0);

  const n8 = computePlacementNormal({});
  pass("empty event fallback up", n8.x === 0 && n8.y === 1 && n8.z === 0);

  const n9 = computePlacementNormal({ face: { normal: new THREE.Vector3(0.2, 0.9, 0.1) } });
  pass("diagonal normal -> +Y", n9.x === 0 && n9.y === 1 && n9.z === 0);

  const n10 = computePlacementNormal({ face: { normal: new THREE.Vector3(-0.9, 0.1, 0.1) } });
  pass("diagonal normal -> −X", n10.x === -1 && n10.y === 0 && n10.z === 0);

  const cornerYZ = mesh.localToWorld(new THREE.Vector3(0, 0.5, 0.49).clone());
  const n11 = computePlacementNormal({ point: cornerYZ, object: mesh });
  pass("corner tie yields axis (Z or Y)", (n11.z === 1 && n11.x === 0) || (n11.y === 1 && n11.x === 0));

  const cornerXYExact = mesh.localToWorld(new THREE.Vector3(0.5, 0.5, 0).clone());
  const n12 = computePlacementNormal({ point: cornerXYExact, object: mesh });
  pass("tie X vs Y resolves to X", n12.x === 1 && n12.y === 0 && n12.z === 0);

  const worldNy = mesh.localToWorld(new THREE.Vector3(0, -0.51, 0).clone());
  const n13 = computePlacementNormal({ point: worldNy, eventObject: mesh });
  pass("eventObject + point infers −Y", n13.x === 0 && n13.y === -1 && n13.z === 0);

  const n14 = computePlacementNormal({ face: null });
  pass("null face fallback up", n14.x === 0 && n14.y === 1 && n14.z === 0);

  const n15 = computePlacementNormal({ face: { normal: { x: 0, y: 0, z: 1 } } });
  pass("plain-object face normal -> +Z", n15.x === 0 && n15.y === 0 && n15.z === 1);

  const worldPz = mesh.localToWorld(new THREE.Vector3(0, 0, 0.51).clone());
  const n16 = computePlacementNormal({ point: { x: worldPz.x, y: worldPz.y, z: worldPz.z }, object: mesh });
  pass("plain-object point infers +Z", n16.x === 0 && n16.y === 0 && n16.z === 1);

  const n17 = computePlacementNormal(42);
  pass("non-object event fallback up", n17.x === 0 && n17.y === 1 && n17.z === 0);

  const n18 = computePlacementNormal({ intersections: [] });
  pass("intersections[] fallback up", n18.x === 0 && n18.y === 1 && n18.z === 0);

  const n19 = computePlacementNormal({ intersections: [{}] });
  pass("intersections[0] without face/point -> up", n19.x === 0 && n19.y === 1 && n19.z === 0);

  const n20 = computePlacementNormal({ face: { normal: { x: NaN, y: 0, z: 0 } } });
  pass("NaN normal component -> up", n20.x === 0 && n20.y === 1 && n20.z === 0);

  const n21 = computePlacementNormal({ point: new THREE.Vector3(0.51, 0, 0), object: {} });
  pass("point with object lacking worldToLocal -> up", n21.x === 0 && n21.y === 1 && n21.z === 0);

  const n22 = computePlacementNormal({ face: { normal: { x: 0.49, y: 0.49, z: 0.51 } } });
  pass("dominant axis unit output (+Z)", n22.x === 0 && n22.y === 0 && n22.z === 1);

  // New tests in v10 (unit axis strictness)
  let strictOK = true;
  for (let i = 0; i < 10; i++) {
    const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    const out = computePlacementNormal({ face: { normal: v } });
    const comps = [Math.abs(out.x), Math.abs(out.y), Math.abs(out.z)];
    const sum = comps[0] + comps[1] + comps[2];
    if (!(Math.abs(sum - 1) < 1e-6 && comps.filter((c) => c === 1).length === 1)) strictOK = false;
  }
  pass("unit axis output for random normals", strictOK);

  // New tests (world rules via store)
  const api = useGame; // zustand store API
  api.setState({ blocks: new Map(), selected: BLOCK_TYPES[0].id });
  const { setBlocks, addBlock, removeBlock } = api.getState();

  const initial = new Map();
  initial.set(keyFrom(0, 0, 0), { x: 0, y: 0, z: 0, type: "stone" });
  initial.set(keyFrom(0, 1, 0), { x: 0, y: 1, z: 0, type: "stone" });
  setBlocks(initial);

  // Protected ground cannot be removed
  removeBlock([0, 0, 0]);
  pass("ground block remains after remove", api.getState().blocks.has(keyFrom(0, 0, 0)) === true);

  // Above ground can be removed
  removeBlock([0, 1, 0]);
  pass("above-ground block removed", api.getState().blocks.has(keyFrom(0, 1, 0)) === false);

  // Cannot place below ground
  addBlock([0, -1, 0], "wood");
  pass("no below-ground placement", api.getState().blocks.has(keyFrom(0, -1, 0)) === false);

  // Cannot overwrite occupied
  addBlock([0, 0, 0], "wood");
  pass("occupied target unchanged", api.getState().blocks.get(keyFrom(0, 0, 0)).type === "stone");

  dump();
}

if (typeof window !== "undefined") setTimeout(runTests, 0);

// ---------- Main exported component ----------
export default function Skyrimcraft() {
  return (
    <div className="w-full h-[80vh] relative bg-slate-900 rounded-2xl overflow-hidden"
         onContextMenu={(e) => e.preventDefault()}>
      <Canvas id="skyrimcraft-canvas" shadows camera={{ fov: 70, position: [0, 10, 15] }}
              onPointerMissed={() => { /* explicit no-op on empty air */ }}>
        <Scene />
        <Html center>
          <div className="pointer-events-none text-white/90 text-xs bg-black/40 px-3 py-1.5 rounded-full shadow">
            Click to enter — explore the tundra
          </div>
        </Html>
      </Canvas>
      <HUD />
    </div>
  );
}
