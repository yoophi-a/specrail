import { loadConfig } from "@specrail/config";

const config = loadConfig();

function bootstrap(): void {
  console.log(`[specrail] api bootstrap on port ${config.port}`);
  console.log("[specrail] next step: wire HTTP routes and SSE event stream");
}

bootstrap();
