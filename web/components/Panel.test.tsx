import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Panel } from "./Panel";

describe("Panel", () => {
  it("renders the title and children", () => {
    render(
      <Panel title="Battery settings">
        <p>child content</p>
      </Panel>
    );

    expect(screen.getByText("Battery settings")).toBeInTheDocument();
    expect(screen.getByText("child content")).toBeInTheDocument();
  });

  it("starts collapsed (body hidden, toggle not open)", () => {
    render(
      <Panel title="Advanced">
        <p>child content</p>
      </Panel>
    );

    const toggle = screen.getByRole("button", { name: /Advanced/ });
    expect(toggle.className).not.toMatch(/\bopen\b/);
    expect(screen.getByText("child content").parentElement).toHaveClass("panel-body", "hidden");
  });

  it("expands the body and marks the toggle open when clicked", async () => {
    const user = userEvent.setup();
    render(
      <Panel title="Advanced">
        <p>child content</p>
      </Panel>
    );

    await user.click(screen.getByRole("button", { name: /Advanced/ }));

    const toggle = screen.getByRole("button", { name: /Advanced/ });
    expect(toggle).toHaveClass("open");
    const body = screen.getByText("child content").parentElement!;
    expect(body).toHaveClass("panel-body");
    expect(body).not.toHaveClass("hidden");
  });

  it("collapses again on a second click", async () => {
    const user = userEvent.setup();
    render(
      <Panel title="Advanced">
        <p>child content</p>
      </Panel>
    );

    const toggle = screen.getByRole("button", { name: /Advanced/ });
    await user.click(toggle);
    await user.click(toggle);

    expect(toggle).not.toHaveClass("open");
    expect(screen.getByText("child content").parentElement).toHaveClass("hidden");
  });
});
