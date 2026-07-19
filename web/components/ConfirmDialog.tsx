"use client";

export function ConfirmDialog({
  text,
  okLabel,
  cancelLabel,
  onOk,
  onCancel,
}: {
  text: string;
  okLabel: string;
  cancelLabel: string;
  onOk: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal">
      <div className="modal-box">
        <p>{text}</p>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="btn-danger" onClick={onOk}>
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
