"use client";

import SettingsForm from "@/components/dryer/SettingsForm";
import PresetsEditor from "@/components/dryer/PresetsEditor";

export default function DryerSettingsPage() {
  return (
    <main className="grid">
      <SettingsForm />
      <PresetsEditor />
    </main>
  );
}
