import type { Position } from "../../domain/snapshot.js";

export function createSearchFrontier(
  origin: Position,
  step: number,
  maxDistance: number,
): readonly Position[] {
  const points: Position[] = [];
  for (let radius = step; radius <= maxDistance; radius += step) {
    points.push(
      { x: origin.x + radius, y: origin.y, z: origin.z },
      { x: origin.x, y: origin.y, z: origin.z + radius },
      { x: origin.x - radius, y: origin.y, z: origin.z },
      { x: origin.x, y: origin.y, z: origin.z - radius },
    );
  }
  return points;
}
