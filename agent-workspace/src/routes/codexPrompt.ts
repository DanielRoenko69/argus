export interface CompactedRuntimePrompt {
  prompt: string;
  compacted: boolean;
  originalChars: number;
  finalChars: number;
  omittedChars: number;
}

const HEAD_SHARE = 0.35;

/**
 * Keep oversized retry prompts usable without silently discarding the failure
 * summary or the ticket instructions. Test runners often emit their useful
 * diagnostics at the end, while the beginning still contains command/setup
 * evidence, so the bridge retains both ends with an explicit audit marker.
 */
export function compactRuntimePrompt(
  input: string,
  maxChars: number,
): CompactedRuntimePrompt {
  if (!Number.isSafeInteger(maxChars) || maxChars < 256) {
    throw new Error('maxChars must be an integer of at least 256');
  }
  if (input.length <= maxChars) {
    return {
      prompt: input,
      compacted: false,
      originalChars: input.length,
      finalChars: input.length,
      omittedChars: 0,
    };
  }

  const markerFor = (omittedChars: number) =>
    `\n\n[ARGUS_RUNTIME_PROMPT_COMPACTED omitted_chars=${omittedChars} preserved=head+tail]\n\n`;
  let marker = markerFor(input.length - maxChars);
  let available = maxChars - marker.length;
  const headChars = Math.floor(available * HEAD_SHARE);
  const tailChars = available - headChars;
  const omittedChars = input.length - headChars - tailChars;
  marker = markerFor(omittedChars);
  available = maxChars - marker.length;
  const adjustedHeadChars = Math.floor(available * HEAD_SHARE);
  const adjustedTailChars = available - adjustedHeadChars;
  const prompt = `${input.slice(0, adjustedHeadChars)}${marker}${input.slice(-adjustedTailChars)}`;

  return {
    prompt,
    compacted: true,
    originalChars: input.length,
    finalChars: prompt.length,
    omittedChars: input.length - adjustedHeadChars - adjustedTailChars,
  };
}
