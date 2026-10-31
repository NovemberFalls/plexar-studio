import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AgentApprovalDialog from "../components/AgentApprovalDialog";

const adopt = {
  id: "a1", kind: "adopt", caller_name: "implementation", target_name: "FW-World",
  prompt: null, status: "pending",
};
const refresh = { ...adopt, id: "a2", kind: "self_refresh", target_name: "implementation", prompt: "Read HANDOFF.md" };

describe("AgentApprovalDialog", () => {
  it("renders nothing without a request", () => {
    const { container } = render(<AgentApprovalDialog request={null} onAnswer={vi.fn()} onDismiss={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("names both sessions and answers with the request id", async () => {
    const onAnswer = vi.fn().mockResolvedValue({ ok: true });
    render(<AgentApprovalDialog request={adopt} onAnswer={onAnswer} onDismiss={vi.fn()} />);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("implementation wants to take over FW-World");
    fireEvent.click(screen.getByText("Allow takeover"));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("a1", true));
  });

  it("shows the boot line for a self-refresh", () => {
    render(<AgentApprovalDialog request={refresh} onAnswer={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText("Read HANDOFF.md")).toBeTruthy();
  });

  it("keeps the dialog open and shows the refusal when the answer fails", async () => {
    const onAnswer = vi.fn().mockResolvedValue({ ok: false, error: "session is gone" });
    render(<AgentApprovalDialog request={adopt} onAnswer={onAnswer} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByText("Deny"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "session is gone");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("Escape dismisses without answering", () => {
    const onAnswer = vi.fn();
    const onDismiss = vi.fn();
    render(<AgentApprovalDialog request={adopt} onAnswer={onAnswer} onDismiss={onDismiss} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
