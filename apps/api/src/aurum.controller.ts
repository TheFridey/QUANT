import { Controller, Get } from "@nestjs/common";
import { aurumReadiness, legacyRetirementFromEnv } from "@odin/shared";

/** Inactive capability contract, behind the application's global JWT guard. No provider or DB calls. */
@Controller("aurum")
export class AurumController {
  @Get("readiness")
  readiness() {
    const legacy = legacyRetirementFromEnv();
    return {
      ...aurumReadiness(),
      // CATALYST: the configured legacy mode as this API process reads it. In production the API and worker load
      // the same repository .env; the worker logs its own mode at start, which is the authoritative signal.
      legacyCrypto: { mode: legacy.mode, discoveryEnabled: legacy.discoveryEnabled, newEntriesEnabled: legacy.newEntriesEnabled, issue: legacy.issue, source: "API_PROCESS_ENV" as const },
    };
  }
}
