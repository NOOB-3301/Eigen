"use client";
import { motion } from "motion/react";
import { cn } from "@/lib/cn";

/** A slim message strip under a panel header; animates its height so the content below does not jump. */
export function Banner({ tone, icon, children }: { tone: "warn" | "bad"; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <motion.div role="status" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
      <div className={cn("flex gap-2.5 border-b px-5 py-3 text-[12.5px]", tone === "warn" ? "border-warn/30 bg-warn/8 text-ink" : "border-bad/30 bg-bad/8 text-ink")}>
        <span className={cn("mt-0.5", tone === "warn" ? "text-warn" : "text-bad")}>{icon}</span>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </motion.div>
  );
}
