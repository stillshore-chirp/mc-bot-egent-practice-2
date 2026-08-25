import { useEffect, useRef, useState } from "react";

import type { TraceGraphScene } from "../graph/scene";
import type { TraceState } from "../trace/reducer";
import { TraceGraph2D } from "./TraceGraph2D";

interface BrainGraphCanvasProps {
  readonly state: TraceState;
  readonly onSelect: (spanId: string) => void;
}

export function BrainGraphCanvas({ state, onSelect }: BrainGraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<TraceGraphScene | undefined>(undefined);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [fallback, setFallback] = useState<string>();
  const [sceneReady, setSceneReady] = useState(false);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext("webgl2");
    if (context === null) {
      setSceneReady(false);
      setFallback("WebGL 2を利用できないため、2Dグラフへ切り替えています。");
      return;
    }

    let cancelled = false;
    let scene: TraceGraphScene | undefined;
    const initialize = async (): Promise<void> => {
      try {
        const module = await import("../graph/scene");
        if (cancelled) return;
        scene = new module.TraceGraphScene({
          canvas,
          onSelect,
          reducedMotion,
          onContextLost: () => {
            scene?.dispose();
            sceneRef.current = undefined;
            setSceneReady(false);
            setFallback(
              "WebGLコンテキストが失われたため、2Dグラフへ切り替えています。",
            );
          },
        });
        sceneRef.current = scene;
        scene.sync(stateRef.current);
        setSceneReady(true);
      } catch {
        if (!cancelled) {
          setSceneReady(false);
          setFallback(
            "3Dシーンを初期化できないため、2Dグラフを表示しています。",
          );
        }
      }
    };
    void initialize();
    return () => {
      cancelled = true;
      scene?.dispose();
      sceneRef.current = undefined;
      setSceneReady(false);
    };
  }, [onSelect, reducedMotion]);
  useEffect(() => {
    sceneRef.current?.sync(state);
  }, [state]);
  if (fallback !== undefined) {
    return (
      <div className="graph-fallback">
        <p className="fallback-note" role="status">
          {fallback}
        </p>
        <TraceGraph2D
          spans={state.spans}
          links={state.links}
          results={state.results}
          selectedSpanId={state.selectedSpanId}
          onSelect={onSelect}
        />
      </div>
    );
  }
  return (
    <div
      className="graph-canvas-wrap"
      data-scene-ready={sceneReady ? "true" : "false"}
    >
      <canvas ref={canvasRef} className="graph-canvas" aria-hidden="true" />
      <p className="graph-assistive-note">
        3Dグラフの内容は下の処理ノード一覧からキーボードでも確認できます。
      </p>
    </div>
  );
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}
