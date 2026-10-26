import * as React from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "flex h-9 w-full rounded-md border border-border bg-panel px-3 text-sm text-foreground outline-none placeholder:text-muted focus:border-primary",
        className,
      )}
      {...props}
    />
  );
}
