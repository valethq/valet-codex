import { definePlugin } from "@valethq/sdk";
import type { CodexConfig } from "./config";
import { createProvider, PROVIDER_KEY } from "./provider";
import { registerSettings } from "./settings";

export default definePlugin<CodexConfig>({
  activate(ctx) {
    const { provider, usage, dispose } = createProvider(ctx);
    ctx.onDispose(dispose);
    ctx.scopes.provide("inference", provider, { key: PROVIDER_KEY });
    registerSettings(ctx, usage);
    ctx.onConfigChange(() => {}); // values are read from ctx.config at use; launch options apply when the app-server restarts
  },
});
