import { Controller, Get } from "@nestjs/common";
import { aurumReadiness } from "@odin/shared";

/** Inactive capability contract, behind the application's global JWT guard. No provider or DB calls. */
@Controller("aurum")
export class AurumController {
  @Get("readiness")
  readiness() {
    return aurumReadiness();
  }
}
