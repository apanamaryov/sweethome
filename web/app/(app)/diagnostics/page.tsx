"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { postJson } from "@/lib/api";
import { Panel } from "@/components/Panel";

export default function DiagnosticsPage() {
  const t = useT();
  const [cmd, setCmd] = useState("");
  const [out, setOut] = useState<string | null>(null);

  const send = async () => {
    const command = cmd.trim().toUpperCase();
    if (!command) return;
    setOut("…");
    try {
      const data = await (await postJson("/api/raw", { command })).json();
      setOut(data.ok ? data.reply : t.toastError + ": " + data.error);
    } catch (e) {
      setOut(t.toastNetErr + (e as Error).message);
    }
  };

  return (
    <Panel title={t.panelAdvanced}>
      {/* advNote содержит <code> из собственного словаря — не пользовательский ввод */}
      <p className="note" dangerouslySetInnerHTML={{ __html: t.advNote }} />
      <div className="row">
        <input
          type="text"
          value={cmd}
          placeholder="QPIGS"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button className="apply" onClick={send}>
          {t.send}
        </button>
      </div>
      {out !== null && <pre className="raw-out">{out}</pre>}
    </Panel>
  );
}
