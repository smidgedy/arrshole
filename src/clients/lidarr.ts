import type { Logger } from "../logger.js";
import { BaseArrClient } from "./arr-client.js";

export class LidarrClient extends BaseArrClient {
  constructor(url: string, apiKey: string, logger: Logger) {
    super("Lidarr", url, apiKey, "v1", logger);
  }
}
