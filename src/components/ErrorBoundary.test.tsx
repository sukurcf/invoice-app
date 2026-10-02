import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";
import { ErrorMessage, Loading } from "./Feedback";

describe("failure boundaries", () => {
  it("renders its children when they are healthy", () => {
    render(<ErrorBoundary><p>Healthy application</p></ErrorBoundary>);
    expect(screen.getByText("Healthy application")).toBeInTheDocument();
  });
  it("reports unexpected rendering failures and offers recovery without claiming data loss", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const expectedError = (event: ErrorEvent) => {
      if (event.message === "Unexpected render failure") event.preventDefault();
    };
    window.addEventListener("error", expectedError);
    function Broken(): never { throw new Error("Unexpected render failure"); }
    try {
      render(<ErrorBoundary><Broken /></ErrorBoundary>);
      expect(screen.getByRole("alert")).toHaveTextContent("Saved data remains on the server");
      expect(screen.getByRole("button", { name: "Reload application" })).toBeInTheDocument();
      expect(logged).toHaveBeenCalled();
    } finally {
      window.removeEventListener("error", expectedError);
    }
  });
  it("renders explicit loading and error states", () => {
    const { rerender } = render(<Loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    rerender(<ErrorMessage error={new Error("Failure")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Failure");
    rerender(<ErrorMessage error={null} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
