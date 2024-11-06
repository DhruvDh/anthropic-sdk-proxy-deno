import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import Anthropic from "npm:@anthropic-ai/sdk";

const router = new Router();
const app = new Application();

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
});

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
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  model?: string;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
}

router
  .options("/", (ctx) => {
    ctx.response.status = 200;
    ctx.response.statusText = "OK";
  })
  .post("/", async (ctx) => {
    try {
      const body: RequestBody = await ctx.request.body.json();

      // Extract request parameters
      const {
        messages,
        model = "claude-3-5-haiku-20241022",
        max_tokens = 2048,
        stream = false,
        temperature = 0.0,
      } = body;

      if (stream) {
        ctx.response.headers.set("Content-Type", "text/event-stream");
        const target = ctx.sendEvents();

        try {
          // Stream responses from Anthropic
          const stream = await anthropic.messages.create({
            messages,
            model,
            max_tokens,
            temperature,
            stream: true,
          });

          for await (const chunk of stream) {
            // Pass through the raw SSE events from Anthropic
            target.dispatchEvent(chunk);
          }
          await target.close();
        } catch (error) {
          console.error("Stream error:", error);
          await target.close();
          throw error;
        }
      } else {
        ctx.response.headers.set("Content-Type", "application/json");
        // Handle regular response
        const response = await anthropic.messages.create({
          messages,
          model,
          max_tokens,
          temperature,
        });

        ctx.response.body = response;
      }
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
