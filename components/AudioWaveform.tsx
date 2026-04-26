"use client";

import { useEffect, useRef } from "react";

interface Props {
  getAnalyser: () => AnalyserNode | null;
  active: boolean;
  bars?: number;
  color?: string;
}

/**
 * Minimal live waveform: vertical bars driven by frequency-domain data.
 * Lightweight — single canvas, requestAnimationFrame, no deps.
 */
export function AudioWaveform({ getAnalyser, active, bars = 24, color = "#8B2E2C" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      // clear canvas when inactive
      const c = canvasRef.current;
      if (c) c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
      return;
    }

    let cancelled = false;

    const draw = () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      const analyser = getAnalyser();
      if (!canvas || !analyser) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      // High-DPI
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);

      // Bin frequency data into `bars`
      const step = Math.floor(data.length / bars);
      const barW = cssW / bars - 2;
      const midY = cssH / 2;

      ctx.fillStyle = color;
      for (let i = 0; i < bars; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += data[i * step + j] || 0;
        const v = sum / step / 255; // 0..1
        const h = Math.max(2, v * cssH * 0.95);
        const x = i * (barW + 2);
        ctx.beginPath();
        ctx.roundRect(x, midY - h / 2, barW, h, barW / 2);
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, getAnalyser, bars, color]);

  return <canvas ref={canvasRef} className="w-full h-full" />;
}
