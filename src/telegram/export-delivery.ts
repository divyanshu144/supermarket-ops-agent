import { rm } from 'node:fs/promises';
import { InputFile, type Context } from 'grammy';

/** Export copies are one-shot delivery artifacts and are removed on both success and failure. */
export async function deliverTemporaryExport(
  ctx: Context,
  path: string,
  filename: string,
): Promise<true> {
  try {
    await ctx.replyWithDocument(new InputFile(path, filename));
    return true;
  } finally {
    await rm(path, { force: true });
  }
}
