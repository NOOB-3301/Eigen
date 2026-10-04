"use client";
import { Modal } from "@/components/ui";

export type SettingsSection = "models" | "telegram" | "memory" | "sandbox" | "tools" | "advanced";

/**
 * CONTRACT STUB (owned by the app-settings worker, who replaces the body; the canvas worker opens it from the top bar and palette).
 * Editor for the shared root ~/.eigen/config.json.
 */
export function SettingsDialog({ open, onClose, section }: { open: boolean; onClose: () => void; section?: SettingsSection }) {
  return (
    <Modal open={open} onClose={onClose} title="Settings" description="Shared config for every agent.">
      <div className="p-4 text-ink-3">{section ?? "models"}</div>
    </Modal>
  );
}
