import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { CognitiveTraceResult, CognitiveTraceSpan } from "@trace";

import { stageColors } from "../trace/labels";
import type { TraceState } from "../trace/reducer";
import { calculateLayout, type GraphPoint } from "./layout";

export interface GraphSceneOptions {
  readonly canvas: HTMLCanvasElement;
  readonly onSelect: (spanId: string) => void;
  readonly onContextLost: () => void;
  readonly reducedMotion: boolean;
}

interface Pulse {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  readonly start: GraphPoint;
  readonly end: GraphPoint;
  readonly startedAt: number;
  readonly duration: number;
}

export interface RendererDiagnostics {
  readonly disposed: boolean;
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly nodes: number;
  readonly edges: number;
  readonly pulses: number;
}

export class TraceGraphScene {
  readonly #canvas: HTMLCanvasElement;
  readonly #onSelect: (spanId: string) => void;
  readonly #onContextLost: () => void;
  readonly #reducedMotion: boolean;
  readonly #scene = new THREE.Scene();
  readonly #camera: THREE.PerspectiveCamera;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #composer: EffectComposer;
  readonly #controls: OrbitControls;
  readonly #raycaster = new THREE.Raycaster();
  readonly #pointer = new THREE.Vector2();
  readonly #nodeGroup = new THREE.Group();
  readonly #edgeGroup = new THREE.Group();
  readonly #pulseGroup = new THREE.Group();
  readonly #nodes = new Map<string, THREE.Mesh>();
  readonly #edges = new Map<string, THREE.Line>();
  readonly #nodeSignatures = new Map<string, string>();
  readonly #edgeSignatures = new Map<string, string>();
  #pulses: Pulse[] = [];
  #animationFrame: number | undefined;
  #disposed = false;
  #autoFocus = true;
  #lastSelectedSpanId: string | undefined;
  #lastSequence = 0;
  #resizeObserver: ResizeObserver | undefined;
  #resizeFrame: number | undefined;

