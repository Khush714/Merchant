"use client";
import { useRef, useState, type PointerEvent } from "react";
import Image from "next/image";
import { Crosshair, Minus, Plus } from "lucide-react";
import type { DeliveryZone, ServicePoint } from "@/lib/types";

const TILE = 256;
const DEFAULT_CENTER = { latitude: 20.5937, longitude: 78.9629 }; // India, before a pin is placed.

function lngToX(longitude: number, zoom: number) { return (longitude + 180) / 360 * 2 ** zoom; }
function latToY(latitude: number, zoom: number) {
  const radians = latitude * Math.PI / 180;
  return (0.5 - Math.log((1 + Math.sin(radians)) / (1 - Math.sin(radians))) / (4 * Math.PI)) * 2 ** zoom;
}
function xToLng(x: number, zoom: number) { return x / 2 ** zoom * 360 - 180; }
function yToLat(y: number, zoom: number) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** zoom))) * 180 / Math.PI; }
function metresToPixels(metres: number, latitude: number, zoom: number) {
  return metres / (156_543.03392 * Math.cos(latitude * Math.PI / 180) / 2 ** zoom);
}

type Props = {
  point: ServicePoint | null;
  radiusMeters?: number;
  zones?: DeliveryZone[];
  onPick?: (point: ServicePoint) => void;
  focus?: ServicePoint | null;
  compact?: boolean;
};

/**
 * A minimal slippy map. Tiles are ordinary HTTPS images, so the app's CSP and
 * geolocation policy stay unchanged and no map SDK or provider key is needed.
 */
export function ServiceMap({ point, radiusMeters = 3000, zones = [], onPick, focus, compact = false }: Props) {
  const [zoom, setZoom] = useState(13);
  const [view, setView] = useState<ServicePoint | null>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const center = view ?? focus ?? point ?? DEFAULT_CENTER;
  const cx = lngToX(center.longitude, zoom), cy = latToY(center.latitude, zoom);
  const tiles = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = Math.floor(cx) + dx, y = Math.floor(cy) + dy;
      const count = 2 ** zoom;
      if (y < 0 || y >= count) continue;
      const wrapped = ((x % count) + count) % count;
      tiles.push(
        <Image key={`${x}:${y}:${zoom}`} src={`https://tile.openstreetmap.org/${zoom}/${wrapped}/${y}.png`} alt="" width={TILE} height={TILE}
          unoptimized draggable={false} className="map-tile" style={{ left: (x - cx) * TILE, top: (y - cy) * TILE }} />,
      );
    }
  }
  const offset = (target: ServicePoint) => ({
    x: (lngToX(target.longitude, zoom) - cx) * TILE,
    y: (latToY(target.latitude, zoom) - cy) * TILE,
  });
  const marker = point ? offset(point) : null;
  const radiusPixels = point ? metresToPixels(radiusMeters, point.latitude, zoom) : 0;

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!onPick) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, cx, cy, moved: false };
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) current.moved = true;
    if (!current.moved) return;
    // Measure from the pointer-down centre so panning doesn't accelerate as React re-renders.
    setView({
      latitude: yToLat(current.cy - dy / TILE, zoom),
      longitude: xToLng(current.cx - dx / TILE, zoom),
    });
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    drag.current = null;
    if (!current || current.moved || !onPick) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = cx + (event.clientX - rect.left - rect.width / 2) / TILE;
    const y = cy + (event.clientY - rect.top - rect.height / 2) / TILE;
    onPick({ latitude: Math.max(-85, Math.min(85, yToLat(y, zoom))), longitude: xToLng(x, zoom) });
  }

  return <div className={`service-map ${compact ? "map-compact" : ""} ${onPick ? "map-editable" : ""}`}>
    <div className="map-canvas" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { drag.current = null; }}>
      {tiles}
      {zones.map((zone) => {
        const at = offset(zone);
        const size = metresToPixels(zone.radiusMeters, zone.latitude, zoom) * 2;
        return <span key={zone.id} className="map-zone" style={{ left: `calc(50% + ${at.x}px)`, top: `calc(50% + ${at.y}px)`, width: size, height: size }} title={zone.name} />;
      })}
      {marker && <>
        <span className="map-radius" style={{ left: `calc(50% + ${marker.x}px)`, top: `calc(50% + ${marker.y}px)`, width: radiusPixels * 2, height: radiusPixels * 2 }} />
        <span className="map-marker" style={{ left: `calc(50% + ${marker.x}px)`, top: `calc(50% + ${marker.y}px)` }} />
      </>}
    </div>
    <div className="map-controls">
      <button type="button" aria-label="Zoom in" disabled={zoom >= 18} onClick={() => setZoom((value) => Math.min(18, value + 1))}><Plus size={15} /></button>
      <button type="button" aria-label="Zoom out" disabled={zoom <= 4} onClick={() => setZoom((value) => Math.max(4, value - 1))}><Minus size={15} /></button>
      {point && <button type="button" aria-label="Centre map on pin" onClick={() => setView(point)}><Crosshair size={15} /></button>}
    </div>
    <span className="map-attribution">© OpenStreetMap contributors</span>
  </div>;
}
