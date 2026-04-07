import type { Logger } from "../logger.js";
import { BaseArrClient } from "./arr-client.js";

export class RadarrClient extends BaseArrClient {
  constructor(url: string, apiKey: string, logger: Logger) {
    super("Radarr", url, apiKey, "v3", logger);
  }
}
