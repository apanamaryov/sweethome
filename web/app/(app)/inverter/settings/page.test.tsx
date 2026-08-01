import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  renderWithProviders,
  buildSnapshot,
  buildRatedInfo,
  buildFlags,
  buildBaseline,
  buildMeta,
  restoreLocation,
} from "@/test-utils/renderWithProviders";
import { DICTS } from "@/lib/i18n/dict";
import SettingsPage from "./page";

const t = DICTS.uk;

afterEach(() => {
  restoreLocation();
});

describe("SettingsPage — settings table & baseline", () => {
  it("shows 'not read yet' when the snapshot has no info", async () => {
    await renderWithProviders(<SettingsPage />, { snapshot: buildSnapshot({ info: null }), withMeta: true });

    expect(screen.getByText(t.blNotRead)).toBeInTheDocument();
  });

  it("renders current values (coded + unit'd) and the 'no baseline yet' note", async () => {
    const info = buildRatedInfo({ outputSourcePriority: 0, batteryBulkVoltage: 56.4, socLowCutoff: 10 });
    const { container } = await renderWithProviders(<SettingsPage />, {
      snapshot: buildSnapshot({ info, baseline: null }),
    });
    // Scoped to the settings table: the control panel below also renders an
    // "outputSourcePriority" segmented button labeled t.osp[0], so an unscoped
    // getByText(t.osp[0]) would match twice.
    const table = within(container.querySelector(".settings-table")!);

    expect(screen.getByText(t.blNone)).toBeInTheDocument();
    expect(table.getByText(t.osp[0])).toBeInTheDocument(); // coded outputSourcePriority display
    expect(table.getByText("56.4 " + t.unit_V)).toBeInTheDocument();
    expect(table.getByText("10 " + t.unit_pct)).toBeInTheDocument();
  });

  it("shows the baseline note with captured date/device, and highlights drifted rows", async () => {
    const info = buildRatedInfo({ batteryBulkVoltage: 56.4 });
    const baseline = buildBaseline({ deviceId: "sk5500-1", info: buildRatedInfo({ batteryBulkVoltage: 55.0 }) });
    const { container } = await renderWithProviders(<SettingsPage />, {
      snapshot: buildSnapshot({ info, baseline }),
    });

    expect(screen.getByText("sk5500-1")).toBeInTheDocument();
    const bulkRow = screen.getByText(t.sBulk).closest(".srow");
    expect(bulkRow).toHaveClass("drift");
  });

  it("renders flag chips with translated names and on/off state", async () => {
    const flags = buildFlags({
      flags: [
        { key: "lcdHome", name: "LCD return to home", enabled: true },
        { key: "ecoMode", name: "ECO mode", enabled: false },
      ],
    });
    await renderWithProviders(<SettingsPage />, { snapshot: buildSnapshot({ flags }) });

    const on = screen.getByText("✓ " + t.flags.lcdHome);
    const off = screen.getByText("✕ " + t.flags.ecoMode);
    expect(on).toHaveClass("flag-chip", "on");
    expect(off).toHaveClass("flag-chip", "off");
  });

  it("recapture button POSTs /api/inverter/baseline/recapture and toasts on success", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await renderWithProviders(<SettingsPage />, { snapshot: buildSnapshot() });

    await user.click(screen.getByRole("button", { name: t.recaptureBtn }));

    expect(await screen.findByText(t.toastBaselineOk)).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/inverter/baseline/recapture",
      expect.objectContaining({ method: "POST" })
    );
  });
});

