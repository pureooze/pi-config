# @pureooze/pi-model-failover

When an `openai` or `openai-codex` request ends in an explicit rate-limit or usage/quota error, this Pi extension waits for Pi's built-in retries to finish, then switches the **same session** to `minimax/MiniMax-M3` with **high** thinking. It sends one short continuation instruction; it does not repeat the original user prompt or automatically switch back to OpenAI.

## Use

Configure MiniMax authentication in Pi first (`/login minimax` or its supported API key configuration). For a local trial:

```bash
pi --extension ./packages/model-failover/index.ts
```

The extension acts only on final OpenAI rate/quota failures (including ChatGPT usage-limit responses and HTTP 429). It does not switch on network, server, context-length, auth, or unrelated errors. If MiniMax is unavailable or the model has been changed/another prompt queued before continuation, it skips the continuation. There is no automatic restore when OpenAI's limit resets; select your OpenAI model manually when ready.

The resumed prompt is an additional turn after the failed assistant message. It cannot erase the original failed turn or guarantee that previously completed tools are never repeated; review any consequential operations. This extension has unit coverage but has not been exercised against a live OpenAI five-hour block.
