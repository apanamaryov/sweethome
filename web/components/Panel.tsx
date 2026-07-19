"use client";

import { ReactNode, useState } from "react";

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel">
      <button className={"panel-toggle" + (open ? " open" : "")} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <span className="chev">▾</span>
      </button>
      <div className={"panel-body" + (open ? "" : " hidden")}>{children}</div>
    </section>
  );
}
