"use client";

/**
 * CONTRACT STUB (owned by the app-settings worker, who replaces the body; consumers keep this signature).
 * Write-only secret field for one ~/.eigen/.env variable: shows "set" / "not set", lets the user type a new value and save it
 * (PUT /api/secrets/:name via putSecret), replace or remove it. Never displays or keeps a value after saving.
 */
export function SecretInput({ name, set, label, onSaved }: { name: string; set: boolean; label?: string; onSaved?: () => void }) {
  void onSaved;
  return (
    <div className="text-[12px] text-ink-3" data-secret-name={name}>
      {label ?? name}: {set ? "set" : "not set"}
    </div>
  );
}