  public constructor(options: GraphSceneOptions) {
    this.#canvas = options.canvas;
    this.#onSelect = options.onSelect;
    this.#onContextLost = options.onContextLost;
    this.#reducedMotion = options.reducedMotion;
    this.#scene.background = new THREE.Color("#080d1d");
    this.#camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    this.#camera.position.set(0, 0, 36);
    this.#renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.#renderer.setSize(
      Math.max(1, options.canvas.clientWidth),
      Math.max(1, options.canvas.clientHeight),
      false,
    );
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#composer = new EffectComposer(this.#renderer);
    this.#composer.addPass(new RenderPass(this.#scene, this.#camera));
    this.#composer.addPass(
      new UnrealBloomPass(
        new THREE.Vector2(640, 480),
        options.reducedMotion ? 0 : 0.85,
        0.65,
        0.78,
      ),
    );
    this.#composer.addPass(new OutputPass());
    this.#controls = new OrbitControls(this.#camera, options.canvas);
    this.#controls.enableDamping = !options.reducedMotion;
    this.#controls.dampingFactor = 0.08;
    this.#controls.minDistance = 8;
    this.#controls.maxDistance = 180;
    this.#controls.addEventListener("start", this.#handleControlStart);
    this.#scene.add(this.#nodeGroup, this.#edgeGroup, this.#pulseGroup);
    this.#canvas.addEventListener("pointerup", this.#handlePointerUp);
    this.#canvas.addEventListener("webglcontextlost", this.#handleContextLost);
    document.addEventListener("visibilitychange", this.#handleVisibilityChange);
    this.#resizeObserver = new ResizeObserver(() => {
      if (this.#resizeFrame !== undefined) return;
      this.#resizeFrame = requestAnimationFrame(() => {
        this.#resizeFrame = undefined;
        this.resize();
      });
    });
    this.#resizeObserver.observe(this.#canvas);
    this.#publishDiagnostics();
    this.#animate();
  }

  public sync(state: TraceState): void {
    if (this.#disposed) return;
    const layout = calculateLayout(state.spans, state.links, state.results);
    const desiredNodeIds = new Set<string>();
    for (const span of state.spans) {
      const point = layout.get(span.spanId);
      if (point === undefined) continue;
      desiredNodeIds.add(span.spanId);
      const selected = span.spanId === state.selectedSpanId;
      const existing = this.#nodes.get(span.spanId);
      const node =
        existing?.userData.nodeKind === "span" &&
        existing.userData.stage === span.stage
          ? existing
          : this.replaceNode(
              span.spanId,
              this.createNode(span, point, selected),
            );
      const signature = `${point.x}:${point.y}:${point.z}:${span.status}:${selected ? "selected" : ""}`;
      if (this.#nodeSignatures.get(span.spanId) !== signature) {
        this.updateSpanNode(node, span, point, selected);
        this.#nodeSignatures.set(span.spanId, signature);
      }
    }
    for (const result of state.results) {
      const point = layout.get(result.resultId);
      if (point === undefined) continue;
      desiredNodeIds.add(result.resultId);
      const selected = result.spanId === state.selectedSpanId;
      const existing = this.#nodes.get(result.resultId);
      const node =
        existing?.userData.nodeKind === "result"
          ? existing
          : this.replaceNode(
              result.resultId,
              this.createResultNode(result, point, selected),
            );
      const signature = `${point.x}:${point.y}:${point.z}:${result.kind}:${selected ? "selected" : ""}`;
      if (this.#nodeSignatures.get(result.resultId) !== signature) {
        this.updateResultNode(node, result, point, selected);
        this.#nodeSignatures.set(result.resultId, signature);
      }
    }
    for (const [id, node] of this.#nodes) {
      if (desiredNodeIds.has(id)) continue;
      this.#nodeGroup.remove(node);
      disposeObject(node);
      this.#nodes.delete(id);
      this.#nodeSignatures.delete(id);
    }
    const desiredEdges = new Map<
      string,
      {
        readonly start: GraphPoint;
        readonly end: GraphPoint;
        readonly type: string;
      }
    >();
    const linkTargets =
      state.links.length > 0
        ? state.links
        : state.spans.flatMap((span) =>
            span.parentSpanId === undefined
              ? []
              : [
                  {
                    sourceSpanId: span.parentSpanId,
                    targetSpanId: span.spanId,
                    type: "parent" as const,
                  },
                ],
          );
    for (const link of linkTargets) {
      const start = layout.get(link.sourceSpanId);
      const end = layout.get(link.targetSpanId);
      if (start !== undefined && end !== undefined)
        desiredEdges.set(
          edgeKey(link.sourceSpanId, link.targetSpanId, link.type),
          { start, end, type: link.type },
        );
    }
    for (const result of state.results) {
      const start = layout.get(result.spanId);
      const end = layout.get(result.resultId);
      if (start !== undefined && end !== undefined)
        desiredEdges.set(edgeKey(result.spanId, result.resultId, "result"), {
          start,
          end,
          type: "result",
        });
    }
    for (const [key, line] of this.#edges) {
      if (desiredEdges.has(key)) continue;
      this.#edgeGroup.remove(line);
      disposeObject(line);
      this.#edges.delete(key);
      this.#edgeSignatures.delete(key);
    }
    for (const [key, edge] of desiredEdges) {
      const existing = this.#edges.get(key);
      const line = existing ?? this.createEdge(edge.start, edge.end, edge.type);
      if (existing === undefined) {
        this.#edges.set(key, line);
        this.#edgeGroup.add(line);
      }
      const signature = `${edge.start.x}:${edge.start.y}:${edge.start.z}:${edge.end.x}:${edge.end.y}:${edge.end.z}`;
      if (this.#edgeSignatures.get(key) !== signature) {
        updateEdge(line, edge.start, edge.end, edge.type);
        this.#edgeSignatures.set(key, signature);
      }
    }
    if (!this.#reducedMotion && state.events.length > 0) {
      const latest = state.events[state.events.length - 1];
      if (latest !== undefined && latest.sequence > this.#lastSequence) {
        const resultTarget =
          latest.result === undefined
            ? undefined
            : layout.get(latest.result.resultId);
        const end = resultTarget ?? layout.get(latest.spanId);
        const parent = state.spans.find(
          ({ spanId }) => spanId === latest.spanId,
        )?.parentSpanId;
        const start =
          resultTarget === undefined
            ? parent === undefined
              ? undefined
              : layout.get(parent)
            : layout.get(latest.spanId);
        if (start !== undefined && end !== undefined) this.addPulse(start, end);
        this.#lastSequence = latest.sequence;
      }
    }
    const selected =
      state.selectedSpanId === undefined
        ? undefined
        : this.#nodes.get(state.selectedSpanId);
    if (state.selectedSpanId !== this.#lastSelectedSpanId) {
      this.#lastSelectedSpanId = state.selectedSpanId;
      this.#autoFocus = true;
    }
    if (selected !== undefined && this.#autoFocus && !this.#reducedMotion)
      this.focus(selected.position);
    this.#publishDiagnostics();
  }

  public diagnostics(): RendererDiagnostics {
    return {
      disposed: this.#disposed,
      geometries: this.#renderer.info.memory.geometries,
      textures: this.#renderer.info.memory.textures,
      programs: this.#renderer.info.programs?.length ?? 0,
      drawCalls: this.#renderer.info.render.calls,
      triangles: this.#renderer.info.render.triangles,
      nodes: this.#nodes.size,
      edges: this.#edges.size,
      pulses: this.#pulses.length,
    };
  }

  public resize(): void {
    if (this.#disposed) return;
    const width = Math.max(1, this.#canvas.clientWidth);
    const height = Math.max(1, this.#canvas.clientHeight);
    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();
    this.#renderer.setSize(width, height, false);
    this.#composer.setSize(width, height);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#animationFrame !== undefined)
      cancelAnimationFrame(this.#animationFrame);
    if (this.#resizeFrame !== undefined)
      cancelAnimationFrame(this.#resizeFrame);
    this.#resizeObserver?.disconnect();
    this.#canvas.removeEventListener("pointerup", this.#handlePointerUp);
    this.#canvas.removeEventListener(
      "webglcontextlost",
      this.#handleContextLost,
    );
    document.removeEventListener(
      "visibilitychange",
      this.#handleVisibilityChange,
    );
    this.#controls.removeEventListener("start", this.#handleControlStart);
    this.clearObjects();
    this.#controls.dispose();
    this.#composer.dispose();
    this.#renderer.renderLists.dispose();
    this.#renderer.dispose();
    this.#publishDiagnostics();
    const context = this.#renderer.getContext();
    const loseContext = context.getExtension("WEBGL_lose_context");
    if (loseContext !== null) loseContext.loseContext();
  }

  private createNode(
    span: CognitiveTraceSpan,
    point: GraphPoint,
    selected: boolean,
  ): THREE.Mesh {
    const geometry = geometryForStage(span.stage);
    const color = new THREE.Color(stageColors[span.stage]);
    const active = span.status === "running";
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity:
        selected || active ? 0.9 : span.status === "failed" ? 0.4 : 0.08,
      metalness: 0.2,
      roughness: 0.55,
      transparent: span.status === "skipped",
      opacity: span.status === "skipped" ? 0.38 : 1,
      wireframe: span.status === "skipped",
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(point.x, point.y, point.z);
    const scale = span.status === "running" && !this.#reducedMotion ? 1.16 : 1;
    mesh.scale.setScalar(scale);
    mesh.userData = {
      nodeKind: "span",
      spanId: span.spanId,
      stage: span.stage,
      status: span.status,
    };
    return mesh;
  }

  private createResultNode(
    result: CognitiveTraceResult,
    point: GraphPoint,
    selected: boolean,
  ): THREE.Mesh {
    const color = new THREE.Color(resultColor(result.kind));
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: selected ? 0.85 : 0.18,
      metalness: 0.1,
      roughness: 0.65,
    });
    const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.55), material);
    mesh.position.set(point.x, point.y, point.z);
    mesh.userData = {
      nodeKind: "result",
      spanId: result.spanId,
      resultId: result.resultId,
    };
    return mesh;
  }

  private updateSpanNode(
    node: THREE.Mesh,
    span: CognitiveTraceSpan,
    point: GraphPoint,
    selected: boolean,
  ): void {
    const previousStatus = node.userData.status as string | undefined;
    if (
      previousStatus !== span.status &&
      span.status === "failed" &&
      !this.#reducedMotion
    ) {
      node.userData.failedFlashUntil = performance.now() + 1_000;
    }
    node.userData.status = span.status;
    node.position.set(point.x, point.y, point.z);
    node.scale.setScalar(span.status === "cancelled" ? 0.88 : 1);
    const material = node.material as THREE.MeshStandardMaterial;
    const color = new THREE.Color(
      span.status === "failed"
        ? "#ff5c75"
        : span.status === "cancelled"
          ? "#64748b"
          : span.status === "waiting"
            ? "#f7cf78"
            : span.status === "succeeded"
              ? "#69e6b1"
              : stageColors[span.stage],
    );
    material.color.copy(color);
    material.emissive.copy(color);
    material.emissiveIntensity =
      selected || span.status === "running"
        ? 0.9
        : span.status === "failed"
          ? 0.55
          : span.status === "waiting"
            ? 0.24
            : 0.08;
    material.transparent =
      span.status === "skipped" || span.status === "cancelled";
    material.opacity =
      span.status === "skipped" ? 0.38 : span.status === "cancelled" ? 0.58 : 1;
    material.wireframe =
      span.status === "failed" ||
      span.status === "skipped" ||
      span.status === "cancelled";
  }

  private updateResultNode(
    node: THREE.Mesh,
    result: CognitiveTraceResult,
    point: GraphPoint,
    selected: boolean,
  ): void {
    node.position.set(point.x, point.y, point.z);
    const material = node.material as THREE.MeshStandardMaterial;
    const color = new THREE.Color(resultColor(result.kind));
    material.color.copy(color);
    material.emissive.copy(color);
    material.emissiveIntensity = selected ? 0.85 : 0.18;
  }

  private replaceNode(id: string, node: THREE.Mesh): THREE.Mesh {
    const previous = this.#nodes.get(id);
    if (previous !== undefined) {
      this.#nodeGroup.remove(previous);
      disposeObject(previous);
    }
    this.#nodes.set(id, node);
    this.#nodeSignatures.delete(id);
    this.#nodeGroup.add(node);
    return node;
  }

  private createEdge(
    start: GraphPoint,
    end: GraphPoint,
    type: string,
  ): THREE.Line {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      toVector(start),
      toVector(end),
    ]);
    const material = new THREE.LineBasicMaterial({
      color:
        type === "interrupts"
          ? "#fb7185"
          : type === "result"
            ? "#7dd3fc"
            : "#526486",
      transparent: true,
      opacity: type === "parent" ? 0.78 : 0.95,
    });
    return new THREE.Line(geometry, material);
  }

  private addPulse(start: GraphPoint, end: GraphPoint): void {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 8, 8),
      new THREE.MeshBasicMaterial({ color: "#e0f2fe" }),
    );
    this.#pulseGroup.add(mesh);
    this.#pulses.push({
      mesh,
      start,
      end,
      startedAt: performance.now(),
      duration: 700,
    });
  }

  private clearObjects(): void {
    for (const node of this.#nodes.values()) {
      this.#nodeGroup.remove(node);
      disposeObject(node);
    }
    this.#nodes.clear();
    this.#nodeSignatures.clear();
    for (const edge of this.#edges.values()) {
      this.#edgeGroup.remove(edge);
      disposeObject(edge);
    }
    this.#edges.clear();
    this.#edgeSignatures.clear();
    for (const pulse of this.#pulses) {
      this.#pulseGroup.remove(pulse.mesh);
      disposeObject(pulse.mesh);
    }
    this.#pulses = [];
  }

  #publishDiagnostics(): void {
    const diagnostics = this.diagnostics();
    this.#canvas.dataset.sceneDisposed = String(diagnostics.disposed);
    this.#canvas.dataset.rendererGeometries = String(diagnostics.geometries);
    this.#canvas.dataset.rendererTextures = String(diagnostics.textures);
    this.#canvas.dataset.rendererPrograms = String(diagnostics.programs);
    this.#canvas.dataset.rendererDrawCalls = String(diagnostics.drawCalls);
    this.#canvas.dataset.sceneNodes = String(diagnostics.nodes);
    this.#canvas.dataset.sceneEdges = String(diagnostics.edges);
    this.#canvas.dataset.scenePulses = String(diagnostics.pulses);
  }

  private focus(position: THREE.Vector3): void {
    const target = new THREE.Vector3(position.x, position.y, position.z);
    this.#controls.target.lerp(target, 0.08);
  }

  readonly #handleControlStart = (): void => {
    this.#autoFocus = false;
  };

  readonly #handlePointerUp = (event: PointerEvent): void => {
    const rect = this.#canvas.getBoundingClientRect();
    this.#pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.#pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const hit = this.#raycaster.intersectObjects(
      this.#nodeGroup.children,
      true,
    )[0];
    const spanId: unknown = hit?.object.userData.spanId;
    if (typeof spanId === "string") this.#onSelect(spanId);
  };

  readonly #handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.#onContextLost();
  };

  readonly #handleVisibilityChange = (): void => {
    if (this.#disposed) return;
    if (document.visibilityState === "hidden") {
      if (this.#animationFrame !== undefined)
        cancelAnimationFrame(this.#animationFrame);
      this.#animationFrame = undefined;
    } else if (this.#animationFrame === undefined) {
      this.#animate();
    }
  };

  readonly #animate = (): void => {
    if (this.#disposed || document.visibilityState === "hidden") {
      this.#animationFrame = undefined;
      return;
    }
    this.#controls.update();
    const now = performance.now();
    if (!this.#reducedMotion) {
      for (const node of this.#nodes.values()) {
        if (node.userData.nodeKind !== "span") continue;
        const status = node.userData.status as string | undefined;
        const material = node.material as THREE.MeshStandardMaterial;
        if (status === "running") {
          node.scale.setScalar(1 + Math.sin(now * 0.0075) * 0.08);
          material.emissiveIntensity =
            0.72 + (Math.sin(now * 0.0075) + 1) * 0.14;
        } else if (status === "waiting") {
          node.scale.setScalar(1 + Math.sin(now * 0.0022) * 0.04);
        } else if (status === "failed") {
          const flashUntil = Number(node.userData.failedFlashUntil ?? 0);
          if (now < flashUntil) {
            const visible = Math.sin(now * 0.01) > 0;
            node.scale.setScalar(visible ? 1.18 : 0.84);
            material.opacity = visible ? 1 : 0.38;
          } else {
            node.scale.setScalar(1.06);
            material.opacity = 1;
            material.wireframe = true;
          }
        }
      }
    }
    this.#pulses = this.#pulses.filter((pulse) => {
      const progress = (now - pulse.startedAt) / pulse.duration;
      if (progress >= 1) {
        this.#pulseGroup.remove(pulse.mesh);
        disposeObject(pulse.mesh);
        return false;
      }
      pulse.mesh.position.lerpVectors(
        toVector(pulse.start),
        toVector(pulse.end),
        progress,
      );
      return true;
    });
    this.#composer.render();
    this.#animationFrame = requestAnimationFrame(this.#animate);
  };
}

