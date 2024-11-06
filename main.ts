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

router
  .options("/", (ctx) => {
    ctx.response.status = 200;
    ctx.response.statusText = "OK";
  })
  .post("/", async (ctx) => {
    try {
      const body = await ctx.request.body.json();

      // Extract request parameters
      const {
        messages,
        model = "claude-3-5-haiku-20241022",
        max_tokens = 2048,
        stream = false,
      } = body;

      if (stream) {
        // Handle streaming response
        const stream = await anthropic.messages.create({
          messages,
          model,
          max_tokens,
          stream: true,
        });

        // Set up streaming response headers
        ctx.response.headers.set("Content-Type", "text/event-stream");
        ctx.response.headers.set("Cache-Control", "no-cache");
        ctx.response.headers.set("Connection", "keep-alive");

        // Create a readable stream from the Anthropic stream
        const body = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of stream) {
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)
                );
              }
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          },
        });

        ctx.response.body = body;
      } else {
        // Handle regular response
        const response = await anthropic.messages.create({
          messages,
          model,
          max_tokens,
        });

        ctx.response.body = response;
      }
    } catch (error) {
      console.error("Error:", error);
      ctx.response.status = error.status || 500;
      ctx.response.body = {
        error: {
          message: error.message,
          type: error.name,
        },
      };
    }
  });

app.use(router.routes());
await app.listen({ port: 8000 });
