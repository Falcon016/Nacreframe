// Example NexusHarness extension. Copy to <config>/extensions/ (see `nexus doctor` for the path).
// Blocks any tool call that tries to touch a lockfile, and adds a /todo-scan command.
import type { ExtensionApi } from 'nexusharness/extensions';

export default function (api: ExtensionApi) {
  api.onBeforeTool(async ({ name, input }) => {
    const path = typeof input.path === 'string' ? input.path : '';
    if (
      (name === 'write' || name === 'edit') &&
      /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(path)
    ) {
      return { block: 'Lockfiles are managed by the package manager; run the install command instead.' };
    }
  });

  api.registerCommand({
    name: 'todo-scan',
    description: 'Ask the agent to list TODO/FIXME comments',
    run: (_args, ctx) =>
      ctx.prompt('Use grep to find TODO and FIXME comments in this project and summarise them by file.'),
  });

  api.registerTool({
    name: 'word_count',
    description: 'Count words in a piece of text.',
    risk: 'read',
    schema: api.z.object({ text: api.z.string() }),
    describe: () => 'count words',
    execute: async (input: { text: string }) => ({
      content: String(input.text.split(/\s+/).filter(Boolean).length),
    }),
  });
}
