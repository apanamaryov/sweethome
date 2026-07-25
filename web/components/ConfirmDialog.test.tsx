import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("shows the message and both labelled actions", () => {
    render(
      <ConfirmDialog
        text="Really unlock control?"
        okLabel="Unlock"
        cancelLabel="Cancel"
        onOk={() => {}}
        onCancel={() => {}}
      />
    );

    expect(screen.getByText("Really unlock control?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("invokes onOk when the confirm button is clicked, not onCancel", async () => {
    const user = userEvent.setup();
    const onOk = jest.fn();
    const onCancel = jest.fn();
    render(
      <ConfirmDialog text="Sure?" okLabel="Yes" cancelLabel="No" onOk={onOk} onCancel={onCancel} />
    );

    await user.click(screen.getByRole("button", { name: "Yes" }));

    expect(onOk).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("invokes onCancel when the cancel button is clicked, not onOk", async () => {
    const user = userEvent.setup();
    const onOk = jest.fn();
    const onCancel = jest.fn();
    render(
      <ConfirmDialog text="Sure?" okLabel="Yes" cancelLabel="No" onOk={onOk} onCancel={onCancel} />
    );

    await user.click(screen.getByRole("button", { name: "No" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onOk).not.toHaveBeenCalled();
  });
});
