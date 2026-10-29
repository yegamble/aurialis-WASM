import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Modal } from "../Primitives";
afterEach(cleanup);
it("makes the page inert and restores it after closing the modal", () => {
  const { container, rerender } = render(<><button>Page action</button><Modal open title="Review" onClose={vi.fn()}><button>Review action</button></Modal></>);
  expect(container.inert).toBe(true);
  expect(screen.getByRole("dialog").parentElement?.inert).not.toBe(true);
  rerender(<><button>Page action</button><Modal open={false} title="Review" onClose={vi.fn()}><button>Review action</button></Modal></>);
  expect(container.inert).not.toBe(true);
});
it("keeps the page inert while a second modal closes and routes Escape only to the active modal", () => {
  const closeOuter = vi.fn(), closeInner = vi.fn();
  const ui = (inner: boolean) => <><Modal open title="Outer" onClose={closeOuter}><button>Outer action</button></Modal><Modal open={inner} title="Inner" onClose={closeInner}><button>Inner action</button></Modal></>;
  const { container, rerender } = render(ui(false)); rerender(ui(true));
  fireEvent.keyDown(document, { key: "Escape" }); expect(closeInner).toHaveBeenCalledOnce(); expect(closeOuter).not.toHaveBeenCalled();
  rerender(ui(false)); expect(container.inert).toBe(true); expect(screen.getByRole("dialog").parentElement?.inert).not.toBe(true);
});
