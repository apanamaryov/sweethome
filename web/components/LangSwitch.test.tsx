import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LangSwitch } from "./LangSwitch";
import { LangProvider } from "@/lib/i18n";

beforeEach(() => {
  localStorage.clear();
});

describe("LangSwitch", () => {
  it("renders a button per language, with the initial uk language marked active", () => {
    render(
      <LangProvider>
        <LangSwitch />
      </LangProvider>
    );

    const nav = screen.getByRole("navigation", { name: "Language" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "UA" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "RU" })).not.toHaveClass("active");
    expect(screen.getByRole("button", { name: "EN" })).not.toHaveClass("active");
  });

  it("switches the active language (and the shared i18n state) when a button is clicked", async () => {
    const user = userEvent.setup();
    render(
      <LangProvider>
        <LangSwitch />
      </LangProvider>
    );

    await user.click(screen.getByRole("button", { name: "EN" }));

    expect(screen.getByRole("button", { name: "EN" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "UA" })).not.toHaveClass("active");
    expect(localStorage.getItem("lang")).toBe("en");
  });
});
