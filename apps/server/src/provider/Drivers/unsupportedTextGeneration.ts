import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";

type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

/**
 * Text generation stub for drivers that cannot run background prompts.
 * Every operation fails with the same typed error naming the provider.
 */
export const unsupportedTextGeneration = (
  displayName: string,
): TextGeneration.TextGeneration["Service"] => {
  const fail = (operation: TextGenerationOperation) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: `${displayName} is not configured for background text generation.`,
      }),
    );
  return {
    generateCommitMessage: () => fail("generateCommitMessage"),
    generatePrContent: () => fail("generatePrContent"),
    generateBranchName: () => fail("generateBranchName"),
    generateThreadTitle: () => fail("generateThreadTitle"),
  };
};
