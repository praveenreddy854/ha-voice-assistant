import { render, screen } from "@testing-library/react";
import Header from "./components/Header";

test("renders the main navigation", () => {
  render(<Header activeView="main" onChangeView={() => undefined} />);

  expect(screen.getByText("🏠 HA Voice Assistant")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Assistant" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Scheduled Tasks" })
  ).toBeInTheDocument();
});
