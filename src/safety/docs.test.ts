import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const safetyDocs = [
  'docs/privacy/data-inventory.md',
  'docs/safety/threat-model.md',
  'docs/safety/dpia-lite.md',
  'docs/safety/system-card.md',
  'docs/safety/risk-register.md',
  'docs/safety/incident-runbook.md',
  'docs/safety/synthetic-replay.md',
];

describe('responsible-AI documentation consistency', () => {
  it('links to each published safety document from the README', async () => {
    const readme = await readFile('README.md', 'utf8');
    const destinations = [...readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
    for (const path of safetyDocs) {
      await expect(access(path)).resolves.toBeUndefined();
      expect(destinations).toContain(path);
    }
  });

  it('uses only explicit status values and makes no compliance claims', async () => {
    for (const path of safetyDocs) {
      const content = await readFile(path, 'utf8');
      expect(content).toMatch(/\*\*Status:\*\* (implemented|partial|not done|not applicable)/i);
      expect(content).not.toMatch(
        /\b(?:we|this system|the project|the bot)\s+(?:are|is|comply|complies|conform|conforms)\s+(?:fully\s+)?(?:certified|compliant|with|to|under)\b/i,
      );
      const lines = content.split('\n');
      const statusHeader = lines.findIndex(
        (line) => line.startsWith('|') && /\|\s*Status\s*\|/i.test(line),
      );
      if (statusHeader >= 0) {
        const headers = lines[statusHeader]!.split('|')
          .map((cell) => cell.trim())
          .filter(Boolean);
        const statusIndex = headers.findIndex((cell) => /^Status$/i.test(cell));
        for (const row of lines.slice(statusHeader + 2)) {
          if (!row.startsWith('|')) break;
          const cells = row
            .split('|')
            .map((cell) => cell.trim())
            .filter(Boolean);
          expect(cells[statusIndex]).toMatch(/^(implemented|partial|not done|not applicable)$/i);
        }
      }
    }
  });

  it('keeps parse-mode handling, store erasure, and transcript scope visible', async () => {
    const [threatModel, riskRegister, privacy] = await Promise.all([
      readFile('docs/safety/threat-model.md', 'utf8'),
      readFile('docs/safety/risk-register.md', 'utf8'),
      readFile('README.md', 'utf8'),
    ]);

    expect(threatModel).toMatch(/Telegram parse[- ]mode/i);
    const storeErasureRow = riskRegister
      .split('\n')
      .find((line) => line.includes('Store erasure treatment'));
    expect(storeErasureRow?.split('|').map((cell) => cell.trim())[2]).toBe('not done');
    expect(privacy).toContain('/export');
    expect(privacy).toContain('/pseudonymise');
    expect(privacy.replace(/\s+/g, ' ')).toMatch(
      /does not rewrite historical transcript mentions/i,
    );
  });

  it('describes indexed artifact metadata and the historical-file gap accurately', async () => {
    const [inventory, systemCard, riskRegister, threatModel] = await Promise.all([
      readFile('docs/privacy/data-inventory.md', 'utf8'),
      readFile('docs/safety/system-card.md', 'utf8'),
      readFile('docs/safety/risk-register.md', 'utf8'),
      readFile('docs/safety/threat-model.md', 'utf8'),
    ]);
    const normalizedInventory = inventory.replace(/\s+/g, ' ');
    const normalizedCard = systemCard.replace(/\s+/g, ' ');
    const artifactRow = inventory
      .split('\n')
      .find((line) => line.startsWith('| Generated invoice and deck files |'));

    expect(artifactRow).toMatch(/export` includes indexed artifact metadata/i);
    expect(artifactRow).toMatch(/omits file contents and metadata for historical unindexed files/i);
    expect(normalizedInventory).toMatch(/generated_artifacts.*store.*last activity/i);
    expect(normalizedInventory).toMatch(/historical files.*no.*index/i);
    expect(normalizedCard).toMatch(/export includes indexed artifact metadata/i);
    expect(normalizedCard).toMatch(/historical unindexed files/i);
    expect(riskRegister).toMatch(/historical artifact metadata/i);
    expect(threatModel.replace(/\s+/g, ' ')).toMatch(
      /indexed artifact metadata is exported.*file contents and metadata for historical unindexed files are omitted/i,
    );
  });
});
