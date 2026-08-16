/**
 * Model Status Extension
 *
 * Shows the currently active provider and model in the status bar (toolbar),
 * leftmost, in green using raw ANSI codes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

export default function modelStatus(pi: ExtensionAPI) {
  function setStatus(ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) {
    const model = ctx.model;
    const label = model ? `${model.provider} / ${model.id}` : "no model";
    ctx.ui.setStatus("00-model", `${GREEN}${label}${RESET}`);
  }

  pi.on("session_start", (_event, ctx) => {
    setStatus(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    setStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("00-model", undefined);
  });
}
