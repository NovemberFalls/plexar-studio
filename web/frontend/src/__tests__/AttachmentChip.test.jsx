/**
 * AttachmentChip — pending composer chip and Artifacts-rail chip share this
 * component. Pinning: image -> real <img> at /api/upload/{basename}; a
 * non-image -> icon only, never an <img>; a broken thumbnail degrades to the
 * icon instead of a broken-image glyph; the full filename always survives in
 * `title` even when the visible label is truncated; remove still works.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import AttachmentChip from "../components/chat/AttachmentChip.jsx";

describe("AttachmentChip", () => {
  it("renders an <img> pointing at /api/upload/<basename> for an image attachment", () => {
    const a = {
      filename: "ChatGPT Image Jul 31, 2026, 07_37_41 AM.png",
      path: "C:\\Users\\x\\cockpit_uploads_abc\\deadbeef_shot.png",
      kind: "image", size_bytes: 12345,
    };
    render(<AttachmentChip attachment={a} />);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "/api/upload/deadbeef_shot.png");
    expect(img).toHaveAttribute("alt", a.filename);
  });

  it("renders an icon and NO img for a non-image attachment", () => {
    const a = { filename: "notes.txt", path: "C:\\x\\notes.txt", kind: "file", size_bytes: 40 };
    render(<AttachmentChip attachment={a} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("falls back to the icon when the image thumbnail fails to load", () => {
    const a = {
      filename: "shot.png", path: "C:\\x\\deadbeef_shot.png", kind: "image", size_bytes: 999,
    };
    render(<AttachmentChip attachment={a} />);
    const img = screen.getByRole("img");
    fireEvent.error(img);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("keeps the full filename in the title attribute even when the label is truncated", () => {
    const longName = "ChatGPT Image Jul 31, 2026, 07_37_41 AM.png";
    const a = { filename: longName, path: "C:\\x\\y.png", kind: "image", size_bytes: 100 };
    const { container } = render(<AttachmentChip attachment={a} />);
    const chip = container.querySelector("[title]");
    expect(chip).toHaveAttribute("title", longName);
    // The visible label is shorter than the real name.
    expect(chip.textContent).not.toContain(longName);
  });

  it("still calls onRemove when the remove button is clicked", () => {
    const onRemove = vi.fn();
    const a = { filename: "doc.pdf", path: "C:\\x\\doc.pdf", kind: "file", size_bytes: 10 };
    render(<AttachmentChip attachment={a} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: /remove doc\.pdf/i }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