describe("SettingsPage — control panel (lock bar)", () => {
  it("shows the server-disabled message when allowControl is false", async () => {
    await renderWithProviders(<SettingsPage />, {
      snapshot: buildSnapshot({ control: { allowControl: false, locked: true } }),
    });

    expect(screen.getByText(t.lockDisabledServer)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t.btnUnlock })).not.toBeInTheDocument();
  });

  it("shows locked status + unlock button, and disables the priority/current controls", async () => {
    await renderWithProviders(<SettingsPage />, {
      snapshot: buildSnapshot({ control: { allowControl: true, locked: true } }),
    });

    expect(screen.getByText(t.lockLocked)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.btnUnlock })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.osp[0] })).toBeDisabled();
    // Two identical "Apply" buttons (mcc + macc) — both must be disabled while locked.
    for (const btn of screen.getAllByRole("button", { name: t.apply })) {
      expect(btn).toBeDisabled();
    }
  });

  it("shows unlocked status + lock button, and enables the controls", async () => {
    await renderWithProviders(<SettingsPage />, {
      snapshot: buildSnapshot({ control: { allowControl: true, locked: false } }),
    });

    expect(screen.getByText(t.lockUnlocked)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.btnLock })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.osp[0] })).toBeEnabled();
  });

  it("toggling the lock POSTs /api/inverter/lock and toasts the new state", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, locked: true }) });
    const user = userEvent.setup();
    await renderWithProviders(<SettingsPage />, {
      snapshot: buildSnapshot({ control: { allowControl: true, locked: false } }),
    });

    await user.click(screen.getByRole("button", { name: t.btnLock }));

    expect(await screen.findByText(t.toastLocked)).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith("/api/inverter/lock", expect.objectContaining({ method: "POST" }));
  });

  it("picking a new output-source-priority opens a confirm dialog, and confirming applies it", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, command: "W 301 1" }) });
    const user = userEvent.setup();
    await renderWithProviders(<SettingsPage />, {
      snapshot: buildSnapshot({ info: buildRatedInfo({ outputSourcePriority: 0 }), control: { allowControl: true, locked: false } }),
    });

    await user.click(screen.getByRole("button", { name: t.osp[1] }));

    expect(screen.getByText(t.modalConfirm.replace("{label}", t.osp[1]))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t.modalOk }));

    expect(await screen.findByText(t.toastDone + "W 301 1 → ACK")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/inverter/control",
      expect.objectContaining({ body: JSON.stringify({ type: "outputSourcePriority", value: 1 }) })
    );
  });

  it("cancelling the confirm dialog sends nothing", async () => {
    global.fetch = jest.fn();
    const user = userEvent.setup();
    await renderWithProviders(<SettingsPage />, {
      snapshot: buildSnapshot({ info: buildRatedInfo({ outputSourcePriority: 0 }), control: { allowControl: true, locked: false } }),
    });

    await user.click(screen.getByRole("button", { name: t.osp[1] }));
    await user.click(screen.getByRole("button", { name: t.modalCancel }));

    expect(screen.queryByText(t.modalConfirm.replace("{label}", t.osp[1]))).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalledWith("/api/inverter/control", expect.anything());
  });

  it("a rejected control write toasts the rejection reason", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: "NAK" }) });
    const user = userEvent.setup();
    await renderWithProviders(<SettingsPage />, {
      snapshot: buildSnapshot({ info: buildRatedInfo({ outputSourcePriority: 0 }), control: { allowControl: true, locked: false } }),
    });

    await user.click(screen.getByRole("button", { name: t.osp[1] }));
    await user.click(screen.getByRole("button", { name: t.modalOk }));

    expect(await screen.findByText(t.toastRejected + "NAK")).toBeInTheDocument();
  });

  it("renders the max-charging-current selects from meta's allowed values, pre-filled from info", async () => {
    const { container } = await renderWithProviders(<SettingsPage />, {
      snapshot: buildSnapshot({
        info: buildRatedInfo({ maxChargingCurrent: 60, maxAcChargingCurrent: 30 }),
        control: { allowControl: true, locked: true },
      }),
      meta: buildMeta("admin"),
    });

    const selects = container.querySelectorAll<HTMLSelectElement>(".control select");
    expect(selects).toHaveLength(2);
    expect(selects[0].value).toBe("60"); // mcc, pre-filled from info while locked
    expect(selects[1].value).toBe("30"); // macc
  });

  // NB: SettingsPage/ControlPanel itself has no role check at all (no useMeta().session.role
  // gating anywhere in this file) — it renders the full control panel regardless of the
  // viewer/admin role in meta. The actual "viewer can't reach Settings" protection lives in
  // app/(app)/layout.tsx's NavTabs guard (redirects a viewer away from /settings) and in the
  // server-side page redirect, not in this component. Documented as a known limitation /
  // clarification versus the task brief in the task-20 report; covered separately in
  // layout.test.tsx.
  it("(documented gap) still renders the full control panel when meta reports role=viewer", async () => {
    await renderWithProviders(<SettingsPage />, {
      snapshot: buildSnapshot({ control: { allowControl: true, locked: false } }),
      meta: buildMeta("viewer"),
    });

    expect(screen.getByRole("button", { name: t.btnLock })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: t.apply }).length).toBe(2);
  });
});
