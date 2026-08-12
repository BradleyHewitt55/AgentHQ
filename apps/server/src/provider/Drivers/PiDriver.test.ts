import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { PiDriver, PI_SLASH_COMMANDS } from "./PiDriver.ts";

describe("PiDriver", () => {
  it("is registered as a built-in provider driver", () => {
    expect(PiDriver.driverKind).toBe(ProviderDriverKind.make("pi"));
    expect(BUILT_IN_DRIVERS).toContain(PiDriver);
  });

  it("advertises only Pi's documented SDK command", () => {
    expect(PI_SLASH_COMMANDS).toEqual([
      { name: "reload", description: "Reload Pi extensions, skills, prompts, and settings." },
    ]);
  });

  it("uses the default Pi agent directory when no override is configured", () => {
    expect(DEFAULT_SERVER_SETTINGS.providers.pi).toEqual({
      enabled: true,
      agentDir: "",
      customModels: [],
    });
    expect(PiDriver.defaultConfig()).toEqual(DEFAULT_SERVER_SETTINGS.providers.pi);
  });
});
