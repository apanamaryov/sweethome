"use client";

import type { NodeSnapshot } from "@sweethome/dryer-shared";
import { useT } from "@/lib/i18n";
import { stateLabel, stateTone } from "@/lib/dryer";

const PILL: Record<ReturnType<typeof stateTone>, string> = { ok: "pill pill-ok", amber: "pill", bad: "pill pill-bad", muted: "pill pill-muted" };

export default function StateChip({ node }: { node: Pick<NodeSnapshot, "online" | "state"> }) {
  const t = useT();
  return <span className={PILL[stateTone(node)]}>{stateLabel(t, node)}</span>;
}
