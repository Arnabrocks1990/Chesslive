import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

// One entry point for every LLM call in the app (live-assist explanations, coach decisions, plans,
// grounded Q&A, plain-English rewrites). Uses the Anthropic API with the key from the environment.
// Callers already fall back to rules when this throws, so a missing key or a failed call never breaks a feature.

let client: Anthropic | null = null;

/** Runs one prompt and returns the text of the reply. */
export async function askClaude(prompt: string, opts: { maxTokens?: number } = {}): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  client ??= new Anthropic({ timeout: config.claudeTimeoutMs, maxRetries: 2 });
  const res = await client.messages.create({
    model: config.claudeModel,
    max_tokens: opts.maxTokens ?? 3000,
    messages: [{ role: "user", content: prompt }],
  });
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  if (!text) throw new Error("Empty reply from the model");
  return text;
}