function geometryForStage(
  stage: CognitiveTraceSpan["stage"],
): THREE.BufferGeometry {
  if (stage === "tool") return new THREE.BoxGeometry(1.15, 1.15, 1.15);
  if (stage === "verification") return new THREE.OctahedronGeometry(0.9);
  if (stage === "reflex" || stage === "recovery" || stage === "cancellation")
    return new THREE.TetrahedronGeometry(1.05);
  if (
    stage === "memory_read" ||
    stage === "memory_write" ||
    stage === "context"
  )
    return new THREE.IcosahedronGeometry(0.95);
  return new THREE.SphereGeometry(0.9, 16, 12);
}

function resultColor(kind: CognitiveTraceResult["kind"]): string {
  if (kind === "verification_result") return "#67e8f9";
  if (kind === "minecraft_state_delta") return "#e879f9";
  if (kind === "memory_update_result") return "#a7f3d0";
  if (kind === "final_response") return "#c4b5fd";
  if (kind === "selected_tool") return "#f6b26b";
  if (kind === "skill_result") return "#f38ba8";
  return "#f09b6e";
}

function toVector(point: GraphPoint): THREE.Vector3 {
  return new THREE.Vector3(point.x, point.y, point.z);
}

function edgeKey(source: string, target: string, type: string): string {
  return `${source}:${target}:${type}`;
}

function updateEdge(
  line: THREE.Line,
  start: GraphPoint,
  end: GraphPoint,
  type: string,
): void {
  const geometry = line.geometry;
  const position = geometry.getAttribute("position");
  if (position.count >= 2) {
    position.setXYZ(0, start.x, start.y, start.z);
    position.setXYZ(1, end.x, end.y, end.z);
    position.needsUpdate = true;
  } else {
    geometry.setFromPoints([toVector(start), toVector(end)]);
  }
  geometry.computeBoundingSphere();
  const material = line.material as THREE.LineBasicMaterial;
  material.color.set(
    type === "interrupts"
      ? "#fb7185"
      : type === "result"
        ? "#7dd3fc"
        : "#526486",
  );
  material.opacity = type === "parent" ? 0.78 : 0.95;
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Line)) return;
    const renderable = child as THREE.Mesh;
    renderable.geometry.dispose();
    const material = renderable.material;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material.dispose();
  });
}
