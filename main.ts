import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import Anthropic from "npm:@anthropic-ai/sdk";

const router = new Router();
const app = new Application();

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
});

// Initialize Deno KV
const kv = await Deno.openKv();

// Fixed model to prevent cost issues
const FIXED_MODEL = "claude-3-5-haiku-20241022";

// Rate limit constants
const MAX_REQUESTS = 78;
const RATE_LIMIT_ERROR = {
  error: {
    message: `Message quota exceeded. Maximum ${MAX_REQUESTS} requests allowed per user.`,
    type: "MessageQuotaExceeded",
  },
};

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
  email: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    cacheable?: boolean; // Make this optional
  }>;
  system?: string;
  max_tokens?: number;
  temperature?: number;
}

// Helper function to check and increment rate limit
async function checkRateLimit(email: string): Promise<boolean> {
  const key = ["rate_limit", email];
  const atomic = kv.atomic();
  const currentCount = await kv.get(key);

  if (!currentCount.value) {
    await atomic.set(key, 1).commit();
    return true;
  }

  if (currentCount.value >= MAX_REQUESTS) {
    return false;
  }

  await atomic.set(key, (currentCount.value as number) + 1).commit();
  return true;
}

router
  .options("/", (ctx) => {
    ctx.response.status = 200;
    ctx.response.statusText = "OK";
  })
  .post("/", async (ctx) => {
    try {
      const body: RequestBody = await ctx.request.body.json();

      if (!body.email) {
        ctx.response.status = 400;
        ctx.response.body = {
          error: {
            message: "Email is required",
            type: "ValidationError",
          },
        };
        return;
      }

      const withinLimit = await checkRateLimit(body.email);
      if (!withinLimit) {
        ctx.response.status = 429;
        ctx.response.body = RATE_LIMIT_ERROR;
        return;
      }

      const { messages, system, max_tokens = 2048, temperature = 0.0 } = body;

      ctx.response.headers.set("Content-Type", "application/json");

      // Transform messages for the API
      const transformedMessages = messages.map((message, index) => {
        if (message.cacheable) {
          return {
            role: message.role,
            content: message.content,
            cache_control: {
              type: "ephemeral",
            },
          };
        }
        return {
          role: message.role,
          content: message.content,
        };
      });

      // Create the request payload
      const requestPayload = {
        messages: transformedMessages,
        model: FIXED_MODEL,
        max_tokens,
        temperature,
        ...(system && { system }),
      };

      const response = await anthropic.messages.create(requestPayload);
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
