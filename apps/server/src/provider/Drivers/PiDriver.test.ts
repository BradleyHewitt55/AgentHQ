import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { PiDriver } from "./PiDriver.ts";

describe("PiDriver", () => {
  it("is registered as a built-in provider driver", () => {
    expect(PiDriver.driverKind).toBe(ProviderDriverKind.make("pi"));
    expect(BUILT_IN_DRIVERS).toContain(PiDriver);
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
