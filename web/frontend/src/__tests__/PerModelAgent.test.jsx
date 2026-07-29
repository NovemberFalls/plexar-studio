import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PerModelAgent from "../components/localReporting/PerModelAgent.jsx";

const baseReport = {
  window: "lifetime",
  models: [
    {
      model: "claude-opus-5",
      provider: "anthropic",
      provider_id: null,
      family: "Opus",
      runs: 12,
      input_tokens: 1000,
      output_tokens: 500,
      tokens: 1500,
      cost_usd: 0.42,
      by_repo: [
        { repo: "claude-cockpit", runs: 8, tokens: 1000 },
        { repo: "other-repo", runs: 4, tokens: 500 },
      ],
    },
    {
      model: "qwen3-coder-30b-awq",
      provider: "local",
      provider_id: "vllm-local",
      family: "qwen3-coder-30b-awq",
      runs: 30,
      input_tokens: null,
      output_tokens: null,
      tokens: null,
      cost_usd: null,
      by_repo: [{ repo: "claude-cockpit", runs: 30, tokens: null }],
    },
  ],
  totals: { runs: 42, tokens: 1500, cost_usd: 0.42 },
};

describe("PerModelAgent — unified per-model table", () => {
  it("renders unified rows with provider badges", () => {
    render(<PerModelAgent data={{ modelsReport: baseReport, metrics: {} }} view={{}} />);
    expect(screen.getByText("claude-opus-5")).toBeTruthy();
    expect(screen.getAllByText("qwen3-coder-30b-awq").length).toBeGreaterThan(0);
    expect(screen.getByText("anthropic")).toBeTruthy();
    expect(screen.getByText("local")).toBeTruthy();
  });

  it("renders 'not reported' for null tokens, never '0'", () => {
    render(<PerModelAgent data={{ modelsReport: baseReport, metrics: {} }} view={{}} />);
    const notReported = screen.getAllByText("not reported");
    expect(notReported.length).toBeGreaterThan(0);
    expect(screen.queryByText(/^0$/)).toBeNull();
  });

  it("renders 'n/a' for null cost_usd, never '$0.00'", () => {
    render(<PerModelAgent data={{ modelsReport: baseReport, metrics: {} }} view={{}} />);
    expect(screen.getByText("n/a")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("expands a row to show its by_repo list, capped, on click", () => {
    render(<PerModelAgent data={{ modelsReport: baseReport, metrics: {} }} view={{}} />);
    expect(screen.queryByText("claude-cockpit")).toBeNull();
    fireEvent.click(screen.getByText("claude-opus-5"));
    expect(screen.getByText("claude-cockpit")).toBeTruthy();
    expect(screen.getByText("other-repo")).toBeTruthy();
  });

  it("caps the by_repo list at 5 with a '+N more' footer", () => {
    const manyRepos = {
      ...baseReport,
      models: [
        {
          ...baseReport.models[0],
          by_repo: Array.from({ length: 8 }, (_, i) => ({ repo: `repo-${i}`, runs: 1, tokens: 10 })),
        },
      ],
    };
    render(<PerModelAgent data={{ modelsReport: manyRepos, metrics: {} }} view={{}} />);
    fireEvent.click(screen.getByText("claude-opus-5"));
    expect(screen.getByText("repo-0")).toBeTruthy();
    expect(screen.getByText("repo-4")).toBeTruthy();
    expect(screen.queryByText("repo-5")).toBeNull();
    expect(screen.getByText("+3 more repos")).toBeTruthy();
  });

  it("renders the empty state when models array is empty", () => {
    render(<PerModelAgent data={{ modelsReport: { models: [] }, metrics: {} }} view={{}} />);
    expect(screen.getByText("No model activity for this window.")).toBeTruthy();
  });

  it("still renders the per-agent half of the grid", () => {
    const metrics = { by_agent: [{ key: "worker-1", runs_total: 5, backend_mix: { lm: 3, api: 2 } }] };
    render(<PerModelAgent data={{ modelsReport: { models: [] }, metrics }} view={{}} />);
    expect(screen.getByText("Per agent · seat & backend mix")).toBeTruthy();
    expect(screen.getByText("worker-1")).toBeTruthy();
  });
});
