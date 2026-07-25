import { render, screen } from "@testing-library/react";

it("jsdom renders", () => {
  render(<div>hello</div>);
  expect(screen.getByText("hello")).toBeInTheDocument();
});
