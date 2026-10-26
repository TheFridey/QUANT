"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export function AnimatedValue({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const previous = useRef(value);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (previous.current === value) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) {
      const prevNum = Number(previous.current.replace(/[^0-9.-]/g, ""));
      const nextNum = Number(value.replace(/[^0-9.-]/g, ""));
      if (Number.isFinite(prevNum) && Number.isFinite(nextNum) && prevNum !== nextNum) {
        setFlash(nextNum > prevNum ? "up" : "down");
        const timer = window.setTimeout(() => setFlash(null), 450);
        previous.current = value;
        return () => window.clearTimeout(timer);
      }
    }
    previous.current = value;
  }, [value]);

  return (
    <span
      className={cn(
        "mono inline-block transition-colors duration-300",
        flash === "up" && "text-profit",
        flash === "down" && "text-loss",
        className,
      )}
    >
      {value}
    </span>
  );
}
