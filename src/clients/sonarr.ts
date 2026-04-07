import type { Logger } from "../logger.js";
import { BaseArrClient } from "./arr-client.js";

export class SonarrClient extends BaseArrClient {
  constructor(url: string, apiKey: string, logger: Logger) {
    super("Sonarr", url, apiKey, "v3", logger);
  }
}
