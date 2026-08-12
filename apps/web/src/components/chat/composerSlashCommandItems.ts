import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";

/** Turns only the selected instance snapshot into composer menu rows. */
export function providerSlashCommandItems(input: {
  instanceId: ProviderInstanceId;
  provider: ProviderDriverKind;
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}) {
  return input.slashCommands.map((command) => ({
    id: `provider-slash-command:${input.instanceId}:${command.name}`,
    type: "provider-slash-command" as const,
    provider: input.provider,
    providerInstanceId: input.instanceId,
    command,
    label: `/${command.name}`,
    description: command.description ?? "Run provider command",
  }));
}
