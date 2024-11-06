import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import Anthropic from "npm:@anthropic-ai/sdk";

const router = new Router();
const app = new Application();

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
});

// Fixed model to prevent cost issues
const FIXED_MODEL = "claude-3-5-haiku-20241022";

// CORS middleware
app.use((ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set("Access-Control-Allow-Methods", "OPTIONS,POST");
  ctx.response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization"
  );
  return next();
});

interface RequestBody {
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
    cacheable: boolean; // New flag to indicate cacheability
  }>;
  max_tokens?: number;
  temperature?: number;
}

router
  .options("/", (ctx) => {
    ctx.response.status = 200;
    ctx.response.statusText = "OK";
  })
  .post("/", async (ctx) => {
    try {
      const body: RequestBody = await ctx.request.body({ type: "json" }).value;

      // Extract request parameters
      const { messages, max_tokens = 2048, temperature = 0.0 } = body;

      ctx.response.headers.set("Content-Type", "application/json");

      // Determine cacheable messages up to the first non-cacheable message
      const cacheableMessages = [];
      let cacheEnabled = true;

      for (const message of messages) {
        if (message.cacheable && cacheEnabled) {
          cacheableMessages.push({
            role: message.role,
            content: message.content,
            cache_control: { type: "ephemeral" },
          });
        } else {
          cacheEnabled = false;
          cacheableMessages.push({
            role: message.role,
            content: message.content,
          });
        }
      }

      // Send the request with fixed model and prompt caching applied selectively
      const response = await anthropic.messages.create({
        messages: cacheableMessages,
        model: FIXED_MODEL,
        max_tokens,
        temperature,
      });

      ctx.response.body = response;
    } catch (error) {
      console.error("Error:", error);
      ctx.response.status = error.status || 500;
      ctx.response.body = {
        error: {
          message: error.message || "Internal server error",
          type: error.name || "UnknownError",
        },
      };
    }
  });

app.use(router.routes());
await app.listen({ port: 8000 });
